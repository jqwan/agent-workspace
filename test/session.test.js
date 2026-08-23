import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateRunningTask, parseSessionFile } from '../lib/session.js';

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

test('running-task evaluation follows the active child session', () => {
  const now = Date.now();
  const old = sessionFile([{ type: 'session', id: 'old' }]);
  const active = sessionFile([
    { type: 'session', id: 'active' },
    { type: 'message', message: { role: 'assistant', timestamp: new Date(now).toISOString(), stopReason: 'stop' } },
  ]);
  try {
    const task = { sessionFile: old.file, lastRun: { status: 'running', at: new Date(now - 1000).toISOString(), sessionFile: active.file } };
    const result = evaluateRunningTask(task, { now, findPiPids: () => [] });
    assert.equal(result.lastRun.status, 'done');
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(active.dir, { recursive: true, force: true });
  }
});
