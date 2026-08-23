/**
 * Task/run domain rules shared by HTTP routes and the runtime monitor.
 * Persistence remains in store.js; this module only creates state patches.
 */

export function runPatch(session, now = new Date()) {
  return {
    status: 'running',
    reason: null,
    at: now.toISOString(),
    sessionId: session?.id || null,
    sessionFile: session?.sessionFile || null,
  };
}

export function finishPatch(session, exitCode, now = new Date()) {
  return {
    status: exitCode === 0 ? 'done' : 'terminated',
    reason: exitCode === 0 ? null : `原生 TUI 已退出（exit code ${exitCode}）`,
    at: now.toISOString(),
    sessionId: session?.id || null,
    sessionFile: session?.sessionFile || null,
  };
}

export function shouldStartRun(task, session) {
  return Boolean(task && session && (
    task.status !== 'running'
    || task.lastRun?.status !== 'running'
    || task.lastRun?.sessionFile !== session.sessionFile
  ));
}

export function sessionFileForRun(task, session = null) {
  return task?.lastRun?.sessionFile || session?.sessionFile || task?.sessionFile || null;
}
