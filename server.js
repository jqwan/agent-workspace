import express from 'express';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  ROOT, DATA_DIR, SESSIONS_DIR, CONFIG_FILE,
  loadTasks, saveTasks, listTasks, getTask, createTask, updateTask, deleteTask, listNotes, getNote, createNote, updateNote, deleteNote, reorderNotes, subscribeTasks,
} from './lib/store.js';
import { parseSessionFile, extractText } from './lib/session.js';
import { unreadAssistantMessages, messageTime, sessionUnreadCount, nextReadState } from './lib/unread.js';
import { killPi } from './lib/executor.js';
import {
  startWebTui, stopWebTui, stopWebTuiAndWait, stopWebTuiForRestart, stopAllWebTuis, writeWebTui, resizeWebTui,
  isWebTuiRunning, subscribeWebTui, claimWebTuiInput, releaseWebTuiInput, sendWebTuiPrompt,
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
const taskEventClients = new Set();
const taskEventTimers = new Map();
const sessionEventTimers = new Map();
function broadcastTaskEvent(event = {}) {
  const payload = `data: ${JSON.stringify({ type: 'tasks_changed', ...event })}\n\n`;
  for (const client of taskEventClients) {
    try { client.write(payload); } catch { taskEventClients.delete(client); }
  }
}
function notifyTaskChanged(taskId, reason = 'task') {
  const key = taskId || '*';
  if (taskEventTimers.has(key)) return;
  const timer = setTimeout(() => {
    taskEventTimers.delete(key);
    broadcastTaskEvent({ taskId: taskId || null, reason });
  }, 200);
  taskEventTimers.set(key, timer);
  timer.unref?.();
}
// pi 会连续输出多个终端帧；等 JSONL 写入稳定后再通知一次即可。
function notifySessionChanged(taskId) {
  if (!taskId) return;
  clearTimeout(sessionEventTimers.get(taskId));
  const timer = setTimeout(() => {
    sessionEventTimers.delete(taskId);
    broadcastTaskEvent({ taskId, reason: 'session' });
  }, 300);
  sessionEventTimers.set(taskId, timer);
  timer.unref?.();
}
subscribeTasks(({ taskId }) => notifyTaskChanged(taskId));
app.use(express.json({ limit: '2mb' }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib')));
app.use('/vendor/xterm-search', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-search', 'lib')));
app.use(express.static(path.join(ROOT, 'public')));

app.post('/api/client-log', (req, res) => {
  const message = String(req.body?.message || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: '日志内容不能为空' });
  const isError = req.body?.type === 'error';
  const output = `[workbench${isError ? ' error' : ''}] ${message}`;
  if (isError) console.error(output);
  else console.log(output);
  res.json({ ok: true });
});

function nowIso() { return new Date().toISOString(); }
function taskSessions(task) {
  if (!Array.isArray(task.sessions)) {
    task.sessions = task.sessionFile ? [{ id: randomUUID(), title: '新会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
  }
  return task.sessions;
}
function activeTaskSessions(task) {
  return taskSessions(task).filter((session) => session.status !== 'archived');
}
function resolveTaskSession(task, sessionId) {
  if (sessionId) return taskSessions(task).find((session) => session.id === sessionId) || null;
  const sessions = activeTaskSessions(task);
  const activeSessionId = activeSessionIds.get(task.id);
  return sessions.find((session) => session.id === activeSessionId) || sessions[0] || null;
}
function sessionTitleFromPrompt(text) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  if (!title) return '新会话';
  return title.length > 28 ? `${title.slice(0, 28)}…` : title;
}
function assistantMessages(child) {
  return unreadAssistantMessages(parseSessionFile(child.sessionFile).entries);
}
function markSessionRead(task, child, readThroughMessageId) {
  if (!task || !child) return false;
  const next = nextReadState(child, assistantMessages(child), readThroughMessageId);
  if (!next) return false;
  Object.assign(child, next);
  saveTasks();
  return true;
}
function initializeSessionReadState() {
  let changed = false;
  for (const task of listTasks()) for (const child of taskSessions(task)) {
    if (Object.prototype.hasOwnProperty.call(child, 'lastReadAt')) continue;
    const latest = assistantMessages(child).at(-1) || null;
    child.lastReadMessageId = latest?.id || null;
    child.lastReadAt = latest ? (messageTime(latest) || Date.now()) : Date.now();
    changed = true;
  }
  if (changed) saveTasks();
}
function publicSession(child) {
  let shown = child;
  const parsed = parseSessionFile(child.sessionFile);
  if (!child.title || child.title === '新会话') {
    for (const entry of parsed.entries) {
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const text = extractText(entry.message.content).trim();
      if (text) { shown = { ...child, title: sessionTitleFromPrompt(text) }; break; }
    }
  }
  const messages = unreadAssistantMessages(parsed.entries);
  const parsedStats = parsed.stats;
  const { lastReadMessageId, lastReadAt, ...safe } = shown;
  return {
    ...safe,
    status: child.status === 'archived' ? 'archived' : 'active',
    favorite: Boolean(child.favorite),
    restorableWithTask: Boolean(child.restorableWithTask),
    stats: parsedStats ? {
      messages: Number(parsedStats.messages) || 0,
      user: Number(parsedStats.user) || 0,
      assistant: Number(parsedStats.assistant) || 0,
      toolResults: Number(parsedStats.toolResults) || 0,
      input: Number(parsedStats.input) || 0,
      output: Number(parsedStats.output) || 0,
      cacheRead: Number(parsedStats.cacheRead) || 0,
      cacheWrite: Number(parsedStats.cacheWrite) || 0,
      errors: Number(parsedStats.errors) || 0,
    } : null,
    latestMessageId: messages.at(-1)?.id || null,
    unreadCount: sessionUnreadCount(child, messages),
  };
}
function persistSessionTitle(task, child) {
  if (!child || (child.title && child.title !== '新会话')) return;
  const shown = publicSession(child).title;
  if (!shown || shown === child.title) return;
  child.title = shown;
  child.updatedAt = nowIso();
  updateTask(task.id, { sessions: taskSessions(task) });
}
function publicTask(task) {
  const internalStatus = task.status;
  const displayStatus = ['unfinished', 'done', 'archived'].includes(internalStatus) ? internalStatus : 'unfinished';
  const sessions = taskSessions(task);
  const activeSessions = activeTaskSessions(task);
  const storedActiveSessionId = activeSessionIds.get(task.id);
  return {
    ...task,
    status: displayStatus,
    sessions: sessions.map((session) => ({ ...publicSession(session), running: isWebTuiRunning(task.id, session.id) })),
    activeSessionId: activeSessions.some((session) => session.id === storedActiveSessionId) ? storedActiveSessionId : activeSessions[0]?.id || null,
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
function resolveWorkingDirs(values) {
  const source = Array.isArray(values) ? values : [values];
  const raw = source.map((value) => String(value || '').trim()).filter(Boolean);
  if (!raw.length) return null;
  const resolved = raw.map(resolveWorkingDir);
  if (resolved.some((value) => !value)) return null;
  return [...new Set(resolved)];
}
function piSystemPrompt(task, workingDirs) {
  const context = workingDirs.map((workingDir) => {
    const contextFile = path.join(workingDir, 'AGENTS.md');
    let content;
    try {
      content = readFileSync(contextFile, 'utf8');
    } catch {
      content = '(未找到或无法读取该文件)';
    }
    return `${contextFile}:\n${content}`;
  }).join('\n\n');
  return [
    '## Task context',
    `task title: ${task.title || ''}`,
    `task description: ${task.description || ''}`,
    '',
    '## Project instructions',
    context || '(没有配置项目路径)',
  ].join('\n');
}
function concurrencyFull(extra = 0) {
  const runningTaskIds = new Set(listTasks().filter((task) => isWebTuiRunning(task.id)).map((task) => task.id));
  return config.maxConcurrent > 0 && runningTaskIds.size + extra > config.maxConcurrent;
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
function withTuiLock(taskId, action) {
  const previous = tuiOpenings.get(taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  tuiOpenings.set(taskId, current);
  return current.finally(() => {
    if (tuiOpenings.get(taskId) === current) tuiOpenings.delete(taskId);
  });
}
async function openTaskTui(task, childSession, cols, rows, theme, { activateSession = true } = {}) {
  if (!childSession) throw new Error('任务没有可用子会话');
  // 已有 session 以 JSONL header 中记录的 cwd 为准；任务目录只作为新 session 的默认值。
  const sessionCwd = parseSessionFile(childSession.sessionFile).header?.cwd;
  const workingDir = resolveWorkingDir(sessionCwd || task.workingDir);
  if (!workingDir) throw new Error('请先为任务设置工作目录');
  const workingDirs = (Array.isArray(task.workingDirs) ? task.workingDirs : [task.workingDir])
    .map(resolveWorkingDir).filter(Boolean);
  mkdirSync(workingDir, { recursive: true });
  if (activateSession) activeSessionIds.set(task.id, childSession.id);
  const record = await startWebTui({
    taskId: task.id, childSessionId: childSession.id, workingDir, workingDirs, sessionFile: childSession.sessionFile,
    appendSystemPrompt: piSystemPrompt(task, workingDirs.length ? workingDirs : [workingDir]),
    title: childSession.title || task.title, provider: task.modelProvider, model: task.model,
    thinkingLevel: task.thinkingLevel, readOnly: task.readOnly, approve: config.approvePi !== false,
    cols, rows, theme: theme === 'dark' ? 'dark' : 'light',
    onData: () => notifySessionChanged(task.id),
    onExit: () => {
      const current = getTask(task.id);
      if (!current) return;
      const currentSession = resolveTaskSession(current, childSession.id);
      persistSessionTitle(current, currentSession);
      notifySessionChanged(task.id);
    },
  });
  return record;
}

function publicNote(note) {
  return { ...note, overdue: Boolean(note.deadline && note.status !== 'archived' && new Date(note.deadline).getTime() < Date.now()) };
}
function notePatch(body = {}) {
  const patch = {};
  for (const key of ['title', 'description', 'color', 'deadline', 'pinnedToTopBar', 'pinnedToSessionBar']) if (key in body) patch[key] = body[key];
  if ('title' in patch) patch.title = String(patch.title || '').trim();
  if ('description' in patch) patch.description = String(patch.description || '').trim();
  if ('deadline' in patch) patch.deadline = patch.deadline || null;
  if ('pinnedToTopBar' in patch) patch.pinnedToTopBar = Boolean(patch.pinnedToTopBar);
  if ('pinnedToSessionBar' in patch) patch.pinnedToSessionBar = Boolean(patch.pinnedToSessionBar);
  return patch;
}

// 便签 CRUD
app.get('/api/notes', (_req, res) => res.json({ notes: listNotes().map(publicNote) }));
app.post('/api/notes', (req, res) => {
  const patch = notePatch(req.body || {});
  if (!patch.description) return res.status(400).json({ error: '便签描述不能为空' });
  res.json({ note: publicNote(createNote(patch)) });
});
app.post('/api/notes/reorder', (req, res) => {
  const placement = req.body?.placement;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string') : null;
  if (!['topbar', 'session'].includes(placement) || !ids) return res.status(400).json({ error: '无效的便签排序请求' });
  const notes = reorderNotes(placement, ids);
  res.json({ notes: notes.map(publicNote) });
});
app.put('/api/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: '便签不存在' });
  const patch = notePatch(req.body || {});
  if ('description' in patch && !patch.description) return res.status(400).json({ error: '便签描述不能为空' });
  res.json({ note: publicNote(updateNote(note.id, patch)) });
});
app.delete('/api/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: '便签不存在' });
  const archivedAt = nowIso();
  res.json({ note: publicNote(updateNote(note.id, { status: 'archived', archivedAt })) });
});
app.post('/api/notes/:id/restore', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: '便签不存在' });
  if (note.status !== 'archived') return res.status(409).json({ error: '只有废弃便签可以恢复' });
  res.json({ note: publicNote(updateNote(note.id, { status: 'active', archivedAt: null })) });
});
app.delete('/api/notes/:id/permanent', (req, res) => {
  if (!deleteNote(req.params.id)) return res.status(404).json({ error: '便签不存在' });
  res.json({ ok: true });
});

app.delete('/api/archived', async (req, res) => {
  const type = ['all', 'tasks', 'notes', 'sessions'].includes(req.body?.type) ? req.body.type : 'all';
  const archivedTasks = ['notes', 'sessions'].includes(type) ? [] : listTasks().filter((task) => task.status === 'archived');
  for (const task of archivedTasks) {
    await stopTaskTui(task.id, { silent: true });
    removeTaskFiles(task);
    activeSessionIds.delete(task.id);
    deleteTask(task.id);
  }
  const archivedNotes = ['tasks', 'sessions'].includes(type) ? [] : listNotes().filter((note) => note.status === 'archived');
  for (const note of archivedNotes) deleteNote(note.id);
  let archivedSessions = 0;
  if (type === 'all' || type === 'sessions') {
    for (const task of listTasks()) {
      const sessions = taskSessions(task);
      const removed = sessions.filter((session) => session.status === 'archived');
      if (!removed.length) continue;
      for (const session of removed) {
        await stopTaskTui(task.id, { silent: true, sessionId: session.id });
        try { if (existsSync(session.sessionFile)) unlinkSync(session.sessionFile); } catch { /* ignore */ }
      }
      const kept = sessions.filter((session) => session.status !== 'archived');
      const patch = { sessions: kept, sessionFile: kept.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || kept[0]?.sessionFile || null };
      if (!kept.some((session) => session.id === activeSessionIds.get(task.id))) activeSessionIds.set(task.id, kept[0]?.id);
      updateTask(task.id, patch);
      archivedSessions += removed.length;
    }
  }
  res.json({ removed: archivedTasks.length + archivedNotes.length + archivedSessions });
});

// 会话栏中的便签始终以当前会话为上下文，不保存任务或子会话关联。
app.post('/api/notes/:id/send', async (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: '便签不存在' });
  if (note.status === 'archived') return res.status(409).json({ error: '废弃便签不能发送' });
  const task = getTask(req.body?.taskId);
  if (!task) return res.status(400).json({ error: '请先打开一个会话' });
  if (task.status === 'archived') return res.status(409).json({ error: '废弃任务不能发送便签' });
  const mode = req.body?.mode === 'new' ? 'new' : 'current';
  let session;
  if (mode === 'new') {
    session = { id: randomUUID(), title: '新会话', sessionFile: path.join(SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`), createdAt: nowIso(), updatedAt: nowIso() };
    const sessions = taskSessions(task);
    sessions.push(session);
    const patch = { sessions };
    if (!task.sessionFile) patch.sessionFile = session.sessionFile;
    updateTask(task.id, patch);
  } else {
    session = taskSessions(task).find((item) => item.id === req.body?.sessionId);
    if (!session) return res.status(400).json({ error: '当前子会话不存在' });
  }
  const runningSession = isWebTuiRunning(task.id, session.id);
  if (!runningSession) {
    const runningTask = isWebTuiRunning(task.id);
    if (!runningTask && concurrencyFull(1)) return res.status(409).json({ error: `已达到并发上限：${config.maxConcurrent}` });
    await withTuiLock(task.id, () => openTaskTui(getTask(task.id), session, 120, 34, 'light', { activateSession: mode !== 'new' }));
  }
  sendWebTuiPrompt(task.id, session.id, note.description);
  res.json({ ok: true, mode, session: publicSession(session), task: publicTask(getTask(task.id)) });
});

// 任务 CRUD
app.get('/api/tasks', (_req, res) => res.json({ tasks: listTasks().map(publicTask) }));
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  taskEventClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* closed response */ }
  }, 25000);
  heartbeat.unref?.();
  req.on('close', () => {
    clearInterval(heartbeat);
    taskEventClients.delete(res);
  });
});
app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  if (!String(body.title || '').trim()) return res.status(400).json({ error: '标题不能为空' });
  const workingDirs = resolveWorkingDirs(Object.hasOwn(body, 'workingDirs') ? body.workingDirs : body.workingDir);
  if (!workingDirs) return res.status(400).json({ error: '请选择工作目录' });
  res.json({ task: publicTask(createTask({ ...body, workingDir: workingDirs[0], workingDirs })) });
});
app.put('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === 'archived') return res.status(409).json({ error: '废弃任务不能编辑' });
  const patch = {};
  for (const key of ['title', 'description', 'color', 'deadline']) if (key in (req.body || {})) patch[key] = req.body[key];
  if ('workingDirs' in (req.body || {}) || 'workingDir' in (req.body || {})) {
    const workingDirs = resolveWorkingDirs(Object.hasOwn(req.body || {}, 'workingDirs') ? req.body.workingDirs : req.body.workingDir);
    if (!workingDirs) return res.status(400).json({ error: '请选择工作目录' });
    patch.workingDir = workingDirs[0];
    patch.workingDirs = workingDirs;
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
  for (const child of taskSessions(task)) {
    if (child.status !== 'archived') {
      child.status = 'archived';
      child.archivedAt = nowIso();
      child.restorableWithTask = true;
      child.updatedAt = child.archivedAt;
    }
  }
  const archivedAt = nowIso();
  const validStatuses = ['unfinished', 'done'];
  const archivedFromStatus = validStatuses.includes(task.status) ? task.status : (validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'unfinished');
  res.json({ task: publicTask(updateTask(task.id, { status: 'archived', archivedFromStatus, archivedAt, sessions: taskSessions(task) })) });
});
app.post('/api/tasks/:id/restore', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'archived') return res.status(409).json({ error: '只有废弃任务可以恢复' });
  const validStatuses = ['unfinished', 'done'];
  const restoredStatus = validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'unfinished';
  for (const child of taskSessions(task)) {
    if (child.status === 'archived' && child.restorableWithTask) {
      child.status = 'active';
      child.archivedAt = null;
      child.restorableWithTask = false;
      child.updatedAt = nowIso();
    }
  }
  res.json({ task: publicTask(updateTask(task.id, { status: restoredStatus, archivedFromStatus: null, archivedAt: null, sessions: taskSessions(task) })) });
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
  if (task.status !== 'unfinished') return res.status(409).json({ error: '当前状态不能标记完成' });
  stopWebTui(task.id, { silent: true });
  const result = publicTask(updateTask(task.id, { status: 'done', completedAt: nowIso() }));
  res.json({ task: result });
  // 不阻塞完成接口；进程清理由后台任务完成。
  setImmediate(() => { killPi(resolveTaskSession(getTask(task.id))?.sessionFile || task.sessionFile); });
});
app.post('/api/tasks/:id/reopen', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'done') return res.status(409).json({ error: '只有已完成任务可以重开' });
  res.json({ task: publicTask(updateTask(task.id, { status: 'unfinished', completedAt: null })) });
});

// 子会话仅保存 pi JSONL 的入口信息；交互全部在原生 TUI 完成。
app.post('/api/tasks/:id/sessions/:sessionId/read', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '子会话不存在' });
  const readThroughMessageId = typeof req.body?.readThroughMessageId === 'string' ? req.body.readThroughMessageId : null;
  const changed = markSessionRead(task, session, readThroughMessageId);
  if (changed) notifySessionChanged(task.id);
  res.json({ ok: true, session: publicSession(session) });
});
app.get('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = activeTaskSessions(task);
  res.json({ sessions: sessions.map(publicSession), activeSessionId: activeSessionIds.get(task.id) || sessions[0]?.id || null });
});
app.post('/api/tasks/:id/sessions', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  // 回收站中的任务也允许从“打开会话”入口创建新的临时子会话；
  // 新会话不参与任务恢复，任务仍保持废弃状态。
  const session = { id: randomUUID(), title: String(req.body?.title || '新会话').trim().slice(0, 80) || '新会话', sessionFile: path.join(SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`), status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso() };
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
  if (session.status === 'archived') return res.status(409).json({ error: '废弃会话不能编辑' });
  if (Object.hasOwn(req.body || {}, 'favorite')) session.favorite = Boolean(req.body.favorite);
  if (Object.hasOwn(req.body || {}, 'title')) {
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: '会话名称不能为空' });
    session.title = title.slice(0, 80);
  }
  session.updatedAt = nowIso();
  updateTask(task.id, { sessions: taskSessions(task) });
  res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
});
app.delete('/api/tasks/:id/sessions/:sessionId', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = taskSessions(task);
  const removed = sessions.find((item) => item.id === req.params.sessionId);
  if (!removed) return res.status(404).json({ error: '子会话不存在' });
  if (removed.status === 'archived') return res.status(409).json({ error: '会话已在回收站中' });
  if (isWebTuiRunning(task.id, removed.id)) await stopTaskTui(task.id, { silent: true, sessionId: removed.id });
  const emptySession = (parseSessionFile(removed.sessionFile).stats?.messages || 0) === 0;
  if (emptySession) {
    sessions.splice(sessions.indexOf(removed), 1);
    try { if (existsSync(removed.sessionFile)) unlinkSync(removed.sessionFile); } catch { /* ignore */ }
    const active = activeTaskSessions(task);
    if (!active.length) activeSessionIds.delete(task.id);
    else if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, active[0].id);
    updateTask(task.id, { sessions, sessionFile: active.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null });
    return res.json({ ok: true, permanentlyDeleted: true, task: publicTask(getTask(task.id)) });
  }
  removed.status = 'archived';
  removed.archivedAt = nowIso();
  removed.restorableWithTask = false;
  removed.updatedAt = nowIso();
  const active = activeTaskSessions(task);
  const patch = { sessions, sessionFile: active.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null };
  if (!active.length) activeSessionIds.delete(task.id);
  else if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, active[0].id);
  updateTask(task.id, patch);
  res.json({ ok: true, task: publicTask(getTask(task.id)) });
});
app.post('/api/tasks/:id/sessions/:sessionId/restore', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '子会话不存在' });
  if (session.status !== 'archived') return res.status(409).json({ error: '会话不在回收站中' });
  if (task.status === 'archived') return res.status(409).json({ error: '请先恢复所属任务' });
  session.status = 'active';
  session.archivedAt = null;
  session.restorableWithTask = false;
  session.updatedAt = nowIso();
  const sessions = taskSessions(task);
  updateTask(task.id, { sessions, sessionFile: task.sessionFile || session.sessionFile });
  res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
});
app.delete('/api/tasks/:id/sessions/:sessionId/permanent', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const sessions = taskSessions(task);
  const index = sessions.findIndex((item) => item.id === req.params.sessionId);
  if (index < 0) return res.status(404).json({ error: '子会话不存在' });
  const session = sessions[index];
  if (session.status !== 'archived') return res.status(409).json({ error: '只有回收站中的会话可以永久删除' });
  sessions.splice(index, 1);
  await stopTaskTui(task.id, { silent: true, sessionId: session.id });
  try { if (existsSync(session.sessionFile)) unlinkSync(session.sessionFile); } catch { /* ignore */ }
  const active = activeTaskSessions(task);
  if (!active.some((item) => item.id === activeSessionIds.get(task.id))) activeSessionIds.set(task.id, active[0]?.id);
  updateTask(task.id, { sessions, sessionFile: active.find((item) => item.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null });
  res.json({ ok: true, task: publicTask(getTask(task.id)) });
});
app.post('/api/tasks/:id/tui/restart', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const requestedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
  const stopped = await stopWebTuiForRestart(task.id, { sessionId: requestedSessionId || activeSessionIds.get(task.id) || null });
  res.json({ stopped });
});
app.post('/api/tasks/:id/sessions/:sessionId/stop', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: '子会话不存在' });
  const stopped = await stopWebTuiForRestart(task.id, { sessionId: session.id });
  if (stopped) notifyTaskChanged(task.id, 'session');
  res.json({ stopped, task: publicTask(getTask(task.id)) });
});
app.post('/api/tasks/:id/terminate', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!isWebTuiRunning(task.id)) return res.status(409).json({ error: '任务不在执行中' });
  const stopped = await stopTaskTui(task.id, { silent: true });
  const killed = killPi(resolveTaskSession(task)?.sessionFile || task.sessionFile);
  res.json({ task: publicTask(getTask(task.id)) });
});

const webSockets = new WebSocketServer({ noServer: true });
webSockets.on('connection', (ws) => {
  const clientId = randomUUID();
  let taskId = null;
  let sessionId = null;
  let unsubscribe = null;
  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  };
  const bindTui = async (id, requestedSessionId, cols, rows, theme) => {
    const task = getTask(id);
    if (!task) return send({ type: 'tui_error', error: '任务不存在' });
    const childSession = resolveTaskSession(task, requestedSessionId);
    if (!childSession) return send({ type: 'tui_error', error: '子会话不存在' });
    if (!isWebTuiRunning(task.id) && concurrencyFull(1)) return send({ type: 'tui_error', error: `已达到并发上限：${config.maxConcurrent}` });
    try {
      await withTuiLock(id, () => openTaskTui(getTask(id), childSession, cols, rows, theme));
      if (taskId && (taskId !== id || sessionId !== childSession.id)) releaseWebTuiInput(taskId, sessionId, clientId);
      taskId = id;
      sessionId = childSession.id;
      unsubscribe?.();
      unsubscribe = subscribeWebTui(id, sessionId, send);
      claimWebTuiInput(id, sessionId, clientId);
      resizeWebTui(id, sessionId, cols, rows);
      send({ type: 'tui_ready', taskId: id, childSessionId: childSession.id });
    } catch (error) {
      const detail = error?.message || String(error);
      console.error(`[workbench] 打开原生 TUI 失败（${id}/${sessionId || 'unknown'}）：${detail}`);
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
        if (!taskId || !sessionId || !isWebTuiRunning(taskId, sessionId)) return;
        if (message.type === 'tui_input') {
          return writeWebTui(taskId, sessionId, clientId, message.data);
        }
        return resizeWebTui(taskId, sessionId, message.cols, message.rows);
      }
    } catch (error) {
      const detail = error?.message || String(error);
      console.error(`[workbench] 原生 TUI WebSocket 错误：${detail}`);
      send({ type: 'tui_error', error: detail });
    }
  });
  ws.on('close', () => {
    unsubscribe?.();
    if (taskId && sessionId) releaseWebTuiInput(taskId, sessionId, clientId);
  });
});

function selectWindowsDirectory(res) {
  const script = [
    '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms', '[System.Windows.Forms.Application]::EnableVisualStyles()',
    // Use the window that was active when the request was made as the dialog owner.
    // Without an owner, Windows may put the modal dialog behind the browser.
    `Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public sealed class WorkbenchDialogOwner : IWin32Window {
  private readonly IntPtr handle;
  public WorkbenchDialogOwner(IntPtr handle) { this.handle = handle; }
  public IntPtr Handle { get { return handle; } }
}
public static class WorkbenchWindowApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@`,
    '$ownerHandle = [WorkbenchWindowApi]::GetForegroundWindow()',
    '$owner = if ($ownerHandle -ne [IntPtr]::Zero) { New-Object -TypeName WorkbenchDialogOwner -ArgumentList $ownerHandle } else { $null }',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog', '$dialog.Description = "选择工作目录"',
    '$dialog.ShowNewFolderButton = $true', '$result = if ($owner) { $dialog.ShowDialog($owner) } else { $dialog.ShowDialog() }',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
  ].join('\n');
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

loadTasks();
initializeSessionReadState();
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
  for (const client of taskEventClients) {
    try { client.end(); } catch { /* already closed */ }
  }
  taskEventClients.clear();
  await stopAllWebTuis();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
