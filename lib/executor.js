import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { SCRIPTS_DIR } from './store.js';

let PI_BIN = null;
export function resolvePiBin() {
  if (!PI_BIN) {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      PI_BIN = execFileSync(finder, ['pi'], { encoding: 'utf8' })
        .split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    } catch {
      PI_BIN = process.platform === 'win32' ? 'pi.cmd' : 'pi';
    }
  }
  return PI_BIN;
}

/** shell 单引号转义 */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Windows cmd 参数转义 */
const winq = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
/** AppleScript 字符串转义 */
const appleQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * 生成一次执行用的脚本（兼容 macOS/Linux shell 和 Windows cmd）。
 */
export function buildRunScript({ workingDir, sessionFile, title, provider, model, thinkingLevel, readOnly, approve, prompt, taskId, port, token }) {
  const args = ['--session', sessionFile, '--name', title || 'task'];
  if (provider && model) args.push('--provider', provider, '--model', model);
  if (thinkingLevel) args.push('--thinking', thinkingLevel);
  if (readOnly) args.push('--tools', 'read,grep,find,ls');
  if (approve !== false) args.push('--approve');
  args.push(prompt);

  const piBin = resolvePiBin();
  const isWindows = process.platform === 'win32';
  const commandArgs = isWindows ? args.map(winq).join(' ') : args.map(shq).join(' ');
  const lines = isWindows ? [
    '@echo off',
    `cd /d ${winq(workingDir)} || (echo [workbench] cd 失败 ^& exit /b 1)`,
    `${path.isAbsolute(piBin) ? winq(piBin) : piBin} ${commandArgs}`,
    'set "ec=%ERRORLEVEL%"',
    'echo.',
    'echo [workbench] pi 已退出，exit code: %ec%',
    `curl.exe -s -o NUL --max-time 5 -X POST "http://127.0.0.1:${port}/api/internal/turn-ended" -H "Authorization: Bearer ${token}" -d "{\\"taskId\\":\\"${taskId}\\",\\"exitCode\\":%ec%}"`,
    'pause',
    'exit /b %ec%',
  ] : [
    '#!/bin/sh',
    `export PATH="${path.dirname(piBin)}:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `cd ${shq(workingDir)} || { printf '[workbench] cd 失败\\n'; exit 1; }`,
    `${piBin} ${commandArgs}`,
    'ec=$?',
    'printf "\\n[workbench] pi 已退出，exit code: %s\\n" "$ec"',
    `curl -s -o /dev/null -m 5 -X POST 'http://127.0.0.1:${port}/api/internal/turn-ended' -H 'Authorization: Bearer ${token}' -d '{"taskId":"${taskId}","exitCode":'$ec'}' || true`,
    'printf "按回车关闭此窗口... "; read -r _',
  ];
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  const extension = isWindows ? '.cmd' : '.sh';
  const file = path.join(SCRIPTS_DIR, `${taskId.slice(0, 8)}-${Date.now()}${extension}`);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o755 });
  return file;
}

/** 在当前系统打开外部终端执行脚本。 */
export function openTerminalWindow(scriptPath, terminalApp = 'Terminal') {
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const p = spawn('cmd.exe', ['/c', 'start', '', scriptPath], { stdio: 'ignore', detached: true });
      p.on('error', reject);
      p.on('close', () => resolve());
      p.unref();
    });
  }
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

/** 查找操作指定 session 文件的 pi 进程。 */
export function findPiPids(sessionFile) {
  if (!sessionFile) return [];
  try {
    if (process.platform === 'win32') {
      const env = { ...process.env, PI_SESSION_FILE: sessionFile };
      const script = "$needle=$env:PI_SESSION_FILE; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { $_.ProcessId }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', env });
      return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const out = execFileSync('pgrep', ['-f', sessionFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 终止任务的 pi 进程（SIGTERM → 等待 → SIGKILL）。 */
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
