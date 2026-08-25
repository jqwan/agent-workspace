import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSessionFile } from '../lib/session.js';
import { unreadAssistantMessages, sessionUnreadCount, nextReadState } from '../lib/unread.js';

function sessionFile(entries) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-workbench-session-'));
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { dir, file };
}

test('parseSessionFile caches unchanged JSONL and returns statistics', () => {
  const { dir, file } = sessionFile([
    { type: 'session', id: 'root' },
    { type: 'message', message: { role: 'user', content: 'hello' } },
    { type: 'message', message: { role: 'assistant', content: 'world', usage: { input: 2, output: 3, cost: { total: 0.01 } }, stopReason: 'stop' } },
  ]);
  try {
    const first = parseSessionFile(file);
    const second = parseSessionFile(file);
    assert.strictEqual(first, second);
    assert.equal(first.stats.messages, 2);
    assert.equal(first.stats.input, 2);
    assert.equal(first.stats.output, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未读只统计可见助手文本，且已读水位不会跨过客户端未看到的新消息', () => {
  const messages = unreadAssistantMessages([
    { type: 'message', id: 'tool', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', timestamp: 1000, content: [{ type: 'toolCall', id: 'call-1', name: 'read' }] } },
    { type: 'message', id: 'first', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: '第一条回复' }] } },
    { type: 'message', id: 'second', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', timestamp: 3000, content: '第二条回复' } },
  ]);
  assert.deepEqual(messages.map((entry) => entry.id), ['first', 'second']);

  const child = { lastReadMessageId: null, lastReadAt: 0 };
  const next = nextReadState(child, messages, 'first');
  assert.deepEqual(next, { lastReadMessageId: 'first', lastReadAt: 2000 });
  Object.assign(child, next);
  assert.equal(sessionUnreadCount(child, messages), 1);

  // 延迟送达的“已读第一条”请求不能把第二条也一并标记为已读。
  assert.equal(nextReadState(child, messages, 'first'), null);
  assert.equal(sessionUnreadCount(child, messages), 1);
});

