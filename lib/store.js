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
const VALID_STATUSES = new Set(['todo', 'running', 'done', 'archived']);

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, SCRIPTS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function loadTasks() {
  ensureDirs();
  if (existsSync(TASKS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      tasks = Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
      // Backfill the conversation collection for tasks created before the
      // sidebar existed. A task currently starts with one persistent child
      // session; later child sessions can be added without changing the task.
      let changed = false;
      for (const task of tasks) {
        if (!Array.isArray(task.sessions)) {
          task.sessions = task.sessionFile ? [{ id: 'main', title: '主会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
          changed = true;
        }
        if (!VALID_STATUSES.has(task.status)) {
          const now = new Date();
          task.status = 'archived';
          task.archivedFromStatus = null;
          task.archivedAt ||= now.toISOString();
          task.purgeAt ||= new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
          changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) {
          task.archivedFromStatus = null;
          changed = true;
        }
      }
      if (changed) saveTasks();
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

export function getTask(id) {
  return tasks.find((t) => t.id === id) || null;
}

export function createTask({ title, description, color, deadline, workingDir }) {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(),
    title: String(title).trim(),
    description: String(description || '').trim(),
    status: 'todo', // todo | running | done | archived
    color: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'].includes(color) || /^custom-[a-z0-9-]+$/.test(String(color || '')) ? color : 'blue',
    deadline: deadline || null,
    workingDir: workingDir || null,
    model: null,
    modelProvider: null,
    thinkingLevel: null,
    readOnly: false,
    // 新建任务不预建会话；首次执行创建会话时再把 sessionFile 锚定过去
    sessionFile: null,
    lastRun: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedFromStatus: null,
    sessions: [],
  };
  tasks.push(t);
  saveTasks();
  return t;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  return t;
}

export function deleteTask(id) {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [t] = tasks.splice(i, 1);
  saveTasks();
  return t;
}
