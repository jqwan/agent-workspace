import express from 'express';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  ROOT, DATA_DIR, SESSIONS_DIR, PROJECTS_ROOT, CONFIG_FILE,
  loadTasks, listTasks, getTask, createTask, updateTask, deleteTask,
} from './lib/store.js';
import { parseSessionFile, evaluateRunningTask, extractText } from './lib/session.js';
import { findPiPids, killPi, resolvePiBin } from './lib/executor.js';
import { startWebPi, stopWebPi, sendWebPrompt, sendWebCommand, isWebPiRunning, getWebEvents, getWebState, subscribeWebPi } from './lib/web-executor.js';

const DEFAULT_CONFIG = { port: 7777, maxConcurrent: 0, terminalApp: 'auto', approvePi: true };
const activeSessionIds = new Map();
let config = { ...DEFAULT_CONFIG };
try {
  if (existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
} catch { /* 使用默认配置 */ }
function saveConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const tokenFile = path.join(DATA_DIR, 'auth-token');
let authToken;
if (existsSync(tokenFile)) authToken = readFileSync(tokenFile, 'utf8').trim();
else {
  mkdirSync(DATA_DIR, { recursive: true });
  authToken = randomBytes(16).toString('hex');
  writeFileSync(tokenFile, `${authToken}\n`, { mode: 0o600 });
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

let modelsCache = { models: [], updatedAt: null, error: null };
try {
  const file = path.join(DATA_DIR, 'models-cache.json');
  if (existsSync(file)) modelsCache = JSON.parse(readFileSync(file, 'utf8'));
} catch { /* ignore */ }

function parseModelsOutput(output) {
  const models = [];
  for (const line of String(output).trim().split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 2 || cells[0] === 'provider') continue;
    models.push({
      provider: cells[0], id: cells[1], label: `${cells[0]} / ${cells[1]}`,
      context: cells[2] || '', thinking: cells[4] === 'yes',
    });
  }
  return models;
}

function refreshModels() {
  return new Promise((resolve) => {
    execFile(resolvePiBin(), ['--list-models'], { timeout: 30000, encoding: 'utf8' }, (error, stdout) => {
      modelsCache = error
        ? { ...modelsCache, error: error.message }
        : { models: parseModelsOutput(stdout), updatedAt: new Date().toISOString(), error: null };
      try { writeFileSync(path.join(DATA_DIR, 'models-cache.json'), JSON.stringify(modelsCache, null, 2)); } catch { /* ignore */ }
      resolve(modelsCache);
    });
  });
}

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
function nameSessionFromPrompt(task, sessionId, prompt) {
  const session = resolveTaskSession(task, sessionId);
  if (!session || (session.title && session.title !== '主会话' && session.title !== '新会话')) return session;
  let firstPrompt = prompt;
  const existing = parseSessionFile(session.sessionFile);
  for (const entry of existing.entries) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const text = extractText(entry.message.content).trim();
      if (text) { firstPrompt = text; break; }
    }
  }
  session.title = sessionTitleFromPrompt(firstPrompt);
  session.updatedAt = nowIso();
  updateTask(task.id, { sessions: taskSessions(task) });
  return session;
}
function resolveTerminalApp() {
  if (config.terminalApp && config.terminalApp !== 'auto') return config.terminalApp;
  const home = process.env.HOME || '';
  return ['/Applications/iTerm.app', path.join(home, 'Applications/iTerm.app')].some(existsSync) ? 'iTerm2' : 'Terminal';
}
function publicSession(task, child) {
  if (child.title && child.title !== '主会话' && child.title !== '新会话') return child;
  const parsed = parseSessionFile(child.sessionFile);
  for (const entry of parsed.entries) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const text = extractText(entry.message.content).trim();
      if (text) return { ...child, title: sessionTitleFromPrompt(text) };
    }
  }
  return child;
}
function taskStats(task) {
  const stats = { sessions: 0, messages: 0, userMessages: 0, assistantMessages: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, errors: 0 };
  const children = taskSessions(task);
  const started = Boolean(task.lastRun) || children.some((child) => Boolean(parseSessionFile(child.sessionFile).stats?.messages));
  for (const child of children) {
    if (!started && child.id === 'main') continue;
    stats.sessions++;
    const current = parseSessionFile(child.sessionFile).stats;
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
  const displayStatus = internalStatus === 'todo' ? 'todo' : internalStatus === 'done' ? 'done' : internalStatus === 'archived' ? 'archived' : 'running';
  const allSessions = taskSessions(task);
  const started = Boolean(task.lastRun) || allSessions.some((child) => Boolean(parseSessionFile(child.sessionFile).stats?.messages));
  // The automatically-created main session is an implementation detail. Do
  // not expose it until the task has actually started; explicitly-created
  // child sessions remain visible.
  const visibleSessions = allSessions.filter((child) => started || child.id !== 'main');
  return {
    ...task,
    status: displayStatus,
    sessions: visibleSessions.map((child) => publicSession(task, child)),
    activeSessionId: activeSessionIds.get(task.id) || visibleSessions[0]?.id || null,
    stats: taskStats(task),
    overdue: Boolean(task.deadline && !['done', 'archived'].includes(internalStatus) && new Date(task.deadline).getTime() < Date.now()),
    piRunning: internalStatus === 'running' && isWebPiRunning(task.id),
  };
}
function resolveWorkingDir(value) {
  let input = String(value || '').trim();
  if (!input || input.includes('\0')) return null;
  if (input === '~' || input.startsWith('~/')) input = path.join(process.env.HOME || '', input.slice(1));
  // Keep old task values working: relative paths still resolve from projects/.
  return path.resolve(path.isAbsolute(input) ? input : path.join(PROJECTS_ROOT, input));
}

function removeTaskFiles(task) {
  for (const child of taskSessions(task)) {
    killPi(child.sessionFile);
    try { if (existsSync(child.sessionFile)) unlinkSync(child.sessionFile); } catch { /* ignore */ }
  }
}
function purgeArchivedTasks() {
  const cutoff = Date.now();
  for (const task of listTasks()) {
    if (task.status !== 'archived' || !task.purgeAt || new Date(task.purgeAt).getTime() > cutoff) continue;
    stopWebPi(task.id);
    removeTaskFiles(task);
    activeSessionIds.delete(task.id);
    deleteTask(task.id);
  }
}
function settleWebTurn(taskId) {
  const current = getTask(taskId);
  if (!current || current.status !== 'running') return;
  const verdict = evaluateRunningTask(current, { findPiPids });
  if (verdict) updateTask(current.id, { status: verdict.state, lastRun: verdict.lastRun });
  else updateTask(current.id, { status: 'review', lastRun: { status: 'done', reason: null, at: nowIso() } });
}
async function openTaskSession(task, childSession = resolveTaskSession(task)) {
  if (!childSession) throw new Error('任务没有可用子会话');
  activeSessionIds.set(task.id, childSession.id);
  const workingDir = resolveWorkingDir(task.workingDir);
  mkdirSync(workingDir, { recursive: true });
  await startWebPi({
    taskId: task.id, childSessionId: childSession.id, workingDir, sessionFile: childSession.sessionFile, title: childSession.title || task.title,
    provider: task.modelProvider, model: task.model, thinkingLevel: task.thinkingLevel,
    readOnly: task.readOnly, approve: config.approvePi !== false,
    onEvent: (event) => { if (event.type === 'agent_end') setTimeout(() => settleWebTurn(task.id), 250); },
    onExit: ({ code, error }) => {
      setTimeout(() => {
        const current = getTask(task.id);
        if (!current || current.status !== 'running') return;
        const verdict = evaluateRunningTask(current, { findPiPids: () => [] });
        if (verdict) updateTask(current.id, { status: verdict.state, lastRun: verdict.lastRun });
        else updateTask(current.id, { status: 'review', lastRun: { status: error || code !== 0 ? 'failed' : 'terminated', reason: error?.message || (code !== 0 ? `pi 异常退出（exit code ${code}）` : 'pi 已退出但没有完整响应'), at: nowIso() } });
      }, 500);
    },
  });
}
async function launchPi(task, prompt, sessionId) {
  const childSession = resolveTaskSession(task, sessionId);
  await openTaskSession(task, childSession);
  nameSessionFromPrompt(task, childSession.id, prompt);
  // AgentSession.prompt() resolves after the whole turn. Do not hold the HTTP
  // request open while the model is working; SDK events drive the WebSocket.
  void sendWebPrompt(task.id, prompt).catch((error) => {
    updateTask(task.id, { status: 'review', lastRun: { status: 'failed', reason: `执行失败：${error.message}`, at: nowIso() } });
  });
}
async function startRun(task, prompt, sessionId) {
  try {
    const childSession = resolveTaskSession(task, sessionId);
    if (!childSession) throw new Error('任务没有可用子会话');
    const activeState = getWebState(task.id);
    const sameSession = isWebPiRunning(task.id) && activeState?.childSessionId === childSession.id;
    activeSessionIds.set(task.id, childSession.id);
    nameSessionFromPrompt(task, childSession.id, prompt);
    if (!sameSession) {
      stopWebPi(task.id);
      killPi(childSession.sessionFile);
      updateTask(task.id, { status: 'running', lastRun: { status: 'running', reason: null, at: nowIso() } });
      await launchPi(getTask(task.id), prompt, childSession.id);
    } else {
      updateTask(task.id, { status: 'running', lastRun: { status: 'running', reason: null, at: nowIso() } });
      void sendWebPrompt(task.id, prompt).catch((error) => {
        updateTask(task.id, { status: 'review', lastRun: { status: 'failed', reason: `执行失败：${error.message}`, at: nowIso() } });
      });
    }
  } catch (error) {
    updateTask(task.id, { status: 'review', lastRun: { status: 'failed', reason: `启动失败：${error.message}`, at: nowIso() } });
    throw error;
  }
}
function concurrencyFull(extra = 0) {
  return config.maxConcurrent > 0 && listTasks().filter((t) => t.status === 'running').length + extra > config.maxConcurrent;
}

// 任务 CRUD
app.get('/api/tasks', (_req, res) => res.json({ tasks: listTasks().map(publicTask) }));
app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  if (!String(body.title || '').trim() || !String(body.description || '').trim()) return res.status(400).json({ error: '标题和内容描述不能为空' });
  res.json({ task: publicTask(createTask(body)) });
});
app.put('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === 'running') return res.status(409).json({ error: '执行中不能编辑' });
  if (task.status === 'archived') return res.status(409).json({ error: '已废弃任务不能编辑' });
  const patch = {};
  for (const key of ['title', 'description', 'color', 'deadline']) if (key in (req.body || {})) patch[key] = req.body[key];
  if ('title' in patch && !String(patch.title).trim()) return res.status(400).json({ error: '标题不能为空' });
  if ('description' in patch && !String(patch.description).trim()) return res.status(400).json({ error: '内容描述不能为空' });
  res.json({ task: publicTask(updateTask(task.id, patch)) });
});
app.delete('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  stopWebPi(task.id);
  for (const child of taskSessions(task)) killPi(child.sessionFile);
  activeSessionIds.delete(task.id);
  const archivedAt = nowIso();
  const purgeAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  res.json({ task: publicTask(updateTask(task.id, { status: 'archived', archivedAt, purgeAt })) });
});
app.post('/api/tasks/:id/restore', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'archived') return res.status(409).json({ error: '只有已废弃任务可以恢复' });
  res.json({ task: publicTask(updateTask(task.id, { status: 'todo', archivedAt: null, purgeAt: null })) });
});
app.delete('/api/tasks/:id/permanent', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  stopWebPi(task.id);
  removeTaskFiles(task);
  activeSessionIds.delete(task.id);
  deleteTask(task.id);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/complete', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!['todo', 'review'].includes(task.status)) return res.status(409).json({ error: '当前状态不能标记完成' });
  stopWebPi(task.id);
  killPi(resolveTaskSession(task)?.sessionFile || task.sessionFile);
  res.json({ task: publicTask(updateTask(task.id, { status: 'done', completedAt: nowIso() })) });
});
app.post('/api/tasks/:id/reopen', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'done') return res.status(409).json({ error: '只有已完成任务可以重开' });
  res.json({ task: publicTask(updateTask(task.id, { status: 'review', completedAt: null, lastRun: { status: 'reopened', reason: '任务已重新打开', at: nowIso() } })) });
});

// 执行与回复
app.get('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ sessions: taskSessions(task), activeSessionId: activeSessionIds.get(task.id) || taskSessions(task)[0]?.id || null });
});
app.post('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = { id: randomUUID(), title: String(req.body?.title || '新会话').trim().slice(0, 80) || '新会话', sessionFile: path.join(SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`), createdAt: nowIso(), updatedAt: nowIso() };
  const sessions = taskSessions(task);
  sessions.push(session);
  updateTask(task.id, { sessions });
  res.json({ session, task: publicTask(getTask(task.id)) });
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
  res.json({ session, task: publicTask(getTask(task.id)) });
});
app.delete('/api/tasks/:id/sessions/:sessionId', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = taskSessions(task);
  if (sessions.length <= 1) return res.status(409).json({ error: '至少保留一个子会话' });
  const index = sessions.findIndex((item) => item.id === req.params.sessionId);
  if (index < 0) return res.status(404).json({ error: '子会话不存在' });
  const activeState = getWebState(task.id);
  if (activeState?.childSessionId === req.params.sessionId && activeState.isStreaming) return res.status(409).json({ error: '子会话执行中，不能删除' });
  const [removed] = sessions.splice(index, 1);
  if (activeState?.childSessionId === removed.id) stopWebPi(task.id);
  try { if (existsSync(removed.sessionFile)) unlinkSync(removed.sessionFile); } catch { /* ignore */ }
  const patch = { sessions };
  if (task.sessionFile === removed.sessionFile) patch.sessionFile = sessions[0].sessionFile;
  if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, sessions[0].id);
  updateTask(task.id, patch);
  res.json({ ok: true, task: publicTask(getTask(task.id)) });
});

app.post('/api/tasks/:id/execute', async (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status === 'running') return res.status(409).json({ error: '任务正在执行中' });
    if (task.status === 'done') return res.status(409).json({ error: '请先重开已完成任务' });
    if (task.status === 'archived') return res.status(409).json({ error: '已废弃任务请先恢复' });
    if (concurrencyFull()) return res.status(409).json({ error: `已达到并发上限：${config.maxConcurrent}` });
    const body = req.body || {};
    const patch = { thinkingLevel: body.thinkingLevel || null, readOnly: body.readOnly !== undefined ? Boolean(body.readOnly) : task.readOnly };
    if (body.description !== undefined) {
      patch.description = String(body.description || '').trim();
      if (!patch.description) return res.status(400).json({ error: '内容描述不能为空' });
    }
    if (body.workingDir !== undefined) {
      patch.workingDir = resolveWorkingDir(body.workingDir);
      if (!patch.workingDir) return res.status(400).json({ error: '工作目录路径不能为空或不合法' });
    }
    if (!task.workingDir && !patch.workingDir) return res.status(400).json({ error: '请选择工作目录' });
    if (body.model !== undefined) {
      if (!body.model) { patch.model = null; patch.modelProvider = null; }
      else {
        const selected = modelsCache.models.find((m) => m.label === body.model);
        if (!selected) return res.status(400).json({ error: '模型不存在或模型列表尚未刷新' });
        patch.model = selected.id; patch.modelProvider = selected.provider;
      }
    }
    updateTask(task.id, patch);
    const updated = getTask(task.id);
    await startRun(updated, updated.description, body.sessionId || activeSessionIds.get(task.id));
    res.json({ task: publicTask(getTask(task.id)) });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});
app.post('/api/tasks/:id/reply', async (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status !== 'review') return res.status(409).json({ error: '只有待确认状态可以回复' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: '回复内容不能为空' });
    if (concurrencyFull(1)) return res.status(409).json({ error: `已达到并发上限：${config.maxConcurrent}` });
    await startRun(task, message, req.body?.sessionId || activeSessionIds.get(task.id));
    res.json({ task: publicTask(getTask(task.id)) });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});
async function executeWebCommand(task, input) {
  if (!isWebPiRunning(task.id)) throw new Error('当前任务没有活动的 Web SDK 会话，请先执行一次任务');
  const match = String(input || '').trim().match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) throw new Error('请输入以 / 开头的 pi 指令');
  const name = match[1].toLowerCase();
  const argument = (match[2] || '').trim();
  if (name === 'model') {
    if (!argument || argument === 'next') await sendWebCommand(task.id, argument === 'next' ? { type: 'cycle_model' } : { type: 'get_available_models' });
    else {
      const selected = modelsCache.models.find((m) => m.label === argument || `${m.provider}/${m.id}` === argument || m.id === argument);
      if (!selected) throw new Error(`找不到模型：${argument}`);
      await sendWebCommand(task.id, { type: 'set_model', provider: selected.provider, modelId: selected.id });
    }
  } else if (name === 'thinking' || name === 'thinking-level') {
    if (!argument) await sendWebCommand(task.id, { type: 'get_thinking_levels' });
    else {
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(argument)) throw new Error('thinking level 不合法');
      await sendWebCommand(task.id, { type: 'set_thinking_level', level: argument });
    }
  } else if (name === 'compact') await sendWebCommand(task.id, { type: 'compact', ...(argument ? { customInstructions: argument } : {}) });
  else if (name === 'abort') await sendWebCommand(task.id, { type: 'abort' });
  else if (name === 'session' || name === 'models') await sendWebCommand(task.id, { type: name === 'session' ? 'get_state' : 'get_available_models' });
  else throw new Error(`暂不支持 /${name}，支持：/model、/thinking、/compact、/abort、/session、/models`);
}

app.post('/api/tasks/:id/command', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  try { await executeWebCommand(task, req.body?.command); res.json({ ok: true, state: getWebState(task.id) }); }
  catch (error) { res.status(409).json({ error: error.message }); }
});
app.post('/api/tasks/:id/terminate', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'running') return res.status(409).json({ error: '任务不在执行中' });
  const stopped = stopWebPi(task.id);
  const killed = killPi(resolveTaskSession(task)?.sessionFile || task.sessionFile);
  res.json({ task: publicTask(updateTask(task.id, { status: 'review', lastRun: { status: 'terminated', reason: '已手动终止执行', at: nowIso(), stopped, killed } })) });
});

// session 日志
app.get('/api/tasks/:id/session', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const childSession = resolveTaskSession(task, req.query.sessionId);
  const parsed = parseSessionFile(childSession?.sessionFile || task.sessionFile);
  const items = [];
  for (const entry of parsed.entries) {
    if (entry.type === 'model_change' && entry.provider) {
      items.push({ kind: 'note', text: `切换模型：${entry.provider}/${entry.modelId || ''}`, ts: entry.timestamp });
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'user') items.push({ kind: 'user', text: extractText(message.content), ts: message.timestamp });
    else if (message.role === 'assistant') items.push({
      kind: 'assistant', text: extractText(message.content),
      toolCalls: Array.isArray(message.content) ? message.content.filter((b) => b.type === 'toolCall').map((b) => ({ name: b.name, args: b.arguments })) : [],
      stopReason: message.stopReason || null, errorMessage: message.errorMessage || null,
      model: message.provider ? `${message.provider}/${message.model || ''}` : '', usage: message.usage || null, ts: message.timestamp,
    });
    else if (message.role === 'toolResult') items.push({ kind: 'toolResult', toolName: message.toolName || '', isError: Boolean(message.isError), text: extractText(message.content).slice(0, 6000), ts: entry.timestamp });
  }
  res.json({ exists: parsed.exists, items, stats: parsed.stats, header: parsed.header ? { id: parsed.header.id, cwd: parsed.header.cwd, createdAt: parsed.header.timestamp } : null });
});

// Web 会话实时事件流（pi --mode json stdout）
app.get('/api/tasks/:id/events', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ running: isWebPiRunning(task.id), events: getWebEvents(task.id) });
});
app.get('/api/tasks/:id/events/stream', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of getWebEvents(task.id)) send(event);
  const unsubscribe = subscribeWebPi(task.id, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

// WebSocket 会话窗口：协议采用参考 pi-web-ui 的 snapshot + event 模式。
const webSockets = new WebSocketServer({ noServer: true });
webSockets.on('connection', (ws) => {
  let taskId = null;
  let unsubscribe = null;
  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  };
  const bind = async (id, sessionId) => {
    const task = getTask(id);
    if (!task) return send({ type: 'error', error: '任务不存在' });
    if (!task.workingDir) return send({ type: 'snapshot', state: null, taskId: id, childSessionId: sessionId || 'main' });
    const childSession = resolveTaskSession(task, sessionId);
    if (!childSession) return send({ type: 'error', error: '子会话不存在' });
    taskId = id;
    activeSessionIds.set(id, childSession.id);
    const currentState = getWebState(id);
    if (!currentState || currentState.childSessionId !== childSession.id) {
      try { await openTaskSession(task, childSession); }
      catch (error) { return send({ type: 'error', error: `打开 SDK 会话失败：${error.message}` }); }
    }
    unsubscribe?.();
    unsubscribe = subscribeWebPi(id, (event) => {
      // Initial history is not replayed here; the full current state is sent
      // once, then every SDK event is followed by a fresh snapshot.
      if (event.type !== 'snapshot') send(event);
      if (event.type === 'snapshot') send(event);
    });
    send({ type: 'snapshot', state: getWebState(id), taskId: id, childSessionId: childSession.id });
  };
  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello' || message.type === 'select_task') {
        await bind(message.taskId, message.sessionId);
        return;
      }
      if (!taskId) return send({ type: 'error', error: '请先选择任务会话' });
      const task = getTask(taskId);
      if (!task) return send({ type: 'error', error: '任务不存在' });
      if (message.type === 'prompt') {
        const text = String(message.text || '').trim();
        if (!text) return;
        if (text.startsWith('/')) await executeWebCommand(task, text);
        else if (task.status !== 'running' && task.status !== 'review') throw new Error('当前任务状态不能继续对话');
        else {
          if (task.status !== 'running' && concurrencyFull(1)) throw new Error(`已达到并发上限：${config.maxConcurrent}`);
          nameSessionFromPrompt(task, activeSessionIds.get(task.id), text);
          updateTask(task.id, { status: 'running', lastRun: { status: 'running', reason: null, at: nowIso() } });
          void sendWebPrompt(task.id, text, message.queue ? 'followUp' : 'steer').catch((error) => send({ type: 'error', error: error.message }));
        }
        send({ type: 'snapshot', state: getWebState(taskId), taskId });
      } else if (message.type === 'command') {
        await executeWebCommand(task, message.command);
        send({ type: 'snapshot', state: getWebState(taskId), taskId });
      } else if (message.type === 'select_model') {
        await sendWebCommand(taskId, { type: 'set_model', provider: message.provider, modelId: message.modelId });
        send({ type: 'snapshot', state: getWebState(taskId), taskId });
      } else if (message.type === 'abort') {
        await sendWebCommand(taskId, { type: 'abort' });
      }
    } catch (error) {
      send({ type: 'error', error: error.message || String(error) });
    }
  });
  ws.on('close', () => unsubscribe?.());
});

// 元数据
app.post('/api/select-directory', (_req, res) => {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "选择工作目录")'];
  } else if (platform === 'linux') {
    command = 'zenity';
    args = ['--file-selection', '--directory', '--title=选择工作目录'];
  } else {
    return res.status(501).json({ error: '当前系统暂不支持原生目录选择，请直接输入路径' });
  }
  execFile(command, args, { timeout: 120000, encoding: 'utf8' }, (error, stdout) => {
    if (error) {
      // Native pickers use a non-zero exit code when the user presses Cancel.
      if (platform === 'darwin' && error.code === 1) return res.json({ cancelled: true });
      if (platform === 'linux' && error.code === 1) return res.json({ cancelled: true });
      return res.status(500).json({ error: `打开目录选择器失败：${error.message}` });
    }
    const selected = String(stdout || '').trim();
    if (!selected) return res.json({ cancelled: true });
    res.json({ path: selected });
  });
});
app.get('/api/dirs', (_req, res) => {
  let dirs = [];
  try { dirs = readdirSync(PROJECTS_ROOT).filter((name) => { try { return statSync(path.join(PROJECTS_ROOT, name)).isDirectory(); } catch { return false; } }).sort(); } catch { /* ignore */ }
  res.json({ root: PROJECTS_ROOT, dirs });
});
app.get('/api/models', (_req, res) => res.json(modelsCache));
app.post('/api/models/refresh', async (_req, res) => res.json(await refreshModels()));
app.get('/api/config', (_req, res) => res.json({ ...config, projectsRoot: PROJECTS_ROOT, sessionsDir: SESSIONS_DIR, piBin: resolvePiBin() }));
app.post('/api/config', (req, res) => {
  for (const key of ['maxConcurrent', 'terminalApp', 'approvePi']) if (key in (req.body || {})) config[key] = req.body[key];
  saveConfig();
  res.json(config);
});

// Terminal 脚本退出回调：等待 session 最后一行写完后再判断，避免正常完成被误判为中断
app.post('/api/internal/turn-ended', (req, res) => {
  if ((req.headers.authorization || '') !== `Bearer ${authToken}`) return res.status(401).json({ error: 'unauthorized' });
  const taskId = req.body?.taskId;
  const exitCode = req.body?.exitCode;
  setTimeout(() => {
    const task = getTask(taskId);
    if (!task || task.status !== 'running') return;
    const verdict = evaluateRunningTask(task, { findPiPids });
    if (verdict) {
      updateTask(task.id, { status: verdict.state, lastRun: verdict.lastRun });
    } else if (exitCode !== 0) {
      updateTask(task.id, { status: 'review', lastRun: { status: 'failed', reason: `pi 异常退出（exit code ${exitCode}）`, at: nowIso() } });
    }
    // exitCode 为 0 但 session 尚未出现完整消息时，不立即判定中断；后台轮询会继续等待。
  }, 1200);
  res.json({ ok: true });
});

// 自动清理已废弃超过 15 天的任务
setInterval(purgeArchivedTasks, 60 * 60 * 1000);

// 轮询 session 状态
setInterval(() => {
  for (const task of listTasks()) {
    if (task.status !== 'running') continue;
    if (isWebPiRunning(task.id)) continue;
    const verdict = evaluateRunningTask(task, { findPiPids });
    if (verdict) updateTask(task.id, { status: verdict.state, lastRun: verdict.lastRun });
  }
}, 2000);

loadTasks();
purgeArchivedTasks();
refreshModels().catch(() => {});
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[workbench] http://127.0.0.1:${config.port}`);
  console.log(`[workbench] pi: ${resolvePiBin()}`);
  console.log(`[workbench] projects: ${PROJECTS_ROOT}`);
});
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
