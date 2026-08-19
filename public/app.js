import { deadline, esc, renderMarkdown, time } from './ui/format.js';

const $ = (s, root = document) => root.querySelector(s);
const STATUS = { todo: { label: '待办', cls: 'todo' }, running: { label: '处理中', cls: 'running' }, done: { label: '已完成', cls: 'done' }, archived: { label: '已废弃', cls: 'archived' } };
const COLORS = { red: { label: '红色' }, orange: { label: '橙色' }, yellow: { label: '黄色' }, green: { label: '绿色' }, cyan: { label: '青色' }, blue: { label: '蓝色' }, purple: { label: '紫色' }, gray: { label: '灰色' } };
const LEGACY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' };
const state = { tasks: [], status: '', sort: 'updated', search: '', signature: '', sessionTask: null, sessionSessionId: 'main', collapsedSessionTasks: new Set() };
function taskColor(task) { return COLORS[task.color] ? task.color : (LEGACY_COLOR[task.priority] || 'blue'); }
function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  localStorage.setItem('workbench-theme', theme);
  const select = $('#theme-select'); if (select) select.value = theme;
}
const savedTheme = localStorage.getItem('workbench-theme') || 'system';
applyTheme(['system', 'light', 'dark'].includes(savedTheme) ? savedTheme : 'system'); 
let sessionSocket = null;
let sessionSnapshot = null;
let liveSession = { text: '', tools: [] };
const liveToolOutputs = new Map();
const liveToolStatuses = new Map();
const cache = { dirs: null, models: null };
let commandMenuIndex = 0;
const SLASH_COMMANDS = [
  ['model', '切换模型'], ['models', '查看模型列表'], ['thinking', '设置思考强度'],
  ['compact', '压缩上下文'], ['abort', '停止当前生成'], ['session', '查看会话状态'],
];

// UI domains: task board rendering, session rendering, then event wiring.
// Shared formatting lives in public/ui/format.js so the view code stays focused.

async function api(path, options = {}) {
  const init = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch('/api' + path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function toast(message, type = '') { const node = document.createElement('div'); node.className = `toast ${type}`; node.textContent = message; $('#toast-root').appendChild(node); setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 300); }, 3500); }
function currentTask(id) { return state.tasks.find((t) => t.id === id); }
function renderSessionHeader() {
  const title = $('#session-title');
  const task = currentTask(state.sessionTask);
  const view = $('#session-view');
  if (view) view.classList.toggle('no-session', !task);
  if (!task) { const box = $('#session-messages'); if (box) box.innerHTML = '<div class="empty">从左侧选择一个任务会话</div>'; return; }
  if (!title) return;
  const child = task.sessions?.find((session) => session.id === state.sessionSessionId);
  title.textContent = child ? child.title || '新会话' : task.title;
}

function renderStats() {
  const counts = { todo: 0, running: 0, done: 0 }; let overdue = 0;
  state.tasks.forEach((t) => { if (counts[t.status] !== undefined) counts[t.status]++; if (t.overdue) overdue++; });
  $('#stats').innerHTML = ['todo', 'running', 'done'].map((key) => { const s = STATUS[key]; return `<span class="chip ${s.cls}">${s.label} ${counts[key]}</span>`; }).join('') + (overdue ? `<span class="chip overdue">逾期 ${overdue}</span>` : '');
}
function formatCount(value = 0) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
  return `${Math.round(value / 1000000)}M`;
}
function renderSessionStats(snapshot) {
  const stats = snapshot?.stats || {};
  const tokens = stats.tokens || {};
  const context = stats.contextUsage || {};
  const current = Number.isFinite(context.tokens) ? context.tokens : null;
  const maximum = Number.isFinite(context.contextWindow) ? context.contextWindow : null;
  const percent = Number.isFinite(context.percent) ? Math.max(0, Math.min(100, context.percent)) : null;
  const contextText = current !== null && maximum !== null ? `${formatCount(current)} / ${formatCount(maximum)}${percent === null ? '' : ` · ${percent.toFixed(0)}%`}` : '—';
  const contextNode = $('#session-context-usage');
  if (contextNode) { const level = percent !== null && percent >= 90 ? 'high' : percent !== null && percent >= 70 ? 'mid' : 'ok'; contextNode.innerHTML = `上下文 <span class="context-meter ${level}"><span style="width:${percent || 0}%"></span></span><b>${contextText}</b>`; }
  const total = Number(tokens.total || ((tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0)));
  const tokenNode = $('#session-token-usage'); if (tokenNode) tokenNode.textContent = `Token ${formatCount(total)}（入 ${formatCount(tokens.input || 0)} / 出 ${formatCount(tokens.output || 0)}）`;
  const cacheNode = $('#session-cache-usage');
  if (cacheNode) {
    const cacheParts = [];
    if (tokens.cacheRead) cacheParts.push(`R${formatCount(tokens.cacheRead)}`);
    if (tokens.cacheWrite) cacheParts.push(`W${formatCount(tokens.cacheWrite)}`);
    if ((tokens.cacheRead || tokens.cacheWrite) && Number.isFinite(stats.cacheHitRate)) cacheParts.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
    cacheNode.textContent = cacheParts.length ? cacheParts.join(' ') : '缓存 —';
  }
  const messageNode = $('#session-message-usage'); if (messageNode) messageNode.textContent = `消息 ${stats.totalMessages || 0}`;
  const costNode = $('#session-cost-usage'); if (costNode) costNode.textContent = `成本 $${Number(stats.cost || 0).toFixed(4)}`;
}
function renderTaskSidebar() {
  const box = $('#task-groups'); if (!box) return;
  const groups = [{ key: '', label: '全部任务' }, ...Object.entries(STATUS).map(([key, value]) => ({ key, label: value.label }))];
  box.innerHTML = groups.map(({ key, label }) => {
    const count = key ? state.tasks.filter((task) => task.status === key).length : state.tasks.filter((task) => task.status !== 'archived').length;
    return `<button class="task-group-item${state.status === key ? ' active' : ''}" data-task-filter="${key}"><span>${esc(label)}</span><b>${count}</b></button>`;
  }).join('');
}
function visibleTasks() {
  return state.tasks.filter((t) => (state.status ? t.status === state.status : t.status !== 'archived') && (!state.search || `${t.title} ${t.description}`.toLowerCase().includes(state.search.toLowerCase()))).sort((a, b) => {
    if (state.sort === 'deadline') {
      const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity;
      const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
      return ad - bd || new Date(b.updatedAt) - new Date(a.updatedAt);
    }
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
function actions(t) {
  if (t.status === 'archived') return `<button data-action="restore" data-id="${t.id}">恢复任务</button><button class="danger" data-action="purge" data-id="${t.id}">永久删除</button>`;
  if (t.status === 'todo') return `<button class="primary" data-action="execute" data-id="${t.id}">执行</button><button data-action="complete" data-id="${t.id}">标记完成</button><button data-action="edit" data-id="${t.id}">编辑</button><button class="danger" data-action="delete" data-id="${t.id}">删除</button>`;
  if (t.status === 'running') return `<button class="primary" data-action="session" data-id="${t.id}">详情</button>${t.piRunning ? `<button data-action="terminate" data-id="${t.id}">■ 终止</button>` : `<button data-action="complete" data-id="${t.id}">标记完成</button>`}<button class="danger" data-action="delete" data-id="${t.id}">删除</button>`;
  return `<button data-action="session" data-id="${t.id}">详情</button><button data-action="reopen" data-id="${t.id}">重开</button><button class="danger" data-action="delete" data-id="${t.id}">删除</button>`;
}
function card(t, compact = false) {
  const s = STATUS[t.status] || STATUS.running;
  const stats = t.stats || {};
  const archiveInfo = t.status === 'archived' ? `<div class="archive-info">已废弃 · ${time(t.archivedAt)} · ${t.purgeAt ? `预计 ${time(t.purgeAt)} 自动删除` : ''}</div>` : '';
  const statsHtml = compact ? '' : `<div class="task-stats"><span>会话 ${stats.sessions || 0}</span><span>消息 ${stats.messages || 0}</span><span>输入 ${formatCount(stats.inputTokens || 0)}</span><span>输出 ${formatCount(stats.outputTokens || 0)}</span><span>Token ${formatCount(stats.totalTokens || 0)}</span>${stats.cost ? `<span>成本 $${Number(stats.cost).toFixed(4)}</span>` : ''}</div>`;
  return `<article class="card ${s.cls} color-${taskColor(t)}${compact ? ' compact' : ''}"><div class="card-head"><h3 class="card-title">${esc(t.title)}</h3><span class="spacer"></span>${t.deadline ? `<span class="deadline ${t.overdue ? 'overdue' : ''}">⏰ ${deadline(t.deadline)}${t.overdue ? ' 逾期' : ''}</span>` : ''}</div><p class="card-desc">${esc(t.description)}</p>${archiveInfo}${statsHtml}<div class="card-actions">${actions(t)}</div></article>`;
}
function renderList() {
  document.body.classList.toggle('board-mode', !state.status);
  const tasks = visibleTasks();
  if (!state.status) {
    const columns = ['todo', 'running', 'done'].map((key) => {
      const columnTasks = tasks.filter((task) => task.status === key).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const status = STATUS[key];
      return `<section class="task-board-column"><header class="task-board-head"><span class="badge ${status.cls}">${status.label}</span><b>${columnTasks.length}</b></header><div class="task-board-list">${columnTasks.length ? columnTasks.map((task) => card(task, true)).join('') : '<div class="task-board-empty">暂无任务</div>'}</div></section>`;
    }).join('');
    $('#task-list').innerHTML = `<div class="task-board">${columns}</div>`;
    return;
  }
  $('#task-list').innerHTML = tasks.length ? tasks.map(card).join('') : '<div class="empty">没有符合条件的任务</div>';
}
function sessionTasks() {
  return state.tasks.filter((task) => task.status === 'running' && Array.isArray(task.sessions) && task.sessions.length > 0);
}
function syncSessionTasks() {
  const select = $('#session-task-select'); if (!select) return;
  const previous = state.sessionTask || select.value;
  select.innerHTML = '<option value="">选择一个任务会话</option>' + sessionTasks().map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  if (state.tasks.some((t) => t.id === previous)) { select.value = previous; state.sessionTask = previous; }
}
function renderSessionTree() {
  renderSessionHeader();
  const tree = $('#session-tree'); if (!tree) return;
  const tasks = sessionTasks();
  if (!tasks.length) { tree.innerHTML = '<div class="empty" style="padding:30px 8px">暂无已启动会话</div>'; return; }
  tree.innerHTML = tasks.map((task) => {
    const sessions = Array.isArray(task.sessions) ? task.sessions : [];
    const collapsed = state.collapsedSessionTasks.has(task.id);
    const children = collapsed ? '' : sessions.map((session, index) => {
      const active = state.sessionTask === task.id && state.sessionSessionId === session.id ? ' active' : '';
      const label = session.title || `子会话 ${index + 1}`;
      const remove = sessions.length > 1 ? `<button class="session-child-delete" data-delete-session="${esc(task.id)}" data-session-id="${esc(session.id)}" title="删除子会话">×</button>` : '';
      return `<div class="session-child-session${active}" data-session-task="${esc(task.id)}" data-session-id="${esc(session.id)}" title="${esc(task.title)} · ${esc(label)}"><span class="child-dot">●</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(label)}</span>${remove}</div>`;
    }).join('');
    return `<div class="session-task-group"><div class="session-task-title color-${taskColor(task)}" data-session-group="${esc(task.id)}" title="${esc(task.title)}"><span>${collapsed ? '▸' : '▾'}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(task.title)}</span><button class="session-new-child" data-new-session-task="${esc(task.id)}" title="新建子会话">＋</button></div>${children}</div>`;
  }).join('');
}
async function refresh() { try { const data = await api('/tasks'); const signature = JSON.stringify(data.tasks.map((t) => [t.id, t.status, t.updatedAt, t.activeSessionId, t.stats?.messages, t.stats?.totalTokens])); state.tasks = data.tasks; renderStats(); renderTaskSidebar(); syncSessionTasks(); renderSessionTree(); if (signature !== state.signature && !$('.modal')) renderList(); state.signature = signature; if (state.sessionTask && !sessionSocket && !$('.modal')) loadSession(); } catch (e) { toast(e.message, 'error'); } }
function renderLiveSession() {
  const box = $('#session-live'); if (!box) return;
  const tools = liveSession.tools.map((t) => `🔧 ${esc(t.name)}${t.done ? (t.isError ? '（失败）' : '（完成）') : '（执行中）'}`).join('\\n');
  const text = liveSession.text.trim();
  if (!text && !tools) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden'); box.innerHTML = `${text ? `<div>🤖 ${esc(text)}</div>` : ''}${tools ? `<div class="hint">${esc(tools)}</div>` : ''}`;
}
function handleLiveEvent(event) {
  if (event.type === 'message_start' && event.message?.role === 'assistant') liveSession.text = '';
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent || {};
    if (typeof update.delta === 'string' && (update.type === 'text_delta' || update.type === 'thinking_delta')) liveSession.text += update.delta;
  }
  if (event.type === 'tool_execution_start') liveSession.tools.push({ name: event.toolName || 'tool', done: false });
  if (event.type === 'tool_execution_end') {
    const tool = [...liveSession.tools].reverse().find((x) => !x.done && x.name === (event.toolName || x.name));
    if (tool) { tool.done = true; tool.isError = event.isError; }
  }
  if (event.type === 'response') {
    if (!event.success) liveSession.text = `指令失败：${event.error || '未知错误'}`;
    else if (event.command === 'get_available_models') liveSession.text = `可用模型：\n${(event.data?.models || []).map((m) => `${m.provider}/${m.id}`).join('\n') || '暂无模型'}`;
    else if (event.command === 'set_model' && event.data) liveSession.text = `已切换模型：${event.data.provider || ''}/${event.data.id || event.data.modelId || ''}`;
    else if (event.command === 'get_state') liveSession.text = `当前会话状态：\n${JSON.stringify(event.data || {}, null, 2)}`;
    else liveSession.text = `指令已执行：/${event.command}`;
  }
  if (event.type === 'agent_end' || event.type === 'process_exit') liveSession = { text: '', tools: [] };
  renderLiveSession();
}
function toolTone(name = '') {
  const value = String(name).toLowerCase();
  if (value.includes('bash') || value.includes('shell') || value.includes('exec')) return 'bash';
  if (value.includes('read')) return 'read';
  if (value.includes('write') || value.includes('edit')) return 'write';
  return 'other';
}
function sessionHtml(item) {
  const stamp = item.ts ? `<span class="session-meta">${time(item.ts)}</span>` : '';
  const identity = item.id ? ` data-msg-id="${esc(item.id)}"` : '';
  if (item.kind === 'user') return `<div class="session-item user"${identity}><div class="session-who">你${stamp}</div>${esc(item.text)}</div>`;
  if (item.kind === 'assistant') { const tools = (item.toolCalls || []).map((x) => `<details class="tool-call tool-${toolTone(x.name)}"><summary>🔧 ${esc(x.name)}</summary><pre>${esc(x.args || '')}</pre></details>`).join(''); const thinking = item.thinking ? `<details class="thinking"><summary>💭 思考过程</summary><pre>${esc(item.thinking)}</pre></details>` : ''; const model = item.model ? ` · ${esc(item.model)}` : ''; return `<div class="session-item assistant"${identity}><div class="session-who">🤖 AI${model}${item.streaming ? ' · 生成中' : ''}${stamp}</div>${thinking}${renderMarkdown(item.text || '')}${tools}</div>`; }
  if (item.kind === 'toolResult') return `<div class="session-item tool tool-${toolTone(item.toolName)} ${item.isError ? 'error' : ''}"${identity}><div class="session-who">🔧 ${esc(item.toolName)}${item.live ? ' · 执行中' : ''}${stamp}</div><pre>${esc(item.text)}</pre></div>`;
  return `<div class="session-item"${identity}>${esc(item.text)}${stamp}</div>`;
}
function snapshotItems(snapshot) {
  if (!snapshot) return [];
  const items = [];
  const messages = [...(snapshot.messages || [])];
  if (snapshot.streamingMessage) messages.push(snapshot.streamingMessage);
  for (const message of messages) {
    const blocks = message.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('');
    if (message.role === 'user') items.push({ id: message.id, kind: 'user', text, ts: message.timestamp });
    else if (message.role === 'assistant') items.push({ id: message.id, kind: 'assistant', text, thinking, model: message.provider && message.model ? `${message.provider}/${message.model}` : '', ts: message.timestamp, streaming: message.id?.startsWith('stream-'), toolCalls: blocks.filter((b) => b.type === 'toolCall').map((b) => ({ name: b.name, args: b.argumentsText || '' })) });
    else if (message.role === 'toolResult') items.push({ id: message.id, kind: 'toolResult', toolName: message.toolName || '', isError: message.isError, text, ts: message.timestamp });
  }
  for (const [toolCallId, output] of liveToolOutputs) {
    const status = liveToolStatuses.get(toolCallId);
    if (output) items.push({ kind: 'toolResult', toolName: status?.toolName || 'tool', isError: status?.isError, text: output, live: true });
  }
  return items;
}
function renderSessionSnapshot(snapshot) {
  sessionSnapshot = snapshot;
  renderSessionStats(snapshot);
  for (const message of snapshot?.messages || []) {
    if (message.role === 'toolResult' && message.toolCallId) {
      liveToolOutputs.delete(message.toolCallId);
      liveToolStatuses.delete(message.toolCallId);
    }
  }
  const box = $('#session-messages'); if (!box || !snapshot) return;
  const items = snapshotItems(snapshot);
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  box.innerHTML = items.length ? items.map(sessionHtml).join('') : `<div class="session-welcome"><div class="welcome-icon">✦</div><h2>开始与 pi agent 对话</h2><p>输入任务、问题或使用 Slash Command 控制当前会话。</p><div class="welcome-examples"><button data-example="请先分析当前项目结构，并告诉我下一步建议。">分析项目</button><button data-example="请检查当前项目是否存在明显错误。">检查问题</button><button data-example="请为当前项目补充测试。">补充测试</button></div></div>`;
  if (wasNearBottom || items.length === 0) box.scrollTop = box.scrollHeight;
  const task = currentTask(state.sessionTask);
  const modelButton = $('#session-model-button');
  const thinkingButton = $('#session-thinking-button');
  if (modelButton) { modelButton.disabled = !task; modelButton.textContent = snapshot.model ? `🤖 ${snapshot.model.name}` : '🤖 选择模型'; }
  if (thinkingButton) { thinkingButton.disabled = !task; thinkingButton.textContent = `思考：${snapshot.thinkingLevel || '—'}`; }
  $('#session-send').disabled = !task;
  $('#session-stop').disabled = !task || !snapshot.isStreaming;
}
function renderModelPicker(models) {
  const box = $('#session-model-menu'); if (!box) return;
  const items = (models || []).map((model) => `<button data-model-provider="${esc(model.provider)}" data-model-id="${esc(model.id)}" title="${esc(model.name || '')}">${esc(model.name || `${model.provider}/${model.id}`)}<span class="hint" style="margin-left:7px">${esc(model.provider)}/${esc(model.id)}</span></button>`).join('');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="model-menu-head">可用模型 <button data-model-close style="float:right">关闭</button></div><div>${items || '<span class="hint">暂无可用模型</span>'}</div>`;
}
function renderThinkingPicker(levels, current) {
  const box = $('#session-model-menu'); if (!box) return;
  const items = (levels || []).map((level) => `<button data-thinking-level="${esc(level)}" style="${level === current ? 'font-weight:700;background:#dbeafe' : ''}">${esc(level)}</button>`).join('');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="model-menu-head">思考强度 <button data-model-close style="float:right">关闭</button></div><div>${items || '<span class="hint">当前模型不支持可调思考强度</span>'}</div>`;
}
$('#session-messages').onclick = (event) => {
  const example = event.target.closest('[data-example]');
  if (!example) return;
  $('#session-input').value = example.dataset.example;
  $('#session-input').focus();
};
$('#session-model-menu').onclick = (event) => {
  const close = event.target.closest('[data-model-close]');
  if (close) { $('#session-model-menu').classList.add('hidden'); $('#session-model-menu').innerHTML = ''; return; }
  const modelButton = event.target.closest('[data-model-provider]');
  if (modelButton && sessionSocket?.readyState === WebSocket.OPEN) {
    sessionSocket.send(JSON.stringify({ type: 'select_model', provider: modelButton.dataset.modelProvider, modelId: modelButton.dataset.modelId }));
    $('#session-model-menu').classList.add('hidden'); $('#session-model-menu').innerHTML = '';
    toast(`正在切换模型：${modelButton.dataset.modelProvider}/${modelButton.dataset.modelId}`);
    return;
  }
  const thinkingButton = event.target.closest('[data-thinking-level]');
  if (thinkingButton && sessionSocket?.readyState === WebSocket.OPEN) {
    sessionSocket.send(JSON.stringify({ type: 'command', command: `/thinking ${thinkingButton.dataset.thinkingLevel}` }));
    $('#session-model-menu').classList.add('hidden'); $('#session-model-menu').innerHTML = '';
    toast(`正在设置思考强度：${thinkingButton.dataset.thinkingLevel}`);
  }
};
function updateCommandMenu() {
  const input = $('#session-input'); const menu = $('#session-command-menu');
  if (!input || !menu) return;
  const value = input.value;
  if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) {
    menu.classList.add('hidden'); menu.innerHTML = ''; return;
  }
  const query = value.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter(([name]) => name.includes(query));
  if (!matches.length) { menu.classList.add('hidden'); menu.innerHTML = ''; return; }
  commandMenuIndex = Math.min(commandMenuIndex, matches.length - 1);
  menu.classList.remove('hidden');
  menu.innerHTML = matches.map(([name, description], index) => `<button type="button" data-command="/${name}" style="display:block;width:100%;text-align:left;border:0;border-radius:0;background:${index === commandMenuIndex ? '#eff6ff' : '#fff'}"><strong>/${name}</strong><span class="hint" style="margin-left:10px">${esc(description)}</span></button>`).join('');
  menu.querySelectorAll('[data-command]').forEach((button) => {
    button.onclick = () => { input.value = button.dataset.command; menu.classList.add('hidden'); input.focus(); };
  });
}

async function loadSession() {
  const id = state.sessionTask; if (!id) return;
  try {
    const data = await api(`/tasks/${id}/session?sessionId=${encodeURIComponent(state.sessionSessionId || 'main')}`); const box = $('#session-messages'); if (!box || sessionSocket) return;
    box.innerHTML = data.exists && data.items.length ? data.items.map(sessionHtml).join('') : '<div class="empty">暂无会话消息</div>';
    box.scrollTop = box.scrollHeight;
    const running = Boolean(task?.piRunning); $('#session-send').disabled = !task; $('#session-stop').disabled = !running;
  } catch (e) { toast(e.message, 'error'); }
}
function selectSession(id, sessionId = 'main') {
  state.sessionTask = id || null;
  state.sessionSessionId = sessionId || 'main';
  renderSessionHeader();
  renderSessionTree();
  sessionSnapshot = null;
  renderSessionStats(null);
  if ($('#session-model-button')) { $('#session-model-button').disabled = true; $('#session-model-button').textContent = '🤖 选择模型'; }
  if ($('#session-thinking-button')) { $('#session-thinking-button').disabled = true; $('#session-thinking-button').textContent = '思考：—'; }
  $('#session-model-menu')?.classList.add('hidden');
  liveToolOutputs.clear(); liveToolStatuses.clear();
  liveSession = { text: '', tools: [] }; renderLiveSession();
  if (sessionSocket) { sessionSocket.close(); sessionSocket = null; }
  if (!id) { $('#session-messages').innerHTML = '<div class="empty">选择任务后查看会话</div>'; return; }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  sessionSocket = new WebSocket(`${protocol}//${location.host}/ws`);
  sessionSocket.onopen = () => sessionSocket?.send(JSON.stringify({ type: 'hello', taskId: id, sessionId: state.sessionSessionId }));
  sessionSocket.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === 'snapshot') { if (event.state?.childSessionId) { state.sessionSessionId = event.state.childSessionId; renderSessionHeader(); renderSessionTree(); } renderSessionSnapshot(event.state); }
      else if (event.type === 'tool_execution_start') {
        liveToolStatuses.set(event.toolCallId, { toolName: event.toolName || 'tool', isError: false });
        if (sessionSnapshot) renderSessionSnapshot(sessionSnapshot);
      } else if (event.type === 'bash_execution_update' && event.id) {
        liveToolOutputs.set(event.id, (liveToolOutputs.get(event.id) || '') + (event.delta || ''));
        if (sessionSnapshot) renderSessionSnapshot(sessionSnapshot);
      } else if (event.type === 'tool_execution_end') {
        liveToolStatuses.set(event.toolCallId, { toolName: event.toolName || 'tool', isError: Boolean(event.isError) });
        if (sessionSnapshot) renderSessionSnapshot(sessionSnapshot);
      } else if (event.type === 'model_list') renderModelPicker(event.models);
      else if (event.type === 'thinking_list') renderThinkingPicker(event.levels, event.current);
      else if (event.type === 'notice') toast(event.text || '指令已执行');
      else if (event.type === 'error') toast(event.error || '会话错误', 'error');
    } catch { /* ignore malformed websocket data */ }
  };
  sessionSocket.onerror = () => { toast('WebSocket 会话连接失败，正在使用日志视图', 'error'); sessionSocket = null; loadSession(); };
  sessionSocket.onclose = () => { if (sessionSocket?.readyState === WebSocket.CLOSED) sessionSocket = null; };
  loadSession();
}

function modal(html) { const root = $('#modal-root'); root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`; root.querySelector('.overlay').addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) closeModal(); }); return $('.modal', root); }
function closeModal() { $('#modal-root').innerHTML = ''; }

function openTaskForm(task = null) {
  const selectedColor = taskColor(task || {});
  const m = modal(`<h2>${task ? '编辑任务' : '新建任务'}</h2><label>标题<input id="task-title" value="${task ? esc(task.title) : ''}" placeholder="例如：整理项目测试结果"></label><label>内容描述（将作为 pi agent 的执行指令）<textarea id="task-desc" rows="7" placeholder="详细描述希望 AI 完成的工作…">${task ? esc(task.description) : ''}</textarea></label><div class="row"><label>颜色标签<div id="color-picker" class="color-picker">${Object.entries(COLORS).map(([key, value]) => `<button type="button" class="color-option color-${key}${selectedColor === key ? ' active' : ''}" data-color-value="${key}" aria-label="${value.label}" title="${value.label}"><span></span></button>`).join('')}</div><input type="hidden" id="task-color" value="${selectedColor}"></label><label>截止时间<input id="task-deadline" type="datetime-local" value="${task?.deadline || ''}"></label></div><div class="modal-actions"><button class="primary" id="save-task">${task ? '保存' : '创建'}</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  m.querySelectorAll('[data-color-value]').forEach((button) => { button.onclick = () => { $('#task-color', m).value = button.dataset.colorValue; m.querySelectorAll('[data-color-value]').forEach((item) => item.classList.toggle('active', item === button)); }; });
  $('#save-task', m).onclick = async () => { try { const body = { title: $('#task-title', m).value, description: $('#task-desc', m).value, color: $('#task-color', m).value, deadline: $('#task-deadline', m).value || null }; await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PUT' : 'POST', body }); closeModal(); toast(task ? '任务已保存' : '任务已创建'); refresh(); } catch (e) { toast(e.message, 'error'); } };
}
async function openExecute(task) {
  const m = modal(`<h2>执行任务：${esc(task.title)}</h2><p class="hint">可使用任意本地目录作为工作目录，开始后将自动进入对应会话。</p><label>工作目录路径<div class="path-picker-row"><input id="exec-dir" value="${esc(task.workingDir || '')}" placeholder="例如：/Users/your-name/projects/demo 或 ~/projects/demo"><button type="button" id="choose-dir">选择文件夹</button></div></label><label>本次执行描述<textarea id="exec-description" rows="8" placeholder="描述希望 AI 完成的工作…">${esc(task.description)}</textarea></label><div class="modal-actions"><button class="primary" id="start-exec">开始执行</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  $('#choose-dir', m).onclick = async () => { const picker = $('#choose-dir', m); picker.disabled = true; try { const result = await api('/select-directory', { method: 'POST' }); if (result.path) { $('#exec-dir', m).value = result.path; $('#exec-dir', m).focus(); } } catch (error) { toast(error.message, 'error'); } finally { picker.disabled = false; } };
  $('#start-exec', m).onclick = async () => { const dir = $('#exec-dir', m).value.trim(); if (!dir) return toast('请输入工作目录路径', 'error'); const button = $('#start-exec', m); button.disabled = true; try { const result = await api(`/tasks/${task.id}/execute`, { method: 'POST', body: { workingDir: dir, description: $('#exec-description', m).value } }); closeModal(); toast('已开始执行'); await refresh(); switchModule('session'); selectSession(task.id, result.task?.activeSessionId || 'main'); } catch (e) { button.disabled = false; toast(e.message, 'error'); } };
}

function openDeleteTaskModal(task) {
  const m = modal(`<h2>废弃任务</h2><p>确定将「${esc(task.title)}」移入已废弃任务吗？任务及其会话会保留 15 天，之后自动删除。</p><div class="modal-actions"><button class="danger" id="confirm-archive-task">移入已废弃</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  $('#confirm-archive-task', m).onclick = async () => {
    const button = $('#confirm-archive-task', m); button.disabled = true;
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); closeModal(); state.status = ''; toast('任务已移入已废弃'); await refresh(); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
function openPurgeTaskModal(task) {
  const m = modal(`<h2>永久删除任务</h2><p>确定永久删除「${esc(task.title)}」及其全部会话吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-task">永久删除</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  $('#confirm-purge-task', m).onclick = async () => {
    const button = $('#confirm-purge-task', m); button.disabled = true;
    try { await api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }); closeModal(); toast('任务已永久删除'); await refresh(); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
function switchModule(module) {
  const session = module === 'session';
  document.body.classList.toggle('session-mode', session);
  $('#module-session').classList.toggle('active', session);
  $('#module-tasks').classList.toggle('active', !session);
  $('#task-sidebar').classList.toggle('hidden', session);
  $('#session-sidebar').classList.toggle('hidden', !session);
  $('#stats').classList.toggle('hidden', session);
  $('#task-toolbar').classList.toggle('hidden', session);
  $('#task-list').classList.toggle('hidden', session);
  $('#session-view').classList.toggle('hidden', !session);
  if (session) { syncSessionTasks(); renderSessionTree(); loadSession(); }
}
$('#theme-select').onchange = (event) => { applyTheme(event.target.value); event.target.blur(); };
$('#module-tasks').onclick = () => switchModule('tasks');
$('#module-session').onclick = () => switchModule('session');
$('#sidebar-new-task').onclick = () => openTaskForm();
function openSessionModal(task, session = null) {
  const editing = Boolean(session);
  const m = modal(`<h2>${editing ? '重命名子会话' : '新建子会话'}</h2><p class="hint">任务：${esc(task.title)}</p><label>会话名称<input id="session-title-input" value="${esc(session?.title || '新会话')}" placeholder="例如：检查登录模块"></label><div class="modal-actions"><button class="primary" id="save-session">${editing ? '保存' : '创建'}</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  $('#session-title-input', m).focus();
  $('#save-session', m).onclick = async () => {
    const title = $('#session-title-input', m).value.trim();
    if (!title) return toast('会话名称不能为空', 'error');
    const button = $('#save-session', m); button.disabled = true;
    try {
      const result = await api(editing ? `/tasks/${task.id}/sessions/${session.id}` : `/tasks/${task.id}/sessions`, { method: editing ? 'PATCH' : 'POST', body: { title } });
      closeModal(); await refresh();
      if (!editing) selectSession(task.id, result.session.id);
      else if (state.sessionTask === task.id && state.sessionSessionId === session.id) selectSession(task.id, session.id);
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
function openDeleteSessionModal(task, sessionId) {
  const m = modal(`<h2>删除子会话</h2><p>确定删除「${esc(task.title)}」下的这个子会话及其日志吗？</p><div class="modal-actions"><button class="danger" id="confirm-delete-session">删除</button><button data-close>取消</button></div>`);
  $('[data-close]', m).onclick = closeModal;
  $('#confirm-delete-session', m).onclick = async () => {
    const button = $('#confirm-delete-session', m); button.disabled = true;
    const wasActive = state.sessionTask === task.id && state.sessionSessionId === sessionId;
    const remaining = task.sessions?.find((item) => item.id !== sessionId);
    try { await api(`/tasks/${task.id}/sessions/${sessionId}`, { method: 'DELETE' }); closeModal(); await refresh(); if (wasActive && remaining) selectSession(task.id, remaining.id); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
$('#session-task-select').onchange = (e) => selectSession(e.target.value);
$('#session-tree').onclick = (event) => {
  const create = event.target.closest('[data-new-session-task]');
  if (create) { const task = currentTask(create.dataset.newSessionTask); if (task) openSessionModal(task); return; }
  const remove = event.target.closest('[data-delete-session]');
  if (remove) { event.stopPropagation(); const task = currentTask(remove.dataset.deleteSession); if (task) openDeleteSessionModal(task, remove.dataset.sessionId); return; }
  const group = event.target.closest('[data-session-group]');
  if (group) { const id = group.dataset.sessionGroup; if (state.collapsedSessionTasks.has(id)) state.collapsedSessionTasks.delete(id); else state.collapsedSessionTasks.add(id); renderSessionTree(); return; }
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
$('#session-model-button').onclick = () => {
  if (sessionSocket?.readyState !== WebSocket.OPEN) return toast('请先选择一个可用会话', 'error');
  sessionSocket.send(JSON.stringify({ type: 'command', command: '/model' }));
};
$('#session-thinking-button').onclick = () => {
  if (sessionSocket?.readyState !== WebSocket.OPEN) return toast('请先选择一个可用会话', 'error');
  sessionSocket.send(JSON.stringify({ type: 'command', command: '/thinking' }));
};
function resizeSessionInput() {
  const input = $('#session-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
}
async function sendSessionMessage(queue = false) {
  const input = $('#session-input');
  const task = currentTask(state.sessionTask); const message = input.value.trim();
  if (!task || !message) return toast('请选择会话并输入消息', 'error');
  try {
    if (sessionSocket?.readyState === WebSocket.OPEN) {
      sessionSocket.send(JSON.stringify({ type: 'prompt', text: message, queue }));
    } else {
      const isCommand = message.startsWith('/');
      await api(isCommand ? `/tasks/${task.id}/command` : `/tasks/${task.id}/reply`, { method: 'POST', body: isCommand ? { command: message } : { message } });
    }
    input.value = '';
    resizeSessionInput();
    updateCommandMenu();
    toast(message.startsWith('/') ? 'pi 指令已发送' : '消息已发送');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}
$('#session-send').onclick = () => sendSessionMessage(false);
$('#session-followup').onclick = () => sendSessionMessage(true);
$('#session-input').oninput = () => { commandMenuIndex = 0; resizeSessionInput(); updateCommandMenu(); };
resizeSessionInput();
$('#session-input').onkeydown = (event) => {
  const menu = $('#session-command-menu');
  const menuVisible = menu && !menu.classList.contains('hidden');
  const options = menuVisible ? [...menu.querySelectorAll('[data-command]')] : [];
  if (event.key === 'Escape') {
    if (menuVisible) { event.preventDefault(); menu.classList.add('hidden'); return; }
    if (sessionSnapshot?.isStreaming && sessionSocket?.readyState === WebSocket.OPEN) {
      event.preventDefault();
      sessionSocket.send(JSON.stringify({ type: 'abort' }));
      toast('正在停止当前生成');
    }
    return;
  }
  if (menuVisible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    commandMenuIndex = (commandMenuIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
    updateCommandMenu();
    return;
  }
  if (event.key === 'Tab' && menuVisible && options[commandMenuIndex]) {
    event.preventDefault();
    event.target.value = options[commandMenuIndex].dataset.command;
    updateCommandMenu();
    return;
  }
  // Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter also sends.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (menuVisible && options[commandMenuIndex] && !event.target.value.includes(' ')) {
      event.target.value = options[commandMenuIndex].dataset.command;
    }
    sendSessionMessage();
  }
};
$('#session-stop').onclick = async () => { const task = currentTask(state.sessionTask); if (!task) return; try { await api(`/tasks/${task.id}/terminate`, { method: 'POST' }); toast('已终止执行'); refresh(); } catch (e) { toast(e.message, 'error'); } };
$('#task-groups').onclick = (event) => {
  const group = event.target.closest('[data-task-filter]');
  if (!group) return;
  state.status = group.dataset.taskFilter || '';
  renderTaskSidebar();
  renderList();
};
$('#sort').onchange = (e) => { state.sort = e.target.value; renderList(); };
$('#search').oninput = (e) => { state.search = e.target.value; renderList(); };
$('#task-list').onclick = async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const id = button.dataset.id; const task = currentTask(id); const action = button.dataset.action;
  try {
    if (action === 'new') openTaskForm();
    else if (action === 'edit') openTaskForm(task);
    else if (action === 'execute') openExecute(task);
    else if (action === 'session') { switchModule('session'); selectSession(task.id, task.activeSessionId || 'main'); }
    else if (action === 'delete') openDeleteTaskModal(task);
    else if (action === 'restore') { await api(`/tasks/${id}/restore`, { method: 'POST' }); state.status = ''; toast('任务已恢复到待办'); refresh(); }
    else if (action === 'purge') openPurgeTaskModal(task);
    else if (action === 'complete') { await api(`/tasks/${id}/complete`, { method: 'POST' }); toast('已标记完成'); refresh(); }
    else if (action === 'reopen') { await api(`/tasks/${id}/reopen`, { method: 'POST' }); toast('任务已重开'); refresh(); }
    else if (action === 'terminate' && confirm('确定终止当前 AI 执行吗？')) { await api(`/tasks/${id}/terminate`, { method: 'POST' }); toast('执行已终止'); refresh(); }

  } catch (e) { toast(e.message, 'error'); }
};

refresh();
setInterval(refresh, 3000);
