import { deadline, esc, number, time } from './ui/format.js';
import { api } from './ui/api.js';
import {
  COLORS, STATUS, colorCatalog, customColors, saveCustomColors, state, taskColor,
  applyViewSettings, loadLayoutState, saveLayoutState, updateViewSetting,
} from './ui/state.js';

const $ = (selector, root = document) => root.querySelector(selector);

function customColorStyle(key) {
  const color = customColors[key];
  return color ? ` style="--task-color:${esc(color.value)}"` : '';
}

loadLayoutState();
let layoutInitialized = false;
let tuiSocket = null;
let terminal = null;
let fitAddon = null;
let terminalResizeObserver = null;
let terminalImeCursorHandler = null;
let terminalCursorSubscription = null;
let terminalWriteParsedSubscription = null;
let terminalWriteTimer = null;
let terminalWriteBuffer = [];
let terminalImePositionFrame = null;
let terminalImeComposing = false;
let terminalImeInputStyle = null;
let tuiOpening = null;
let modalRestoreFocus = null;
let sessionTaskDetailsOpen = false;
let sessionTaskDetailsCloseTimer = null;
const seenSessionMessageIds = new Map();
const readRequests = new Map();

function hiddenWorkingDirs() {
  try { const parsed = JSON.parse(localStorage.getItem('workbench-hidden-working-dirs') || '[]'); if (Array.isArray(parsed)) return parsed; } catch { /* ignore malformed browser data */ }
  return [];
}
function recentWorkingDirs() {
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench-working-dirs') || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch { /* ignore malformed browser data */ }
  const hidden = new Set(hiddenWorkingDirs());
  return [...new Set([...saved, ...state.tasks.map((task) => task.workingDir)].filter((item) => item && !hidden.has(item)))].slice(0, 12);
}
function rememberWorkingDir(value) {
  const dir = String(value || '').trim();
  if (!dir) return;
  localStorage.setItem('workbench-hidden-working-dirs', JSON.stringify(hiddenWorkingDirs().filter((item) => item !== dir)));
  localStorage.setItem('workbench-working-dirs', JSON.stringify([dir, ...recentWorkingDirs().filter((item) => item !== dir)].slice(0, 12)));
}
function forgetWorkingDir(value) {
  const dir = String(value || '').trim();
  if (!dir) return;
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench-working-dirs') || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch { /* ignore malformed browser data */ }
  localStorage.setItem('workbench-working-dirs', JSON.stringify(saved.filter((item) => item !== dir)));
  localStorage.setItem('workbench-hidden-working-dirs', JSON.stringify([dir, ...hiddenWorkingDirs().filter((item) => item !== dir)].slice(0, 50)));
}
function syncThemeMenu() {
  const style = localStorage.getItem('workbench-style') || 'classic';
  document.querySelectorAll('[data-theme-style]').forEach((button) => {
    const active = button.dataset.themeStyle === style;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}
const THEME_STYLES = ['classic', 'geek-terminal', 'pixel-arcade', 'blueprint', 'aurora', 'newspaper', 'dopamine', 'music'];
const THEME_CLASS_NAMES = { classic: 'classic', 'geek-terminal': 'geek', 'pixel-arcade': 'pixel-arcade', blueprint: 'blueprint', aurora: 'aurora', newspaper: 'newspaper', dopamine: 'dopamine', music: 'music' };
const THEME_BODY_CLASSES = ['classic', 'geek', 'geek-terminal', 'pixel-arcade', 'blueprint', 'aurora', 'newspaper', 'dopamine', 'music'];
function applyThemeStyle(style) {
  const normalized = style === 'geek' ? 'geek-terminal' : style;
  const selected = THEME_STYLES.includes(normalized) ? normalized : 'classic';
  THEME_BODY_CLASSES.forEach((name) => document.body.classList.toggle(`theme-${name}`, THEME_CLASS_NAMES[selected] === name));
  localStorage.setItem('workbench-style', selected);
  syncThemeMenu();
}
function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const style = THEME_STYLES.includes(localStorage.getItem('workbench-style')) ? localStorage.getItem('workbench-style') : 'classic';
  const themeColors = {
    classic: { light: '#edf1f2', dark: '#0e191f' },
    'geek-terminal': { light: '#f4f7f5', dark: '#0f1412' },
    'pixel-arcade': { light: '#f7f1de', dark: '#101528' },
    blueprint: { light: '#e7f1f7', dark: '#0b1e2d' },
    aurora: { light: '#f1f2ff', dark: '#0e1020' },
    newspaper: { light: '#f4f4f0', dark: '#171716' },
    dopamine: { light: '#fff4fb', dark: '#17132a' },
    music: { light: '#eef3fb', dark: '#111a2d' },
  };
  const themeColor = themeColors[style][dark ? 'dark' : 'light'];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  localStorage.setItem('workbench-theme', theme);
  const modeToggle = $('#mode-toggle');
  if (modeToggle) {
    const modeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '亮色模式' : '暗色模式';
    const modeIcon = theme === 'system'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>'
      : theme === 'light'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 14.5A7 7 0 0 1 9.5 5 7.5 7.5 0 1 0 19 14.5Z"/></svg>';
    modeToggle.innerHTML = modeIcon;
    modeToggle.title = `显示模式：${modeLabel}，点击切换`;
    modeToggle.setAttribute('aria-label', `显示模式：${modeLabel}，点击切换`);
  }
  syncThemeMenu();
}
function isTerminalDark() {
  return document.body.classList.contains('theme-dark') || (!document.body.classList.contains('theme-light') && matchMedia('(prefers-color-scheme: dark)').matches);
}
function syncViewportHeight() {
  document.documentElement.style.setProperty('--app-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
applyThemeStyle(localStorage.getItem('workbench-style'));
applyTheme(['system', 'light', 'dark'].includes(localStorage.getItem('workbench-theme')) ? localStorage.getItem('workbench-theme') : 'system');
syncViewportHeight();
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle');
  button.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
}
const SORT_OPTIONS = [
  { value: 'updated', label: '最近更新', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>' },
  { value: 'created', label: '创建时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 4v3M16 4v3M4 9.5h16M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01"/></svg>' },
  { value: 'deadline', label: '截止时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v3M18 4v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11H4V7a2 2 0 0 1 2-2Z"/><path d="M12 12v3l2 1"/></svg>' },
];
const BOARD_GROUP_ICONS = {
  single: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  status: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h6"/></svg>',
  path: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  color: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="2"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/><circle cx="16" cy="16" r="2"/></svg>',
};
function syncSortControl() {
  const button = $('#sort-toggle');
  const option = SORT_OPTIONS.find((item) => item.value === state.sort) || SORT_OPTIONS[0];
  button.innerHTML = option.icon;
  button.title = `排序：${option.label}（点击切换）`;
  button.setAttribute('aria-label', button.title);
}
function syncCardLayoutControl() {
  const button = $('#board-card-layout');
  const compact = state.boardCardLayout === 'compact';
  button.innerHTML = compact
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="7" height="12" rx="1.5"/><rect x="13" y="6" width="7" height="12" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="16" rx="1.5"/></svg>';
  button.title = `切换布局（当前：${compact ? '紧凑' : '单列'}）`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(compact));
}
applySidebarCollapsed(state.sidebarCollapsed);
syncSortControl();
syncCardLayoutControl();
$('#search').value = state.search;
window.addEventListener('resize', () => { syncViewportHeight(); syncMasonryColumns(); syncOverflowTooltips(); });
window.addEventListener('pagehide', saveLayoutState);
window.visualViewport?.addEventListener('resize', syncViewportHeight);

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type === 'error' ? '!' : '✓';
  node.appendChild(icon);
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  node.appendChild(text);
  const dismiss = () => {
    if (node.classList.contains('out')) return;
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  };
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.onclick = dismiss;
  node.appendChild(close);
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(dismiss, 4500); };
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', schedule);
  node.addEventListener('focusin', () => clearTimeout(timer));
  node.addEventListener('focusout', (event) => { if (!node.contains(event.relatedTarget)) schedule(); });
  $('#toast-root').querySelectorAll('.toast').forEach((item) => item.remove());
  $('#toast-root').appendChild(node);
  schedule();
}
function currentTask(id) { return state.tasks.find((task) => task.id === id); }
function sessionMarkerKey(taskId, sessionId) { return `${taskId}\u0000${sessionId}`; }
function rememberCurrentSessionMessage() {
  if (state.module !== 'session' || document.visibilityState !== 'visible' || !state.sessionTask || !state.sessionSessionId) return;
  const session = currentTask(state.sessionTask)?.sessions?.find((item) => item.id === state.sessionSessionId);
  if (session?.latestMessageId) seenSessionMessageIds.set(sessionMarkerKey(state.sessionTask, state.sessionSessionId), session.latestMessageId);
}
function syncMasonryColumns(root = document) {
  const board = root.querySelector('.task-board');
  if (board && board.clientWidth > 0) {
    const count = board.querySelectorAll(':scope > .task-board-column').length || 1;
    const maxColumns = Math.max(1, Math.floor((board.clientWidth + 14) / 374));
    board.style.columnCount = String(Math.min(count, maxColumns));
  }
  root.querySelectorAll('.compact-card-layout .task-board-list').forEach((list) => {
    if (list.clientWidth <= 0) return;
    const count = list.querySelectorAll(':scope > .card').length || 1;
    const maxColumns = Math.max(1, Math.floor((list.clientWidth + 10) / 260));
    list.style.columnCount = String(Math.min(count, maxColumns));
  });
}
function nativeTooltip(value) {
  return String(value || '').split('\n').map((line) => {
    const chars = [...line];
    const lines = [];
    while (chars.length > 32) lines.push(chars.splice(0, 32).join(''));
    lines.push(chars.join(''));
    return lines.join('\n');
  }).join('\n');
}
function syncOverflowTooltips(root = document) {
  root.querySelectorAll('[data-tooltip]').forEach((node) => {
    const overflowing = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight + 1;
    node.title = overflowing ? nativeTooltip(node.dataset.tooltip) : '';
    node.classList.toggle('is-overflowing', overflowing);
  });
}
const overflowTooltipObserver = new MutationObserver(() => requestAnimationFrame(() => syncOverflowTooltips()));
overflowTooltipObserver.observe(document.body, { childList: true, subtree: true });
function renderStats() {
  const counts = { unfinished: 0, done: 0 };
  let overdue = 0;
  state.tasks.forEach((task) => { if (counts[task.status] !== undefined) counts[task.status]++; if (task.overdue) overdue++; });
  $('#stats').innerHTML = ['unfinished', 'done'].map((key) => `<span class="chip ${STATUS[key].cls}">${STATUS[key].label} ${number(counts[key])}</span>`).join('') + (overdue ? `<span class="chip overdue">逾期 ${number(overdue)}</span>` : '');
}
const GROUP_ICONS = { '': '▦', unfinished: '○', done: '✓', archived: '✕' };
const STATUS_ICONS = { unfinished: '○', done: '✓', archived: '✕' };
function renderTaskSidebar() {
  $('#task-groups').innerHTML = [{ key: '', label: '全部任务' }, ...Object.entries(STATUS).map(([key, value]) => ({ key, label: value.label }))].map(({ key, label }) => {
    const count = key ? state.tasks.filter((task) => task.status === key).length : state.tasks.filter((task) => task.status !== 'archived').length;
    return `<button type="button" class="task-group-item${state.status === key ? ' active' : ''}" data-task-filter="${key}" aria-label="${esc(label)}" aria-pressed="${state.status === key}"><span class="group-icon" aria-hidden="true">${GROUP_ICONS[key] || '•'}</span><span class="group-label">${esc(label)}</span><b>${number(count)}</b></button>`;
  }).join('');
}
function visibleTasks() {
  return state.tasks.filter((task) => (state.status ? task.status === state.status : task.status !== 'archived') && (!state.search || `${task.title} ${task.description}`.toLowerCase().includes(state.search.toLowerCase()))).sort((a, b) => {
    if (state.sort === 'deadline') return (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity) || new Date(b.updatedAt) - new Date(a.updatedAt);
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
const ACTION_ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM7 9l2 2-2 2M12 13h4"/></svg>',
  complete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 10-10 4 4L8 20H4zM13 7l4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M4 4l4 4a8 8 0 1 1-1 10"/></svg>',
  reopen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M4 4l4 4a8 8 0 1 1-1 10"/></svg>',
  purge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 4v3M16 4v3M4 9.5h16"/></svg>',
};
function actionButton(action, id, label, iconName, className = '') {
  return `<button type="button" class="icon-button ${className}" data-action="${action}" data-id="${esc(id)}" title="${label}" aria-label="${label}">${ACTION_ICONS[iconName]}</button>`;
}
function actions(task) {
  if (task.status === 'archived') return `${actionButton('restore', task.id, '恢复任务', 'restore')}${actionButton('purge', task.id, '永久删除', 'purge', 'danger')}`;
  if (task.status === 'unfinished') {
    const openAction = availableSessions(task).length ? 'session' : 'execute';
    return `${actionButton(openAction, task.id, '打开会话', 'open', 'primary')}${actionButton('complete', task.id, '标记完成', 'complete')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  }
  if (task.status === 'done') return `${actionButton('session', task.id, '打开会话', 'open', 'primary')}${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  return `${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
}
function card(task, compact = false) {
  const archiveInfo = task.status === 'archived' ? `<div class="archive-info">已废弃 · ${time(task.archivedAt)} · ${task.purgeAt ? `预计 ${time(task.purgeAt)} 自动删除` : ''}</div>` : '';
  const folder = task.workingDir ? `<span class="task-folder" data-tooltip="${esc(task.workingDir)}">${ACTION_ICONS.folder} ${esc(task.workingDir)}</span>` : '';
  const description = task.description?.trim();
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  return `<article class="card ${task.status} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row"><span class="card-status-icon ${task.status}" role="img" aria-label="状态：${esc(STATUS[task.status]?.label || '未知')}" title="${esc(STATUS[task.status]?.label || '未知状态')}">${STATUS_ICONS[task.status] || '•'}</span><h3 class="card-title" data-tooltip="${esc(task.title)}">${esc(task.title)}</h3><span class="spacer"></span>${task.deadline ? `<span class="deadline ${task.overdue ? 'overdue' : ''}">${ACTION_ICONS.calendar} ${deadline(task.deadline)}${task.overdue ? ' · 逾期' : ''}</span>` : ''}</div>${folder}</div></div>${description ? `<p class="card-desc" data-tooltip="${esc(description)}">${esc(description)}</p>` : ''}${archiveInfo}<div class="card-actions">${actions(task)}</div></article>`;
}
function boardGroupOptions() {
  const options = [{ value: 'single', label: '全部' }];
  if (!state.status) options.push({ value: 'status', label: '按状态' });
  options.push({ value: 'path', label: '按路径' }, { value: 'color', label: '按颜色' });
  return options;
}
function syncBoardGroupOptions() {
  const options = boardGroupOptions();
  if (!options.some((option) => option.value === state.boardGroup)) updateViewSetting('boardGroup', 'single');
  const option = options.find((item) => item.value === state.boardGroup) || options[0];
  const button = $('#board-group-toggle');
  button.innerHTML = BOARD_GROUP_ICONS[option.value];
  button.title = `看板分布：${option.label}（点击切换）`;
  button.setAttribute('aria-label', button.title);
}
function boardGroups(tasks) {
  if (state.boardGroup === 'path') {
    const groups = new Map();
    tasks.forEach((task) => {
      const key = task.workingDir || '未设置工作路径';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, items]) => ({ label, items }));
  }
  if (state.boardGroup === 'color') {
    return Object.entries(colorCatalog()).map(([key, value]) => ({ label: value.label, items: tasks.filter((task) => taskColor(task) === key) })).filter((group) => group.items.length > 0);
  }
  if (state.boardGroup === 'status' && !state.status) {
    return Object.keys(STATUS).map((key) => ({ label: STATUS[key].label, badgeClass: key, items: tasks.filter((task) => task.status === key) })).filter((group) => group.items.length > 0);
  }
  return [{ label: state.status ? STATUS[state.status]?.label || '当前分组' : '全部任务', items: tasks }];
}
function renderList() {
  document.body.classList.add('board-mode');
  syncSortControl();
  syncCardLayoutControl();
  syncBoardGroupOptions();
  const tasks = visibleTasks();
  const groups = boardGroups(tasks);
  const clearArchived = state.status === 'archived' && tasks.length ? '<div class="archive-actions"><button type="button" class="danger" data-action="purge-archived">全部清空</button></div>' : '';
  const hasFilters = Boolean(state.search || state.status);
  const emptyState = `<div class="task-board-empty"><strong>${hasFilters ? '没有匹配的任务' : '还没有任务'}</strong><p>${hasFilters ? '试试调整搜索词或清除筛选条件。' : '创建一个任务，开始你的下一次执行。'}</p>${hasFilters ? '<button type="button" data-action="clear-filters">清除筛选</button>' : ''}</div>`;
  const board = groups.length && tasks.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head"><span class="badge ${group.badgeClass || 'board-group-badge'}" title="${esc(group.label)}">${esc(group.label)}</span><b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((task) => card(task, true)).join('') || '<div class="task-board-empty">暂无任务</div>'}</div></section>`).join('') : emptyState;
  $('#task-list').innerHTML = clearArchived + `<div class="task-board${state.boardCardLayout === 'compact' ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list'));
  syncOverflowTooltips($('#task-list'));
}

function availableSessions(task) {
  return Array.isArray(task?.sessions) ? task.sessions : [];
}
function showSessionTask(taskId) {
  state.sessionTaskIds.add(taskId);
  state.hiddenCompletedSessionTasks.delete(taskId);
  saveLayoutState();
}
function sessionTasks() {
  return state.tasks.filter((task) => task.status !== 'archived' && (availableSessions(task).length > 0 || state.sessionTaskIds.has(task.id)) && !state.hiddenCompletedSessionTasks.has(task.id));
}
function renderSessionHeader() {
  const task = currentTask(state.sessionTask);
  $('#session-view').classList.toggle('no-session', !task);
  const child = availableSessions(task).find((session) => session.id === state.sessionSessionId);
  const sessionTitle = task?.title || '选择一个子会话';
  const sessionName = child ? (child.title || '新会话') : '';
  $('#session-title').textContent = sessionTitle;
  $('#session-title').dataset.tooltip = sessionTitle;
  syncOverflowTooltips($('#session-title').parentElement);
  requestAnimationFrame(() => syncOverflowTooltips($('#session-title').parentElement));
  $('#session-name').textContent = sessionName;
  $('#session-name').title = sessionName || '会话名称';
  $('#copy-session-file').disabled = !child?.sessionFile;
  $('#session-restart').disabled = !task || !child;
  if (!task) sessionTaskDetailsOpen = false;
  $('#session-title').disabled = !task;
  $('#session-title').setAttribute('aria-expanded', String(Boolean(task && sessionTaskDetailsOpen)));
  $('#session-task-details-panel').classList.toggle('hidden', !task || !sessionTaskDetailsOpen);
  $('#session-working-dir').textContent = task?.workingDir || '未设置工作路径';
  $('#session-description-text').textContent = task?.description?.trim() || '暂无任务描述';
  $('#session-task-select').innerHTML = '<option value="">选择一个任务会话</option>' + sessionTasks().filter((item) => availableSessions(item).length > 0).map((item) => `<option value="${item.id}"${item.id === state.sessionTask ? ' selected' : ''}>${esc(item.title)}</option>`).join('');
}
function closeSessionTaskDetails() {
  clearTimeout(sessionTaskDetailsCloseTimer);
  sessionTaskDetailsCloseTimer = null;
  if (!sessionTaskDetailsOpen) return;
  sessionTaskDetailsOpen = false;
  renderSessionHeader();
}
function scheduleSessionTaskDetailsClose() {
  clearTimeout(sessionTaskDetailsCloseTimer);
  sessionTaskDetailsCloseTimer = setTimeout(closeSessionTaskDetails, 600);
}
function renderSessionTree() {
  renderSessionHeader();
  const tasks = sessionTasks();
  $('#session-tree').innerHTML = tasks.length ? tasks.map((task) => {
    const collapsed = state.collapsedSessionTasks.has(task.id);
    const sessions = availableSessions(task);
    const colorKey = taskColor(task);
    const customClass = customColors[colorKey] ? ' custom-color' : '';
    const taskAction = `<button type="button" class="session-new-child" data-new-session-task="${esc(task.id)}" title="新建子会话" aria-label="为${esc(task.title)}新建子会话">＋</button><button type="button" class="session-remove-task" data-remove-completed-task="${esc(task.id)}" title="从会话管理移除" aria-label="从会话管理移除${esc(task.title)}">×</button>`;
    const sessionItems = sessions.map((session, index) => { const title = session.title || `子会话 ${index + 1}`; const current = state.sessionTask === task.id && state.sessionSessionId === session.id; const unread = current ? 0 : (Number(session.unreadCount) || 0); const unreadLabel = unread > 99 ? '99+' : String(unread); return `<div class="session-child-session${current ? ' active' : ''}" data-session-task="${esc(task.id)}" data-session-id="${esc(session.id)}"><button type="button" class="session-child-open" aria-label="${esc(title)}${unread ? `，${unreadLabel}条未读消息` : ''}"><span class="child-dot${unread ? ' has-unread' : ''}" aria-hidden="true"></span><span class="session-child-name" data-tooltip="${esc(title)}">${esc(title)}</span></button><button type="button" class="session-child-delete" data-delete-session="${esc(task.id)}" data-session-id="${esc(session.id)}" title="删除子会话" aria-label="删除子会话">×</button></div>`; }).join('');
    return `<div class="session-task-group"><div class="session-task-heading"><button type="button" class="session-task-title color-${colorKey}${customClass}"${customColorStyle(colorKey)} data-session-group="${esc(task.id)}" aria-label="${esc(task.title)}" aria-expanded="${!collapsed}"><span aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span data-tooltip="${esc(task.title)}">${esc(task.title)}</span></button>${taskAction}</div>${collapsed ? '' : sessionItems}</div>`;
  }).join('') : '<div class="empty sidebar-empty">暂无可打开的会话</div>';
  syncOverflowTooltips($('#session-tree'));
}
async function refresh() {
  try {
    const data = await api('/tasks');
    const signature = JSON.stringify(data.tasks.map((task) => [task.id, task.status, task.updatedAt, task.activeSessionId, task.sessions?.length]));
    state.tasks = data.tasks;
    const taskIds = new Set(data.tasks.map((task) => task.id));
    const sessionKeys = new Set(data.tasks.flatMap((task) => availableSessions(task).map((session) => sessionMarkerKey(task.id, session.id))));
    for (const key of [...seenSessionMessageIds.keys()]) if (!sessionKeys.has(key)) seenSessionMessageIds.delete(key);
    for (const key of [...readRequests.keys()]) if (!sessionKeys.has(key)) readRequests.delete(key);
    let layoutChanged = false;
    for (const taskId of [...state.sessionTaskIds]) {
      if (!taskIds.has(taskId)) { state.sessionTaskIds.delete(taskId); layoutChanged = true; }
    }
    for (const taskId of [...state.hiddenCompletedSessionTasks]) {
      if (!taskIds.has(taskId)) { state.hiddenCompletedSessionTasks.delete(taskId); layoutChanged = true; }
    }
    data.tasks.forEach((task) => { if (availableSessions(task).length > 0) state.sessionTaskIds.add(task.id); });
    if (layoutChanged) saveLayoutState();
    rememberCurrentSessionMessage();
    if (state.sessionTask && !sessionTasks().some((task) => task.id === state.sessionTask)) {
      detachTui();
      state.sessionTask = null;
      state.sessionSessionId = null;
      saveLayoutState();
    }
    renderStats(); renderTaskSidebar(); renderSessionTree();
    if (signature !== state.signature && !$('.modal')) renderList();
    state.signature = signature;
    if (!layoutInitialized) {
      layoutInitialized = true;
      if (state.module === 'session') {
        switchModule('session');
        const task = currentTask(state.sessionTask);
        if (task && sessionTasks().some((item) => item.id === task.id) && availableSessions(task).length > 0) selectSession(task.id, state.sessionSessionId);
        else {
          state.sessionTask = null;
          state.sessionSessionId = null;
          renderSessionTree();
          saveLayoutState();
        }
      }
    }
  } catch (error) { toast(error.message, 'error'); }
}

function terminalFontFamily() {
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  const mac = /mac/i.test(platform);
  if (document.body.classList.contains('theme-geek')) {
    return mac
      ? '"JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"JetBrains Mono", "DengXian", "等线", "Microsoft YaHei UI", monospace';
  }
  if (document.body.classList.contains('theme-pixel-arcade')) {
    return mac
      ? '"Courier New", "Cascadia Mono", Menlo, "STFangsong", "PingFang SC", monospace'
      : '"Courier New", "Cascadia Mono", "FangSong", "仿宋", monospace';
  }
  if (document.body.classList.contains('theme-blueprint')) {
    return mac
      ? '"JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"JetBrains Mono", "Cascadia Mono", "Microsoft YaHei UI", monospace';
  }
  if (document.body.classList.contains('theme-aurora')) {
    return mac
      ? '"SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"Cascadia Mono", "Microsoft YaHei UI", monospace';
  }
  if (document.body.classList.contains('theme-newspaper')) {
    // macOS 使用 Kaiti SC / STKaiti 注册楷体，Windows 则通常使用 KaiTi。
    const macKaiti = mac ? '"Kaiti SC", "STKaiti", ' : '';
    return `"Courier New", ${macKaiti}"KaiTi", "楷体", "Courier Prime", monospace`;
  }
  if (document.body.classList.contains('theme-dopamine') || document.body.classList.contains('theme-music')) {
    return mac
      ? '"Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"Cascadia Mono", "JetBrains Mono", "Microsoft YaHei UI", monospace';
  }
  return mac
    ? '"SFMono-Regular", Menlo, "PingFang SC", monospace'
    : 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace';
}
function terminalTheme() {
  const styles = getComputedStyle(document.body);
  const background = styles.getPropertyValue('--bg').trim();
  const foreground = styles.getPropertyValue('--ink').trim();
  const muted = styles.getPropertyValue('--muted').trim();
  const accent = styles.getPropertyValue('--accent').trim();
  const selectionBackground = styles.getPropertyValue('--accent-soft').trim();
  const dark = isTerminalDark();
  const theme = document.body.classList.contains('theme-geek')
    ? 'geek'
    : document.body.classList.contains('theme-pixel-arcade')
      ? 'pixel-arcade'
      : document.body.classList.contains('theme-newspaper')
        ? 'newspaper'
        : document.body.classList.contains('theme-blueprint')
          ? 'blueprint'
          : document.body.classList.contains('theme-aurora')
            ? 'aurora'
            : document.body.classList.contains('theme-dopamine')
              ? 'dopamine'
              : document.body.classList.contains('theme-music')
                ? 'music'
                : 'classic';
  const palettes = {
    classic: {
      light: { black: '#172b36', red: '#c84822', green: '#2f855a', yellow: '#a16207', blue: '#075985', magenta: '#7c3aed', cyan: '#078c86', white: '#fbfcfa' },
      dark: { black: '#10252d', red: '#ff8b72', green: '#7fd69b', yellow: '#f6c85f', blue: '#8cc8ff', magenta: '#d4a5ff', cyan: '#67d8d1', white: '#e6f0ed' },
    },
    geek: {
      light: { black: '#17251f', red: '#b42318', green: '#166534', yellow: '#8a5a00', blue: '#075985', magenta: '#6b21a8', cyan: '#0f766e', white: '#fbfdfb' },
      dark: { black: '#0b120e', red: '#fb7185', green: '#4ade80', yellow: '#facc15', blue: '#7dd3fc', magenta: '#c4b5fd', cyan: '#5eead4', white: '#e5f3ea' },
    },
    'pixel-arcade': {
      light: { black: '#19233a', red: '#d9365e', green: '#3e8f48', yellow: '#b7791f', blue: '#315bb5', magenta: '#8b4cc7', cyan: '#147f8c', white: '#fffdf4' },
      dark: { black: '#101528', red: '#ff6b8a', green: '#7bdc7d', yellow: '#f6d365', blue: '#7aa2f7', magenta: '#d19aff', cyan: '#56d8d5', white: '#f4f1df' },
    },
    blueprint: {
      light: { black: '#12344a', red: '#b42318', green: '#2f855a', yellow: '#9a6700', blue: '#075985', magenta: '#6b4c9a', cyan: '#008c95', white: '#f7fcff' },
      dark: { black: '#0b1e2d', red: '#ff9b8e', green: '#72d6a5', yellow: '#f4ca68', blue: '#7dd3fc', magenta: '#c4b5fd', cyan: '#5eead4', white: '#e2f3fb' },
    },
    aurora: {
      light: { black: '#25213f', red: '#c2415d', green: '#2f855a', yellow: '#a16207', blue: '#0ea5e9', magenta: '#7c3aed', cyan: '#0f8fa5', white: '#ffffff' },
      dark: { black: '#0e1020', red: '#ff9ba9', green: '#83d995', yellow: '#f5c451', blue: '#82cfff', magenta: '#c4a8ff', cyan: '#67e8f9', white: '#f3efff' },
    },
    newspaper: {
      light: { black: '#28231d', red: '#a3332f', green: '#39704b', yellow: '#936b12', blue: '#385d82', magenta: '#78506f', cyan: '#3e6d68', white: '#fffaf0' },
      dark: { black: '#171716', red: '#c98972', green: '#9baea4', yellow: '#d1b56e', blue: '#9aafba', magenta: '#b99bad', cyan: '#9baea4', white: '#eee6d5' },
    },
    dopamine: {
      light: { black: '#2a1635', red: '#d52d3f', green: '#27834c', yellow: '#a16207', blue: '#4e72c9', magenta: '#c91f69', cyan: '#00a8c6', white: '#ffffff' },
      dark: { black: '#17132a', red: '#ff8d98', green: '#83d995', yellow: '#f5c451', blue: '#82aaff', magenta: '#ff91c5', cyan: '#5de5e1', white: '#fff1fc' },
    },
    music: {
      light: { black: '#17243a', red: '#3a74c5', green: '#3f805d', yellow: '#9b6b18', blue: '#24549c', magenta: '#5f6fbd', cyan: '#287f86', white: '#ffffff' },
      dark: { black: '#111a2d', red: '#66a5ff', green: '#9bdfa9', yellow: '#f2c66d', blue: '#8bbcff', magenta: '#b7a1ff', cyan: '#61d3d5', white: '#edf4ff' },
    },
  };
  return {
    background,
    foreground,
    // Pi keeps the hardware cursor enabled for Windows IME positioning. Match
    // its paint to the terminal background so the parked cursor is not visible.
    cursor: background,
    cursorAccent: background,
    selectionBackground,
    ...palettes[theme][dark ? 'dark' : 'light'],
    brightBlack: muted,
  };
}
function clearQueuedTerminalWrite() {
  if (terminalWriteTimer !== null) clearTimeout(terminalWriteTimer);
  terminalWriteTimer = null;
  terminalWriteBuffer = [];
}
function flushQueuedTerminalWrite() {
  terminalWriteTimer = null;
  const data = terminalWriteBuffer.join('');
  terminalWriteBuffer = [];
  if (data && terminal) terminal.write(data);
}
function queueTerminalWrite(data) {
  if (!terminal || !data) return;
  terminalWriteBuffer.push(String(data));
  // PTY chunks can split one Pi redraw. Paint complete redraws together so
  // the editor cursor never briefly disappears between ANSI operations.
  if (terminalWriteTimer === null) terminalWriteTimer = setTimeout(flushQueuedTerminalWrite, 16);
}
function disposeTerminal() {
  terminalResizeObserver?.disconnect(); terminalResizeObserver = null;
  terminalCursorSubscription?.dispose(); terminalCursorSubscription = null;
  terminalWriteParsedSubscription?.dispose(); terminalWriteParsedSubscription = null;
  clearQueuedTerminalWrite();
  if (terminalImePositionFrame !== null) cancelAnimationFrame(terminalImePositionFrame);
  terminalImePositionFrame = null;
  terminalImeComposing = false; terminalImeInputStyle = null;
  const box = $('#session-terminal');
  if (terminalImeCursorHandler) {
    box.removeEventListener('compositionstart', terminalImeCursorHandler);
    box.removeEventListener('compositionend', terminalImeCursorHandler);
    box.removeEventListener('focusin', terminalImeCursorHandler);
    box.removeEventListener('focusout', terminalImeCursorHandler);
  }
  terminalImeCursorHandler = null;
  try { terminal?.dispose(); } catch { /* already disposed */ }
  terminal = null; fitAddon = null;
  box.innerHTML = '';
}
function detachTui() {
  if (tuiSocket) { tuiSocket.onclose = null; tuiSocket.close(); tuiSocket = null; }
  disposeTerminal();
  document.body.classList.remove('tui-active');
}
function positionTerminalImeInput() {
  const input = terminal?.element?.querySelector('.xterm-helper-textarea');
  const screen = terminal?.element?.querySelector('.xterm-screen');
  if (!input || !screen || !terminal?.cols || !terminal?.rows) return null;
  const rect = screen.getBoundingClientRect();
  const cursor = terminal.buffer.active;
  input.style.left = `${Math.max(0, Math.min(terminal.cols - 1, cursor.cursorX)) * rect.width / terminal.cols}px`;
  input.style.top = `${Math.max(0, Math.min(terminal.rows - 1, cursor.cursorY)) * rect.height / terminal.rows}px`;
  input.style.width = `${Math.max(1, rect.width / terminal.cols)}px`;
  input.style.height = `${Math.max(1, rect.height / terminal.rows)}px`;
  input.style.zIndex = '5';
  return { left: input.style.left, top: input.style.top, width: input.style.width, height: input.style.height, zIndex: input.style.zIndex };
}
function restoreTerminalImeInput() {
  const input = terminal?.element?.querySelector('.xterm-helper-textarea');
  if (input && terminalImeInputStyle) Object.assign(input.style, terminalImeInputStyle);
}
function scheduleTerminalImeInputPosition() {
  if (terminalImePositionFrame !== null) return;
  terminalImePositionFrame = requestAnimationFrame(() => {
    terminalImePositionFrame = null;
    if (terminalImeComposing) restoreTerminalImeInput();
    else positionTerminalImeInput();
  });
}
async function openNativeTui() {
  if (tuiOpening) return tuiOpening;
  const task = currentTask(state.sessionTask);
  if (!task) return toast('请先选择一个会话', 'error');
  const session = availableSessions(task).find((item) => item.id === state.sessionSessionId);
  if (task.status === 'archived') return toast('当前任务不能打开会话', 'error');
  if (!session) return toast('没有可用的历史会话', 'error');
  const taskId = task.id;
  const sessionId = state.sessionSessionId;
  tuiOpening = (async () => {
    detachTui();
    document.body.classList.add('tui-active');
    const box = $('#session-terminal');
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('/vendor/xterm/lib/xterm.mjs'), import('/vendor/xterm-fit/addon-fit.mjs')]);
      if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
      terminal = new Terminal({ cursorBlink: false, cursorStyle: 'bar', cursorWidth: 2, convertEol: true, scrollback: 10000, scrollOnUserInput: false, fontSize: 13, fontFamily: terminalFontFamily(), theme: terminalTheme() });
      const browserPlatform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
      const isWindowsBrowser = /^win/i.test(browserPlatform);
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        if (!event.ctrlKey && !(event.metaKey && key === 'v')) return true;
        if (key === 'c' && terminal.hasSelection()) {
          event.preventDefault();
          event.stopPropagation();
          if (navigator.clipboard) void navigator.clipboard.writeText(terminal.getSelection()).catch(() => toast('复制失败，请使用右键菜单', 'error')); 
          else toast('复制失败，请使用右键菜单', 'error');
          terminal.clearSelection();
          return false;
        }
        if (key === 'v') {
          event.preventDefault();
          event.stopPropagation();
          // Ask pi to read the native clipboard instead of letting xterm send
          // the browser shortcut as terminal input. Pi uses Ctrl+V on
          // macOS/Linux and Alt+V on Windows; both paths support text fallback
          // and clipboard images (inserted as a temporary file path).
          const pasteKey = isWindowsBrowser ? '\x1bv' : '\x16';
          if (tuiSocket?.readyState === WebSocket.OPEN) tuiSocket.send(JSON.stringify({ type: 'tui_input', data: pasteKey }));
          else toast('粘贴失败，请先连接会话', 'error');
          return false;
        }
        return true;
      });
      fitAddon = new FitAddon(); terminal.loadAddon(fitAddon); terminal.open(box); fitAddon.fit(); terminal.focus();
      terminalImeCursorHandler = (event) => {
        if (event?.type === 'compositionstart') {
          terminalImeComposing = true;
          terminalImeInputStyle = positionTerminalImeInput();
          return;
        }
        if (event?.type === 'compositionend' || event?.type === 'focusout') {
          terminalImeComposing = false;
          terminalImeInputStyle = null;
        }
        // xterm relocates its helper textarea for every cursor movement. Keep
        // it fixed throughout an IME composition, even while Pi redraws.
        if (terminalImeComposing) return restoreTerminalImeInput();
        scheduleTerminalImeInputPosition();
      };
      terminalCursorSubscription = terminal.onCursorMove(terminalImeCursorHandler);
      terminalWriteParsedSubscription = terminal.onWriteParsed(terminalImeCursorHandler);
      box.addEventListener('compositionstart', terminalImeCursorHandler);
      box.addEventListener('compositionend', terminalImeCursorHandler);
      box.addEventListener('focusin', terminalImeCursorHandler);
      box.addEventListener('focusout', terminalImeCursorHandler);
      terminalImeCursorHandler();
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      tuiSocket = socket;
      const sendSize = () => {
        try { fitAddon?.fit(); } catch { /* layout is changing */ }
        if (socket.readyState === WebSocket.OPEN && terminal) socket.send(JSON.stringify({ type: 'tui_resize', cols: terminal.cols, rows: terminal.rows }));
      };
      // regular mode leaves wheel scrolling to xterm.js and its viewport.
      terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tui_input', data })); });
      terminalResizeObserver = new ResizeObserver(sendSize); terminalResizeObserver.observe(box);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'tui_hello', taskId, sessionId, cols: terminal.cols, rows: terminal.rows, theme: isTerminalDark() ? 'dark' : 'light' }));
        requestAnimationFrame(() => requestAnimationFrame(sendSize));
      };
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === 'tui_reset') { clearQueuedTerminalWrite(); terminal?.reset(); sendSize(); }
          else if (event.type === 'tui_data') queueTerminalWrite(event.data || '');
          else if (event.type === 'tui_exit') queueTerminalWrite(`\r\n\r\n[工作台] pi 已退出（${event.exitCode ?? '未知'}）。\r\n`);
          else if (event.type === 'tui_error') {
            const error = event.error || '终端错误';
            // Ignore stale frames emitted while a PTY is already exiting.
            if (error === '会话未运行') return;
            queueTerminalWrite(`\r\n[工作台] ${error}\r\n`);
            toast(error, 'error');
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onerror = () => toast('会话连接失败，请查看服务终端中的错误信息', 'error');
      socket.onclose = () => {
        if (tuiSocket === socket) tuiSocket = null;
        if (state.sessionTask === taskId && terminal) queueTerminalWrite('\r\n[工作台] 终端连接已断开，点击“重新连接”可恢复。\r\n');
      };
    } catch (error) {
      detachTui();
      toast(`加载终端组件失败：${error.message}`, 'error');
    }
  })().finally(() => { tuiOpening = null; });
  return tuiOpening;
}
async function restartCurrentTui(message = '正在重启会话…') {
  const taskId = state.sessionTask;
  if (!taskId) return;
  toast(message);
  detachTui();
  try {
    await api(`/tasks/${taskId}/tui/restart`, { method: 'POST' });
  } catch { /* the process may already have exited */ }
  await refresh();
  if (state.sessionTask === taskId) await openNativeTui();
}
async function restartTuiForTheme() {
  if (!state.sessionTask || !tuiSocket) return;
  await restartCurrentTui('主题已切换，正在重启会话…');
}
function selectSession(taskId, sessionId = null) {
  const task = currentTask(taskId);
  const target = availableSessions(task).find((session) => session.id === sessionId);
  // 传入的 id 不存在时回退到服务端活跃会话或首个会话
  const nextSessionId = target?.id || task?.activeSessionId || availableSessions(task)[0]?.id || null;
  const changing = state.sessionTask !== taskId || state.sessionSessionId !== nextSessionId;
  if (state.sessionTask && changing) leaveCurrentSession();
  // 重复点击当前子会话不应重启 TUI。
  if (taskId && !changing && tuiSocket) {
    rememberCurrentSessionMessage();
    renderSessionTree();
    return;
  }
  detachTui();
  state.sessionTask = taskId || null;
  state.sessionSessionId = nextSessionId;
  rememberCurrentSessionMessage();
  renderSessionTree();
  saveLayoutState();
  if (taskId) void openNativeTui();
}

function modal(html) {
  const root = $('#modal-root');
  modalRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.innerHTML = `<div class="overlay" role="presentation"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">${html}</div></div>`;
  const dialog = $('.modal', root);
  const heading = dialog.querySelector('h2');
  if (heading) { heading.id = 'modal-title'; heading.classList.remove('sr-only'); }
  (dialog.querySelector('input, textarea, select, button') || dialog).focus();
  return dialog;
}
function closeModal() {
  const restore = modalRestoreFocus;
  modalRestoreFocus = null;
  $('#modal-root').innerHTML = '';
  if (restore?.isConnected) restore.focus();
}
document.addEventListener('keydown', (event) => {
  const dialog = $('.modal');
  if (!dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function setFieldError(form, inputId, message = '') {
  const input = $(`#${inputId}`, form);
  const error = form.querySelector(`[data-error-for="${inputId}"]`);
  if (!input || !error) return;
  input.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}
function openTaskForm(task = null, options = {}) {
  const openSessionAfterCreate = Boolean(options.openSessionAfterCreate && !task);
  const workingDirEditable = true;
  const workingDirHint = task ? '（仅新会话使用此路径）' : '';
  const workingDirReadonly = workingDirEditable ? '' : ' disabled';
  const form = modal(`<h2>${task ? '编辑任务' : '新建任务'}</h2><label for="task-title">标题<input id="task-title" name="title" autocomplete="off" value="${esc(task?.title || '')}"><span class="field-error hidden" data-error-for="task-title" role="alert"></span></label><label for="task-working-dir">工作目录${workingDirHint}<div class="path-picker-row"><div class="working-dir-field"><input id="task-working-dir" name="workingDir" autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="recent-task-dir-list" value="${esc(task?.workingDir || '')}"${workingDirReadonly}><div id="recent-task-dir-list" class="recent-dir-list hidden" role="group" aria-label="最近工作路径"></div></div><button type="button" id="choose-task-dir" class="icon-button" title="选择文件夹" aria-label="选择文件夹"${workingDirReadonly}>${ACTION_ICONS.folder}</button></div><span class="field-error hidden" data-error-for="task-working-dir" role="alert"></span></label><label for="task-desc">描述<textarea id="task-desc" name="description" autocomplete="off" rows="4">${esc(task?.description || '')}</textarea></label><div class="row"><label>颜色<div class="color-selector"><button type="button" id="color-trigger" class="color-trigger" aria-expanded="false" aria-controls="color-picker"><span id="color-trigger-swatch" class="color-trigger-swatch" aria-hidden="true"></span><span id="color-trigger-label"></span></button><div id="color-picker" class="color-picker hidden" role="group" aria-label="颜色选项"></div><input id="custom-color-value" class="color-native-input" type="color" aria-label="新增颜色" value="#E85F32"></div><input type="hidden" id="task-color" name="color" value="${taskColor(task || {})}"></label><label for="task-deadline">截止<input id="task-deadline" name="deadline" type="datetime-local" value="${esc(task?.deadline || '')}"></label></div><div class="modal-actions"><button type="button" class="primary" id="save-task">${task ? '保存' : '创建'}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  const colorPicker = $('#color-picker', form);
  const colorTrigger = $('#color-trigger', form);
  const customColorValue = $('#custom-color-value', form);
  const colorCapacity = () => {
    const contentWidth = colorPicker.clientWidth - 16;
    const columns = Math.max(1, Math.floor((contentWidth + 4) / 27));
    return Math.max(Object.keys(COLORS).length, columns * 2 - 1);
  };
  const setColorPopup = (open) => {
    colorPicker.classList.toggle('hidden', !open);
    colorTrigger.setAttribute('aria-expanded', String(open));
  };
  const updateColorTrigger = () => {
    const selected = $('#task-color', form).value;
    const color = colorCatalog()[selected] || COLORS.blue;
    $('#color-trigger-label', form).textContent = color.label;
    $('#color-trigger-swatch', form).style.background = color.value;
    colorTrigger.setAttribute('aria-label', `当前颜色 ${color.label}，点击选择`);
    colorPicker.querySelectorAll('[data-color-value]').forEach((item) => {
      const active = item.dataset.colorValue === selected;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
  };
  const selectColor = (key, close = false) => {
    $('#task-color', form).value = key;
    updateColorTrigger();
    if (close) setColorPopup(false);
  };
  const renderColorPicker = () => {
    const selected = $('#task-color', form).value;
    colorPicker.innerHTML = '<button type="button" id="add-custom-color" class="color-add" title="新增颜色" aria-label="新增颜色">＋</button>' + Object.entries(colorCatalog()).map(([key, value]) => {
      const custom = Boolean(customColors[key]);
      return `<div class="color-entry"><button type="button" class="color-option color-${key}${custom ? ' custom-color-option' : ''}${selected === key ? ' active' : ''}" data-color-value="${esc(key)}" aria-label="${esc(value.label)}" title="${esc(value.label)}" aria-pressed="${selected === key}"><span${custom ? ` style="--swatch:${esc(value.value)}"` : ''} aria-hidden="true"></span></button></div>`;
    }).join('');
    colorPicker.querySelectorAll('[data-color-value]').forEach((button) => {
      button.onclick = () => selectColor(button.dataset.colorValue);
      button.ondblclick = () => selectColor(button.dataset.colorValue, true);
      button.onkeydown = (event) => {
        const buttons = [...colorPicker.querySelectorAll('[data-color-value]')];
        const columns = Math.max(1, Math.ceil((colorCapacity() + 1) / 2));
        const index = buttons.indexOf(button);
        let next = index;
        if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1);
        else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
        else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + columns);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else if (event.key === 'Escape') { event.preventDefault(); setColorPopup(false); colorTrigger.focus(); return; }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectColor(button.dataset.colorValue, true); return; }
        else return;
        event.preventDefault();
        buttons[next]?.focus();
      };
    });
    $('#add-custom-color', form).onclick = () => { setColorPopup(false); customColorValue.click(); };
    updateColorTrigger();
  };
  colorTrigger.onclick = () => setColorPopup(colorPicker.classList.contains('hidden'));
  form.addEventListener('click', (event) => { if (!event.target.closest('.color-selector')) setColorPopup(false); });
  customColorValue.addEventListener('change', () => {
    const value = customColorValue.value.toLowerCase();
    const existing = Object.entries(colorCatalog()).find(([, color]) => color.value === value);
    if (existing) {
      $('#task-color', form).value = existing[0];
      renderColorPicker();
      return;
    }
    const key = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    customColors[key] = { label: value.toUpperCase(), value, createdAt: Date.now() };
    $('#task-color', form).value = key;
    saveCustomColors();
    renderColorPicker();

  });
  renderColorPicker();
  const workingDirInput = $('#task-working-dir', form);
  const recentList = $('#recent-task-dir-list', form);
  const hideRecentOptions = () => { recentList.classList.add('hidden'); workingDirInput.setAttribute('aria-expanded', 'false'); };
  const renderRecentOptions = () => {
    const query = workingDirInput.value.trim().toLowerCase();
    const dirs = recentWorkingDirs().filter((dir) => !query || dir.toLowerCase().includes(query));
    recentList.innerHTML = dirs.length ? dirs.map((dir) => `<div class="recent-dir-option"><button type="button" class="recent-dir-option-name" data-recent-dir="${esc(dir)}">${esc(dir)}</button><button type="button" class="recent-dir-delete" data-remove-recent-dir="${esc(dir)}" aria-label="删除路径" title="删除路径">×</button></div>`).join('') : '';
    recentList.classList.toggle('hidden', !dirs.length);
    workingDirInput.setAttribute('aria-expanded', String(Boolean(dirs.length)));
  };
  if (workingDirEditable) {
    workingDirInput.addEventListener('focus', renderRecentOptions);
    workingDirInput.addEventListener('input', renderRecentOptions);
    workingDirInput.addEventListener('blur', () => setTimeout(hideRecentOptions, 150));
  }
  recentList.onclick = (event) => {
    const remove = event.target.closest('[data-remove-recent-dir]');
    if (remove) {
      forgetWorkingDir(remove.dataset.removeRecentDir);
      renderRecentOptions();
      return;
    }
    const option = event.target.closest('[data-recent-dir]');
    if (!option) return;
    workingDirInput.value = option.dataset.recentDir;
    workingDirInput.dispatchEvent(new Event('input', { bubbles: true }));
    hideRecentOptions();
  };
  $('#choose-task-dir', form).onclick = async () => { try { const result = await api('/select-directory', { method: 'POST' }); if (result.path) { rememberWorkingDir(result.path); workingDirInput.value = result.path; renderRecentOptions(); } } catch (error) { toast(error.message, 'error'); } };
  $('#save-task', form).onclick = async () => {
    const button = $('#save-task', form);
    try {
      const title = $('#task-title', form).value.trim();
      const workingDir = $('#task-working-dir', form).value.trim();
      setFieldError(form, 'task-title');
      setFieldError(form, 'task-working-dir');
      if (!title) { setFieldError(form, 'task-title', '请输入任务标题。'); $('#task-title', form).focus(); return; }
      if (workingDirEditable && !workingDir) { setFieldError(form, 'task-working-dir', '请选择或输入工作目录。'); $('#task-working-dir', form).focus(); return; }
      button.disabled = true;
      button.textContent = task ? '保存中…' : '创建中…';
      if (workingDirEditable) rememberWorkingDir(workingDir);
      const body = { title, description: $('#task-desc', form).value, color: $('#task-color', form).value, deadline: $('#task-deadline', form).value || null, workingDir };
      const result = await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PUT' : 'POST', body });
      closeModal();
      if (!task && openSessionAfterCreate && result.task) {
        await openExecute(result.task);
        return;
      }
      toast(task ? '任务已保存' : '任务已创建');
      refresh();
    } catch (error) { button.disabled = false; button.textContent = task ? '保存' : '创建'; toast(error.message, 'error'); }
  };
}
async function openExecute(task) {
  if (!task.workingDir) return openTaskForm(task);
  try {
    const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
    showSessionTask(task.id);
    await refresh(); switchModule('session'); selectSession(task.id, result.session.id);
    toast(task.description ? '已打开会话，请在 pi 输入框中发送任务描述。' : '已打开会话。');
  } catch (error) { toast(error.message, 'error'); }
}
function openDeleteTaskModal(task) {
  const form = modal(`<h2>废弃任务</h2><p>确定将「${esc(task.title)}」移入已废弃任务吗？任务及其会话会保留 15 天。</p><div class="modal-actions"><button class="danger" id="confirm-archive-task">移入已废弃</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-archive-task', form).onclick = async () => {
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      closeModal(); state.status = ''; applyViewSettings(); await refresh();
      toast('任务已移入已废弃，15 天内可恢复');
    } catch (error) { toast(error.message, 'error'); }
  };
}
function openPurgeTaskModal(task) {
  const form = modal(`<h2>永久删除任务</h2><p>确定永久删除「${esc(task.title)}」及其全部会话吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-task">永久删除</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-task', form).onclick = async () => { try { await api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }); closeModal(); toast('任务已永久删除'); refresh(); } catch (error) { toast(error.message, 'error'); } };
}
function openClearArchivedModal() {
  const form = modal('<h2>清空已废弃任务</h2><p>确定永久删除全部已废弃任务及其会话文件吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-archived">全部清空</button><button data-close>取消</button></div>');
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-archived', form).onclick = async () => {
    const button = $('#confirm-purge-archived', form);
    button.disabled = true;
    try {
      const result = await api('/tasks/archived', { method: 'DELETE' });
      closeModal();
      toast(`已永久删除 ${result.removed || 0} 个已废弃任务`);
      refresh();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  };
}
async function createChildSession(task) {
  try {
    const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
    showSessionTask(task.id);
    await refresh();
    selectSession(task.id, result.session.id);
    toast('子会话已创建');
  } catch (error) {
    toast(error.message, 'error');
  }
}
function openSessionModal(task, session = null) {
  const editing = Boolean(session);
  const form = modal(`<h2>${editing ? '重命名子会话' : '新建子会话'}</h2><p class="hint">任务：${esc(task.title)}</p><label for="session-title-input">会话名称<input id="session-title-input" name="sessionTitle" autocomplete="off" value="${esc(session?.title || '新会话')}" placeholder="例如：检查登录模块…"><span class="field-error hidden" data-error-for="session-title-input" role="alert"></span></label><div class="modal-actions"><button type="button" class="primary" id="save-session">${editing ? '保存' : '创建'}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#save-session', form).onclick = async () => {
    const button = $('#save-session', form);
    try {
      const title = $('#session-title-input', form).value.trim();
      setFieldError(form, 'session-title-input');
      if (!title) { setFieldError(form, 'session-title-input', '请输入会话名称。'); $('#session-title-input', form).focus(); return; }
      button.disabled = true;
      button.textContent = editing ? '保存中…' : '创建中…';
      const result = await api(editing ? `/tasks/${task.id}/sessions/${session.id}` : `/tasks/${task.id}/sessions`, { method: editing ? 'PATCH' : 'POST', body: { title } });
      if (!editing) showSessionTask(task.id);
      closeModal(); await refresh(); if (!editing || (state.sessionTask === task.id && state.sessionSessionId === session.id)) selectSession(task.id, result.session.id);
    } catch (error) { button.disabled = false; button.textContent = editing ? '保存' : '创建'; toast(error.message, 'error'); }
  };
}
function openDeleteSessionModal(task, sessionId) {
  const form = modal(`<h2>删除子会话</h2><p>确定删除「${esc(task.title)}」下的这个子会话及其日志吗？</p><div class="modal-actions"><button class="danger" id="confirm-delete-session">删除</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-delete-session', form).onclick = async () => {
    try {
      const deletingCurrent = state.sessionTask === task.id && state.sessionSessionId === sessionId;
      if (deletingCurrent) leaveCurrentSession();
      const result = await api(`/tasks/${task.id}/sessions/${sessionId}`, { method: 'DELETE' });
      const nextSessionId = result.task?.activeSessionId || result.task?.sessions?.[0]?.id || null;
      if (deletingCurrent) {
        detachTui();
        state.sessionSessionId = nextSessionId || null;
      }
      closeModal();
      await refresh();
      if (deletingCurrent && nextSessionId) selectSession(task.id, nextSessionId);
      saveLayoutState();
    } catch (error) { toast(error.message, 'error'); }
  };
}
function leaveCurrentSession() {
  if (!state.sessionTask || !state.sessionSessionId) return;
  markSessionRead(state.sessionTask, state.sessionSessionId);
}
function hideSessionTask(task) {
  const runningSessions = availableSessions(task).filter((session) => session.running);
  if (!task.piRunning && !runningSessions.length) return applyHide();
  const count = runningSessions.length || 1;
  const form = modal(`<h2>终止运行中的会话？</h2><p>任务「${esc(task.title)}」有 ${count} 个子会话正在运行。隐藏任务会终止这些会话，是否继续？</p><div class="modal-actions"><button type="button" class="danger" id="confirm-hide-session-task">终止并隐藏</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-hide-session-task', form).onclick = async () => {
    const button = $('#confirm-hide-session-task', form);
    button.disabled = true;
    try {
      await api(`/tasks/${task.id}/terminate`, { method: 'POST' });
      closeModal();
      applyHide();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  };
  function applyHide() {
    state.sessionTaskIds.delete(task.id);
    state.hiddenCompletedSessionTasks.add(task.id);
    if (state.sessionTask === task.id) {
      leaveCurrentSession();
      detachTui();
      state.sessionTask = null;
      state.sessionSessionId = null;
    }
    renderSessionTree();
    saveLayoutState();
  }
}
function markSessionRead(taskId, sessionId, { keepalive = false } = {}) {
  if (!taskId || !sessionId) return;
  const key = sessionMarkerKey(taskId, sessionId);
  const readThroughMessageId = seenSessionMessageIds.get(key);
  if (!readThroughMessageId || readRequests.get(key) === readThroughMessageId) return;
  readRequests.set(key, readThroughMessageId);
  void api(`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: 'POST', keepalive, body: { readThroughMessageId },
  }).then(() => {
    if (!keepalive) void refresh();
  }).catch(() => {
    // 保留本地旧计数；下次离开会话会重试，避免把失败误显示为已读。
  }).finally(() => {
    if (readRequests.get(key) === readThroughMessageId) readRequests.delete(key);
  });
}
function syncModuleTabs() {
  const session = state.module === 'session';
  $('#module-session').tabIndex = session ? 0 : -1;
  $('#module-tasks').tabIndex = session ? -1 : 0;
}
function switchModule(module) {
  const session = module === 'session';
  if (!session && state.sessionTask) leaveCurrentSession();
  state.module = session ? 'session' : 'tasks';
  saveLayoutState();
  document.body.classList.toggle('session-mode', session);
  $('#module-session').classList.toggle('active', session); $('#module-tasks').classList.toggle('active', !session);
  $('#module-session').setAttribute('aria-selected', String(session)); $('#module-tasks').setAttribute('aria-selected', String(!session));
  syncModuleTabs();
  $('#task-sidebar').classList.toggle('hidden', session); $('#session-sidebar').classList.toggle('hidden', !session);
  $('#task-toolbar').classList.toggle('hidden', session); $('#task-list').classList.toggle('hidden', session); $('#session-view').classList.toggle('hidden', !session);
  if (session) {
    rememberCurrentSessionMessage();
    renderSessionTree();
  } else renderList();
}

function closeThemeMenu() {
  const menu = $('#theme-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('#style-toggle').setAttribute('aria-expanded', 'false');
}
function toggleThemeMenu(focusSelector) {
  const menu = $('#theme-menu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('#style-toggle').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector(focusSelector)?.focus();
}
$('#style-toggle').onclick = () => toggleThemeMenu('[data-theme-style][aria-checked="true"]');
$('#mode-toggle').onclick = () => {
  const modes = ['system', 'light', 'dark'];
  const current = modes.includes(localStorage.getItem('workbench-theme')) ? localStorage.getItem('workbench-theme') : 'system';
  applyTheme(modes[(modes.indexOf(current) + 1) % modes.length]);
  void restartTuiForTheme();
  closeThemeMenu();
};
$('#theme-menu').onclick = (event) => {
  const style = event.target.closest('[data-theme-style]');
  if (!style) return;
  applyThemeStyle(style.dataset.themeStyle);
  void restartTuiForTheme();
  closeThemeMenu();
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('#style-toggle, #mode-toggle, #theme-menu')) closeThemeMenu();
  if (sessionTaskDetailsOpen && !event.target.closest('#session-context-copy')) closeSessionTaskDetails();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeThemeMenu();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (localStorage.getItem('workbench-theme') === 'system') { applyTheme('system'); void restartTuiForTheme(); } });
$('#module-tasks').onclick = () => switchModule('tasks');
$('#module-session').onclick = () => switchModule('session');
[$('#module-tasks'), $('#module-session')].forEach((tab, index, tabs) => {
  tab.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    next.focus();
    next.click();
  };
});
syncModuleTabs();
$('#sidebar-toggle').onclick = () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  state.sidebarCollapsed = collapsed;
  applySidebarCollapsed(collapsed);
  syncMasonryColumns();
  syncOverflowTooltips();
  localStorage.setItem('workbench-sidebar-collapsed', String(collapsed));
  saveLayoutState();
};
$('#sidebar-new-task').onclick = () => openTaskForm();
$('#session-sidebar-new-task').onclick = () => openTaskForm(null, { openSessionAfterCreate: true });
$('#session-task-select').onchange = (event) => selectSession(event.target.value);
$('#session-title').onclick = () => {
  if (!currentTask(state.sessionTask)) return;
  clearTimeout(sessionTaskDetailsCloseTimer);
  sessionTaskDetailsCloseTimer = null;
  sessionTaskDetailsOpen = !sessionTaskDetailsOpen;
  renderSessionHeader();
};
$('#session-context-copy').onpointerenter = () => {
  clearTimeout(sessionTaskDetailsCloseTimer);
  sessionTaskDetailsCloseTimer = null;
};
$('#session-context-copy').onpointerleave = () => {
  if (sessionTaskDetailsOpen) scheduleSessionTaskDetailsClose();
};
$('#copy-session-file').onclick = async () => {
  const task = currentTask(state.sessionTask);
  const session = availableSessions(task).find((item) => item.id === state.sessionSessionId);
  const path = session?.sessionFile;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(`pi --session "${path}"`);
    toast('pi 会话命令已复制');
  } catch { toast('复制失败，请手动选择命令', 'error'); }
};
$('#session-restart').onclick = () => { void restartCurrentTui(); };
$('#session-tree').onclick = (event) => {
  const create = event.target.closest('[data-new-session-task]');
  if (create) { const task = currentTask(create.dataset.newSessionTask); if (task) void createChildSession(task); return; }
  const removeCompleted = event.target.closest('[data-remove-completed-task]');
  if (removeCompleted) {
    event.stopPropagation();
    const task = currentTask(removeCompleted.dataset.removeCompletedTask);
    if (task) hideSessionTask(task);
    return;
  }
  const remove = event.target.closest('[data-delete-session]');
  if (remove) { event.stopPropagation(); const task = currentTask(remove.dataset.deleteSession); if (task) openDeleteSessionModal(task, remove.dataset.sessionId); return; }
  const group = event.target.closest('[data-session-group]');
  if (group) { const id = group.dataset.sessionGroup; state.collapsedSessionTasks.has(id) ? state.collapsedSessionTasks.delete(id) : state.collapsedSessionTasks.add(id); renderSessionTree(); saveLayoutState(); return; }
  const item = event.target.closest('[data-session-task]');
  if (item) selectSession(item.dataset.sessionTask, item.dataset.sessionId);
};
$('#session-tree').ondblclick = (event) => {
  const item = event.target.closest('[data-session-task]');
  if (!item || event.target.closest('[data-delete-session]')) return;
  const task = currentTask(item.dataset.sessionTask);
  const session = availableSessions(task).find((child) => child.id === item.dataset.sessionId);
  if (task && session) openSessionModal(task, session);
};
$('#task-groups').onclick = (event) => {
  const group = event.target.closest('[data-task-filter]');
  if (!group) return;
  state.status = group.dataset.taskFilter || '';
  applyViewSettings();
  renderTaskSidebar();
  renderList();
  saveLayoutState();
};
$('#sort-toggle').onclick = () => {
  const index = SORT_OPTIONS.findIndex((option) => option.value === state.sort);
  updateViewSetting('sort', SORT_OPTIONS[(index + 1) % SORT_OPTIONS.length].value);
  syncSortControl(); renderList(); saveLayoutState();
};
$('#board-group-toggle').onclick = () => {
  const options = boardGroupOptions();
  const index = options.findIndex((option) => option.value === state.boardGroup);
  updateViewSetting('boardGroup', options[(index + 1) % options.length].value);
  renderList(); saveLayoutState();
};
$('#board-card-layout').onclick = () => { updateViewSetting('boardCardLayout', state.boardCardLayout === 'compact' ? 'single' : 'compact'); syncCardLayoutControl(); renderList(); saveLayoutState(); };
$('#search').oninput = (event) => { state.search = event.target.value; renderList(); saveLayoutState(); };
document.addEventListener('keydown', (event) => {
  if ($('.modal') || state.module !== 'tasks') return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === 'k') {
    event.preventDefault(); $('#search').focus(); $('#search').select();
  } else if (!typing && key === '/') {
    event.preventDefault(); $('#search').focus();
  } else if (!typing && !event.metaKey && !event.ctrlKey && key === 'n') {
    event.preventDefault(); openTaskForm();
  }
});
$('#task-list').onclick = async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const task = currentTask(button.dataset.id);
  try {
    if (button.dataset.action === 'clear-filters') {
      state.search = ''; state.status = '';
      applyViewSettings();
      $('#search').value = '';
      renderTaskSidebar(); renderList(); saveLayoutState();
      $('#search').focus();
    } else if (button.dataset.action === 'execute') {
      button.disabled = true;
      button.textContent = '打开中…';
      await openExecute(task);
    }
    else if (button.dataset.action === 'session') {
      showSessionTask(task.id);
      if (!availableSessions(task).length) {
        const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
        saveLayoutState();
        await refresh();
        switchModule('session'); selectSession(task.id, result.session.id);
        toast('已新建会话。');
      } else {
        saveLayoutState();
        switchModule('session'); selectSession(task.id, task.activeSessionId || null);
      }
    }
    else if (button.dataset.action === 'edit') openTaskForm(task);
    else if (button.dataset.action === 'delete') openDeleteTaskModal(task);
    else if (button.dataset.action === 'restore') {
      const result = await api(`/tasks/${task.id}/restore`, { method: 'POST' });
      state.status = '';
      applyViewSettings();
      await refresh();
      const restoredLabel = STATUS[result.task?.status]?.label || '已恢复';
      toast(`任务已恢复到${restoredLabel}`);
    }
    else if (button.dataset.action === 'purge') openPurgeTaskModal(task);
    else if (button.dataset.action === 'purge-archived') openClearArchivedModal();
    else if (button.dataset.action === 'complete') {
      await api(`/tasks/${task.id}/complete`, { method: 'POST' });
      state.hiddenCompletedSessionTasks.add(task.id);
      if (state.sessionTask === task.id) {
        leaveCurrentSession();
        detachTui();
        state.sessionTask = null;
        state.sessionSessionId = null;
      }
      await refresh();
      saveLayoutState();
      toast('任务已完成');
    }
    else if (button.dataset.action === 'reopen') { await api(`/tasks/${task.id}/reopen`, { method: 'POST' }); toast('任务已重开'); refresh(); }
    else if (button.dataset.action === 'terminate' && confirm('确定终止当前 pi TUI 吗？')) { await api(`/tasks/${task.id}/terminate`, { method: 'POST' }); toast('执行已终止'); refresh(); }
  } catch (error) { toast(error.message, 'error'); }
};

let refreshTimer = null;
function scheduleRefresh(delay = 100) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, delay);
}
const taskEvents = new EventSource('/api/events');
taskEvents.onmessage = ({ data }) => {
  try {
    const event = JSON.parse(data);
    if (event.type === 'tasks_changed') scheduleRefresh();
  } catch { /* ignore malformed event */ }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.module === 'session') void refresh();
});
window.addEventListener('pagehide', () => {
  if (state.sessionTask) markSessionRead(state.sessionTask, state.sessionSessionId, { keepalive: true });
  taskEvents.close();
}, { once: true });
refresh();
// SSE 是实时更新路径；不再对任务列表进行定时轮询，避免无必要地重绘任务卡片。
