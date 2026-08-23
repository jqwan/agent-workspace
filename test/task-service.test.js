import test from 'node:test';
import assert from 'node:assert/strict';
import { finishPatch, runPatch, sessionFileForRun, shouldStartRun } from '../lib/task-service.js';

const session = { id: 'child-1', sessionFile: '/tmp/child-1.jsonl' };

test('run patches keep the active child session identity', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.deepEqual(runPatch(session, now), {
    status: 'running', reason: null, at: now.toISOString(), sessionId: 'child-1', sessionFile: session.sessionFile,
  });
  assert.equal(finishPatch(session, 0, now).status, 'done');
  assert.equal(finishPatch(session, 1, now).status, 'terminated');
});

test('run start detection avoids resetting an existing attachment', () => {
  assert.equal(shouldStartRun({ status: 'todo' }, session), true);
  assert.equal(shouldStartRun({ status: 'running', lastRun: { status: 'running', sessionFile: session.sessionFile } }, session), false);
  assert.equal(shouldStartRun({ status: 'running', lastRun: { status: 'running', sessionFile: '/tmp/other.jsonl' } }, session), true);
  assert.equal(sessionFileForRun({ lastRun: { sessionFile: '/tmp/run.jsonl' } }, session), '/tmp/run.jsonl');
});
