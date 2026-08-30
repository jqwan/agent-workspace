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
let notes = [];
const taskListeners = new Set();
const VALID_STATUSES = new Set(['unfinished', 'done', 'archived']);
const VALID_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']);

function validColor(color) {
  return VALID_COLORS.has(color) || /^custom-[a-z0-9-]+$/.test(String(color || ''));
}
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
  for (const dir of [DATA_DIR, SESSIONS_DIR, SCRIPTS_DIR]) mkdirSync(dir, { recursive: true });
}

export function normalizeTasks(input, now = new Date()) {
  const normalized = Array.isArray(input) ? input : [];
  let changed = false;
  for (const task of normalized) {
    if (!Array.isArray(task.sessions)) {
      task.sessions = task.sessionFile ? [{ id: randomUUID(), title: '新会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
      changed = true;
    }
    for (const session of task.sessions) {
      if (!session || typeof session !== 'object') continue;
      if (!session.id) { session.id = randomUUID(); changed = true; }
      if (!session.title) { session.title = '新会话'; changed = true; }
      if (!session.createdAt) { session.createdAt = task.createdAt || now.toISOString(); changed = true; }
      if (!session.updatedAt) { session.updatedAt = session.createdAt; changed = true; }
      const status = session.status === 'archived' ? 'archived' : 'active';
      const defaults = {
        status,
        archivedAt: status === 'archived' ? (session.archivedAt || now.toISOString()) : null,
        favorite: Boolean(session.favorite),
        restorableWithTask: Boolean(session.restorableWithTask),
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (session[key] !== value) { session[key] = value; changed = true; }
      }
    }
    const normalizedStatus = normalizeStatus(task.status);
    if (task.status !== normalizedStatus) { task.status = normalizedStatus; changed = true; }
    if (Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) {
      const normalizedArchivedFromStatus = task.archivedFromStatus == null ? null : normalizeArchivedFromStatus(task.archivedFromStatus);
      if (task.archivedFromStatus !== normalizedArchivedFromStatus) { task.archivedFromStatus = normalizedArchivedFromStatus; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(task, 'lastRun')) { delete task.lastRun; changed = true; }
    if (Object.hasOwn(task, 'purgeAt')) { delete task.purgeAt; changed = true; }
    if (!Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) { task.archivedFromStatus = null; changed = true; }
  }
  return { tasks: normalized, changed };
}

export function normalizeNotes(input) {
  const normalized = Array.isArray(input) ? input : [];
  let changed = false;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const note = normalized[index];
    if (!note || typeof note !== 'object' || !String(note.description || '').trim()) { normalized.splice(index, 1); changed = true; continue; }
    const description = String(note.description).trim();
    const title = String(note.title || '').trim();
    if (note.description !== description) { note.description = description; changed = true; }
    if (note.title !== title) { note.title = title; changed = true; }
    if (!validColor(note.color)) { note.color = 'yellow'; changed = true; }
    const isArchived = note.status === 'archived';
    const status = isArchived ? 'archived' : 'active';
    if (note.status !== status) { note.status = status; changed = true; }
    const existingArchivedAt = note.archivedAt && !Number.isNaN(new Date(note.archivedAt).getTime()) ? note.archivedAt : null;
    const archivedAt = isArchived ? (existingArchivedAt || new Date().toISOString()) : null;
    if (note.archivedAt !== archivedAt) { note.archivedAt = archivedAt; changed = true; }
    if (Object.hasOwn(note, 'purgeAt')) { delete note.purgeAt; changed = true; }
    for (const key of ['topbarOrder', 'sessionOrder']) {
      const value = Number(note[key]);
      if (!Number.isFinite(value) || value < 0) { note[key] = 0; changed = true; }
    }
    for (const key of ['pinnedToTopBar', 'pinnedToSessionBar']) {
      const value = Boolean(note[key]);
      if (note[key] !== value) { note[key] = value; changed = true; }
    }
    if (!note.id) { note.id = randomUUID(); changed = true; }
    if (!note.createdAt) { note.createdAt = new Date().toISOString(); changed = true; }
    if (!note.updatedAt) { note.updatedAt = note.createdAt; changed = true; }
    const deadline = note.deadline || null;
    if (note.deadline !== deadline) { note.deadline = deadline; changed = true; }
  }
  return { notes: normalized, changed };
}

export function loadTasks() {
  ensureDirs();
  if (existsSync(TASKS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      let taskInput = [];
      if (Array.isArray(raw.tasks)) taskInput = raw.tasks;
      else if (Array.isArray(raw)) taskInput = raw;
      const taskResult = normalizeTasks(taskInput);
      const noteResult = normalizeNotes(Array.isArray(raw.notes) ? raw.notes : []);
      tasks = taskResult.tasks;
      notes = noteResult.notes;
      if (taskResult.changed || noteResult.changed || !Array.isArray(raw.notes)) saveTasks();
    } catch { tasks = []; notes = []; }
  }
  return tasks;
}

export function saveTasks() {
  ensureDirs();
  const tmp = TASKS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ tasks, notes }, null, 2));
  renameSync(tmp, TASKS_FILE);
}
export function listTasks() { return tasks; }
export function listNotes() { return notes; }
export function subscribeTasks(listener) { taskListeners.add(listener); return () => taskListeners.delete(listener); }
function emitTaskEvent(event) { for (const listener of taskListeners) try { listener(event); } catch { /* observer failure must not break persistence */ } }
export function getTask(id) { return tasks.find((t) => t.id === id) || null; }
export function getNote(id) { return notes.find((note) => note.id === id) || null; }

export function createTask({ title, description, color, deadline, workingDir }) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), title: String(title).trim(), description: String(description || '').trim(),
    status: 'unfinished', color: validColor(color) ? color : 'blue', deadline: deadline || null,
    workingDir: workingDir || null, model: null, modelProvider: null, thinkingLevel: null,
    readOnly: false, sessionFile: null, createdAt: now, updatedAt: now, completedAt: null,
    archivedFromStatus: null, sessions: [],
  };
  tasks.push(task);
  saveTasks();
  emitTaskEvent({ type: 'created', taskId: task.id });
  return task;
}
export function createNote({ title, description, color, deadline, pinnedToTopBar, pinnedToSessionBar }) {
  const now = new Date().toISOString();
  const note = {
    id: randomUUID(), title: String(title || '').trim(), description: String(description).trim(),
    color: validColor(color) ? color : 'yellow', deadline: deadline || null, status: 'active',
    archivedAt: null, topbarOrder: 0, sessionOrder: 0,
    pinnedToTopBar: Boolean(pinnedToTopBar), pinnedToSessionBar: Boolean(pinnedToSessionBar), createdAt: now, updatedAt: now,
  };
  notes.push(note);
  saveTasks();
  emitTaskEvent({ type: 'note-created', noteId: note.id });
  return note;
}
export function updateTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  emitTaskEvent({ type: 'updated', taskId: task.id });
  return task;
}
export function reorderNotes(placement, ids) {
  const key = placement === 'session' ? 'sessionOrder' : placement === 'topbar' ? 'topbarOrder' : null;
  if (!key) return null;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const selected = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
  const remaining = notes.filter((note) => !selected.includes(note)).sort((a, b) => Number(a[key]) - Number(b[key]));
  // 调整提醒栏顺序不是便签内容更新，保留 updatedAt，避免触发看板卡片重绘。
  [...selected, ...remaining].forEach((note, index) => { note[key] = index + 1; });
  saveTasks();
  emitTaskEvent({ type: 'note-reordered', placement });
  return notes;
}
export function updateNote(id, patch) {
  const note = getNote(id);
  if (!note) return null;
  Object.assign(note, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  emitTaskEvent({ type: 'note-updated', noteId: note.id });
  return note;
}
export function deleteTask(id) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  const [task] = tasks.splice(index, 1);
  saveTasks();
  emitTaskEvent({ type: 'deleted', taskId: task.id });
  return task;
}
export function deleteNote(id) {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) return null;
  const [note] = notes.splice(index, 1);
  saveTasks();
  emitTaskEvent({ type: 'note-deleted', noteId: note.id });
  return note;
}
