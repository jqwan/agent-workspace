import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTasks, normalizeNotes } from '../lib/store.js';

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

test('normalizeNotes keeps optional titles and removes notes without descriptions', () => {
  const result = normalizeNotes([
    {
      id: 'note', title: '', description: '  记录内容  ', color: 'yellow',
      pinnedToTopBar: true, pinnedToSessionBar: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    { id: 'empty', title: '只有标题', description: '' },
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].title, '');
  assert.equal(result.notes[0].description, '记录内容');
  assert.equal(result.notes[0].pinnedToTopBar, true);
});

test('normalizeNotes removes legacy automatic purge deadlines', () => {
  const archivedAt = '2026-01-01T00:00:00.000Z';
  const result = normalizeNotes([{ id: 'archived-note', description: '已废弃', status: 'archived', archivedAt, purgeAt: '2026-01-16T00:00:00.000Z' }]);
  assert.equal(result.notes[0].archivedAt, archivedAt);
  assert.equal(Object.hasOwn(result.notes[0], 'purgeAt'), false);
});
