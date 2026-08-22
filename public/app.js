import { deadline, esc, time } from './ui/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS = { todo: { label: '待办', cls: 'todo' }, running: { label: '处理中', cls: 'running' }, done: { label: '已完成', cls: 'done' }, archived: { label: '已废弃', cls: 'archived' } };
const COLORS = { red: { label: '红色' }, orange: { label: '橙色' }, yellow: { label: '黄色' }, green: { label: '绿色' }, cyan: { label: '青色' }, blue: { label: '蓝色' }, purple: { label: '紫色' }, gray: { label: '灰色' } };
const LEGACY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' };
const state = { tasks: [], status: '', sort: 'updated', search: '', signature: '', sessionTask: null, sessionSessionId: 'main', sessionDescriptionOpen: false, collapsedSessionTasks: new Set() };
let tuiSocket = null;
let terminal = null;
let fitAddon = null;
let terminalResizeObserver = null;
let terminalImeCursorHandler = null;
let terminalCursorSubscription = null;
let tuiOpening = null;

function taskColor(task) { return COLORS[task.color] ? task.color : (LEGACY_COLOR[task.priority] || 'blue'); }
function recentWorkingDirs() {
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench-working-dirs') || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch { /* ignore malformed browser data */ }
  return [...new Set([...saved, ...state.tasks.map((task) => task.workingDir)].filter(Boolean))].slice(0, 12);
}
function rememberWorkingDir(value) {
  const dir = String(value || '').trim();
  if (!dir) return;
  localStorage.setItem('workbench-working-dirs', JSON.stringify([dir, ...recentWorkingDirs().filter((item) => item !== dir)].slice(0, 12)));
}
function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  localStorage.setItem('workbench-theme', theme);
  $('#theme-select').value = theme;
}
function isTerminalDark() {
  return document.body.classList.contains('theme-dark') || (!document.body.classList.contains('theme-light') && matchMedia('(prefers-color-scheme: dark)').matches);
}
function syncViewportHeight() {
  document.documentElement.style.setProperty('--app-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
applyTheme(['system', 'light', 'dark'].includes(localStorage.getItem('workbench-theme')) ? localStorage.getItem('workbench-theme') : 'system');
syncViewportHeight();
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle');
  button.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
}
applySidebarCollapsed(localStorage.getItem('workbench-sidebar-collapsed') === 'true');
window.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('resize', syncViewportHeight);

async function api(path, options = {}) {
  const init = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch('/api' + path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toast-root').appendChild(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 300); }, 3500);
}
function currentTask(id) { return state.tasks.find((task) => task.id === id); }
function formatCount(value = 0) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function renderStats() {
  const counts = { todo: 0, running: 0, done: 0 };
  let overdue = 0;
  state.tasks.forEach((task) => { if (counts[task.status] !== undefined) counts[task.status]++; if (task.overdue) overdue++; });
  $('#stats').innerHTML = ['todo', 'running', 'done'].map((key) => `<span class="chip ${STATUS[key].cls}">${STATUS[key].label} ${counts[key]}</span>`).join('') + (overdue ? `<span class="chip overdue">逾期 ${overdue}</span>` : '');
}
const GROUP_ICONS = { '': '▦', todo: '○', running: '◐', done: '✓', archived: '✕' };
function renderTaskSidebar() {
  $('#task-groups').innerHTML = [{ key: '', label: '全部任务' }, ...Object.entries(STATUS).map(([key, value]) => ({ key, label: value.label }))].map(({ key, label }) => {
    const count = key ? state.tasks.filter((task) => task.status === key).length : state.tasks.filter((task) => task.status !== 'archived').length;
    return `<button class="task-group-item${state.status === key ? ' active' : ''}" data-task-filter="${key}"><span class="group-icon">${GROUP_ICONS[key] || '•'}</span><span class="group-label">${esc(label)}</span><b>${count}</b></button>`;
  }).join('');
}
function visibleTasks() {
  return state.tasks.filter((task) => (state.status ? task.status === state.status : task.status !== 'archived') && (!state.search || `${task.title} ${task.description}`.toLowerCase().includes(state.search.toLowerCase()))).sort((a, b) => {
    if (state.sort === 'deadline') return (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity) || new Date(b.updatedAt) - new Date(a.updatedAt);
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
function actions(task) {
  if (task.status === 'archived') return `<button data-action="restore" data-id="${task.id}">恢复任务</button><button class="danger" data-action="purge" data-id="${task.id}">永久删除</button>`;
  if (task.status === 'todo') return `<button class="primary" data-action="execute" data-id="${task.id}">打开会话</button><button data-action="complete" data-id="${task.id}">标记完成</button><button data-action="edit" data-id="${task.id}">编辑</button><button class="danger" data-action="delete" data-id="${task.id}">删除</button>`;
  if (task.status === 'running') return `<button class="primary" data-action="session" data-id="${task.id}">打开会话</button><button data-action="complete" data-id="${task.id}">标记完成</button><button class="danger" data-action="delete" data-id="${task.id}">删除</button>`;
  return `<button data-action="reopen" data-id="${task.id}">重开</button><button class="danger" data-action="delete" data-id="${task.id}">删除</button>`;
}
function card(task, compact = false) {
  const stats = task.stats || {};
  const archiveInfo = task.status === 'archived' ? `<div class="archive-info">已废弃 · ${time(task.archivedAt)} · ${task.purgeAt ? `预计 ${time(task.purgeAt)} 自动删除` : ''}</div>` : '';
  const statHtml = compact ? '' : `<div class="task-stats"><span>会话 ${stats.sessions || 0}</span><span>消息 ${stats.messages || 0}</span><span>输入 ${formatCount(stats.inputTokens || 0)}</span><span>输出 ${formatCount(stats.outputTokens || 0)}</span><span>Token ${formatCount(stats.totalTokens || 0)}</span>${stats.cost ? `<span>成本 $${Number(stats.cost).toFixed(4)}</span>` : ''}</div>`;
  const folder = task.workingDir ? `<span class="task-folder" title="${esc(task.workingDir)}">📁 ${esc(task.workingDir)}</span>` : '';
  return `<article class="card ${task.status} color-${taskColor(task)}${compact ? ' compact' : ''}"><div class="card-head"><h3 class="card-title">${esc(task.title)}</h3>${folder}<span class="spacer"></span>${task.deadline ? `<span class="deadline ${task.overdue ? 'overdue' : ''}">⏰ ${deadline(task.deadline)}${task.overdue ? ' 逾期' : ''}</span>` : ''}</div><p class="card-desc">${esc(task.description)}</p>${archiveInfo}${statHtml}<div class="card-actions">${actions(task)}</div></article>`;
}
function renderList() {
  document.body.classList.toggle('board-mode', !state.status);
  const tasks = visibleTasks();
  if (!state.status) {
    $('#task-list').innerHTML = `<div class="task-board">${['todo', 'running', 'done'].map((key) => `<section class="task-board-column"><header class="task-board-head"><span class="badge ${key}">${STATUS[key].label}</span><b>${tasks.filter((task) => task.status === key).length}</b></header><div class="task-board-list">${tasks.filter((task) => task.status === key).map((task) => card(task, true)).join('') || '<div class="task-board-empty">暂无任务</div>'}</div></section>`).join('')}</div>`;
    return;
  }
  const clearArchived = state.status === 'archived' && tasks.length ? '<div class="archive-actions"><button class="danger" data-action="purge-archived">全部清空</button></div>' : '';
  $('#task-list').innerHTML = clearArchived + (tasks.length ? tasks.map((task) => card(task)).join('') : '<div class="empty">没有符合条件的任务</div>');
}

function sessionTasks() {
  return state.tasks.filter((task) => ['todo', 'running'].includes(task.status) && Array.isArray(task.sessions) && task.sessions.length > 0);
}
function renderSessionHeader() {
  const task = currentTask(state.sessionTask);
  $('#session-view').classList.toggle('no-session', !task);
  const child = task?.sessions?.find((session) => session.id === state.sessionSessionId);
  $('#session-title').textContent = child?.title || task?.title || '选择一个子会话';
  $('#session-description-text').textContent = task?.description?.trim() || '暂无任务描述';
  $('#session-description-panel').classList.toggle('hidden', !state.sessionDescriptionOpen || !task);
  $('#session-restart').disabled = !task;
  $('#session-task-select').innerHTML = '<option value="">选择一个任务会话</option>' + sessionTasks().map((item) => `<option value="${item.id}"${item.id === state.sessionTask ? ' selected' : ''}>${esc(item.title)}</option>`).join('');
}
function renderSessionTree() {
  renderSessionHeader();
  const tasks = sessionTasks();
  $('#session-tree').innerHTML = tasks.length ? tasks.map((task) => {
    const collapsed = state.collapsedSessionTasks.has(task.id);
    const sessions = task.sessions || [];
    return `<div class="session-task-group"><div class="session-task-title color-${taskColor(task)}" data-session-group="${esc(task.id)}"><span>${collapsed ? '▸' : '▾'}</span><span>${esc(task.title)}</span><button class="session-new-child" data-new-session-task="${esc(task.id)}" title="新建子会话">＋</button></div>${collapsed ? '' : sessions.map((session, index) => `<div class="session-child-session${state.sessionTask === task.id && state.sessionSessionId === session.id ? ' active' : ''}" data-session-task="${esc(task.id)}" data-session-id="${esc(session.id)}"><span class="child-dot">●</span><span class="session-child-name">${esc(session.title || `子会话 ${index + 1}`)}</span>${sessions.length > 1 ? `<button class="session-child-delete" data-delete-session="${esc(task.id)}" data-session-id="${esc(session.id)}" title="删除子会话">×</button>` : ''}</div>`).join('')}</div>`;
  }).join('') : '<div class="empty sidebar-empty">暂无可打开的会话</div>';
}
async function refresh() {
  try {
    const data = await api('/tasks');
    const signature = JSON.stringify(data.tasks.map((task) => [task.id, task.status, task.updatedAt, task.activeSessionId, task.stats?.messages, task.stats?.totalTokens]));
    state.tasks = data.tasks;
    renderStats(); renderTaskSidebar(); renderSessionTree();
    if (signature !== state.signature && !$('.modal')) renderList();
    state.signature = signature;
  } catch (error) { toast(error.message, 'error'); }
}

function terminalTheme() {
  return isTerminalDark()
    ? { background: '#0b1220', foreground: '#e5e7eb', cursor: '#93c5fd', selectionBackground: '#1e3a5f', black: '#334155', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb', brightBlack: '#94a3b8' }
    : { background: '#f8fafc', foreground: '#172033', cursor: '#2563eb', selectionBackground: '#bfdbfe', black: '#172033', red: '#dc2626', green: '#15803d', yellow: '#a16207', blue: '#2563eb', magenta: '#7c3aed', cyan: '#0f766e', white: '#f8fafc', brightBlack: '#64748b' };
}
function disposeTerminal() {
  terminalResizeObserver?.disconnect(); terminalResizeObserver = null;
  terminalCursorSubscription?.dispose(); terminalCursorSubscription = null;
  const box = $('#session-terminal');
  if (terminalImeCursorHandler) {
    box.removeEventListener('compositionstart', terminalImeCursorHandler);
    box.removeEventListener('focusin', terminalImeCursorHandler);
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
  if (!input || !screen || !terminal?.cols || !terminal?.rows) return;
  const rect = screen.getBoundingClientRect();
  const cursor = terminal.buffer.active;
  input.style.left = `${Math.max(0, Math.min(terminal.cols - 1, cursor.cursorX)) * rect.width / terminal.cols}px`;
  input.style.top = `${Math.max(0, Math.min(terminal.rows - 1, cursor.cursorY)) * rect.height / terminal.rows}px`;
  input.style.width = `${Math.max(1, rect.width / terminal.cols)}px`;
  input.style.height = `${Math.max(1, rect.height / terminal.rows)}px`;
  input.style.zIndex = '5';
}
async function openNativeTui() {
  if (tuiOpening) return tuiOpening;
  const task = currentTask(state.sessionTask);
  if (!task) return toast('请先选择一个会话', 'error');
  if (task.status === 'done' || task.status === 'archived') return toast('当前任务不能打开会话', 'error');
  const taskId = task.id;
  const sessionId = state.sessionSessionId;
  tuiOpening = (async () => {
    detachTui();
    document.body.classList.add('tui-active');
    const box = $('#session-terminal');
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('/vendor/xterm/lib/xterm.mjs'), import('/vendor/xterm-fit/addon-fit.mjs')]);
      if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
      terminal = new Terminal({ cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, convertEol: true, scrollback: 10000, scrollOnUserInput: false, fontSize: 13, fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace', theme: terminalTheme() });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey) return true;
        const key = event.key.toLowerCase();
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
          if (navigator.clipboard) void navigator.clipboard.readText().then((text) => { if (text) terminal?.paste(text); }).catch(() => toast('粘贴失败，请使用右键菜单', 'error'));
          else toast('粘贴失败，请使用右键菜单', 'error');
          return false;
        }
        return true;
      });
      fitAddon = new FitAddon(); terminal.loadAddon(fitAddon); terminal.open(box); fitAddon.fit(); terminal.focus();
      terminalImeCursorHandler = () => requestAnimationFrame(positionTerminalImeInput);
      terminalCursorSubscription = terminal.onCursorMove(terminalImeCursorHandler);
      box.addEventListener('compositionstart', terminalImeCursorHandler);
      box.addEventListener('focusin', terminalImeCursorHandler);
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
          if (event.type === 'tui_reset') { terminal?.reset(); sendSize(); }
          else if (event.type === 'tui_data') terminal?.write(event.data || '');
          else if (event.type === 'tui_exit') terminal?.write(`\r\n\r\n[工作台] pi 已退出（${event.exitCode ?? '未知'}）。\r\n`);
          else if (event.type === 'tui_error') {
            const error = event.error || '终端错误';
            // Ignore stale frames emitted while a PTY is already exiting.
            if (error === '会话未运行') return;
            terminal?.write(`\r\n[工作台] ${error}\r\n`);
            toast(error, 'error');
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onerror = () => toast('会话连接失败，请查看服务终端中的错误信息', 'error');
      socket.onclose = () => {
        if (tuiSocket === socket) tuiSocket = null;
        if (state.sessionTask === taskId && terminal) terminal.write('\r\n[工作台] 终端连接已断开，点击“重新连接”可恢复。\r\n');
      };
    } catch (error) {
      detachTui();
      toast(`加载终端组件失败：${error.message}`, 'error');
    }
  })().finally(() => { tuiOpening = null; });
  return tuiOpening;
}
async function restartTuiForTheme() {
  const taskId = state.sessionTask;
  if (!taskId || !tuiSocket) return;
  toast('主题已切换，正在重启会话…');
  try {
    await api(`/tasks/${taskId}/tui/restart`, { method: 'POST' });
  } catch { /* the process may already have exited */ }
  await refresh();
  if (state.sessionTask === taskId) await openNativeTui();
}
function selectSession(taskId, sessionId = 'main') {
  detachTui();
  state.sessionTask = taskId || null;
  state.sessionSessionId = sessionId || 'main';
  renderSessionTree();
  if (taskId) void openNativeTui();
}

function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  root.querySelector('.overlay').addEventListener('mousedown', (event) => { if (event.target.classList.contains('overlay')) closeModal(); });
  return $('.modal', root);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function openTaskForm(task = null) {
  const recent = recentWorkingDirs().map((dir) => `<option value="${esc(dir)}">${esc(dir)}</option>`).join('');
  const form = modal(`<h2>${task ? '编辑任务' : '新建任务'}</h2><label>标题<input id="task-title" value="${esc(task?.title || '')}"></label><label>工作目录路径<div class="path-picker-row"><input id="task-working-dir" value="${esc(task?.workingDir || '')}"><select id="recent-task-dir"><option value="">选择已使用的文件夹</option>${recent}</select><button type="button" id="choose-task-dir">选择文件夹</button></div></label><label>内容描述<textarea id="task-desc" rows="7">${esc(task?.description || '')}</textarea></label><div class="row"><label>颜色标签<div id="color-picker" class="color-picker">${Object.entries(COLORS).map(([key, value]) => `<button type="button" class="color-option color-${key}${taskColor(task || {}) === key ? ' active' : ''}" data-color-value="${key}" aria-label="${value.label}"><span></span></button>`).join('')}</div><input type="hidden" id="task-color" value="${taskColor(task || {})}"></label><label>截止时间<input id="task-deadline" type="datetime-local" value="${esc(task?.deadline || '')}"></label></div><div class="modal-actions"><button class="primary" id="save-task">${task ? '保存' : '创建'}</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  form.querySelectorAll('[data-color-value]').forEach((button) => { button.onclick = () => { $('#task-color', form).value = button.dataset.colorValue; form.querySelectorAll('[data-color-value]').forEach((item) => item.classList.toggle('active', item === button)); }; });
  $('#recent-task-dir', form).onchange = (event) => { if (event.target.value) { $('#task-working-dir', form).value = event.target.value; event.target.value = ''; } };
  $('#choose-task-dir', form).onclick = async () => { try { const result = await api('/select-directory', { method: 'POST' }); if (result.path) { rememberWorkingDir(result.path); $('#task-working-dir', form).value = result.path; } } catch (error) { toast(error.message, 'error'); } };
  $('#save-task', form).onclick = async () => { try { const workingDir = $('#task-working-dir', form).value.trim(); if (!workingDir) return toast('请选择工作目录', 'error'); rememberWorkingDir(workingDir); await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PUT' : 'POST', body: { title: $('#task-title', form).value, description: $('#task-desc', form).value, workingDir, color: $('#task-color', form).value, deadline: $('#task-deadline', form).value || null } }); closeModal(); toast(task ? '任务已保存' : '任务已创建'); refresh(); } catch (error) { toast(error.message, 'error'); } };
}
async function openExecute(task) {
  if (!task.workingDir) return openTaskForm(task);
  try {
    const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
    await refresh(); switchModule('session'); selectSession(task.id, result.session.id);
    toast(task.description ? '已打开会话，请在 pi 输入框中发送任务描述。' : '已打开会话。');
  } catch (error) { toast(error.message, 'error'); }
}
function openDeleteTaskModal(task) {
  const form = modal(`<h2>废弃任务</h2><p>确定将「${esc(task.title)}」移入已废弃任务吗？任务及其会话会保留 15 天。</p><div class="modal-actions"><button class="danger" id="confirm-archive-task">移入已废弃</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-archive-task', form).onclick = async () => { try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); closeModal(); state.status = ''; toast('任务已移入已废弃'); refresh(); } catch (error) { toast(error.message, 'error'); } };
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
    await refresh();
    selectSession(task.id, result.session.id);
    toast('子会话已创建');
  } catch (error) {
    toast(error.message, 'error');
  }
}
function openSessionModal(task, session = null) {
  const editing = Boolean(session);
  const form = modal(`<h2>${editing ? '重命名子会话' : '新建子会话'}</h2><p class="hint">任务：${esc(task.title)}</p><label>会话名称<input id="session-title-input" value="${esc(session?.title || '新会话')}" placeholder="例如：检查登录模块"></label><div class="modal-actions"><button class="primary" id="save-session">${editing ? '保存' : '创建'}</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#save-session', form).onclick = async () => { try { const title = $('#session-title-input', form).value.trim(); if (!title) return toast('会话名称不能为空', 'error'); const result = await api(editing ? `/tasks/${task.id}/sessions/${session.id}` : `/tasks/${task.id}/sessions`, { method: editing ? 'PATCH' : 'POST', body: { title } }); closeModal(); await refresh(); if (!editing || (state.sessionTask === task.id && state.sessionSessionId === session.id)) selectSession(task.id, result.session.id); } catch (error) { toast(error.message, 'error'); } };
}
function openDeleteSessionModal(task, sessionId) {
  const form = modal(`<h2>删除子会话</h2><p>确定删除「${esc(task.title)}」下的这个子会话及其日志吗？</p><div class="modal-actions"><button class="danger" id="confirm-delete-session">删除</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-delete-session', form).onclick = async () => { try { const remaining = task.sessions?.find((item) => item.id !== sessionId); await api(`/tasks/${task.id}/sessions/${sessionId}`, { method: 'DELETE' }); closeModal(); await refresh(); if (state.sessionTask === task.id && state.sessionSessionId === sessionId && remaining) selectSession(task.id, remaining.id); } catch (error) { toast(error.message, 'error'); } };
}
function switchModule(module) {
  const session = module === 'session';
  document.body.classList.toggle('session-mode', session);
  $('#module-session').classList.toggle('active', session); $('#module-tasks').classList.toggle('active', !session);
  $('#task-sidebar').classList.toggle('hidden', session); $('#session-sidebar').classList.toggle('hidden', !session);
  $('#task-toolbar').classList.toggle('hidden', session); $('#task-list').classList.toggle('hidden', session); $('#session-view').classList.toggle('hidden', !session);
  if (session) renderSessionTree();
}

$('#theme-select').onchange = (event) => { applyTheme(event.target.value); void restartTuiForTheme(); event.target.blur(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (localStorage.getItem('workbench-theme') === 'system') void restartTuiForTheme(); });
$('#module-tasks').onclick = () => switchModule('tasks');
$('#module-session').onclick = () => switchModule('session');
$('#sidebar-toggle').onclick = () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(collapsed);
  localStorage.setItem('workbench-sidebar-collapsed', String(collapsed));
};
$('#sidebar-new-task').onclick = () => openTaskForm();
$('#session-task-select').onchange = (event) => selectSession(event.target.value);
$('#session-title').onclick = () => {
  if (!currentTask(state.sessionTask)) return;
  state.sessionDescriptionOpen = !state.sessionDescriptionOpen;
  renderSessionHeader();
};
document.addEventListener('click', (event) => {
  if (state.sessionDescriptionOpen && !event.target.closest('.session-context')) {
    state.sessionDescriptionOpen = false;
    renderSessionHeader();
  }
});
$('#session-restart').onclick = () => { detachTui(); void openNativeTui(); };
$('#session-tree').onclick = (event) => {
  const create = event.target.closest('[data-new-session-task]');
  if (create) { const task = currentTask(create.dataset.newSessionTask); if (task) void createChildSession(task); return; }
  const remove = event.target.closest('[data-delete-session]');
  if (remove) { event.stopPropagation(); const task = currentTask(remove.dataset.deleteSession); if (task) openDeleteSessionModal(task, remove.dataset.sessionId); return; }
  const group = event.target.closest('[data-session-group]');
  if (group) { const id = group.dataset.sessionGroup; state.collapsedSessionTasks.has(id) ? state.collapsedSessionTasks.delete(id) : state.collapsedSessionTasks.add(id); renderSessionTree(); return; }
  const item = event.target.closest('[data-session-task]');
  if (item) selectSession(item.dataset.sessionTask, item.dataset.sessionId);
};
$('#session-tree').ondblclick = (event) => {
  const item = event.target.closest('[data-session-task]');
  if (!item || event.target.closest('button')) return;
  const task = currentTask(item.dataset.sessionTask);
  const session = task?.sessions?.find((child) => child.id === item.dataset.sessionId);
  if (task && session) openSessionModal(task, session);
};
$('#task-groups').onclick = (event) => { const group = event.target.closest('[data-task-filter]'); if (group) { state.status = group.dataset.taskFilter || ''; renderTaskSidebar(); renderList(); } };
$('#sort').onchange = (event) => { state.sort = event.target.value; renderList(); };
$('#search').oninput = (event) => { state.search = event.target.value; renderList(); };
$('#task-list').onclick = async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const task = currentTask(button.dataset.id);
  try {
    if (button.dataset.action === 'execute') openExecute(task);
    else if (button.dataset.action === 'session') { switchModule('session'); selectSession(task.id, task.activeSessionId || 'main'); }
    else if (button.dataset.action === 'edit') openTaskForm(task);
    else if (button.dataset.action === 'delete') openDeleteTaskModal(task);
    else if (button.dataset.action === 'restore') { await api(`/tasks/${task.id}/restore`, { method: 'POST' }); state.status = ''; toast('任务已恢复到待办'); refresh(); }
    else if (button.dataset.action === 'purge') openPurgeTaskModal(task);
    else if (button.dataset.action === 'purge-archived') openClearArchivedModal();
    else if (button.dataset.action === 'complete') { await api(`/tasks/${task.id}/complete`, { method: 'POST' }); toast('已标记完成'); refresh(); }
    else if (button.dataset.action === 'reopen') { await api(`/tasks/${task.id}/reopen`, { method: 'POST' }); toast('任务已重开'); refresh(); }
    else if (button.dataset.action === 'terminate' && confirm('确定终止当前 pi TUI 吗？')) { await api(`/tasks/${task.id}/terminate`, { method: 'POST' }); toast('执行已终止'); refresh(); }
  } catch (error) { toast(error.message, 'error'); }
};

refresh();
setInterval(refresh, 3000);
