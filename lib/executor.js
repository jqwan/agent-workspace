import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { SCRIPTS_DIR } from './store.js';

let PI_BIN = null;
export function resolvePiBin() {
  if (!PI_BIN) {
    try {
      PI_BIN = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    } catch {
      PI_BIN = 'pi';
    }
  }
  return PI_BIN;
}

/** shell 单引号转义 */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** AppleScript 字符串转义 */
const appleQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
/** pgrep -f 使用 ERE，转义特殊字符 */
const escRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 生成一次执行用的 shell 脚本（供 Terminal 窗口运行）。
 * 流程：cd 到工作目录 → 运行 pi（交互模式，初始消息自动发送）→ 回调工作台 → 保持窗口。
 */
export function buildRunScript({ workingDir, sessionFile, title, provider, model, thinkingLevel, readOnly, approve, prompt, taskId, port, token }) {
  const args = ['--session', shq(sessionFile), '--name', shq(title || 'task')];
  if (provider && model) args.push('--provider', shq(provider), '--model', shq(model));
  if (thinkingLevel) args.push('--thinking', shq(thinkingLevel));
  if (readOnly) args.push('--tools', 'read,grep,find,ls');
  if (approve !== false) args.push('--approve');
  args.push(shq(prompt));

  const piBin = resolvePiBin();
  const piCmd = path.isAbsolute(piBin) ? piBin : 'pi';
  const lines = [
    '#!/bin/sh',
    `export PATH="${path.dirname(piBin)}:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `cd ${shq(workingDir)} || { printf '[workbench] cd 失败\\n'; exit 1; }`,
    `${piCmd} ${args.join(' ')}`,
    'ec=$?',
    'printf "\\n[workbench] pi 已退出，exit code: %s\\n" "$ec"',
    `curl -s -o /dev/null -m 5 -X POST 'http://127.0.0.1:${port}/api/internal/turn-ended' -H 'Authorization: Bearer ${token}' -d '{"taskId":"${taskId}","exitCode":'$ec'}' || true`,
    'printf "按回车关闭此窗口... "; read -r _',
  ];
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  const file = path.join(SCRIPTS_DIR, `${taskId.slice(0, 8)}-${Date.now()}.sh`);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o755 });
  return file;
}

/** 通过 AppleScript 在 Terminal / iTerm2 中打开脚本 */
export function openTerminalWindow(scriptPath, terminalApp = 'Terminal') {
  let script;
  if (terminalApp === 'iTerm2') {
    script = [
      'tell application "iTerm"',
      '  activate',
      '  if (count of windows) = 0 then create window with default profile',
      '  tell current window to create tab with default profile',
      `  tell current session of current window to write text ${appleQuote(scriptPath)}`,
      'end tell',
    ].join('\n');
  } else {
    script = [
      'tell application "Terminal"',
      '  activate',
      `  do script ${appleQuote(scriptPath)}`,
      'end tell',
    ].join('\n');
  }
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `osascript 退出码 ${code}`))));
  });
}

/** 查找操作指定 session 文件的 pi 进程 */
export function findPiPids(sessionFile) {
  if (!sessionFile) return [];
  try {
    const out = execFileSync('pgrep', ['-f', escRegex(sessionFile)], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 终止任务的 pi 进程（SIGTERM → 等待 → SIGKILL），返回杀掉的进程数 */
export function killPi(sessionFile, { timeoutMs = 2500 } = {}) {
  const pids = findPiPids(sessionFile);
  if (!pids.length) return 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPiPids(sessionFile).length === 0) break;
    sleepSync(200);
  }
  for (const pid of findPiPids(sessionFile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ }
  }
  return pids.length;
}
