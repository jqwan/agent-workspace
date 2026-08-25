import { extractText } from './session.js';

/** 仅把用户在会话中可见的助手文本当作一条未读消息。 */
export function unreadAssistantMessages(entries) {
  return (entries || []).filter((entry) => (
    entry?.type === 'message'
    && entry.message?.role === 'assistant'
    && Boolean(extractText(entry.message.content).trim())
  ));
}

export function messageTime(entry) {
  const value = entry?.message?.timestamp || entry?.timestamp;
  const time = typeof value === 'number' ? value : new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

export function sessionUnreadCount(child, messages) {
  if (!messages.length) return 0;
  const markerIndex = child.lastReadMessageId ? messages.findIndex((entry) => entry.id === child.lastReadMessageId) : -1;
  const lastReadAt = Number(child.lastReadAt) || new Date(child.lastReadAt || 0).getTime() || 0;
  return markerIndex >= 0 ? messages.length - markerIndex - 1 : messages.filter((entry) => messageTime(entry) > lastReadAt).length;
}

/**
 * 根据客户端实际看到的消息 ID 推进已读水位；绝不以请求抵达时的最新消息替代它。
 * 返回 null 表示水位无须更新或客户端水位已经失效。
 */
export function nextReadState(child, messages, readThroughMessageId) {
  if (!readThroughMessageId || !messages.length) return null;
  const targetIndex = messages.findIndex((entry) => entry.id === readThroughMessageId);
  if (targetIndex < 0) return null;

  const currentIndex = child.lastReadMessageId ? messages.findIndex((entry) => entry.id === child.lastReadMessageId) : -1;
  const currentReadAt = Number(child.lastReadAt) || new Date(child.lastReadAt || 0).getTime() || 0;
  const target = messages[targetIndex];
  const targetReadAt = messageTime(target) || Date.now();

  // 若旧 marker 因压缩而不在文件中，仍用时间水位避免倒退。
  if ((currentIndex >= 0 && targetIndex <= currentIndex) || (currentIndex < 0 && targetReadAt <= currentReadAt)) return null;
  return { lastReadMessageId: target.id, lastReadAt: targetReadAt };
}
