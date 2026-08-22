import pty from 'node-pty';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const terminals = new Map();
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function clearSessionName(sessionFile) {
  if (!existsSync(sessionFile)) return;
  const entries = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  let parentId = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    try {
      const entry = JSON.parse(entries[index]);
      if (entry.id) { parentId = entry.id; break; }
    } catch { /* ignore incomplete trailing data */ }
  }
  appendFileSync(sessionFile, `${JSON.stringify({ type: 'session_info', id: randomUUID(), parentId, timestamp: new Date().toISOString(), name: '' })}\n`);
}

function buildArgs({ sessionFile, provider, model, thinkingLevel, readOnly, approve, theme }) {
  const args = ['--session', sessionFile, '--tui-mode', 'regular', '--use-theme', normalizeTheme(theme)];
  if (provider && model) args.push('--provider', provider, '--model', model);
  if (thinkingLevel) args.push('--thinking', thinkingLevel);
  if (readOnly) args.push('--tools', 'read,grep,find,ls');
  args.push(approve === false ? '--no-approve' : '--approve');
  return args;
}

export function isWebTuiRunning(taskId) {
  return terminals.has(taskId);
}

export async function stopAllWebTuis() {
  await Promise.all([...terminals.keys()].map((taskId) => stopWebTuiAndWait(taskId, { silent: true })));
}

export function getWebTui(taskId) {
  return terminals.get(taskId) || null;
}

export function subscribeWebTui(taskId, listener) {
  const record = terminals.get(taskId);
  if (!record) return () => {};
  record.listeners.add(listener);
  if (record.replayReset) listener({ type: 'tui_reset' });
  if (record.output) listener({ type: 'tui_data', data: record.output });
  return () => record.listeners.delete(listener);
}

function broadcast(record, message) {
  for (const listener of record.listeners) {
    try { listener(message); } catch { /* browser disconnected */ }
  }
}

export async function startWebTui(options) {
  const theme = normalizeTheme(options.theme);
  const current = terminals.get(options.taskId);
  if (current && current.childSessionId === options.childSessionId && current.theme === theme) {
    resizeWebTui(options.taskId, options.cols, options.rows);
    return current;
  }
  if (current) await stopWebTuiAndWait(options.taskId, { silent: true });
  clearSessionName(options.sessionFile);

  // Launch the installed JS entry directly: npm's pi.cmd quoting is unsafe in
  // a Windows ConPTY child process.
  const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
  const child = pty.spawn(process.execPath, [cliEntry, ...buildArgs({ ...options, theme })], {
    name: 'xterm-256color', cols: options.cols || 120, rows: options.rows || 34,
    cwd: options.workingDir,
    // A visible cursor anchors the Windows browser IME candidate window.
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_HARDWARE_CURSOR: '1' },
  });

  let resolveExit;
  const record = {
    taskId: options.taskId, childSessionId: options.childSessionId, theme,
    process: child, listeners: new Set(), output: '', replayReset: false,
    inputOwner: null, onExit: options.onExit,
    exit: new Promise((resolve) => { resolveExit = resolve; }),
  };
  terminals.set(options.taskId, record);
  child.onData((data) => {
    // ANSI output is only replayable from the start of the terminal stream.
    // Never retain an arbitrary tail, which corrupts a reconnecting xterm.
    if (!record.replayReset) {
      if (record.output.length + data.length > MAX_REPLAY_BYTES) {
        record.output = '';
        record.replayReset = true;
      } else {
        record.output += data;
      }
    }
    broadcast(record, { type: 'tui_data', data });
  });
  child.onExit(({ exitCode, signal }) => {
    if (terminals.get(options.taskId) === record) terminals.delete(options.taskId);
    broadcast(record, { type: 'tui_exit', exitCode, signal });
    resolveExit({ exitCode, signal });
    if (!record.silentStop) record.onExit?.({ exitCode, signal });
  });
  return record;
}

export function claimWebTuiInput(taskId, ownerId) {
  const record = terminals.get(taskId);
  if (!record) return false;
  record.inputOwner = ownerId;
  return true;
}

export function releaseWebTuiInput(taskId, ownerId) {
  const record = terminals.get(taskId);
  if (record?.inputOwner === ownerId) record.inputOwner = null;
}

export function writeWebTui(taskId, ownerId, data) {
  const record = terminals.get(taskId);
  if (!record) throw new Error('原生 TUI 未运行，请重新打开');
  if (record.inputOwner !== ownerId) throw new Error('该原生 TUI 已在另一页面中操作');
  const text = String(data || '');
  if (text.length > 64 * 1024) throw new Error('终端输入过长');
  record.process.write(text);
}

export function resizeWebTui(taskId, cols, rows) {
  const record = terminals.get(taskId);
  if (!record) return false;
  const width = Math.max(20, Math.min(500, Number(cols) || 120));
  const height = Math.max(5, Math.min(200, Number(rows) || 34));
  record.process.resize(width, height);
  return true;
}

function stopProcess(record) {
  if (process.platform === 'win32') {
    // Avoid node-pty's ConPTY AttachConsole helper when this service has no
    // Windows console; the exposed PID is the pi CLI process.
    try { process.kill(record.process.pid); } catch { /* already exited */ }
  } else {
    try { record.process.kill(); } catch { /* already exited */ }
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function stopWebTuiAndWait(taskId, { silent = false } = {}) {
  const record = terminals.get(taskId);
  if (!record) return false;
  record.silentStop = silent;
  terminals.delete(taskId);
  stopProcess(record);
  await record.exit;
  return true;
}

// Theme changes only need the pi CLI to be gone before another CLI attaches to
// the same JSONL. Do not wait for ConPTY's delayed output-pipe cleanup.
export async function stopWebTuiForRestart(taskId) {
  const record = terminals.get(taskId);
  if (!record) return false;
  record.silentStop = true;
  terminals.delete(taskId);
  stopProcess(record);
  await waitForProcessExit(record.process.pid);
  return true;
}

export function stopWebTui(taskId, options) {
  if (!terminals.has(taskId)) return false;
  void stopWebTuiAndWait(taskId, options);
  return true;
}
