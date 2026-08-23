export const STATUS = {
  todo: { label: '待办', cls: 'todo' },
  running: { label: '处理中', cls: 'running' },
  done: { label: '已完成', cls: 'done' },
  archived: { label: '已废弃', cls: 'archived' },
};

export const COLORS = {
  red: { label: '#DF7468', value: '#df7468' },
  orange: { label: '#E59654', value: '#e59654' },
  yellow: { label: '#D3B13E', value: '#d3b13e' },
  green: { label: '#6EAA7B', value: '#6eaa7b' },
  cyan: { label: '#4DA9A4', value: '#4da9a4' },
  blue: { label: '#7098C0', value: '#7098c0' },
  purple: { label: '#A184B6', value: '#a184b6' },
  gray: { label: '#96A5A7', value: '#96a5a7' },
};

const CUSTOM_COLORS_STORAGE_KEY = 'workbench-custom-colors';
const LAYOUT_STORAGE_KEY = 'workbench-layout';
const MAX_COLOR_COUNT = 17;
const LEGACY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' };

export const state = {
  tasks: [], status: '', boardGroup: 'single', boardCardLayout: 'single', sort: 'updated', search: '', signature: '',
  module: 'tasks', sidebarCollapsed: false, sessionTask: null, sessionSessionId: 'main', sessionDescriptionOpen: false,
  collapsedSessionTasks: new Set(), hiddenCompletedSessionTasks: new Set(),
};

export let customColors = loadCustomColors();

function loadCustomColors() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, value]) => /^custom-[a-z0-9-]+$/.test(key) && value && /^#[0-9a-f]{6}$/i.test(value.value))
      .map(([key, value]) => [key, { label: value.value.toUpperCase(), value: value.value.toLowerCase(), createdAt: Number(value.createdAt) || 0 }]));
  } catch { return {}; }
}

export function colorCatalog() { return { ...COLORS, ...customColors }; }

export function saveCustomColors() {
  try { localStorage.setItem(CUSTOM_COLORS_STORAGE_KEY, JSON.stringify(customColors)); } catch { /* ignore unavailable browser storage */ }
}

export function trimCustomColors(maxColorCount = MAX_COLOR_COUNT) {
  const maxCustomColors = Math.max(0, maxColorCount - Object.keys(COLORS).length);
  const removed = [];
  while (Object.keys(customColors).length > maxCustomColors) {
    const key = Object.keys(customColors).sort((a, b) => (customColors[a].createdAt || 0) - (customColors[b].createdAt || 0))[0];
    if (!key) break;
    removed.push(key);
    delete customColors[key];
  }
  if (removed.length) saveCustomColors();
  return removed;
}

export function taskColor(task) {
  return colorCatalog()[task.color] ? task.color : (LEGACY_COLOR[task.priority] || 'blue');
}

export function loadLayoutState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}') || {}; } catch { /* ignore malformed browser data */ }
  if (saved.module === 'tasks' || saved.module === 'session') state.module = saved.module;
  if (['', ...Object.keys(STATUS)].includes(saved.status)) state.status = saved.status;
  if (['single', 'status', 'path', 'color'].includes(saved.boardGroup)) state.boardGroup = saved.boardGroup;
  if (['single', 'compact'].includes(saved.boardCardLayout)) state.boardCardLayout = saved.boardCardLayout;
  if (['updated', 'created', 'deadline'].includes(saved.sort)) state.sort = saved.sort;
  if (typeof saved.search === 'string') state.search = saved.search;
  if (typeof saved.sidebarCollapsed === 'boolean') state.sidebarCollapsed = saved.sidebarCollapsed;
  else state.sidebarCollapsed = localStorage.getItem('workbench-sidebar-collapsed') === 'true';
  if (typeof saved.sessionTask === 'string' && saved.sessionTask) state.sessionTask = saved.sessionTask;
  if (typeof saved.sessionSessionId === 'string' && saved.sessionSessionId) state.sessionSessionId = saved.sessionSessionId;
  if (typeof saved.sessionDescriptionOpen === 'boolean') state.sessionDescriptionOpen = saved.sessionDescriptionOpen;
  if (Array.isArray(saved.collapsedSessionTasks)) state.collapsedSessionTasks = new Set(saved.collapsedSessionTasks.filter((id) => typeof id === 'string'));
  if (Array.isArray(saved.hiddenCompletedSessionTasks)) state.hiddenCompletedSessionTasks = new Set(saved.hiddenCompletedSessionTasks.filter((id) => typeof id === 'string'));
}

export function saveLayoutState() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      module: state.module, status: state.status, boardGroup: state.boardGroup, boardCardLayout: state.boardCardLayout,
      sort: state.sort, search: state.search, sidebarCollapsed: state.sidebarCollapsed, sessionTask: state.sessionTask,
      sessionSessionId: state.sessionSessionId, sessionDescriptionOpen: state.sessionDescriptionOpen,
      collapsedSessionTasks: [...state.collapsedSessionTasks], hiddenCompletedSessionTasks: [...state.hiddenCompletedSessionTasks],
    }));
  } catch { /* ignore unavailable browser storage */ }
}
