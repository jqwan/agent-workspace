import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTasks } from '../lib/store.js';

test('normalizeTasks backfills legacy sessions and archives unknown statuses', () => {
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
  assert.equal(result.tasks[0].status, 'archived');
  assert.equal(result.tasks[0].sessions[0].id, 'main');
  assert.equal(result.tasks[0].archivedAt, now.toISOString());
  assert.equal(new Date(result.tasks[0].purgeAt).getTime(), now.getTime() + 15 * 24 * 60 * 60 * 1000);
});

test('normalizeTasks does not change valid current tasks', () => {
  const task = { id: 'current', status: 'todo', sessions: [], archivedFromStatus: null };
  const result = normalizeTasks([task], new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(result.changed, false);
  assert.strictEqual(result.tasks[0], task);
});
