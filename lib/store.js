import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(LIB_DIR, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(ROOT, 'sessions');
export const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let tasks = [];
const taskListeners = new Set();
const VALID_STATUSES = new Set(['unfinished', 'done', 'archived']);

function normalizeStatus(status) {
  if (status === 'todo' || status === 'running' || !VALID_STATUSES.has(status)) return 'unfinished';
  return status;
}

function normalizeArchivedFromStatus(status) {
  if (status === 'todo' || status === 'running') return 'unfinished';
  if (status === 'unfinished' || status === 'done') return status;
  return 'unfinished';
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, SCRIPTS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function normalizeTasks(input, now = new Date()) {
  const normalized = Array.isArray(input) ? input : [];
  let changed = false;
  for (const task of normalized) {
    if (!Array.isArray(task.sessions)) {
      task.sessions = task.sessionFile ? [{ id: randomUUID(), title: '新会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
      changed = true;
    }
    const normalizedStatus = normalizeStatus(task.status);
    if (task.status !== normalizedStatus) {
      task.status = normalizedStatus;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) {
      const normalizedArchivedFromStatus = task.archivedFromStatus == null ? null : normalizeArchivedFromStatus(task.archivedFromStatus);
      if (task.archivedFromStatus !== normalizedArchivedFromStatus) {
        task.archivedFromStatus = normalizedArchivedFromStatus;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(task, 'lastRun')) {
      delete task.lastRun;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) {
      task.archivedFromStatus = null;
      changed = true;
    }
  }
  return { tasks: normalized, changed };
}

export function loadTasks() {
  ensureDirs();
  if (existsSync(TASKS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      const result = normalizeTasks(Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw) ? raw : []);
      tasks = result.tasks;
      if (result.changed) saveTasks();
    } catch {
      tasks = [];
    }
  }
  return tasks;
}

export function saveTasks() {
  ensureDirs();
  const tmp = TASKS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
  renameSync(tmp, TASKS_FILE);
}

export function listTasks() {
  return tasks;
}

export function subscribeTasks(listener) {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

function emitTaskEvent(event) {
  for (const listener of taskListeners) {
    try { listener(event); } catch { /* observer failure must not break persistence */ }
  }
}

export function getTask(id) {
  return tasks.find((t) => t.id === id) || null;
}

export function createTask({ title, description, color, deadline, workingDir }) {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(),
    title: String(title).trim(),
    description: String(description || '').trim(),
    status: 'unfinished', // unfinished | done | archived
    color: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'].includes(color) || /^custom-[a-z0-9-]+$/.test(String(color || '')) ? color : 'blue',
    deadline: deadline || null,
    workingDir: workingDir || null,
    model: null,
    modelProvider: null,
    thinkingLevel: null,
    readOnly: false,
    // 新建任务不预建会话；首次执行创建会话时再把 sessionFile 锚定过去
    sessionFile: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedFromStatus: null,
    sessions: [],
  };
  tasks.push(t);
  saveTasks();
  emitTaskEvent({ type: 'created', taskId: t.id });
  return t;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  emitTaskEvent({ type: 'updated', taskId: t.id });
  return t;
}

export function deleteTask(id) {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [t] = tasks.splice(i, 1);
  saveTasks();
  emitTaskEvent({ type: 'deleted', taskId: t.id });
  return t;
}
