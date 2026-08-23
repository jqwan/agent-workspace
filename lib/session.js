import { readFileSync, existsSync, statSync } from 'node:fs';

const sessionCache = new Map();

/** 从 pi 消息 content 中提取纯文本 */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

/**
 * 解析 pi session 文件（JSONL）。
 * 返回 { exists, header, entries, leaf, lastMessage, stats }
 */
export function parseSessionFile(file) {
  const empty = { exists: false, entries: [], leaf: null, lastMessage: null, stats: null };
  if (!file || !existsSync(file)) {
    if (file) sessionCache.delete(file);
    return empty;
  }
  let text;
  let signature;
  try {
    const stat = statSync(file);
    signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = sessionCache.get(file);
    if (cached?.signature === signature) return cached.value;
    text = readFileSync(file, 'utf8');
  } catch {
    sessionCache.delete(file);
    return empty;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 忽略不完整行（可能正在写入） */
    }
  }
  const header = entries[0] && entries[0].type === 'session' ? entries[0] : null;
  const body = entries.slice(header ? 1 : 0);
  const leaf = body.length ? body[body.length - 1] : null;

  let lastMessage = null;
  for (const e of body) if (e.type === 'message') lastMessage = e;

  const stats = {
    messages: 0, user: 0, assistant: 0, toolResults: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, errors: 0,
  };
  for (const e of body) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    stats.messages++;
    if (m.role === 'user') {
      stats.user++;
    } else if (m.role === 'assistant') {
      stats.assistant++;
      if (m.usage) {
        stats.input += m.usage.input || 0;
        stats.output += m.usage.output || 0;
        stats.cacheRead += m.usage.cacheRead || 0;
        stats.cacheWrite += m.usage.cacheWrite || 0;
        if (m.usage.cost && typeof m.usage.cost.total === 'number') stats.cost += m.usage.cost.total;
      }
      if (m.stopReason === 'error') stats.errors++;
    } else if (m.role === 'toolResult') {
      stats.toolResults++;
      if (m.isError) stats.errors++;
    }
  }
  const result = { exists: true, header, entries: body, leaf, lastMessage, stats };
  sessionCache.set(file, { signature, value: result });
  return result;
}

export function invalidateSessionFile(file) {
  if (file) sessionCache.delete(file);
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * 判定一个「执行中」任务的状态迁移。
 * 只看「本轮运行」(runStart 之后) 写入的消息，避免被上一轮历史干扰。
 *
 * @returns null = 继续执行中；否则 { lastRun: { status, reason, at } }
 */
export function evaluateRunningTask(task, { findPiPids, now = Date.now(), sessionFile = null }) {
  const runStart = task.lastRun && task.lastRun.at ? new Date(task.lastRun.at).getTime() : 0;
  // task.sessionFile is a legacy compatibility anchor. A run must be checked
  // against the child session that actually started it.
  const activeSessionFile = sessionFile || task.lastRun?.sessionFile || task.sessionFile;
  const parsed = parseSessionFile(activeSessionFile);
  const processAlive = findPiPids(activeSessionFile).length > 0;
  if (!processAlive && task.lastRun?.status && task.lastRun.status !== 'running') return null;

  if (!parsed.exists) {
    if (runStart && now - runStart > 180_000) {
      return { lastRun: { status: 'failed', reason: '未生成 session 文件，pi 可能启动失败', at: iso(now) } };
    }
    return null;
  }

  // 本轮写入的最后一条消息
  let leafMsg = null;
  for (const e of parsed.entries) {
    if (e.type !== 'message' || !e.message) continue;
    const ts = typeof e.message.timestamp === 'number'
      ? e.message.timestamp
      : new Date(e.message.timestamp || 0).getTime();
    if (ts >= runStart - 2000) leafMsg = e;
  }
  if (!leafMsg) {
    if (runStart && now - runStart > 180_000) {
      return { lastRun: { status: 'failed', reason: 'pi 未写入任何新消息（可能启动失败）', at: iso(now) } };
    }
    return null;
  }

  const m = leafMsg.message;
  if (m.role === 'assistant') {
    if (m.stopReason === 'stop' || m.stopReason === 'length') {
      return { lastRun: { status: 'done', reason: null, at: iso(now) } };
    }
    if (m.stopReason === 'error') {
      return { lastRun: { status: 'failed', reason: m.errorMessage || '模型返回错误（检查模型连接/认证/限流）', at: iso(now) } };
    }
    if (m.stopReason === 'aborted') {
      return { lastRun: { status: 'terminated', reason: '执行被中断', at: iso(now) } };
    }
    // stopReason === 'toolUse'：工具执行中
    return processAlive
      ? null
      : { lastRun: { status: 'terminated', reason: 'pi 进程已退出（工具执行中）', at: iso(now) } };
  }
  if (m.role === 'user') {
    return processAlive
      ? null
      : { lastRun: { status: 'terminated', reason: 'pi 进程已退出（可能关闭了终端窗口）', at: iso(now) } };
  }
  // toolResult
  return processAlive
    ? null
    : { lastRun: { status: 'terminated', reason: 'pi 执行中进程退出（可能关闭了终端窗口）', at: iso(now) } };
}
