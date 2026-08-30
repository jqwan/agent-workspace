import { deadline, esc, number, time } from './ui/format.js';
import { api } from './ui/api.js';
import {
  COLORS, MAX_CUSTOM_COLORS, STATUS, colorCatalog, customColors, saveCustomColors, state, taskColor,
  applyViewSettings, loadLayoutState, saveLayoutState, updateViewSetting,
} from './ui/state.js';

const $ = (selector, root = document) => root.querySelector(selector);

function customColorStyle(key) {
  const color = customColors[key];
  return color ? ` style="--task-color:${esc(color.value)}"` : '';
}
function customColorUseCount(key) {
  const assignedCount = [...state.tasks, ...state.notes].filter((item) => item.color === key).length;
  return (Number(customColors[key]?.useCount) || 0) + assignedCount;
}
function createCustomColor(value) {
  const existing = Object.entries(colorCatalog()).find(([, color]) => color.value === value);
  if (existing) return existing[0];
  const entries = Object.entries(customColors);
  let key;
  if (entries.length < MAX_CUSTOM_COLORS) {
    key = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } else {
    const [leastUsedKey] = entries.slice().sort(([aKey, a], [bKey, b]) => customColorUseCount(aKey) - customColorUseCount(bKey)
      || (Number(a.lastUsedAt) || Number(a.createdAt) || 0) - (Number(b.lastUsedAt) || Number(b.createdAt) || 0)
      || aKey.localeCompare(bKey))[0];
    key = leastUsedKey;
  }
  customColors[key] = { label: value.toUpperCase(), value, createdAt: Date.now(), useCount: 0, lastUsedAt: 0 };
  saveCustomColors();
  return key;
}
function markCustomColorUsed(key) {
  if (!customColors[key]) return;
  customColors[key].useCount = (Number(customColors[key].useCount) || 0) + 1;
  customColors[key].lastUsedAt = Date.now();
  saveCustomColors();
}

loadLayoutState();
let layoutInitialized = false;
let tuiSocket = null;
let terminal = null;
let fitAddon = null;
let terminalSearchAddon = null;
let terminalResizeObserver = null;
let terminalImeCursorHandler = null;
let terminalCursorSubscription = null;
let terminalWriteParsedSubscription = null;
let terminalWriteTimer = null;
let terminalWriteBuffer = [];
let terminalImePositionFrame = null;
let terminalFocusRetryTimer = null;
let terminalImeComposing = false;
let terminalImeInputStyle = null;
let tuiOpening = null;
let modalRestoreFocus = null;
let sessionTaskDetailsOpen = false;
let sessionActionMenuOpen = false;
let marqueeMotionFrame = null;
let marqueeMotion = null;
let renderedPinnedNotesSignature = '';
let renderedSessionTreeSignature = '';
let sessionTreeClickTimer = null;
let noteDragTimer = null;
let noteDrag = null;
let suppressNoteClickUntil = 0;
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
const THEME_STYLES = ['classic', 'geek-terminal', 'aurora', 'newspaper'];
const THEME_CLASS_NAMES = { classic: 'classic', 'geek-terminal': 'geek', aurora: 'aurora', newspaper: 'newspaper' };
const THEME_BODY_CLASSES = ['classic', 'geek', 'geek-terminal', 'aurora', 'newspaper'];
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
    classic: { light: '#1e1e1e', dark: '#181818' },
    'geek-terminal': { light: '#edf7f0', dark: '#070a09' },
    aurora: { light: '#f5f7ff', dark: '#111322' },
    newspaper: { light: '#f4f1e8', dark: '#181817' },
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
  // TUI 的配色必须跟随工作台当前的亮暗模式，不能只看浏览器默认主题。
  return document.body.classList.contains('theme-dark')
    || (!document.body.classList.contains('theme-light') && matchMedia('(prefers-color-scheme: dark)').matches);
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
  if (!button.querySelector('.sidebar-toggle-line')) {
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="3"/><path class="sidebar-toggle-line" d="M9 3v18"/></svg>';
  }
}

// 工作区导航记录的是“看过的界面”，不干涉任务内容和终端内的 undo/redo。
const workspaceHistory = { entries: [], index: -1, restoring: false };
function workspaceViewSnapshot() {
  return {
    module: state.module,
    boardType: state.boardType,
    status: state.status,
    archiveType: state.archiveType,
    noteFilter: state.noteFilter,
    sessionTask: state.module === 'session' ? state.sessionTask : null,
    sessionSessionId: state.module === 'session' ? state.sessionSessionId : null,
  };
}
function sameWorkspaceView(a, b) {
  return Boolean(a && b && ['module', 'boardType', 'status', 'archiveType', 'noteFilter', 'sessionTask', 'sessionSessionId'].every((key) => a[key] === b[key]));
}
function syncWorkspaceHistoryControls() {
  const back = $('#workspace-back');
  const forward = $('#workspace-forward');
  if (!back || !forward) return;
  back.disabled = workspaceHistory.index <= 0;
  forward.disabled = workspaceHistory.index < 0 || workspaceHistory.index >= workspaceHistory.entries.length - 1;
  back.title = back.disabled ? '' : '返回（Alt+←）';
  forward.title = forward.disabled ? '' : '前进（Alt+→）';
  back.setAttribute('aria-disabled', String(back.disabled));
  forward.setAttribute('aria-disabled', String(forward.disabled));
}
function recordWorkspaceView() {
  if (workspaceHistory.restoring) return;
  const snapshot = workspaceViewSnapshot();
  if (sameWorkspaceView(workspaceHistory.entries[workspaceHistory.index], snapshot)) return;
  workspaceHistory.entries.splice(workspaceHistory.index + 1);
  workspaceHistory.entries.push(snapshot);
  workspaceHistory.index = workspaceHistory.entries.length - 1;
  syncWorkspaceHistoryControls();
}
async function restoreWorkspaceView(snapshot) {
  workspaceHistory.restoring = true;
  try {
    state.boardType = snapshot.boardType;
    state.status = snapshot.status;
    state.archiveType = snapshot.archiveType;
    state.noteFilter = snapshot.noteFilter;
    applyViewSettings();
    if (snapshot.module === 'session') {
      if (snapshot.sessionTask && currentTask(snapshot.sessionTask)) await selectSession(snapshot.sessionTask, snapshot.sessionSessionId, { record: false });
      else await selectSession(null, null, { record: false });
    } else {
      switchModule('tasks');
      saveLayoutState();
    }
  } finally {
    workspaceHistory.restoring = false;
    syncWorkspaceHistoryControls();
  }
}
async function moveWorkspaceHistory(delta) {
  const nextIndex = workspaceHistory.index + delta;
  const snapshot = workspaceHistory.entries[nextIndex];
  if (!snapshot) return;
  workspaceHistory.index = nextIndex;
  syncWorkspaceHistoryControls();
  await restoreWorkspaceView(snapshot);
}

// 通知消息框每次只播放一条便签，过长内容截断以保持轨道稳定。
const MARQUEE_MAX_MESSAGE_CHARS = 300;
const TITLE_MARQUEE_SPEED = 28; // px/s，标题滚动采用恒定的像素速度
const SORT_OPTIONS = [
  { value: 'updated', label: '最近更新', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>' },
  { value: 'created', label: '创建时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 4v3M16 4v3M4 9.5h16M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01"/></svg>' },
  { value: 'deadline', label: '截止时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v3M18 4v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11H4V7a2 2 0 0 1 2-2Z"/><path d="M12 12v3l2 1"/></svg>' },
];
const BOARD_GROUP_ICONS = {
  single: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  status: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h6"/></svg>',
  path: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  color: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 0 16h1.5a2 2 0 0 0 0-4H12a1.5 1.5 0 0 1 0-3h3a5 5 0 0 0 5-5c0-2.2-3.6-4-8-4Z"/><circle cx="8" cy="9" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/></svg>',
  kind: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="13" height="14" rx="1.5"/><path d="M8 4h11a1 1 0 0 1 1 1v12"/></svg>',
  noteCategory: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="6" height="6" rx="1"/><rect x="14" y="5" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
};
function syncTaskToolbarTitle() {
  const archived = state.status === 'archived';
  const notes = !archived && state.boardType === 'notes';
  const clearArchivedButton = $('#purge-archived');
  if (clearArchivedButton) {
    const archivedTaskCount = state.tasks.filter((task) => task.status === 'archived').length;
    const archivedNoteCount = state.notes.filter((note) => note.status === 'archived').length;
    const archivedCounts = { all: archivedTaskCount + archivedNoteCount, tasks: archivedTaskCount, notes: archivedNoteCount };
    clearArchivedButton.classList.toggle('hidden', !archived);
    clearArchivedButton.disabled = archivedCounts[state.archiveType] === 0;
  }
  const searchInput = $('#search');
  let searchLabel = '搜索任务';
  if (archived) searchLabel = '搜索回收站';
  else if (notes) searchLabel = '搜索便签';
  if (searchInput) searchInput.setAttribute('aria-label', searchLabel);
  const newItemButton = $('#toolbar-new-item');
  if (newItemButton) {
    const label = notes ? '新建便签' : '新建任务';
    newItemButton.classList.toggle('hidden', archived);
    newItemButton.title = label;
    newItemButton.setAttribute('aria-label', label);
  }
  syncArchiveButton();
  syncModuleTabs();
}
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
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="5" height="12" rx="1.2"/><rect x="9.5" y="6" width="5" height="12" rx="1.2"/><rect x="16" y="6" width="5" height="12" rx="1.2"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="16" rx="1.5"/></svg>';
  button.title = `切换布局（当前：${compact ? '紧凑' : '单列'}）`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(compact));
}
applySidebarCollapsed(state.sidebarCollapsed);
syncTaskToolbarTitle();
syncBoardFilter();
syncSortControl();
syncCardLayoutControl();
$('#search').value = state.search;
workspaceHistory.entries = [workspaceViewSnapshot()];
workspaceHistory.index = 0;
syncWorkspaceHistoryControls();
$('#workspace-back').onclick = () => { void moveWorkspaceHistory(-1); };
$('#workspace-forward').onclick = () => { void moveWorkspaceHistory(1); };
document.addEventListener('keydown', (event) => {
  if ($('.modal') || event.defaultPrevented) return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  if (typing) return;
  const back = (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowLeft')
    || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '[');
  const forward = (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowRight')
    || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ']');
  if (!back && !forward) return;
  event.preventDefault();
  void moveWorkspaceHistory(back ? -1 : 1);
});
window.addEventListener('resize', () => { syncViewportHeight(); syncMasonryColumns(); syncOverflowTooltips(); });
window.addEventListener('pagehide', saveLayoutState);
window.visualViewport?.addEventListener('resize', syncViewportHeight);

// 将原 Toast 内容输出到运行后端的终端，不再显示浏览器弹窗。
function toast(message, type = '') {
  const text = String(message || '').trim();
  if (!text) return;
  void api('/client-log', { method: 'POST', body: { message: text, type } }).catch(() => {});
}
function currentTask(id) { return state.tasks.find((task) => task.id === id); }
function currentNote(id) { return state.notes.find((note) => note.id === id); }
const LAST_OPENED_SESSION_KEY = 'workbench-last-opened-session';
function rememberLastOpenedSession(taskId, sessionId) {
  if (!taskId || !sessionId) return;
  try { localStorage.setItem(LAST_OPENED_SESSION_KEY, JSON.stringify({ taskId, sessionId })); } catch { /* ignore unavailable browser storage */ }
}
function storedLastOpenedSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_OPENED_SESSION_KEY) || 'null');
    if (saved && typeof saved.taskId === 'string' && typeof saved.sessionId === 'string') return saved;
  } catch { /* ignore malformed browser data */ }
  return null;
}
function findLastOpenedSession() {
  const candidates = [
    { taskId: state.sessionTask, sessionId: state.sessionSessionId },
    storedLastOpenedSession(),
  ];
  return candidates.find((candidate) => {
    const task = candidate && currentTask(candidate.taskId);
    return task && availableSessions(task).some((session) => session.id === candidate.sessionId);
  }) || null;
}
function noteInitial(note) {
  const source = `${note?.title || ''} ${note?.description || ''}`.trim();
  const chars = [...source].filter((char) => !/\s/u.test(char));
  if (!chars.length) return { primary: '', secondary: '' };
  const firstIsChinese = /\p{Script=Han}/u.test(chars[0]);
  const secondIsChinese = /\p{Script=Han}/u.test(chars[1] || '');
  // 首字符是中文，或第二字符是中文时，都只显示首字符；仅前两个字符都非中文时显示双字符缩写。
  return { primary: chars[0], secondary: !firstIsChinese && !secondIsChinese ? (chars[1] || '') : '' };
}
function noteInitialMarkup(note) {
  const { primary, secondary } = noteInitial(note);
  if (!primary && !secondary) return '';
  return `<span class="note-initial"><span class="note-initial-primary">${esc(primary)}</span>${secondary ? `<span class="note-initial-secondary">${esc(secondary)}</span>` : ''}</span>`;
}
function noteLabel(note) { return note?.title ? `${note.title}：${note.description}` : note?.description || ''; }
function orderedPinnedNotes(flag, orderKey) {
  return state.notes.filter((note) => note.status !== 'archived' && note[flag]).sort((a, b) => Number(a[orderKey]) - Number(b[orderKey]) || new Date(a.createdAt) - new Date(b.createdAt));
}
const MARQUEE_INITIAL_ITEMS = 8;
const MARQUEE_MAX_ITEMS = 24;
const MARQUEE_GAP = 28;
function stopMarqueeMotion() {
  if (marqueeMotionFrame !== null) cancelAnimationFrame(marqueeMotionFrame);
  marqueeMotionFrame = null;
  marqueeMotion = null;
}
function marqueeMessages() {
  return state.notes.filter((note) => note.status !== 'archived').map((note) => {
    const chars = [...noteLabel(note)];
    return chars.length > MARQUEE_MAX_MESSAGE_CHARS ? `${chars.slice(0, MARQUEE_MAX_MESSAGE_CHARS).join('')}…` : chars.join('');
  }).filter(Boolean);
}
function shuffledMarqueeMessages(messages) {
  const shuffled = messages.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}
function nextMarqueeMessage(motion) {
  if (motion.roundIndex >= motion.round.length) {
    motion.round = shuffledMarqueeMessages(motion.messages);
    motion.roundIndex = 0;
  }
  return motion.round[motion.roundIndex++];
}
function marqueeItemMarkup(message) {
  return `<span class="note-marquee-item" title="${esc(message)}">${esc(message)}</span>`;
}
function appendMarqueeItem(motion) {
  const message = nextMarqueeMessage(motion);
  motion.track.insertAdjacentHTML('beforeend', marqueeItemMarkup(message));
}
function startMarqueeMotion(motion) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const { root, track } = motion;
  marqueeMotion = motion;
  const tick = (now) => {
    // 悬停只改变像素速度，不重置 transform，因此不会产生回跳或卡顿。
    const speed = root.matches(':hover') ? 30 : 120;
    motion.travel += Math.min(Math.max(0, now - motion.lastTime), 120) * speed / 1000;
    motion.lastTime = now;
    const first = track.firstElementChild;
    if (first) {
      const width = first.getBoundingClientRect().width;
      // 每帧最多回收一个节点，避免大步长触发无界循环。
      if (motion.travel >= root.clientWidth + width) {
        motion.travel -= width + MARQUEE_GAP;
        first.remove();
        if (track.children.length < MARQUEE_INITIAL_ITEMS) appendMarqueeItem(motion);
      }
    }
    track.style.transform = `translate3d(${root.clientWidth - motion.travel}px, 0, 0)`;
    marqueeMotionFrame = requestAnimationFrame(tick);
  };
  track.style.transform = `translate3d(${root.clientWidth}px, 0, 0)`;
  motion.lastTime = performance.now();
  marqueeMotionFrame = requestAnimationFrame(tick);
}
function renderMarquee() {
  stopMarqueeMotion();
  const root = $('#note-marquee');
  const shell = $('#toast-root');
  root.classList.remove('notice', 'error');
  root.setAttribute('aria-hidden', 'true');
  const messages = marqueeMessages();
  if (!messages.length) {
    root.classList.add('empty'); shell.classList.add('notification-empty');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('empty'); shell.classList.remove('notification-empty');
  const motion = { root, track: null, messages, round: [], roundIndex: 0, travel: 0, lastTime: 0 };
  const initialItems = Array.from({ length: MARQUEE_INITIAL_ITEMS }, () => marqueeItemMarkup(nextMarqueeMessage(motion))).join('');
  root.innerHTML = `<span class="note-marquee-track">${initialItems}</span>`;
  motion.track = root.querySelector('.note-marquee-track');
  // 有界预填充：最多补到 24 个节点，不使用可能失控的 while。
  for (let index = MARQUEE_INITIAL_ITEMS; index < MARQUEE_MAX_ITEMS && motion.track.getBoundingClientRect().width < root.clientWidth * 2; index += 1) {
    appendMarqueeItem(motion);
  }
  // DOM 插入当帧即定位到右侧，不能等 rAF 回调，否则低帧率下会闪到左侧。
  motion.track.style.transform = `translate3d(${root.clientWidth}px, 0, 0)`;
  marqueeMotionFrame = requestAnimationFrame(() => {
    marqueeMotionFrame = null;
    startMarqueeMotion(motion);
  });
}
function renderTopbarNoteButtons() {
  const root = $('#topbar-note-buttons');
  if (!root) return;
  const notes = orderedPinnedNotes('pinnedToTopBar', 'topbarOrder');
  root.innerHTML = `${notes.map((note) => `<button type="button" class="note-button color-${taskColor(note)}${customColors[taskColor(note)] ? ' custom-color' : ''}"${customColorStyle(taskColor(note))} data-topbar-note="${esc(note.id)}" data-note-id="${esc(note.id)}" data-note-placement="topbar" aria-label="${esc(noteLabel(note))}" aria-haspopup="menu" aria-expanded="false" title="${esc(noteLabel(note))}">${noteInitialMarkup(note)}</button>`).join('')}<button type="button" class="note-button note-add-button" data-new-topbar-note aria-label="新建提醒便签" title="新建提醒便签">＋</button><section id="topbar-note-panel" class="session-description-panel topbar-note-panel hidden" aria-label="便签详情"></section>`;
}
function renderPinnedNotes() {
  // 会话输出也会触发 refresh；仅在便签自身变化时重绘，不能重启动画。
  const signature = JSON.stringify(state.notes.map((note) => [note.id, note.updatedAt, note.status, note.title, note.description, note.color, note.pinnedToTopBar, note.pinnedToSessionBar, note.topbarOrder, note.sessionOrder]));
  if (signature === renderedPinnedNotesSignature) return;
  renderedPinnedNotesSignature = signature;
  renderTopbarNoteButtons();
  const messages = marqueeMessages();
  if (messages.length && marqueeMotion?.track?.isConnected) {
    marqueeMotion.messages = messages;
    marqueeMotion.round = [];
    marqueeMotion.roundIndex = 0;
  }
  else renderMarquee();
}
function renderSessionNoteButtons() {
  const root = $('#session-note-buttons');
  if (!root) return;
  closeSessionNoteMenu();
  const notes = orderedPinnedNotes('pinnedToSessionBar', 'sessionOrder');
  root.innerHTML = `${notes.map((note) => `<button type="button" class="note-button session-note-button color-${taskColor(note)}${customColors[taskColor(note)] ? ' custom-color' : ''}"${customColorStyle(taskColor(note))} data-session-note="${esc(note.id)}" data-note-id="${esc(note.id)}" data-note-placement="session" aria-label="${esc(noteLabel(note))}" aria-haspopup="menu" aria-expanded="false" title="选择发送方式">${noteInitialMarkup(note)}</button>`).join('')}<button type="button" class="note-button note-add-button" data-new-session-note aria-label="新建会话便签" title="新建会话便签">＋</button>`;
}
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
const titleAnimations = new WeakMap();
function nativeTooltip(value) {
  return String(value || '').split('\n').map((line) => {
    const chars = [...line];
    const lines = [];
    while (chars.length > 32) lines.push(chars.splice(0, 32).join(''));
    lines.push(chars.join(''));
    return lines.join('\n');
  }).join('\n');
}
function titleIsHovered(node) {
  const owner = node.closest('.session-task-heading, .session-child-session, .session-title-row');
  return Boolean(owner && (owner.matches(':hover') || owner.matches(':focus-within')));
}
function syncTitleMarquee(node, overflowing) {
  const current = titleAnimations.get(node);
  if (!overflowing || !titleIsHovered(node) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    current?.animation.cancel();
    titleAnimations.delete(node);
    return;
  }
  const distance = Math.max(0, node.scrollWidth - node.clientWidth);
  if (current?.distance === distance) return;
  current?.animation.cancel();
  // 从当前位置立即开始匀速滚动，避免悬浮时先向后“弹”一下。
  const animation = node.animate([
    { transform: 'translateX(0)' },
    { transform: `translateX(${-distance}px)` },
  ], { duration: (distance / TITLE_MARQUEE_SPEED) * 1000, iterations: Infinity, direction: 'alternate', easing: 'linear', fill: 'both' });
  titleAnimations.set(node, { animation, distance });
}
function syncOverflowTooltips(root = document) {
  root.querySelectorAll('[data-tooltip]').forEach((node) => {
    const overflowing = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight + 1;
    const scrollingTitle = node.matches('.session-title-text');
    // 侧栏标题用悬停滚动展示全文，不再触发浏览器原生全文提示框。
    node.title = scrollingTitle ? '' : (overflowing ? nativeTooltip(node.dataset.tooltip) : '');
    node.classList.toggle('is-overflowing', overflowing);
    node.closest('.session-title-text-viewport')?.classList.toggle('is-overflowing', scrollingTitle && overflowing);
    if (scrollingTitle) syncTitleMarquee(node, overflowing);
  });
}
const overflowTooltipObserver = new MutationObserver(() => requestAnimationFrame(() => syncOverflowTooltips()));
overflowTooltipObserver.observe(document.body, { childList: true, subtree: true });
// 悬停时右侧操作按钮会出现并触发布局过渡；等过渡结束后再测量，避免动画先按旧宽度前进、再被重置后退。
document.addEventListener('mouseover', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (item) setTimeout(() => syncOverflowTooltips(item), 180);
});
document.addEventListener('focusin', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (item) setTimeout(() => syncOverflowTooltips(item), 180);
});
document.addEventListener('mouseout', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (!item || item.contains(event.relatedTarget)) return;
  requestAnimationFrame(() => syncOverflowTooltips(item));
});
document.addEventListener('focusout', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (!item || item.contains(event.relatedTarget)) return;
  requestAnimationFrame(() => syncOverflowTooltips(item));
});
document.addEventListener('transitionend', (event) => {
  const target = event.target;
  if (!(target instanceof Element) || event.propertyName !== 'padding-right') return;
  if (!target.matches('.session-task-title, .session-child-open')) return;
  const item = target.closest('.session-task-heading, .session-child-session');
  if (item) syncOverflowTooltips(item);
});
function renderStats() {
  const counts = { unfinished: 0, done: 0 };
  let overdue = 0;
  state.tasks.forEach((task) => { if (counts[task.status] !== undefined) counts[task.status]++; if (task.overdue) overdue++; });
  $('#stats').innerHTML = ['unfinished', 'done'].map((key) => `<span class="chip ${STATUS[key].cls}">${STATUS[key].label} ${number(counts[key])}</span>`).join('') + (overdue ? `<span class="chip overdue">逾期 ${number(overdue)}</span>` : '');
}
const GROUP_ICONS = { '': '▦', unfinished: '○', done: '✓', archived: '✕' };
const STATUS_ICONS = { unfinished: '○', done: '✓', archived: '✕' };
function syncArchiveButton() {
  const button = $('#archive-toggle');
  if (!button) return;
  const count = state.tasks.filter((task) => task.status === 'archived').length + state.notes.filter((note) => note.status === 'archived').length;
  button.title = `回收站${count ? `（${count}）` : ''}`;
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('active', state.status === 'archived');
}
// 兼容旧的刷新调用；任务/便签筛选已移至顶部内容入口。
function renderTaskSidebar() {
  syncArchiveButton();
  syncModuleTabs();
}
function syncBoardFilter() {
  const root = $('#board-filter-tabs');
  const activeTasks = state.tasks.filter((task) => task.status !== 'archived');
  const activeNotes = state.notes.filter((note) => note.status !== 'archived');
  const archivedTasks = state.tasks.filter((task) => task.status === 'archived');
  const archivedNotes = state.notes.filter((note) => note.status === 'archived');
  let options;
  if (state.status === 'archived') {
    options = [
      ['all', '全部', archivedTasks.length + archivedNotes.length, state.archiveType === 'all', 'archive'],
      ['tasks', '任务', archivedTasks.length, state.archiveType === 'tasks', 'archive'],
      ['notes', '便签', archivedNotes.length, state.archiveType === 'notes', 'archive'],
    ];
  } else if (state.boardType === 'notes') {
    options = [
      ['all', '全部', activeNotes.length, state.noteFilter === 'all', 'note'],
      ['normal', '无标记', activeNotes.filter((note) => !note.pinnedToTopBar && !note.pinnedToSessionBar).length, state.noteFilter === 'normal', 'note'],
      ['topbar', '提醒标记', activeNotes.filter((note) => note.pinnedToTopBar).length, state.noteFilter === 'topbar', 'note'],
      ['session', '会话标记', activeNotes.filter((note) => note.pinnedToSessionBar).length, state.noteFilter === 'session', 'note'],
    ];
  } else {
    options = [
      ['', '全部', activeTasks.length, !state.status, 'task'],
      ['unfinished', '未完成', activeTasks.filter((task) => task.status === 'unfinished').length, state.status === 'unfinished', 'task'],
      ['done', '已完成', activeTasks.filter((task) => task.status === 'done').length, state.status === 'done', 'task'],
    ];
  }
  root.innerHTML = options.map(([value, label, count, active, type]) => `<button type="button" class="board-filter-option${active ? ' active' : ''}" data-filter-value="${esc(value)}" data-filter-type="${type}" aria-label="${esc(label)}" aria-pressed="${active}"><span>${esc(label)}</span><b>${number(count)}</b></button>`).join('');
  root.setAttribute('aria-label', state.status === 'archived' ? '回收站筛选' : state.boardType === 'notes' ? '便签筛选' : '任务筛选');
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
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 8 8M14 4l6 6-3 1-3 5-2 2-5-3-1 3-2-2 2-2 5-3 1-3-6-6Z"/></svg>',
  topbar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16M8 7h.01M11 7h.01"/></svg>',
  session: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12h5"/></svg>',
};
function actionButton(action, id, label, iconName, className = '', pressed = null) {
  const pressedAttribute = pressed === null ? '' : ` aria-pressed="${pressed}"`;
  return `<button type="button" class="icon-button ${className}" data-action="${action}" data-id="${esc(id)}" title="${label}" aria-label="${label}"${pressedAttribute}>${ACTION_ICONS[iconName]}</button>`;
}
function actions(task) {
  if (task.status === 'archived') return `${actionButton('open-archived-session', task.id, '打开会话', 'open', 'primary')}${actionButton('restore', task.id, '恢复任务', 'restore')}${actionButton('purge', task.id, '永久删除', 'purge', 'danger')}`;
  if (task.status === 'unfinished') {
    const openAction = availableSessions(task).length ? 'session' : 'execute';
    return `${actionButton(openAction, task.id, '打开会话', 'open', 'primary')}${actionButton('complete', task.id, '标记完成', 'complete')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  }
  if (task.status === 'done') return `${actionButton('session', task.id, '打开会话', 'open', 'primary')}${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  return `${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
}
function card(task, compact = false) {
  const archiveInfo = task.status === 'archived' ? `<div class="archive-info">废弃 · ${time(task.archivedAt)}</div>` : '';
  const folder = task.workingDir ? `<span class="task-folder" data-tooltip="${esc(task.workingDir)}">${ACTION_ICONS.folder} ${esc(task.workingDir)}</span>` : '';
  const description = task.description?.trim();
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  return `<article class="card ${task.status} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row"><span class="card-status-icon ${task.status}" role="img" aria-label="状态：${esc(STATUS[task.status]?.label || '未知')}" title="${esc(STATUS[task.status]?.label || '未知状态')}">${STATUS_ICONS[task.status] || '•'}</span><h3 class="card-title" data-tooltip="${esc(task.title)}">${esc(task.title)}</h3><span class="spacer"></span>${task.deadline ? `<span class="deadline ${task.overdue ? 'overdue' : ''}">${ACTION_ICONS.calendar} ${deadline(task.deadline)}${task.overdue ? ' · 逾期' : ''}</span>` : ''}</div>${folder}</div></div>${description ? `<p class="card-desc" data-tooltip="${esc(description)}">${esc(description)}</p>` : ''}${archiveInfo}<div class="card-actions">${actions(task)}</div></article>`;
}
function visibleNotes() {
  const archived = state.status === 'archived';
  const query = state.search.toLowerCase();
  return state.notes.filter((note) => {
    if (archived) {
      if (note.status !== 'archived') return false;
    } else {
      if (note.status === 'archived') return false;
      if (state.noteFilter === 'normal' && (note.pinnedToTopBar || note.pinnedToSessionBar)) return false;
      if (state.noteFilter === 'topbar' && !note.pinnedToTopBar) return false;
      if (state.noteFilter === 'session' && !note.pinnedToSessionBar) return false;
    }
    return !query || `${note.title} ${note.description}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    if (state.sort === 'deadline') return (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity) || new Date(b.updatedAt) - new Date(a.updatedAt);
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
function noteCard(note, compact = false) {
  const colorKey = taskColor(note);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  const title = note.title?.trim();
  const deadlineText = note.deadline ? `<span class="deadline ${note.overdue ? 'overdue' : ''}">${ACTION_ICONS.calendar} ${deadline(note.deadline)}${note.overdue ? ' · 逾期' : ''}</span>` : '';
  const archiveInfo = note.status === 'archived' ? `<div class="archive-info">废弃${note.archivedAt ? ` · ${time(note.archivedAt)}` : ''}</div>` : '';
  const actionsHtml = note.status === 'archived'
    ? `${actionButton('restore-note', note.id, '恢复便签', 'restore')}${actionButton('purge-note', note.id, '永久删除便签', 'purge', 'danger')}`
    : `${actionButton('edit-note', note.id, '编辑便签', 'edit')}${actionButton('toggle-top-note', note.id, note.pinnedToTopBar ? '取消提醒标记' : '提醒标记', 'topbar', note.pinnedToTopBar ? 'note-pin-active' : '', note.pinnedToTopBar)}${actionButton('toggle-session-note', note.id, note.pinnedToSessionBar ? '取消会话标记' : '会话标记', 'session', note.pinnedToSessionBar ? 'note-pin-active' : '', note.pinnedToSessionBar)}${actionButton('delete-note', note.id, '废弃便签', 'delete', 'danger')}`;
  return `<article class="card note-card${note.status === 'archived' ? ' archived' : ''} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row">${title ? `<h3 class="card-title" data-tooltip="${esc(title)}">${esc(title)}</h3>` : '<span class="spacer"></span>'}${title ? '<span class="spacer"></span>' : ''}${deadlineText}</div></div></div><p class="card-desc" data-tooltip="${esc(note.description)}">${esc(note.description)}</p>${archiveInfo}<div class="card-actions">${actionsHtml}</div></article>`;
}
const NOTE_CATEGORY_GROUPS = [
  { label: '无标记', match: (note) => !note.pinnedToTopBar && !note.pinnedToSessionBar },
  { label: '提醒标记', match: (note) => note.pinnedToTopBar && !note.pinnedToSessionBar },
  { label: '会话标记', match: (note) => note.pinnedToSessionBar && !note.pinnedToTopBar },
  { label: '提醒标记 + 会话标记', match: (note) => note.pinnedToTopBar && note.pinnedToSessionBar },
];
function noteGroups(notes) {
  if (state.boardGroup === 'color') return Object.entries(colorCatalog()).map(([key, value]) => ({ label: value.label, items: notes.filter((note) => taskColor(note) === key) })).filter((group) => group.items.length > 0);
  if (state.boardGroup === 'noteCategory') return NOTE_CATEGORY_GROUPS.map((group) => ({ label: group.label, items: notes.filter(group.match) })).filter((group) => group.items.length > 0);
  return [{ label: '便签', items: notes }];
}
function renderNotesList() {
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle(); syncBoardFilter(); syncSortControl(); syncCardLayoutControl(); syncBoardGroupOptions();
  const notes = visibleNotes();
  const groups = noteGroups(notes);
  const compact = state.boardCardLayout === 'compact';
  const empty = `<div class="task-board-empty"><strong>${state.search ? '没有匹配的便签' : '还没有便签'}</strong><p>${state.search ? '试试调整搜索词。' : '创建一张便签，记录临时想法。'}</p>${state.search ? '<button type="button" data-action="clear-note-filters">清除搜索</button>' : ''}</div>`;
  const board = notes.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head"><span class="badge board-group-badge" title="${esc(group.label)}">${esc(group.label)}</span><b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((note) => noteCard(note, compact)).join('')}</div></section>`).join('') : empty;
  $('#task-list').innerHTML = `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list')); syncOverflowTooltips($('#task-list'));
}
function archivedGroups(items) {
  if (state.boardGroup === 'color') return Object.entries(colorCatalog()).map(([key, value]) => ({ label: value.label, items: items.filter((item) => taskColor(item.value) === key) })).filter((group) => group.items.length > 0);
  if (state.archiveType === 'all' && state.boardGroup === 'kind') return [
    { label: '任务', items: items.filter((item) => item.kind === 'task') },
    { label: '便签', items: items.filter((item) => item.kind === 'note') },
  ].filter((group) => group.items.length > 0);
  if (state.archiveType === 'tasks' && state.boardGroup === 'status') {
    return ['unfinished', 'done', 'archived'].map((key) => ({ label: STATUS[key].label, items: items.filter((item) => (item.value.archivedFromStatus || item.value.status) === key) })).filter((group) => group.items.length > 0);
  }
  if (state.archiveType === 'tasks' && state.boardGroup === 'path') {
    const groups = new Map();
    items.forEach((item) => {
      const key = item.value.workingDir || '未设置工作路径';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, groupItems]) => ({ label, items: groupItems }));
  }
  if (state.archiveType === 'notes' && state.boardGroup === 'noteCategory') return NOTE_CATEGORY_GROUPS.map((group) => ({ label: group.label, items: items.filter((item) => group.match(item.value)) })).filter((group) => group.items.length > 0);
  return [{ label: '废弃卡片', items }];
}
function renderArchivedList() {
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle(); syncBoardFilter(); syncSortControl(); syncCardLayoutControl(); syncBoardGroupOptions();
  const items = [
    ...(state.archiveType === 'all' || state.archiveType === 'tasks' ? visibleTasks().map((task) => ({ kind: 'task', value: task })) : []),
    ...(state.archiveType === 'all' || state.archiveType === 'notes' ? visibleNotes().map((note) => ({ kind: 'note', value: note })) : []),
  ].sort((a, b) => new Date(b.value.updatedAt) - new Date(a.value.updatedAt));
  const groups = archivedGroups(items);
  const compact = state.boardCardLayout === 'compact';
  const board = items.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head"><span class="badge board-group-badge">${esc(group.label)}</span><b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((item) => item.kind === 'task' ? card(item.value, compact) : noteCard(item.value, compact)).join('')}</div></section>`).join('') : '<div class="task-board-empty"><strong>回收站为空</strong></div>';
  $('#task-list').innerHTML = `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list')); syncOverflowTooltips($('#task-list'));
}
function boardGroupOptions() {
  if (state.status === 'archived') {
    if (state.archiveType === 'tasks') return [{ value: 'single', label: '全部' }, { value: 'status', label: '任务状态' }, { value: 'path', label: '工作路径' }, { value: 'color', label: '颜色' }];
    if (state.archiveType === 'notes') return [{ value: 'single', label: '全部' }, { value: 'noteCategory', label: '便签标记' }, { value: 'color', label: '颜色' }];
    return [{ value: 'single', label: '全部' }, { value: 'kind', label: '卡片类别' }, { value: 'color', label: '颜色' }];
  }
  if (state.boardType === 'notes') {
    const options = [{ value: 'single', label: '全部' }, { value: 'color', label: '按颜色' }];
    if (state.noteFilter === 'all') options.push({ value: 'noteCategory', label: '按便签类别' });
    return options;
  }
  const options = [{ value: 'single', label: '全部' }];
  if (!state.status) options.push({ value: 'status', label: '按状态' });
  options.push({ value: 'path', label: '按路径' }, { value: 'color', label: '按颜色' });
  return options;
}
function syncBoardGroupOptions() {
  const options = boardGroupOptions();
  const fallback = options[0]?.value || 'single';
  if (!options.some((option) => option.value === state.boardGroup)) updateViewSetting('boardGroup', fallback);
  const option = options.find((item) => item.value === state.boardGroup) || options[0];
  const button = $('#board-group-toggle');
  button.innerHTML = BOARD_GROUP_ICONS[option.value];
  button.title = `分布：${option.label}（点击切换）`;
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
  return [{ label: state.status ? STATUS[state.status]?.label || '当前分组' : '任务', items: tasks }];
}
function renderList() {
  if (state.status === 'archived') return renderArchivedList();
  if (state.boardType === 'notes') return renderNotesList();
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle();
  syncBoardFilter();
  syncSortControl();
  syncCardLayoutControl();
  syncBoardGroupOptions();
  const tasks = visibleTasks();
  const groups = boardGroups(tasks);
  const compact = state.boardCardLayout === 'compact';
  const clearArchived = state.status === 'archived' && tasks.length ? '<div class="archive-actions"><button type="button" class="danger" data-action="purge-archived">全部清空</button></div>' : '';
  const hasFilters = Boolean(state.search || state.status);
  const emptyState = `<div class="task-board-empty"><strong>${hasFilters ? '没有匹配的任务' : '还没有任务'}</strong><p>${hasFilters ? '试试调整搜索词或清除筛选条件。' : '创建一个任务，开始你的下一次执行。'}</p>${hasFilters ? '<button type="button" data-action="clear-filters">清除筛选</button>' : ''}</div>`;
  const board = groups.length && tasks.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head"><span class="badge ${group.badgeClass || 'board-group-badge'}" title="${esc(group.label)}">${esc(group.label)}</span><b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((task) => card(task, compact)).join('') || '<div class="task-board-empty">暂无任务</div>'}</div></section>`).join('') : emptyState;
  $('#task-list').innerHTML = clearArchived + `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
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
  return state.tasks.filter((task) => (availableSessions(task).length > 0 || state.sessionTaskIds.has(task.id)) && !state.hiddenCompletedSessionTasks.has(task.id));
}
function renderSessionHeader() {
  const task = currentTask(state.sessionTask);
  renderSessionNoteButtons();
  $('#session-view').classList.toggle('no-session', !task);
  const child = availableSessions(task).find((session) => session.id === state.sessionSessionId);
  const sessionName = child ? (child.title || '新会话') : (task ? '新会话' : '选择一个子会话');
  $('#session-name').textContent = sessionName;
  $('#session-name').dataset.tooltip = sessionName;
  syncOverflowTooltips($('#session-name').parentElement);
  requestAnimationFrame(() => syncOverflowTooltips($('#session-name').parentElement));
  if (!task) {
    sessionTaskDetailsOpen = false;
    sessionActionMenuOpen = false;
  }
  const sessionActionsButton = $('#copy-session-file');
  const actionMenu = $('#session-action-menu');
  const description = task?.description?.trim() || '';
  const sessionPath = child?.sessionFile || '';
  sessionActionsButton.disabled = !task;
  sessionActionsButton.title = task ? '会话操作' : '暂无会话操作';
  sessionActionsButton.setAttribute('aria-label', sessionActionsButton.title);
  sessionActionsButton.setAttribute('aria-expanded', String(Boolean(task && sessionActionMenuOpen)));
  actionMenu.classList.toggle('hidden', !task || !sessionActionMenuOpen);
  $('#session-action-copy-command').disabled = !sessionPath;
  $('#session-action-copy-description').disabled = !description;
  $('#session-task-details-panel').classList.toggle('hidden', !task || !sessionTaskDetailsOpen);
  $('#session-task-title-detail').textContent = task?.title || '暂无任务标题';
  $('#session-description-text').textContent = description || '暂无任务描述';
  $('#session-file-path-detail').textContent = sessionPath || '暂无会话文件路径';
  $('#session-task-select').innerHTML = '<option value="">选择一个任务会话</option>' + sessionTasks().filter((item) => availableSessions(item).length > 0).map((item) => `<option value="${item.id}"${item.id === state.sessionTask ? ' selected' : ''}>${esc(item.title)}</option>`).join('');
}
function closeSessionTaskDetails() {
  if (!sessionTaskDetailsOpen) return;
  sessionTaskDetailsOpen = false;
  renderSessionHeader();
}
function closeSessionActionMenu() {
  if (!sessionActionMenuOpen) return;
  sessionActionMenuOpen = false;
  const menu = $('#session-action-menu');
  const button = $('#copy-session-file');
  menu?.classList.add('hidden');
  button?.setAttribute('aria-expanded', 'false');
}
function syncSessionTreeUnread(tasks) {
  const root = $('#session-tree');
  for (const task of tasks) {
    for (const session of availableSessions(task)) {
      const row = [...root.querySelectorAll('.session-child-session')].find((item) => item.dataset.sessionTask === task.id && item.dataset.sessionId === session.id);
      if (!row) continue;
      const current = state.module === 'session' && state.sessionTask === task.id && state.sessionSessionId === session.id;
      const unread = current ? 0 : (Number(session.unreadCount) || 0);
      const title = session.title || '新会话';
      const unreadLabel = unread > 99 ? '99+' : String(unread);
      row.querySelector('.child-dot')?.classList.toggle('has-unread', unread > 0);
      row.querySelector('.session-child-open')?.setAttribute('aria-label', `${title}${unread ? `，${unreadLabel}条未读消息` : ''}`);
    }
  }
}
function sessionItemMarkup(task, session, index) {
  const title = session.title || `子会话 ${index + 1}`;
  const current = state.module === 'session' && state.sessionTask === task.id && state.sessionSessionId === session.id;
  const unread = current ? 0 : (Number(session.unreadCount) || 0);
  const unreadLabel = unread > 99 ? '99+' : String(unread);
  return `<div class="session-child-session${current ? ' active' : ''}" data-session-task="${esc(task.id)}" data-session-id="${esc(session.id)}"><button type="button" class="session-child-open" aria-label="${esc(title)}${unread ? `，${unreadLabel}条未读消息` : ''}"><span class="child-dot${unread ? ' has-unread' : ''}" aria-hidden="true"></span><span class="session-title-text-viewport"><span class="session-child-name session-title-text" data-tooltip="${esc(title)}">${esc(title)}</span></span></button><button type="button" class="session-child-delete" data-delete-session="${esc(task.id)}" data-session-id="${esc(session.id)}" title="删除子会话" aria-label="删除子会话">×</button></div>`;
}
function sessionGroupMarkup(task) {
  const collapsed = state.collapsedSessionTasks.has(task.id);
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  const taskActions = `<button type="button" class="session-new-child" data-new-session-task="${esc(task.id)}" title="新建子会话" aria-label="为${esc(task.title)}新建子会话">＋</button><button type="button" class="session-remove-task" data-remove-completed-task="${esc(task.id)}" title="从会话管理移除" aria-label="从会话管理移除${esc(task.title)}">×</button>`;
  const sessions = availableSessions(task).map((session, index) => sessionItemMarkup(task, session, index)).join('');
  const items = collapsed ? '' : sessions;
  return `<div class="session-task-group"><div class="session-task-heading"><button type="button" class="session-task-title color-${colorKey}${customClass}"${customColorStyle(colorKey)} data-session-group="${esc(task.id)}" aria-label="${esc(task.title)}" aria-expanded="${!collapsed}"><span aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span class="session-title-text-viewport"><span class="session-title-text task-status-${esc(task.status)}" data-tooltip="${esc(task.title)}">${esc(task.title)}</span></span></button>${taskActions}</div>${items}</div>`;
}
function renderSessionTree() {
  renderSessionHeader();
  const tasks = sessionTasks();
  // 终端输入/输出也会触发刷新；树结构未变化时不要重建 DOM，避免标题滚动动画从头开始。
  const treeSignature = JSON.stringify({
    module: state.module,
    sessionTask: state.sessionTask,
    sessionSessionId: state.sessionSessionId,
    collapsed: [...state.collapsedSessionTasks].sort(),
    tasks: tasks.map((task) => [task.id, task.title, task.status, task.color, availableSessions(task).map((session) => [session.id, session.title])]),
  });
  if (treeSignature === renderedSessionTreeSignature) {
    syncSessionTreeUnread(tasks);
    return;
  }
  renderedSessionTreeSignature = treeSignature;
  $('#session-tree').innerHTML = tasks.length
    ? tasks.map(sessionGroupMarkup).join('')
    : '<div class="empty sidebar-empty">暂无可打开的会话</div>';
  syncOverflowTooltips($('#session-tree'));
  syncSessionTreeUnread(tasks);
}
async function refresh() {
  try {
    const [data, noteData] = await Promise.all([api('/tasks'), api('/notes')]);
    const signature = JSON.stringify({ tasks: data.tasks.map((task) => [task.id, task.status, task.updatedAt, task.activeSessionId, task.sessions?.length]), notes: noteData.notes.map((note) => [note.id, note.updatedAt, note.pinnedToTopBar, note.pinnedToSessionBar]) });
    state.tasks = data.tasks;
    state.notes = noteData.notes;
    renderPinnedNotes();
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
        if (task && sessionTasks().some((item) => item.id === task.id) && availableSessions(task).length > 0) selectSession(task.id, state.sessionSessionId, { record: false });
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
  // CSS 是主题字体的唯一来源；xterm 与工作台主题共享同一变量。
  const configured = getComputedStyle(document.body).getPropertyValue('--terminal-font-family').trim();
  if (configured) return configured;
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  const mac = /mac/i.test(platform);
  if (document.body.classList.contains('theme-geek')) {
    return mac
      ? '"JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"JetBrains Mono", "DengXian", "等线", "Microsoft YaHei UI", monospace';
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
  return mac
    ? '"SFMono-Regular", Menlo, "PingFang SC", monospace'
    : 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace';
}
function terminalTheme() {
  const styles = getComputedStyle(document.body);
  const cssVar = (name, fallback) => styles.getPropertyValue(name).trim() || styles.getPropertyValue(fallback).trim();
  const background = cssVar('--terminal', '--bg');
  const foreground = cssVar('--terminal-ink', '--ink');
  const muted = cssVar('--terminal-muted', '--muted');
  const accent = cssVar('--terminal-accent', '--accent');
  const selectionBackground = cssVar('--terminal-selection', '--accent-soft');
  const dark = isTerminalDark();
  let theme = 'classic';
  if (document.body.classList.contains('theme-geek')) theme = 'geek';
  else if (document.body.classList.contains('theme-newspaper')) theme = 'newspaper';
  else if (document.body.classList.contains('theme-aurora')) theme = 'aurora';
  const palettes = {
    classic: {
      light: { black: '#172b36', red: '#c84822', green: '#2f855a', yellow: '#a16207', blue: '#075985', magenta: '#7c3aed', cyan: '#078c86', white: '#fbfcfa' },
      dark: { black: '#10252d', red: '#ff8b72', green: '#7fd69b', yellow: '#f6c85f', blue: '#8cc8ff', magenta: '#d4a5ff', cyan: '#67d8d1', white: '#e6f0ed' },
    },
    geek: {
      light: { black: '#17251f', red: '#b42318', green: '#166534', yellow: '#8a5a00', blue: '#075985', magenta: '#6b21a8', cyan: '#0f766e', white: '#fbfdfb' },
      dark: { black: '#0b120e', red: '#fb7185', green: '#4ade80', yellow: '#facc15', blue: '#7dd3fc', magenta: '#c4b5fd', cyan: '#5eead4', white: '#e5f3ea' },
    },
    aurora: {
      light: { black: '#25213f', red: '#c2415d', green: '#2f855a', yellow: '#a16207', blue: '#0ea5e9', magenta: '#7c3aed', cyan: '#0f8fa5', white: '#ffffff' },
      dark: { black: '#0e1020', red: '#ff9ba9', green: '#83d995', yellow: '#f5c451', blue: '#82cfff', magenta: '#c4a8ff', cyan: '#67e8f9', white: '#f3efff' },
    },
    newspaper: {
      light: { black: '#28231d', red: '#a3332f', green: '#39704b', yellow: '#936b12', blue: '#385d82', magenta: '#78506f', cyan: '#3e6d68', white: '#fffaf0' },
      dark: { black: '#171716', red: '#c98972', green: '#9baea4', yellow: '#d1b56e', blue: '#9aafba', magenta: '#b99bad', cyan: '#9baea4', white: '#eee6d5' },
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
function focusTerminalInput() {
  if (!terminal || state.module !== 'session') return false;
  const input = terminal.textarea || terminal.element?.querySelector('.xterm-helper-textarea');
  if (!input) return false;
  input.autofocus = true;
  input.focus({ preventScroll: true });
  return document.activeElement === input;
}
function ensureTerminalInputFocus() {
  if (terminalFocusRetryTimer !== null) clearTimeout(terminalFocusRetryTimer);
  let attempts = 0;
  const focus = () => {
    terminalFocusRetryTimer = null;
    if (state.module !== 'session' || !terminal || focusTerminalInput()) return;
    if (attempts >= 5) return;
    attempts += 1;
    terminalFocusRetryTimer = setTimeout(focus, 50);
  };
  focus();
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
  clearTerminalSearch();
  terminalSearchAddon?.dispose(); terminalSearchAddon = null;
  terminalResizeObserver?.disconnect(); terminalResizeObserver = null;
  terminalCursorSubscription?.dispose(); terminalCursorSubscription = null;
  terminalWriteParsedSubscription?.dispose(); terminalWriteParsedSubscription = null;
  clearQueuedTerminalWrite();
  if (terminalFocusRetryTimer !== null) clearTimeout(terminalFocusRetryTimer);
  terminalFocusRetryTimer = null;
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
  // 动态加载 xterm 期间可能再次切换会话。等待当前打开动作结束后，
  // 只为最后仍然选中的会话继续打开，避免旧请求把新请求吞掉。
  const taskId = state.sessionTask;
  const sessionId = state.sessionSessionId;
  if (tuiOpening) {
    try { await tuiOpening; } catch { /* 当前打开失败，下面仍可尝试最新会话 */ }
    if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId || tuiSocket) return;
  }
  const task = currentTask(taskId);
  if (!task) return toast('请先选择一个会话', 'error');
  const session = availableSessions(task).find((item) => item.id === sessionId);
  if (!session) return toast('没有可用的历史会话', 'error');
  tuiOpening = (async () => {
    detachTui();
    document.body.classList.add('tui-active');
    const box = $('#session-terminal');
    try {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([import('/vendor/xterm/lib/xterm.mjs'), import('/vendor/xterm-fit/addon-fit.mjs'), import('/vendor/xterm-search/addon-search.mjs')]);
      if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
      terminal = new Terminal({ cursorBlink: false, cursorStyle: 'bar', cursorWidth: 2, convertEol: true, scrollback: 10000, scrollOnUserInput: false, fontSize: 13, fontFamily: terminalFontFamily(), theme: terminalTheme() });
      const browserPlatform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
      const isWindowsBrowser = /^win/i.test(browserPlatform);
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === 'f') {
          event.preventDefault();
          event.stopPropagation();
          focusTerminalSearch(true);
          return false;
        }
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
      fitAddon = new FitAddon(); terminal.loadAddon(fitAddon); terminal.open(box); fitAddon.fit();
      terminalSearchAddon = new SearchAddon();
      terminal.loadAddon(terminalSearchAddon);
      searchTerminal();
      ensureTerminalInputFocus();
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
        // 防止旧会话延迟到达的 WebSocket 帧污染当前终端。
        if (tuiSocket !== socket || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'tui_hello', taskId, sessionId, cols: terminal.cols, rows: terminal.rows, theme: isTerminalDark() ? 'dark' : 'light' }));
        requestAnimationFrame(() => requestAnimationFrame(sendSize));
      };
      socket.onmessage = ({ data }) => {
        if (tuiSocket !== socket || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'tui_reset') { clearQueuedTerminalWrite(); terminal?.reset(); sendSize(); }
          else if (event.type === 'tui_data') queueTerminalWrite(event.data || '');
          else if (event.type === 'tui_exit') queueTerminalWrite(`\r\n\r\n[工作台] pi 已退出（${event.exitCode ?? '未知'}）。\r\n`);
          else if (event.type === 'tui_error') {
            const error = event.error || '终端错误';
            // Ignore stale frames emitted while a PTY is already exiting.
            if (error === '会话未运行') return;
            toast(error, 'error');
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onerror = () => toast('会话连接失败，请查看服务终端中的错误信息', 'error');
      socket.onclose = () => {
        const current = tuiSocket === socket;
        if (current) tuiSocket = null;
        if (current && state.sessionTask === taskId && state.sessionSessionId === sessionId && terminal) queueTerminalWrite('\r\n[工作台] 终端连接已断开，点击“重新连接”可恢复。\r\n');
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
    await api(`/tasks/${taskId}/tui/restart`, { method: 'POST', body: { sessionId: state.sessionSessionId } });
  } catch { /* the process may already have exited */ }
  await refresh();
  if (state.sessionTask === taskId) await openNativeTui();
}
async function restartTuiForTheme() {
  if (!state.sessionTask || !tuiSocket) return;
  await restartCurrentTui('主题已切换，正在重启会话…');
}
function selectSession(taskId, sessionId = null, { record = true } = {}) {
  if (state.module !== 'session') switchModule('session');
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
  if (taskId && nextSessionId) rememberLastOpenedSession(taskId, nextSessionId);
  rememberCurrentSessionMessage();
  renderSessionTree();
  saveLayoutState();
  if (record) recordWorkspaceView();
  if (taskId) return openNativeTui();
  return Promise.resolve();
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
function openNoteForm(note = null, options = {}) {
  const editing = Boolean(note);
  const form = modal(`<h2>${editing ? '编辑便签' : '新建便签'}</h2><label for="note-title">标题（可选）<input id="note-title" autocomplete="off" value="${esc(note?.title || '')}"></label><label for="note-desc">描述<textarea id="note-desc" autocomplete="off" rows="5">${esc(note?.description || '')}</textarea><span class="field-error hidden" data-error-for="note-desc" role="alert"></span></label><div class="row"><label>颜色<div class="color-selector"><button type="button" id="note-color-trigger" class="color-trigger" aria-expanded="false" aria-controls="note-color-picker"><span id="note-color-swatch" class="color-trigger-swatch" aria-hidden="true"></span><span id="note-color-label"></span></button><div id="note-color-picker" class="color-picker hidden" role="group" aria-label="颜色选项"></div><input id="note-custom-color-value" class="color-native-input" type="color" aria-label="新增颜色" value="#E85F32"></div><input type="hidden" id="note-color" value="${taskColor(note || {})}"></label><label for="note-deadline">截止<input id="note-deadline" type="datetime-local" value="${esc(note?.deadline || '')}"></label></div><label class="note-switch"><input id="note-topbar" type="checkbox"${(note?.pinnedToTopBar || options.pinnedToTopBar) ? ' checked' : ''}> 是否启用提醒标记</label><label class="note-switch"><input id="note-sessionbar" type="checkbox"${(note?.pinnedToSessionBar || options.pinnedToSessionBar) ? ' checked' : ''}> 是否启用会话标记</label><div class="modal-actions"><button type="button" class="primary" id="save-note">${editing ? '保存' : '创建'}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  const colorPicker = $('#note-color-picker', form);
  const colorTrigger = $('#note-color-trigger', form);
  const customInput = $('#note-custom-color-value', form);
  const setPicker = (open) => { colorPicker.classList.toggle('hidden', !open); colorTrigger.setAttribute('aria-expanded', String(open)); };
  const renderPicker = () => {
    const selected = $('#note-color', form).value;
    const color = colorCatalog()[selected] || COLORS.yellow;
    $('#note-color-label', form).textContent = color.label;
    $('#note-color-swatch', form).style.background = color.value;
    const options = Object.entries(colorCatalog()).map(([key, value]) => `<div class="color-entry"><button type="button" class="color-option color-${key}${customColors[key] ? ' custom-color-option' : ''}${selected === key ? ' active' : ''}" data-note-color-value="${esc(key)}" aria-label="${esc(value.label)}" aria-pressed="${selected === key}"><span${customColors[key] ? ` style="--swatch:${esc(value.value)}"` : ''}></span></button></div>`).join('');
    colorPicker.innerHTML = `<button type="button" class="color-add" data-add-note-color title="新增颜色（最多9个，超出替换最少使用）" aria-label="新增颜色（最多9个，超出替换最少使用）">＋</button>${options}`;
  };
  colorTrigger.onclick = () => setPicker(colorPicker.classList.contains('hidden'));
  colorPicker.onclick = (event) => { const option = event.target.closest('[data-note-color-value]'); if (option) { $('#note-color', form).value = option.dataset.noteColorValue; renderPicker(); } if (event.target.closest('[data-add-note-color]')) { setPicker(false); customInput.click(); } };
  customInput.onchange = () => {
    const value = customInput.value.toLowerCase();
    const key = createCustomColor(value);
    $('#note-color', form).value = key;
    renderPicker();
  };
  form.addEventListener('click', (event) => { if (!event.target.closest('.color-selector')) setPicker(false); });
  renderPicker();
  $('#save-note', form).onclick = async () => {
    const button = $('#save-note', form);
    const description = $('#note-desc', form).value.trim();
    setFieldError(form, 'note-desc');
    if (!description) { setFieldError(form, 'note-desc', '请输入便签描述。'); $('#note-desc', form).focus(); return; }
    try {
      button.disabled = true;
      const body = {
        title: $('#note-title', form).value,
        description,
        color: $('#note-color', form).value,
        deadline: $('#note-deadline', form).value || null,
        pinnedToTopBar: $('#note-topbar', form).checked,
        pinnedToSessionBar: $('#note-sessionbar', form).checked,
      };
      const url = editing ? `/notes/${note.id}` : '/notes';
      const method = editing ? 'PUT' : 'POST';
      await api(url, { method, body });
      markCustomColorUsed(body.color);
      closeModal();
      toast(editing ? '便签已保存' : '便签已创建');
      await refresh();
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
function openDeleteNoteModal(note) {
  const form = modal(`<h2>废弃便签</h2><p>确定将这张便签移入回收站吗？</p><div class="modal-actions"><button class="danger" id="confirm-delete-note">移入回收站</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-delete-note', form).onclick = async () => {
    try {
      await api(`/notes/${note.id}`, { method: 'DELETE' });
      closeModal();
      toast('便签已移入回收站');
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
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
    colorPicker.innerHTML = '<button type="button" id="add-custom-color" class="color-add" title="新增颜色（最多9个，超出替换最少使用）" aria-label="新增颜色（最多9个，超出替换最少使用）">＋</button>' + Object.entries(colorCatalog()).map(([key, value]) => {
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
    const key = createCustomColor(value);
    $('#task-color', form).value = key;
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
      markCustomColorUsed(body.color);
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
async function restoreTask(task) {
  const result = await api(`/tasks/${task.id}/restore`, { method: 'POST' });
  // 保留当前回收站视图；刷新后恢复的卡片会从回收站列表中消失。
  // 恢复只改变任务状态；保持任务在会话列表中的原有展示状态。
  await refresh();
  saveLayoutState();
  return currentTask(task.id) || result.task;
}
async function openTaskSession(task) {
  showSessionTask(task.id);
  const sessions = availableSessions(task);
  const session = sessions.find((item) => item.id === task.activeSessionId) || sessions[0];
  if (session) await selectSession(task.id, session.id);
  else await openExecute(task);
}
function runningSessionCount(task) {
  return availableSessions(task).filter((session) => session.running).length || (task.piRunning ? 1 : 0);
}
async function completeTask(task) {
  await api(`/tasks/${task.id}/complete`, { method: 'POST' });
  state.hiddenCompletedSessionTasks.add(task.id);
  if (state.sessionTask === task.id) {
    leaveCurrentSession();
    detachTui();
    state.sessionTask = null;
    state.sessionSessionId = null;
  }
}
async function finishCompleteTask(task) {
  await completeTask(task);
  await refresh();
  saveLayoutState();
  toast('任务已完成');
}
function openCompleteTaskModal(task) {
  const runningCount = runningSessionCount(task);
  const form = modal(`<h2>完成正在运行的任务？</h2><p>任务「${esc(task.title)}」当前有 ${runningCount} 个会话正在运行。标记完成将停止运行中的会话，是否继续？</p><div class="modal-actions"><button type="button" class="danger" id="confirm-complete-task">停止并标记完成</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-complete-task', form).onclick = async () => {
    const button = $('#confirm-complete-task', form);
    button.disabled = true;
    try {
      await completeTask(task);
      closeModal();
      await refresh();
      saveLayoutState();
      toast('任务已完成');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
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
  const runningCount = runningSessionCount(task);
  const runningWarning = runningCount ? `<p class="danger">当前有 ${runningCount} 个会话正在运行，移入回收站后将关闭这些会话。</p>` : '';
  const confirmLabel = runningCount ? '关闭会话并移入废弃' : '移入废弃';
  const form = modal(`<h2>废弃任务</h2><p>确定将「${esc(task.title)}」移入废弃任务吗？之后可在回收站中恢复或永久删除。</p>${runningWarning}<div class="modal-actions"><button class="danger" id="confirm-archive-task">${confirmLabel}</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-archive-task', form).onclick = async () => {
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      state.sessionTaskIds.delete(task.id);
      state.hiddenCompletedSessionTasks.add(task.id);
      if (state.sessionTask === task.id) {
        leaveCurrentSession();
        detachTui();
        state.sessionTask = null;
        state.sessionSessionId = null;
      }
      // 废弃卡片后保留当前任务分类筛选，刷新后卡片自然从列表中移除。
      closeModal(); await refresh();
      saveLayoutState();
      toast('任务已移入废弃，可在回收站中恢复');
    } catch (error) { toast(error.message, 'error'); }
  };
}
function openPurgeTaskModal(task) {
  const form = modal(`<h2>永久删除任务</h2><p>确定永久删除「${esc(task.title)}」及其全部会话吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-task">永久删除</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-task', form).onclick = async () => { try { await api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }); closeModal(); toast('任务已永久删除'); refresh(); } catch (error) { toast(error.message, 'error'); } };
}
function openClearArchivedModal() {
  const categoryLabel = { all: '卡片', tasks: '任务', notes: '便签' }[state.archiveType] || '卡片';
  const fileSuffix = state.archiveType === 'notes' ? '' : '及其会话文件';
  const form = modal(`<h2>清空${categoryLabel}</h2><p>确定永久删除当前类别下的全部废弃${categoryLabel}${fileSuffix}吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-archived">全部清空</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-archived', form).onclick = async () => {
    const button = $('#confirm-purge-archived', form);
    button.disabled = true;
    try {
      const result = await api('/archived', { method: 'DELETE', body: { type: state.archiveType } });
      closeModal();
      toast(`已永久删除 ${result.removed || 0} 个废弃卡片`);
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
  syncArchiveButton();
  const session = state.module === 'session';
  const tasks = $('#module-tasks');
  const notes = $('#module-notes');
  const sessionTab = $('#module-sessions');
  const workspaceTasks = $('#workspace-module-tasks');
  const workspaceNotes = $('#workspace-module-notes');
  const workspaceSession = $('#workspace-module-session');
  const taskCount = state.tasks.filter((task) => task.status !== 'archived').length;
  const noteCount = state.notes.filter((note) => note.status !== 'archived').length;
  const runningSessionCount = state.tasks
    .filter((task) => task.status !== 'archived')
    .reduce((count, task) => count + availableSessions(task).filter((item) => item.running).length, 0);
  tasks.querySelector('span:nth-of-type(2)').textContent = '任务';
  notes.querySelector('span:nth-of-type(2)').textContent = '便签';
  sessionTab.querySelector('span:nth-of-type(2)').textContent = '会话';
  tasks.querySelector('.module-count').textContent = number(taskCount);
  notes.querySelector('.module-count').textContent = number(noteCount);
  sessionTab.querySelector('.module-count').textContent = number(runningSessionCount);
  tasks.setAttribute('aria-label', `任务，${number(taskCount)}个`);
  notes.setAttribute('aria-label', `便签，${number(noteCount)}个`);
  sessionTab.setAttribute('aria-label', `会话，当前运行${number(runningSessionCount)}个`);
  tasks.tabIndex = 0;
  notes.tabIndex = 0;
  sessionTab.tabIndex = 0;
  const taskActive = !session && state.status !== 'archived' && state.boardType === 'tasks';
  const noteActive = !session && state.status !== 'archived' && state.boardType === 'notes';
  const sessionActive = session;
  tasks.classList.toggle('active', taskActive);
  notes.classList.toggle('active', noteActive);
  sessionTab.classList.toggle('active', sessionActive);
  tasks.setAttribute('aria-selected', String(taskActive));
  notes.setAttribute('aria-selected', String(noteActive));
  sessionTab.setAttribute('aria-selected', String(sessionActive));
  workspaceTasks?.classList.toggle('active', taskActive);
  workspaceNotes?.classList.toggle('active', noteActive);
  workspaceSession?.classList.toggle('active', session);
  workspaceTasks?.setAttribute('aria-pressed', String(taskActive));
  workspaceNotes?.setAttribute('aria-pressed', String(noteActive));
  workspaceSession?.setAttribute('aria-pressed', String(session));
}
function switchModule(module) {
  const session = module === 'session';
  if (session && state.status === 'archived') {
    state.status = '';
    applyViewSettings();
  }
  if (!session && state.sessionTask) leaveCurrentSession();
  state.module = session ? 'session' : 'tasks';
  saveLayoutState();
  document.body.classList.toggle('session-mode', session);
  syncModuleTabs();
  // 会话树始终留在侧边栏，只有主区域在任务/便签和终端之间切换。
  $('#task-toolbar').classList.toggle('hidden', session); $('#task-list').classList.toggle('hidden', session); $('#session-view').classList.toggle('hidden', !session);
  if (session) {
    rememberCurrentSessionMessage();
    renderSessionTree();
    // 返回会话页时恢复 xterm 的输入焦点，避免焦点停留在内容切换按钮上。
    requestAnimationFrame(() => {
      if (state.module === 'session') ensureTerminalInputFocus();
    });
  } else {
    // 离开会话页后保留会话上下文，但不让侧栏继续显示选中态。
    renderSessionTree();
    renderList();
  }
}

function closeThemeMenu() {
  const menu = $('#theme-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('#style-toggle').setAttribute('aria-expanded', 'false');
}
let topbarNoteMenuAnchor = null;
function openTopbarNotePanel(note) {
  const panel = $('#topbar-note-panel');
  if (!panel) return;
  const title = note.title?.trim();
  panel.innerHTML = `${title ? `<div class="session-detail-row"><span>标题</span><p>${esc(title)}</p></div>` : ''}<div class="session-detail-row"><span>便签内容</span><p>${esc(note.description)}</p></div>`;
  panel.dataset.noteId = note.id;
  panel.classList.remove('hidden');
}
function closeTopbarNotePanel() {
  topbarNoteMenuAnchor?.setAttribute('aria-expanded', 'false');
  topbarNoteMenuAnchor = null;
  document.querySelector('.topbar-note-menu')?.remove();
  const panel = $('#topbar-note-panel');
  if (!panel) return;
  delete panel.dataset.noteId;
  panel.classList.add('hidden');
}
function openTopbarNoteMenu(button, note) {
  closeTopbarNotePanel();
  const menu = document.createElement('div');
  menu.className = 'session-note-menu topbar-note-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="session-note-menu-title">${esc(note.title?.trim() || '便签')}</div><button type="button" role="menuitem" data-topbar-note-action="details">查看详情</button><button type="button" role="menuitem" data-topbar-note-action="copy-description">复制描述</button><button type="button" role="menuitem" data-topbar-note-action="edit">编辑</button><button type="button" role="menuitem" data-topbar-note-action="remove">取消标记</button>`;
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  const top = rect.bottom + menu.offsetHeight + gap <= window.innerHeight
    ? rect.bottom + gap
    : Math.max(8, rect.top - menu.offsetHeight - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  topbarNoteMenuAnchor = button;
  button.setAttribute('aria-expanded', 'true');
  menu.onclick = (event) => {
    const action = event.target.closest('[data-topbar-note-action]');
    if (!action) return;
    closeTopbarNotePanel();
    if (action.dataset.topbarNoteAction === 'details') openTopbarNotePanel(note);
    else if (action.dataset.topbarNoteAction === 'copy-description') void copySessionNoteDescription(note);
    else if (action.dataset.topbarNoteAction === 'edit') openNoteForm(note);
    else void removeTopbarNote(note);
  };
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
  if (!event.target.closest('#topbar-note-buttons, .topbar-note-menu')) closeTopbarNotePanel();
  if (!event.target.closest('#session-note-buttons, .session-note-menu:not(.topbar-note-menu)')) closeSessionNoteMenu();
  if (!event.target.closest('#session-context-copy')) {
    closeSessionActionMenu();
    if (sessionTaskDetailsOpen) closeSessionTaskDetails();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeThemeMenu(); closeTopbarNotePanel(); closeSessionNoteMenu();
    closeSessionActionMenu();
    if (sessionTaskDetailsOpen) closeSessionTaskDetails();
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (localStorage.getItem('workbench-theme') === 'system') { applyTheme('system'); void restartTuiForTheme(); } });
function openNewBoardItem(type) {
  if (state.status === 'archived') {
    state.status = '';
    state.boardType = type;
    applyViewSettings(); renderList(); saveLayoutState();
    recordWorkspaceView();
  }
  if (type === 'notes') openNoteForm();
  else openTaskForm();
}
function openBoardType(type) {
  state.boardType = type;
  if (state.status === 'archived') state.status = '';
  applyViewSettings();
  switchModule('tasks');
  saveLayoutState();
  recordWorkspaceView();
}
function openLastSession() {
  const last = findLastOpenedSession();
  if (!last) return toast('暂无可打开的历史会话', 'error');
  showSessionTask(last.taskId);
  void selectSession(last.taskId, last.sessionId);
}
$('#module-tasks').onclick = () => openBoardType('tasks');
$('#module-notes').onclick = () => openBoardType('notes');
$('#module-sessions').onclick = openLastSession;
$('#workspace-module-tasks').onclick = () => openBoardType('tasks');
$('#workspace-module-notes').onclick = () => openBoardType('notes');
$('#workspace-module-session').onclick = openLastSession;
$('#sidebar-toggle').onclick = () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  state.sidebarCollapsed = collapsed;
  applySidebarCollapsed(collapsed);
  syncMasonryColumns();
  syncOverflowTooltips();
  localStorage.setItem('workbench-sidebar-collapsed', String(collapsed));
  saveLayoutState();
};
[$('#module-tasks'), $('#module-notes'), $('#module-sessions')].forEach((tab, index, tabs) => {
  tab.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  };
});
$('#archive-toggle').onclick = () => {
  state.status = 'archived';
  state.archiveType = 'all';
  applyViewSettings();
  switchModule('tasks');
  renderList();
  saveLayoutState();
  recordWorkspaceView();
};
// 任务入口只创建任务，不预建会话。
$('#sidebar-new-task').onclick = () => openTaskForm();
$('#sidebar-new-note').onclick = () => openNewBoardItem('notes');
$('#toolbar-new-item').onclick = () => openNewBoardItem(state.boardType);
$('#sidebar-new-session-task').onclick = () => openTaskForm(null, { openSessionAfterCreate: true });
function clearTerminalSearch() {
  const input = $('#terminal-search-input');
  if (!input) return;
  input.value = '';
  $('#terminal-search-results').textContent = '';
  terminalSearchAddon?.clearDecorations();
}
function focusTerminalSearch(select = false) {
  const panel = $('#terminal-search');
  const input = $('#terminal-search-input');
  if (!panel || !input) return;
  panel.classList.remove('hidden');
  input.focus();
  if (select) input.select();
}
function searchTerminal(previous = false) {
  const input = $('#terminal-search-input');
  const results = $('#terminal-search-results');
  const term = input?.value || '';
  if (!term) {
    terminalSearchAddon?.clearDecorations();
    if (results) results.textContent = '';
    return;
  }
  if (!terminalSearchAddon) {
    if (results) results.textContent = '终端未就绪';
    return;
  }
  const found = previous
    ? terminalSearchAddon.findPrevious(term)
    : terminalSearchAddon.findNext(term);
  if (results) results.textContent = found ? '' : '未找到';
}
$('#session-task-select').onchange = (event) => selectSession(event.target.value);
$('#terminal-search-previous').onclick = () => searchTerminal(true);
$('#terminal-search-next').onclick = () => searchTerminal();
$('#terminal-search-input').oninput = () => searchTerminal();
$('#terminal-search-input').onkeydown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    clearTerminalSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    searchTerminal(event.shiftKey);
  }
};
// 会话页的空白区域不应把焦点从终端输入框移走；真正的交互控件仍保留自己的焦点行为。
function keepTerminalFocusOnBlankArea(event) {
  if (state.module !== 'session' || !terminal || $('.modal')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('button, a, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="menuitem"], .session-name-title, .session-description-panel, .session-note-menu, .xterm')) return;
  // 阻止浏览器在空白控制带上产生临时焦点，再把焦点交还给终端。
  if (event.type === 'pointerdown') event.preventDefault();
  ensureTerminalInputFocus();
}
document.addEventListener('pointerdown', keepTerminalFocusOnBlankArea, true);
document.addEventListener('click', keepTerminalFocusOnBlankArea);
// 侧边栏按钮完成动作后也不保留按钮焦点；有弹窗时则把焦点留给弹窗。
function restoreTerminalFocusAfterSidebarInteraction(event) {
  if (state.module !== 'session' || !terminal || $('.modal')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('#app-sidebar button');
  if (!button) return;
  button.blur();
  ensureTerminalInputFocus();
}
document.addEventListener('pointerup', restoreTerminalFocusAfterSidebarInteraction);
document.addEventListener('click', restoreTerminalFocusAfterSidebarInteraction);
$('#copy-session-file').onclick = (event) => {
  event.stopPropagation();
  const task = currentTask(state.sessionTask);
  if (!task) return;
  sessionActionMenuOpen = !sessionActionMenuOpen;
  if (sessionActionMenuOpen) sessionTaskDetailsOpen = false;
  renderSessionHeader();
};
$('#session-action-menu').onclick = async (event) => {
  const action = event.target.closest('[data-session-action]');
  if (!action || action.disabled) return;
  const task = currentTask(state.sessionTask);
  const session = availableSessions(task).find((item) => item.id === state.sessionSessionId);
  const commandPath = session?.sessionFile;
  const description = task?.description?.trim();
  closeSessionActionMenu();
  if (action.dataset.sessionAction === 'details') {
    sessionTaskDetailsOpen = true;
    renderSessionHeader();
    return;
  }
  const text = action.dataset.sessionAction === 'copy-command'
    ? (commandPath ? `pi --session "${commandPath}"` : '')
    : (description || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(action.dataset.sessionAction === 'copy-command' ? 'pi 会话命令已复制' : '任务描述已复制');
  } catch {
    toast('复制失败，请手动选择内容', 'error');
  }
};
let sessionNoteMenuAnchor = null;
function closeSessionNoteMenu() {
  sessionNoteMenuAnchor?.setAttribute('aria-expanded', 'false');
  sessionNoteMenuAnchor = null;
  document.querySelector('.session-note-menu:not(.topbar-note-menu)')?.remove();
}
function openSessionNoteMenu(button, note) {
  closeSessionNoteMenu();
  const menu = document.createElement('div');
  menu.className = 'session-note-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="session-note-menu-title">${esc(note.title?.trim() || '便签')}</div><button type="button" role="menuitem" data-session-note-mode="current">发送到当前会话</button><button type="button" role="menuitem" data-session-note-mode="new">新建后台会话并发送</button><button type="button" role="menuitem" data-session-note-action="copy-description">复制描述</button><button type="button" role="menuitem" data-session-note-action="edit">编辑</button><button type="button" role="menuitem" data-session-note-action="remove">取消标记</button>`;
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  const top = rect.bottom + menu.offsetHeight + gap <= window.innerHeight
    ? rect.bottom + gap
    : Math.max(8, rect.top - menu.offsetHeight - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  sessionNoteMenuAnchor = button;
  button.setAttribute('aria-expanded', 'true');
  menu.onclick = (event) => {
    const action = event.target.closest('[data-session-note-action]');
    if (action) {
      closeSessionNoteMenu();
      if (action.dataset.sessionNoteAction === 'copy-description') void copySessionNoteDescription(note);
      else if (action.dataset.sessionNoteAction === 'edit') openNoteForm(note);
      else void removeSessionNote(note);
      return;
    }
    const option = event.target.closest('[data-session-note-mode]');
    if (!option) return;
    const mode = option.dataset.sessionNoteMode;
    closeSessionNoteMenu();
    void sendSessionNote(note, mode);
  };
}
async function sendSessionNote(note, mode) {
  const taskId = state.sessionTask;
  const sessionId = state.sessionSessionId;
  if (!taskId || !sessionId) return toast('请先打开一个会话', 'error');
  try {
    const result = await api(`/notes/${note.id}/send`, { method: 'POST', body: { taskId, sessionId, mode } });
    await refresh();
    toast(mode === 'new' ? '已在后台新建会话并发送便签' : '便签已发送到当前会话');
    return result;
  } catch (error) { toast(error.message, 'error'); }
}
async function copySessionNoteDescription(note) {
  const description = note.description?.trim();
  if (!description) return toast('便签没有描述内容', 'error');
  try {
    await navigator.clipboard.writeText(description);
    toast('便签描述已复制');
  } catch {
    toast('复制失败，请手动选择内容', 'error');
  }
}
async function removeSessionNote(note) {
  try {
    await api(`/notes/${note.id}`, { method: 'PUT', body: { pinnedToSessionBar: false } });
    await refresh();
    toast('已移除会话标记');
  } catch (error) { toast(error.message, 'error'); }
}
async function removeTopbarNote(note) {
  try {
    await api(`/notes/${note.id}`, { method: 'PUT', body: { pinnedToTopBar: false } });
    await refresh();
    toast('已取消提醒标记');
  } catch (error) { toast(error.message, 'error'); }
}
function finishNoteDrag(commit = false) {
  clearTimeout(noteDragTimer); noteDragTimer = null;
  const drag = noteDrag;
  noteDrag = null;
  if (!drag?.active) return;
  drag.button.classList.remove('note-dragging');
  drag.root.classList.remove('note-drag-active');
  try { drag.button.releasePointerCapture(drag.pointerId); } catch { /* capture already released */ }
  suppressNoteClickUntil = Date.now() + 500;
  if (!commit) return;
  const ids = [...drag.root.querySelectorAll(`button[data-note-placement="${drag.placement}"]`)].map((item) => item.dataset.noteId);
  void api('/notes/reorder', { method: 'POST', body: { placement: drag.placement, ids } }).then(() => refresh()).catch((error) => toast(error.message, 'error'));
}
function bindNoteDrag(root) {
  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button[data-note-placement]');
    if (!button || event.button !== 0) return;
    const placement = button.dataset.notePlacement;
    noteDrag = { button, root, placement, pointerId: event.pointerId, active: false };
    clearTimeout(noteDragTimer);
    noteDragTimer = setTimeout(() => {
      if (!noteDrag || noteDrag.button !== button) return;
      noteDrag.active = true;
      button.classList.add('note-dragging'); root.classList.add('note-drag-active');
      button.setPointerCapture(event.pointerId);
      navigator.vibrate?.(12);
    }, 450);
  });
  root.addEventListener('pointermove', (event) => {
    if (!noteDrag?.active || noteDrag.root !== root) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(`button[data-note-placement="${noteDrag.placement}"]`);
    if (!target || target === noteDrag.button || !root.contains(target)) return;
    const rect = target.getBoundingClientRect();
    root.insertBefore(noteDrag.button, event.clientX < rect.left + rect.width / 2 ? target : target.nextSibling);
  });
  root.addEventListener('pointerup', (event) => {
    if (noteDrag?.root === root && noteDrag.pointerId === event.pointerId) finishNoteDrag(true);
  });
  root.addEventListener('pointercancel', (event) => {
    if (noteDrag?.root === root && noteDrag.pointerId === event.pointerId) finishNoteDrag(false);
  });
  root.addEventListener('contextmenu', (event) => { if (noteDrag?.active) event.preventDefault(); });
}
bindNoteDrag($('#session-note-buttons'));
bindNoteDrag($('#topbar-note-buttons'));
// 指针移出按钮容器后，pointerup 可能不再经过容器；全局兜底，确保拖动态总能清理。
window.addEventListener('pointerup', (event) => {
  if (noteDrag?.pointerId === event.pointerId) finishNoteDrag(true);
});
window.addEventListener('pointercancel', (event) => {
  if (noteDrag?.pointerId === event.pointerId) finishNoteDrag(false);
});
window.addEventListener('blur', () => finishNoteDrag(false));
$('#topbar-note-buttons').onclick = (event) => {
  if (Date.now() < suppressNoteClickUntil) return;
  if (event.target.closest('[data-new-topbar-note]')) { openNoteForm(null, { pinnedToTopBar: true }); return; }
  const button = event.target.closest('[data-topbar-note]');
  if (!button) return;
  const note = currentNote(button.dataset.topbarNote);
  if (!note) return;
  if (topbarNoteMenuAnchor === button) {
    closeTopbarNotePanel();
    button.blur();
    return;
  }
  openTopbarNoteMenu(button, note);
};
$('#session-note-buttons').onclick = (event) => {
  if (Date.now() < suppressNoteClickUntil) return;
  if (event.target.closest('[data-new-session-note]')) { openNoteForm(null, { pinnedToSessionBar: true }); return; }
  const button = event.target.closest('[data-session-note]');
  if (!button) return;
  const note = currentNote(button.dataset.sessionNote);
  if (!note) return;
  if (sessionNoteMenuAnchor === button) {
    closeSessionNoteMenu();
    button.blur();
    ensureTerminalInputFocus();
    return;
  }
  openSessionNoteMenu(button, note);
};
async function reconnectTreeSession(taskId, sessionId) {
  // 仅当前正在查看的子会话支持双击重新连接；其他项仍按普通打开处理。
  if (state.module !== 'session' || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return selectSession(taskId, sessionId);
  return restartCurrentTui('正在重新连接会话…');
}
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
  if (group) {
    const id = group.dataset.sessionGroup;
    if (state.collapsedSessionTasks.has(id)) state.collapsedSessionTasks.delete(id);
    else state.collapsedSessionTasks.add(id);
    renderSessionTree();
    saveLayoutState();
    return;
  }
  const item = event.target.closest('[data-session-task]');
  if (!item) return;
  const taskId = item.dataset.sessionTask;
  const sessionId = item.dataset.sessionId;
  // 首击先等待一小段时间，不重绘树，第二击才能可靠地被识别为双击。
  if (sessionTreeClickTimer) {
    clearTimeout(sessionTreeClickTimer);
    sessionTreeClickTimer = null;
    void reconnectTreeSession(taskId, sessionId);
    return;
  }
  sessionTreeClickTimer = setTimeout(() => {
    sessionTreeClickTimer = null;
    void selectSession(taskId, sessionId);
  }, 240);
};
$('#board-filter-tabs').onclick = (event) => {
  const filter = event.target.closest('[data-filter-value]');
  if (!filter) return;
  const value = filter.dataset.filterValue;
  if (filter.dataset.filterType === 'archive') {
    state.status = 'archived';
    state.archiveType = value;
  } else if (filter.dataset.filterType === 'note') {
    state.boardType = 'notes';
    state.status = '';
    state.noteFilter = value;
  } else {
    state.boardType = 'tasks';
    state.status = value;
  }
  applyViewSettings(); renderTaskSidebar(); renderList(); saveLayoutState();
  recordWorkspaceView();
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
    event.preventDefault();
    if (state.boardType === 'notes') openNoteForm();
    else openTaskForm();
  }
});
$('#task-list').onclick = async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  if (button.dataset.action === 'purge-archived') {
    openClearArchivedModal();
    return;
  }
  if (button.dataset.action === 'clear-note-filters') {
    state.search = ''; $('#search').value = ''; renderList(); saveLayoutState(); recordWorkspaceView(); return;
  }
  const noteActions = ['edit-note', 'delete-note', 'restore-note', 'purge-note', 'toggle-top-note', 'toggle-session-note'];
  // 回收站的“全部”视图可能在便签页状态下同时渲染任务和便签，不能仅凭 boardType 分流。
  if (button.closest('.note-card') || noteActions.includes(button.dataset.action)) {
    const note = currentNote(button.dataset.id);
    if (!note) return;
    try {
      if (button.dataset.action === 'edit-note') openNoteForm(note);
      else if (button.dataset.action === 'delete-note') openDeleteNoteModal(note);
      else if (button.dataset.action === 'restore-note') { await api(`/notes/${note.id}/restore`, { method: 'POST' }); await refresh(); toast('便签已恢复'); }
      else if (button.dataset.action === 'purge-note') { await api(`/notes/${note.id}/permanent`, { method: 'DELETE' }); await refresh(); toast('便签已永久删除'); }
      else if (button.dataset.action === 'toggle-top-note' || button.dataset.action === 'toggle-session-note') {
        const key = button.dataset.action === 'toggle-top-note' ? 'pinnedToTopBar' : 'pinnedToSessionBar';
        await api(`/notes/${note.id}`, { method: 'PUT', body: { [key]: !note[key] } });
        await refresh();
      }
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  const task = currentTask(button.dataset.id);
  try {
    if (button.dataset.action === 'clear-filters') {
      state.search = ''; state.status = '';
      applyViewSettings();
      $('#search').value = '';
      renderTaskSidebar(); renderList(); saveLayoutState();
      recordWorkspaceView();
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
    else if (button.dataset.action === 'open-archived-session') {
      await openTaskSession(task);
      toast('已进入子会话，任务仍为废弃状态');
    }
    else if (button.dataset.action === 'restore') {
      const restoredTask = await restoreTask(task);
      const restoredLabel = STATUS[restoredTask?.status]?.label || '已恢复';
      toast(`任务已恢复到${restoredLabel}`);
    }
    else if (button.dataset.action === 'purge') openPurgeTaskModal(task);
    else if (button.dataset.action === 'purge-archived') openClearArchivedModal();
    else if (button.dataset.action === 'complete') {
      if (runningSessionCount(task)) openCompleteTaskModal(task);
      else await finishCompleteTask(task);
    }
    else if (button.dataset.action === 'reopen') { await api(`/tasks/${task.id}/reopen`, { method: 'POST' }); toast('任务已重开'); refresh(); }
    else if (button.dataset.action === 'terminate' && confirm('确定终止当前 pi TUI 吗？')) { await api(`/tasks/${task.id}/terminate`, { method: 'POST' }); toast('执行已终止'); refresh(); }
  } catch (error) { toast(error.message, 'error'); }
};
$('#purge-archived').onclick = () => openClearArchivedModal();

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
  if (document.visibilityState === 'hidden') { stopMarqueeMotion(); return; }
  renderMarquee();
  if (state.module === 'session') void refresh();
});
window.addEventListener('pagehide', () => {
  stopMarqueeMotion();
  if (state.sessionTask) markSessionRead(state.sessionTask, state.sessionSessionId, { keepalive: true });
  taskEvents.close();
}, { once: true });
refresh();
// SSE 是实时更新路径；不再对任务列表进行定时轮询，避免无必要地重绘任务卡片。
