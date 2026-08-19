import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import os from 'node:os';

// The web session is an in-process AgentSession. This is deliberately different
// from the old `pi --mode rpc` implementation: the SDK owns persistence and we
// can expose its exact state (including streamingMessage) to the browser.
const runs = new Map();
const histories = new Map();
const listeners = new Map();
const stateTimers = new Map();

function broadcast(taskId, item) {
  for (const listener of listeners.get(taskId) || []) {
    try { listener(item); } catch { /* 客户端已断开 */ }
  }
}
function addEvent(taskId, event) {
  const item = { ...event, receivedAt: new Date().toISOString() };
  const history = histories.get(taskId) || [];
  history.push(item);
  if (history.length > 3000) history.splice(0, history.length - 3000);
  histories.set(taskId, history);
  broadcast(taskId, item);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'thinking') return block.thinking || '';
    return '';
  }).join('');
}

function contentOf(message) {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  if (!Array.isArray(message.content)) return [];
  return message.content.map((block) => {
    if (block?.type === 'text') return { type: 'text', text: String(block.text || '') };
    if (block?.type === 'thinking') return { type: 'thinking', thinking: String(block.thinking || '') };
    if (block?.type === 'toolCall') return {
      type: 'toolCall', id: block.id, name: block.name,
      argumentsText: block.arguments === undefined ? undefined : JSON.stringify(block.arguments),
    };
    if (block?.type === 'image') return { type: 'image', mimeType: block.mimeType };
    return { type: String(block?.type || 'unknown'), text: textOf(block) };
  });
}

function serializeMessage(message, index) {
  if (!message || !message.role) return null;
  const id = `${message.role}-${message.timestamp || 0}-${index}`;
  if (message.role === 'toolResult') {
    return {
      id: `tool-${message.toolCallId || id}`, role: 'toolResult',
      content: [{ type: 'text', text: textOf(message.content) }],
      toolCallId: message.toolCallId, toolName: message.toolName,
      isError: Boolean(message.isError), timestamp: message.timestamp,
    };
  }
  return {
    id, role: message.role, content: contentOf(message), timestamp: message.timestamp,
    model: message.model, provider: message.provider,
    stopReason: message.stopReason, errorMessage: message.errorMessage,
  };
}

function serializeStreaming(message) {
  if (!message) return null;
  const result = serializeMessage(message, 0);
  return result ? { ...result, id: `stream-${message.timestamp || 0}` } : null;
}

function sessionState(record) {
  const session = record.session;
  const raw = session.messages || session.state?.messages || [];
  let stats = { totalMessages: raw.length, userMessages: 0, assistantMessages: 0, toolResults: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: null, cacheHitRate: null };
  try {
    const s = session.getSessionStats();
    let cacheHitRate = null;
    const entries = session.sessionManager?.getEntries?.() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const usage = entries[i]?.type === 'message' && entries[i].message?.role === 'assistant' ? entries[i].message.usage : null;
      if (!usage) continue;
      const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      if (promptTokens > 0) { cacheHitRate = (usage.cacheRead || 0) / promptTokens * 100; }
      break;
    }
    stats = {
      totalMessages: s.totalMessages,
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      toolResults: s.toolResults,
      toolCalls: s.toolCalls,
      tokens: s.tokens,
      cost: s.cost,
      contextUsage: s.contextUsage || null,
      cacheHitRate,
    };
  } catch { /* best effort */ }
  const model = session.model;
  const state = session.state || {};
  return {
    taskId: record.taskId,
    childSessionId: record.childSessionId || 'main',
    cwd: record.workingDir,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    messages: raw.map(serializeMessage).filter(Boolean),
    streamingMessage: serializeStreaming(state.streamingMessage),
    isStreaming: Boolean(session.isStreaming),
    model: model ? { id: model.id, name: model.name, provider: model.provider, vision: model.input?.includes('image') || false } : null,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels?.() || [],
    queue: { steering: session.getSteeringMessages?.().length || 0, followUp: session.getFollowUpMessages?.().length || 0 },
    errorMessage: state.errorMessage || null,
    tools: session.getActiveToolNames?.() || [],
    stats,
  };
}

function eventForClient(event) {
  // Keep the wire history bounded and JSON-friendly. The complete messages are
  // always available in snapshot; events only carry live deltas/status.
  if (!event || typeof event !== 'object') return { type: 'notice', text: String(event) };
  const out = { ...event };
  if (Array.isArray(out.messages)) delete out.messages;
  if (out.entry) delete out.entry;
  return out;
}

export function isWebPiRunning(taskId) {
  // Kept as the public compatibility name: an SDK session remains available
  // after a turn settles so the user can continue it from the review state.
  return runs.has(taskId);
}

export function hasWebSession(taskId) { return runs.has(taskId); }
export function getWebEvents(taskId) { return histories.get(taskId) || []; }
export function getWebState(taskId) {
  const record = runs.get(taskId);
  return record ? sessionState(record) : null;
}
export function subscribeWebPi(taskId, listener) {
  const set = listeners.get(taskId) || new Set();
  set.add(listener); listeners.set(taskId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(taskId); };
}

function emitState(taskId) {
  if (stateTimers.has(taskId)) return;
  const timer = setTimeout(() => {
    stateTimers.delete(taskId);
    const state = getWebState(taskId);
    if (state) broadcast(taskId, { type: 'snapshot', state, receivedAt: new Date().toISOString() });
  }, 50);
  timer.unref?.();
  stateTimers.set(taskId, timer);
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || `${os.homedir()}/.pi/agent`;
}

export async function startWebPi({ taskId, childSessionId = 'main', workingDir, sessionFile, title, provider, model, thinkingLevel, readOnly, onEvent, onExit }) {
  await stopWebPi(taskId);
  const sessionManager = SessionManager.open(sessionFile, undefined, workingDir);
  let result;
  try {
    result = await createAgentSession({
      cwd: workingDir,
      agentDir: agentDir(),
      sessionManager,
      ...(readOnly ? { tools: ['read', 'grep', 'find', 'ls'] } : {}),
    });
    const session = result.session;
    const record = { taskId, childSessionId, workingDir, session, unsubscribe: null, onExit };
    runs.set(taskId, record);
    if (provider && model) {
      const selected = session.modelRuntime.getModel(provider, model);
      if (!selected) throw new Error(`找不到模型：${provider}/${model}`);
      await session.setModel(selected);
    }
    if (thinkingLevel) session.setThinkingLevel(thinkingLevel);
    await session.bindExtensions({ mode: 'rpc', onError: (error) => {
      addEvent(taskId, { type: 'process_error', message: error?.error || String(error) });
    }});
    record.unsubscribe = session.subscribe((event) => {
      const clientEvent = eventForClient(event);
      addEvent(taskId, clientEvent);
      onEvent?.(clientEvent);
      emitState(taskId);
      if (event.type === 'agent_end') {
        // agent_end can be emitted before the SDK has completed its final
        // persistence bookkeeping; send one more settled snapshot shortly after.
        setTimeout(() => emitState(taskId), 50).unref?.();
      }
    });
    addEvent(taskId, { type: 'process_start', pid: process.pid, mode: 'sdk' });
    emitState(taskId);
    return session;
  } catch (error) {
    const record = runs.get(taskId);
    if (record) { try { record.session.dispose(); } catch {} runs.delete(taskId); }
    throw error;
  }
}

export async function sendWebPrompt(taskId, message, streamingBehavior) {
  const record = runs.get(taskId);
  if (!record) throw new Error('Web 会话未运行，请先执行一次任务');
  const options = record.session.isStreaming ? { streamingBehavior: streamingBehavior || 'steer' } : undefined;
  await record.session.prompt(message, options);
  emitState(taskId);
}

export async function sendWebCommand(taskId, command) {
  const record = runs.get(taskId);
  if (!record) throw new Error('Web 会话未运行，请先执行一次任务');
  const session = record.session;
  const type = command?.type;
  if (type === 'abort') await session.abort();
  else if (type === 'compact') await session.compact(command.customInstructions || undefined);
  else if (type === 'set_thinking_level') session.setThinkingLevel(command.level);
  else if (type === 'get_thinking_levels') addEvent(taskId, { type: 'thinking_list', levels: session.getAvailableThinkingLevels(), current: session.thinkingLevel });
  else if (type === 'cycle_model') await session.cycleModel();
  else if (type === 'set_model') {
    const model = session.modelRuntime.getModel(command.provider, command.modelId);
    if (!model) throw new Error(`找不到模型：${command.provider}/${command.modelId}`);
    await session.setModel(model);
  } else if (type === 'get_available_models') {
    const models = await session.modelRuntime.getAvailable();
    addEvent(taskId, {
      type: 'model_list',
      models: models.map((item) => ({ provider: item.provider, id: item.id, name: item.name })),
    });
  } else if (type === 'get_state') {
    const stats = session.getSessionStats();
    addEvent(taskId, {
      type: 'notice', level: 'info',
      text: `会话 ${session.sessionId}：${stats.totalMessages} 条消息，输入 ${stats.tokens.input} / 输出 ${stats.tokens.output} tokens，成本 $${stats.cost.toFixed(4)}`,
    });
  } else throw new Error(`不支持的 SDK 指令：${type}`);
  emitState(taskId);
}

export function stopWebPi(taskId) {
  const record = runs.get(taskId);
  if (!record) return false;
  runs.delete(taskId);
  const timer = stateTimers.get(taskId);
  if (timer) { clearTimeout(timer); stateTimers.delete(taskId); }
  try { record.unsubscribe?.(); } catch {}
  Promise.resolve(record.session.abort()).catch(() => {}).finally(() => {
    try { record.session.dispose(); } catch {}
  });
  addEvent(taskId, { type: 'process_exit', code: 0, signal: 'SIGTERM', mode: 'sdk' });
  record.onExit?.({ code: 0, signal: 'SIGTERM' });
  return true;
}
