import express from 'express';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  ROOT, DATA_DIR, SESSIONS_DIR, CONFIG_FILE,
  loadTasks, saveTasks, listTasks, getTask, createTask, updateTask, deleteTask,
} from './lib/store.js';
import { parseSessionFile, evaluateRunningTask, extractText } from './lib/session.js';
import { findPiPids, killPi } from './lib/executor.js';
import {
  startWebTui, stopWebTuiAndWait, stopWebTuiForRestart, stopAllWebTuis, writeWebTui, resizeWebTui,
  isWebTuiRunning, subscribeWebTui, claimWebTuiInput, releaseWebTuiInput,
} from './lib/tui-executor.js';

const DEFAULT_CONFIG = { port: 7777, maxConcurrent: 0, approvePi: true };
const activeSessionIds = new Map();
const tuiOpenings = new Map();
let config = { ...DEFAULT_CONFIG };
try {
  if (existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
} catch { /* 使用默认配置 */ }
function saveConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib')));
app.use(express.static(path.join(ROOT, 'public')));

function nowIso() { return new Date().toISOString(); }
function taskSessions(task) {
  if (!Array.isArray(task.sessions)) {
    task.sessions = task.sessionFile ? [{ id: 'main', title: '主会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
  }
  return task.sessions;
}
function resolveTaskSession(task, sessionId) {
  const sessions = taskSessions(task);
  const id = sessionId || activeSessionIds.get(task.id) || sessions[0]?.id || 'main';
  return sessions.find((session) => session.id === id) || sessions[0] || null;
}
function sessionTitleFromPrompt(text) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  if (!title) return '新会话';
  return title.length > 28 ? `${title.slice(0, 28)}…` : title;
}
function messageTime(entry) {
  const value = entry?.message?.timestamp || entry?.timestamp;
  const time = typeof value === 'number' ? value : new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}
function assistantMessages(child) {
  return parseSessionFile(child.sessionFile).entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === 'message' && entry.message?.role === 'assistant');
}
function sessionUnread(child) {
  const messages = assistantMessages(child);
  if (!messages.length) return { unread: false, unreadCount: 0 };
  const markerIndex = child.lastReadMessageId ? messages.findIndex(({ entry }) => entry.id === child.lastReadMessageId) : -1;
  const lastReadAt = Number(child.lastReadAt) || new Date(child.lastReadAt || 0).getTime() || 0;
  const unreadMessages = markerIndex >= 0
    ? messages.slice(markerIndex + 1)
    : messages.filter(({ entry }) => messageTime(entry) > lastReadAt);
  return { unread: unreadMessages.length > 0, unreadCount: unreadMessages.length };
}
function publicSession(child) {
  let shown = child;
  if (!child.title || child.title === '主会话' || child.title === '新会话') {
    const parsed = parseSessionFile(child.sessionFile);
    for (const entry of parsed.entries) {
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const text = extractText(entry.message.content).trim();
      if (text) { shown = { ...child, title: sessionTitleFromPrompt(text) }; break; }
    }
  }
  const { lastReadMessageId, lastReadAt, ...safe } = shown;
  return { ...safe, ...sessionUnread(child) };
}
function markSessionRead(task, child) {
  if (!task || !child) return false;
  const messages = assistantMessages(child);
  const latest = messages.at(-1)?.entry || null;
  const lastReadMessageId = latest?.id || null;
  const lastReadAt = latest ? (messageTime(latest) || Date.now()) : Date.now();
  if (child.lastReadMessageId === lastReadMessageId && Number(child.lastReadAt) === lastReadAt) return false;
  child.lastReadMessageId = lastReadMessageId;
  child.lastReadAt = lastReadAt;
  saveTasks();
  return true;
}
function initializeSessionReadState() {
  let changed = false;
  for (const task of listTasks()) {
    for (const child of taskSessions(task)) {
      if (Object.prototype.hasOwnProperty.call(child, 'lastReadAt')) continue;
      const latest = assistantMessages(child).at(-1)?.entry || null;
      child.lastReadMessageId = latest?.id || null;
      child.lastReadAt = latest ? (messageTime(latest) || Date.now()) : Date.now();
      changed = true;
    }
  }
  if (changed) saveTasks();
}
function persistSessionTitle(task, child) {
  if (!child || (child.title && child.title !== '主会话' && child.title !== '新会话')) return;
  const shown = publicSession(child).title;
  if (!shown || shown === child.title) return;
  child.title = shown;
  child.updatedAt = nowIso();
  updateTask(task.id, { sessions: taskSessions(task) });
}
function taskStats(task) {
  const stats = { sessions: 0, messages: 0, userMessages: 0, assistantMessages: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, errors: 0 };
  const children = taskSessions(task);
  for (const child of children) {
    const current = parseSessionFile(child.sessionFile).stats;
    // 与 publicTask 显示规则一致：没有消息内容的「主会话」占位不计入
    if (child.id === 'main' && !current?.messages) continue;
    stats.sessions++;
    if (!current) continue;
    stats.messages += current.messages || 0;
    stats.userMessages += current.user || 0;
    stats.assistantMessages += current.assistant || 0;
    stats.toolResults += current.toolResults || 0;
    stats.inputTokens += current.input || 0;
    stats.outputTokens += current.output || 0;
    stats.cacheReadTokens += current.cacheRead || 0;
    stats.cacheWriteTokens += current.cacheWrite || 0;
    stats.cost += current.cost || 0;
    stats.errors += current.errors || 0;
  }
  stats.totalTokens = stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  return stats;
}
function publicTask(task) {
  const internalStatus = task.status;
  const displayStatus = ['todo', 'running', 'done', 'archived'].includes(internalStatus) ? internalStatus : 'archived';
  const allSessions = taskSessions(task);
  // 「主会话」只存在于历史数据（由旧 task.sessionFile 回填）；没有消息内容时不显示
  const visibleSessions = allSessions.filter((child) => child.id !== 'main' || Boolean(parseSessionFile(child.sessionFile).stats?.messages));
  return {
    ...task,
    status: displayStatus,
    sessions: visibleSessions.map(publicSession),
    activeSessionId: activeSessionIds.get(task.id) || visibleSessions[0]?.id || null,
    stats: taskStats(task),
    overdue: Boolean(task.deadline && !['done', 'archived'].includes(internalStatus) && new Date(task.deadline).getTime() < Date.now()),
    piRunning: isWebTuiRunning(task.id),
  };
}
function resolveWorkingDir(value) {
  let input = String(value || '').trim();
  if (!input || input.includes('\0')) return null;
  if (input === '~' || input.startsWith('~/')) input = path.join(process.env.HOME || '', input.slice(1));
  if (process.platform === 'win32' && path.win32.isAbsolute(input)) return path.win32.normalize(input);
  if (!path.isAbsolute(input)) return null;
  return path.normalize(input);
}
function concurrencyFull(extra = 0) {
  return config.maxConcurrent > 0 && listTasks().filter((task) => task.status === 'running').length + extra > config.maxConcurrent;
}
function removeTaskFiles(task) {
  for (const child of taskSessions(task)) {
    killPi(child.sessionFile);
    try { if (existsSync(child.sessionFile)) unlinkSync(child.sessionFile); } catch { /* ignore */ }
  }
}
async function stopTaskTui(taskId, options) {
  return stopWebTuiAndWait(taskId, options);
}
async function purgeArchivedTasks() {
  const cutoff = Date.now();
  for (const task of listTasks()) {
    if (task.status !== 'archived' || !task.purgeAt || new Date(task.purgeAt).getTime() > cutoff) continue;
    await stopTaskTui(task.id, { silent: true });
    removeTaskFiles(task);
    activeSessionIds.delete(task.id);
    deleteTask(task.id);
  }
}
function withTuiLock(taskId, action) {
  const previous = tuiOpenings.get(taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  tuiOpenings.set(taskId, current);
  return current.finally(() => {
    if (tuiOpenings.get(taskId) === current) tuiOpenings.delete(taskId);
  });
}
async function openTaskTui(task, childSession, cols, rows, theme) {
  if (!childSession) throw new Error('任务没有可用子会话');
  const historical = task.status === 'done';
  if (task.status === 'archived') throw new Error('当前任务状态不能打开原生 TUI');
  const workingDir = resolveWorkingDir(task.workingDir);
  if (!workingDir) throw new Error('请先为任务设置工作目录');
  mkdirSync(workingDir, { recursive: true });
  activeSessionIds.set(task.id, childSession.id);
  const record = await startWebTui({
    taskId: task.id, childSessionId: childSession.id, workingDir, sessionFile: childSession.sessionFile,
    title: childSession.title || task.title, provider: task.modelProvider, model: task.model,
    thinkingLevel: task.thinkingLevel, readOnly: task.readOnly, approve: config.approvePi !== false,
    cols, rows, theme: theme === 'dark' ? 'dark' : 'light',
    onExit: ({ exitCode }) => {
      const current = getTask(task.id);
      if (!current) return;
      const currentSession = resolveTaskSession(current, childSession.id);
      persistSessionTitle(current, currentSession);
      if (current.status !== 'running') return;
      updateTask(task.id, { lastRun: {
        status: exitCode === 0 ? 'done' : 'terminated',
        reason: exitCode === 0 ? null : `原生 TUI 已退出（exit code ${exitCode}）`, at: nowIso(),
      }});
    },
  });
  const current = getTask(task.id);
  if (!historical && current?.status !== 'running') updateTask(task.id, { status: 'running', lastRun: { status: 'running', reason: null, at: nowIso() } });
  return record;
}

// 任务 CRUD
app.get('/api/tasks', (_req, res) => res.json({ tasks: listTasks().map(publicTask) }));
app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  if (!String(body.title || '').trim()) return res.status(400).json({ error: '标题不能为空' });
  const workingDir = resolveWorkingDir(body.workingDir);
  if (!workingDir) return res.status(400).json({ error: '请选择工作目录' });
  res.json({ task: publicTask(createTask({ ...body, workingDir })) });
});
app.put('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === 'archived') return res.status(409).json({ error: '已废弃任务不能编辑' });
  const patch = {};
  for (const key of ['title', 'description', 'color', 'deadline']) if (key in (req.body || {})) patch[key] = req.body[key];
  // 处理中和已完成任务允许编辑任务信息，但工作目录必须保持不变。
  if (!['running', 'done'].includes(task.status) && 'workingDir' in (req.body || {})) {
    patch.workingDir = resolveWorkingDir(req.body.workingDir);
    if (!patch.workingDir) return res.status(400).json({ error: '请选择工作目录' });
  }
  if ('title' in patch && !String(patch.title).trim()) return res.status(400).json({ error: '标题不能为空' });
  if ('description' in patch) patch.description = String(patch.description || '').trim();
  res.json({ task: publicTask(updateTask(task.id, patch)) });
});
app.delete('/api/tasks/archived', async (_req, res) => {
  const archived = listTasks().filter((task) => task.status === 'archived');
  for (const task of archived) {
    await stopTaskTui(task.id, { silent: true });
    removeTaskFiles(task);
    activeSessionIds.delete(task.id);
    deleteTask(task.id);
  }
  res.json({ removed: archived.length });
});
app.delete('/api/tasks/:id', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  await stopTaskTui(task.id, { silent: true });
  for (const child of taskSessions(task)) killPi(child.sessionFile);
  activeSessionIds.delete(task.id);
  const archivedAt = nowIso();
  const purgeAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  const validStatuses = ['todo', 'running', 'done'];
  const archivedFromStatus = validStatuses.includes(task.status) ? task.status : (validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'todo');
  res.json({ task: publicTask(updateTask(task.id, { status: 'archived', archivedFromStatus, archivedAt, purgeAt })) });
});
app.post('/api/tasks/:id/restore', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'archived') return res.status(409).json({ error: '只有已废弃任务可以恢复' });
  const validStatuses = ['todo', 'running', 'done'];
  const restoredStatus = validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'todo';
  res.json({ task: publicTask(updateTask(task.id, { status: restoredStatus, archivedFromStatus: null, archivedAt: null, purgeAt: null })) });
});
app.delete('/api/tasks/:id/permanent', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  await stopTaskTui(task.id, { silent: true });
  removeTaskFiles(task);
  activeSessionIds.delete(task.id);
  deleteTask(task.id);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/complete', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!['todo', 'running'].includes(task.status)) return res.status(409).json({ error: '当前状态不能标记完成' });
  await stopTaskTui(task.id, { silent: true });
  killPi(resolveTaskSession(task)?.sessionFile || task.sessionFile);
  res.json({ task: publicTask(updateTask(task.id, { status: 'done', completedAt: nowIso() })) });
});
app.post('/api/tasks/:id/reopen', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'done') return res.status(409).json({ error: '只有已完成任务可以重开' });
  res.json({ task: publicTask(updateTask(task.id, { status: 'running', completedAt: null, lastRun: { status: 'reopened', reason: '任务已重新打开', at: nowIso() } })) });
});

// 子会话仅保存 pi JSONL 的入口信息；交互全部在原生 TUI 完成。
app.post('/api/tasks/:id/sessions/:sessionId/read', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '子会话不存在' });
  markSessionRead(task, session);
  res.json({ ok: true, session: publicSession(session) });
});
app.get('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = taskSessions(task);
  res.json({ sessions: sessions.map(publicSession), activeSessionId: activeSessionIds.get(task.id) || sessions[0]?.id || null });
});
app.post('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === 'done' || task.status === 'archived') return res.status(409).json({ error: '当前任务状态不能新建会话' });
  const session = { id: randomUUID(), title: String(req.body?.title || '新会话').trim().slice(0, 80) || '新会话', sessionFile: path.join(SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`), createdAt: nowIso(), updatedAt: nowIso() };
  const sessions = taskSessions(task);
  sessions.push(session);
  const patch = { sessions };
  // 任务级 sessionFile（兼容字段）锚定到首个真实会话
  if (!task.sessionFile) patch.sessionFile = session.sessionFile;
  updateTask(task.id, patch);
  res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
});
app.patch('/api/tasks/:id/sessions/:sessionId', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '子会话不存在' });
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: '会话名称不能为空' });
  session.title = title.slice(0, 80); session.updatedAt = nowIso();
  updateTask(task.id, { sessions: taskSessions(task) });
  res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
});
app.delete('/api/tasks/:id/sessions/:sessionId', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = taskSessions(task);
  if (sessions.length <= 1) return res.status(409).json({ error: '至少保留一个子会话' });
  const index = sessions.findIndex((item) => item.id === req.params.sessionId);
  if (index < 0) return res.status(404).json({ error: '子会话不存在' });
  const [removed] = sessions.splice(index, 1);
  if (isWebTuiRunning(task.id) && activeSessionIds.get(task.id) === removed.id) await stopTaskTui(task.id, { silent: true });
  try { if (existsSync(removed.sessionFile)) unlinkSync(removed.sessionFile); } catch { /* ignore */ }
  const patch = { sessions };
  if (task.sessionFile === removed.sessionFile) patch.sessionFile = sessions[0].sessionFile;
  if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, sessions[0].id);
  updateTask(task.id, patch);
  res.json({ ok: true, task: publicTask(getTask(task.id)) });
});
app.post('/api/tasks/:id/tui/restart', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const stopped = await stopWebTuiForRestart(task.id);
  res.json({ stopped });
});
app.post('/api/tasks/:id/terminate', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'running') return res.status(409).json({ error: '任务不在执行中' });
  const stopped = await stopTaskTui(task.id, { silent: true });
  const killed = killPi(resolveTaskSession(task)?.sessionFile || task.sessionFile);
  res.json({ task: publicTask(updateTask(task.id, { lastRun: { status: 'terminated', reason: '已手动终止执行', at: nowIso(), stopped, killed } })) });
});

const webSockets = new WebSocketServer({ noServer: true });
webSockets.on('connection', (ws) => {
  const clientId = randomUUID();
  let taskId = null;
  let unsubscribe = null;
  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  };
  const bindTui = async (id, sessionId, cols, rows, theme) => {
    const task = getTask(id);
    if (!task) return send({ type: 'tui_error', error: '任务不存在' });
    const childSession = resolveTaskSession(task, sessionId);
    if (!childSession) return send({ type: 'tui_error', error: '子会话不存在' });
    if (task.status === 'archived') return send({ type: 'tui_error', error: '当前任务状态不能打开原生 TUI' });
    if (task.status !== 'running' && concurrencyFull(1)) return send({ type: 'tui_error', error: `已达到并发上限：${config.maxConcurrent}` });
    try {
      await withTuiLock(id, () => openTaskTui(getTask(id), childSession, cols, rows, theme));
      markSessionRead(getTask(id), childSession);
      if (taskId && taskId !== id) releaseWebTuiInput(taskId, clientId);
      taskId = id;
      unsubscribe?.();
      unsubscribe = subscribeWebTui(id, send);
      claimWebTuiInput(id, clientId);
      resizeWebTui(id, cols, rows);
      send({ type: 'tui_ready', taskId: id, childSessionId: childSession.id });
    } catch (error) {
      const detail = error?.message || String(error);
      console.error(`[workbench] 打开原生 TUI 失败（${id}/${sessionId || 'main'}）：${detail}`);
      send({ type: 'tui_error', error: `打开原生 TUI 失败：${detail}` });
    }
  };
  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'tui_hello') return await bindTui(message.taskId, message.sessionId, message.cols, message.rows, message.theme);
      // xterm can emit a final input or resize frame while an old PTY is
      // exiting. It is harmless and should not produce a user-facing toast.
      if (message.type === 'tui_input' || message.type === 'tui_resize') {
        if (!taskId || !isWebTuiRunning(taskId)) return;
        if (message.type === 'tui_input') return writeWebTui(taskId, clientId, message.data);
        return resizeWebTui(taskId, message.cols, message.rows);
      }
    } catch (error) {
      const detail = error?.message || String(error);
      console.error(`[workbench] 原生 TUI WebSocket 错误：${detail}`);
      send({ type: 'tui_error', error: detail });
    }
  });
  ws.on('close', () => {
    unsubscribe?.();
    if (taskId) releaseWebTuiInput(taskId, clientId);
  });
});

function selectWindowsDirectory(res) {
  const script = [
    '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms', '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog', '$dialog.Description = "选择工作目录"',
    '$dialog.ShowNewFolderButton = $true', '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
  ].join('; ');
  const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const commands = ['powershell.exe', 'pwsh.exe'];
  let index = 0;
  const run = () => execFile(commands[index], args, { timeout: 120000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error?.code === 'ENOENT' && index < commands.length - 1) { index += 1; return run(); }
    if (error) return res.status(500).json({ error: `打开 Windows 目录选择器失败：${error.message}` });
    const selected = String(stdout || '').replace(/^\uFEFF/, '').trim();
    if (!selected) return res.json({ cancelled: true });
    res.json({ path: selected });
  });
  run();
}
app.post('/api/select-directory', (_req, res) => {
  const platform = process.platform;
  if (platform === 'win32') return selectWindowsDirectory(res);
  const command = platform === 'darwin' ? 'osascript' : platform === 'linux' ? 'zenity' : null;
  const args = platform === 'darwin' ? ['-e', 'POSIX path of (choose folder with prompt "选择工作目录")'] : platform === 'linux' ? ['--file-selection', '--directory', '--title=选择工作目录'] : [];
  if (!command) return res.status(501).json({ error: '当前系统暂不支持原生目录选择，请直接输入路径' });
  execFile(command, args, { timeout: 120000, encoding: 'utf8' }, (error, stdout) => {
    if (error) {
      if (error.code === 1) return res.json({ cancelled: true });
      return res.status(500).json({ error: `打开目录选择器失败：${error.message}` });
    }
    const selected = String(stdout || '').trim();
    if (!selected) return res.json({ cancelled: true });
    res.json({ path: selected });
  });
});
app.get('/api/config', (_req, res) => res.json({ ...config, sessionsDir: SESSIONS_DIR }));
app.post('/api/config', (req, res) => {
  for (const key of ['maxConcurrent', 'approvePi']) if (key in (req.body || {})) config[key] = req.body[key];
  saveConfig();
  res.json(config);
});

setInterval(() => { void purgeArchivedTasks(); }, 60 * 60 * 1000);
setInterval(() => {
  for (const task of listTasks()) {
    if (task.status !== 'running') continue;
    persistSessionTitle(task, resolveTaskSession(task));
    if (isWebTuiRunning(task.id)) continue;
    const verdict = evaluateRunningTask(task, { findPiPids });
    if (verdict) updateTask(task.id, { lastRun: verdict.lastRun });
  }
}, 2000);

loadTasks();
initializeSessionReadState();
void purgeArchivedTasks();
const server = app.listen(config.port, '127.0.0.1', () => console.log(`[workbench] http://127.0.0.1:${config.port}`));
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  webSockets.handleUpgrade(request, socket, head, (ws) => webSockets.emit('connection', ws, request));
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[workbench] 端口 ${config.port} 已被占用，请修改 data/config.json 后重启`);
    process.exit(1);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // A PTY cannot survive this owner process reliably on Windows. Stop every
  // tracked TUI before exiting instead of leaving orphaned pi processes.
  for (const client of webSockets.clients) {
    try { client.close(); } catch { /* already closed */ }
  }
  await stopAllWebTuis();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
