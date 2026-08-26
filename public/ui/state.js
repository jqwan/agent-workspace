export const STATUS = {
  unfinished: { label: '未完成', cls: 'unfinished' },
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
const LEGACY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' };

const VIEW_SETTING_KEYS = ['', ...Object.keys(STATUS)];
const DEFAULT_VIEW_SETTINGS = { sort: 'updated', boardGroup: 'single', boardCardLayout: 'single' };
function normalizeViewStatus(value) {
  if (value === 'todo' || value === 'running' || value === 'unfinished') return 'unfinished';
  return value === 'done' || value === 'archived' ? value : '';
}

export const state = {
  tasks: [], status: '', boardGroup: 'single', boardCardLayout: 'single', sort: 'updated', search: '', signature: '',
  viewSettings: Object.fromEntries(VIEW_SETTING_KEYS.map((key) => [key, { ...DEFAULT_VIEW_SETTINGS }])),
  module: 'tasks', sidebarCollapsed: false, sessionTask: null, sessionSessionId: null,
  collapsedSessionTasks: new Set(), sessionTaskIds: new Set(), hiddenCompletedSessionTasks: new Set(),
};

export function applyViewSettings(status = state.status) {
  const settings = state.viewSettings[status] || DEFAULT_VIEW_SETTINGS;
  state.sort = settings.sort;
  state.boardGroup = settings.boardGroup;
  state.boardCardLayout = settings.boardCardLayout;
}

export function updateViewSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_VIEW_SETTINGS, key)) return;
  const current = state.viewSettings[state.status] || { ...DEFAULT_VIEW_SETTINGS };
  state.viewSettings[state.status] = { ...current, [key]: value };
  state[key] = value;
}

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

export function taskColor(task) {
  return colorCatalog()[task.color] ? task.color : (LEGACY_COLOR[task.priority] || 'blue');
}

export function loadLayoutState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}') || {}; } catch { /* ignore malformed browser data */ }
  if (saved.module === 'tasks' || saved.module === 'session') state.module = saved.module;
  const savedStatus = normalizeViewStatus(saved.status);
  if (VIEW_SETTING_KEYS.includes(savedStatus)) state.status = savedStatus;

  // 将旧版全局设置迁移到“全部任务”和当前分类，避免升级后当前视图突然改变。
  const legacy = {};
  if (['single', 'status', 'path', 'color'].includes(saved.boardGroup)) legacy.boardGroup = saved.boardGroup;
  if (['single', 'compact'].includes(saved.boardCardLayout)) legacy.boardCardLayout = saved.boardCardLayout;
  if (['updated', 'created', 'deadline'].includes(saved.sort)) legacy.sort = saved.sort;
  if (Object.keys(legacy).length) {
    state.viewSettings[''] = { ...state.viewSettings[''], ...legacy };
    if (state.status) state.viewSettings[state.status] = { ...state.viewSettings[state.status], ...legacy };
  }
  if (saved.viewSettings && typeof saved.viewSettings === 'object') {
    Object.entries(saved.viewSettings).forEach(([key, value]) => {
      const normalizedKey = normalizeViewStatus(key);
      if (!VIEW_SETTING_KEYS.includes(normalizedKey) || !value || typeof value !== 'object') return;
      const settings = { ...state.viewSettings[normalizedKey] };
      if (['updated', 'created', 'deadline'].includes(value.sort)) settings.sort = value.sort;
      if (['single', 'status', 'path', 'color'].includes(value.boardGroup)) settings.boardGroup = value.boardGroup;
      if (['single', 'compact'].includes(value.boardCardLayout)) settings.boardCardLayout = value.boardCardLayout;
      state.viewSettings[normalizedKey] = settings;
    });
  }
  applyViewSettings();
  if (typeof saved.search === 'string') state.search = saved.search;
  if (typeof saved.sidebarCollapsed === 'boolean') state.sidebarCollapsed = saved.sidebarCollapsed;
  else state.sidebarCollapsed = localStorage.getItem('workbench-sidebar-collapsed') === 'true';
  if (typeof saved.sessionTask === 'string' && saved.sessionTask) state.sessionTask = saved.sessionTask;
  if (typeof saved.sessionSessionId === 'string' && saved.sessionSessionId) state.sessionSessionId = saved.sessionSessionId;
  if (Array.isArray(saved.collapsedSessionTasks)) state.collapsedSessionTasks = new Set(saved.collapsedSessionTasks.filter((id) => typeof id === 'string'));
  if (Array.isArray(saved.sessionTaskIds)) state.sessionTaskIds = new Set(saved.sessionTaskIds.filter((id) => typeof id === 'string'));
  if (Array.isArray(saved.hiddenCompletedSessionTasks)) state.hiddenCompletedSessionTasks = new Set(saved.hiddenCompletedSessionTasks.filter((id) => typeof id === 'string'));
}

export function saveLayoutState() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      module: state.module, status: state.status, viewSettings: state.viewSettings,
      // 保留当前值，便于旧版本工作台继续读取布局状态。
      boardGroup: state.boardGroup, boardCardLayout: state.boardCardLayout, sort: state.sort,
      search: state.search, sidebarCollapsed: state.sidebarCollapsed, sessionTask: state.sessionTask,
      sessionSessionId: state.sessionSessionId,
      collapsedSessionTasks: [...state.collapsedSessionTasks], sessionTaskIds: [...state.sessionTaskIds], hiddenCompletedSessionTasks: [...state.hiddenCompletedSessionTasks],
    }));
  } catch { /* ignore unavailable browser storage */ }
}
