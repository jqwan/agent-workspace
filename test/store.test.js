import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTasks } from '../lib/store.js';

test('normalizeTasks backfills legacy sessions and converts unknown statuses to unfinished', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const legacy = {
    id: 'legacy',
    status: 'review',
    sessionFile: '/tmp/legacy.jsonl',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
  };
  const result = normalizeTasks([legacy], now);
  assert.equal(result.changed, true);
  assert.equal(result.tasks[0].status, 'unfinished');
  assert.match(result.tasks[0].sessions[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(result.tasks[0].sessions[0].title, '新会话');
  assert.equal(result.tasks[0].archivedAt, undefined);
  assert.equal(result.tasks[0].purgeAt, undefined);
});

test('normalizeTasks does not change valid current tasks', () => {
  const task = { id: 'current', status: 'unfinished', sessions: [], archivedFromStatus: null };
  const result = normalizeTasks([task], new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(result.changed, false);
  assert.strictEqual(result.tasks[0], task);
});

test('normalizeTasks migrates legacy unfinished statuses', () => {
  const tasks = [{ id: 'todo', status: 'todo', sessions: [] }, { id: 'running', status: 'running', sessions: [] }];
  const result = normalizeTasks(tasks);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tasks.map((task) => task.status), ['unfinished', 'unfinished']);
});
