// Restarting `dsh web` from inside it, so an update takes effect without the player leaving the page.
// A small detached Node helper waits until the old process has released its port, then starts the same command
// line again (detached, output to log files in the temp folder); the old process exits right after the helper is up.
// Not in DSH Desktop (Electron): the desktop app manages its own host. No DSH imports.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const isDesktopHost = () => Boolean(process.versions.electron);

// the port in a dsh command line (--port N, -p N, --port=N), else 3080
export function portOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const v = a === '--port' || a === '-p' ? args[i + 1] : a.startsWith('--port=') ? a.slice(7) : undefined;
    const n = Number(v);
    if (v !== undefined && Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 3080;
}

// the command line that started this process: node [node flags] <dsh bin.js> web [flags]
export const currentLaunch = () => ({
  file: process.execPath,
  args: [...process.execArgv, process.argv[1], ...process.argv.slice(2)],
  cwd: process.cwd(),
});

// The helper's source: poll the port (every 250 ms, up to 30 s) until nothing answers, then start the launch.
export function helperSource(launch, port, outLog, errLog) {
  return `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const launch = ${JSON.stringify(launch)};
const port = ${port};
let left = 120;
function start() {
  try {
    const out = fs.openSync(${JSON.stringify(outLog)}, 'a');
    const err = fs.openSync(${JSON.stringify(errLog)}, 'a');
    spawn(launch.file, launch.args, { cwd: launch.cwd, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: process.env }).unref();
  } catch (e) {
    try { fs.appendFileSync(${JSON.stringify(errLog)}, 'restart failed: ' + (e && e.message) + '\\n'); } catch {}
  }
}
function probe() {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); if (--left > 0) setTimeout(probe, 250); else start(); });
  s.once('error', () => setTimeout(start, 300));
}
probe();
`;
}

// Starts the helper and ends this process half a second later. Returns { ok, pid?, outLog, errLog, error? }.
export function restartDshWeb({ spawnImpl = spawn, exit = () => process.kill(process.pid, 'SIGTERM'), delayMs = 500 } = {}) {
  if (isDesktopHost() && spawnImpl === spawn) return { ok: false, error: 'DSH 桌面版自己管理重启：请在桌面版里重启' };
  const launch = currentLaunch();
  const port = portOf(launch.args);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outLog = path.join(os.tmpdir(), `dsh-wow-bridge-restart-${stamp}.out.log`);
  const errLog = path.join(os.tmpdir(), `dsh-wow-bridge-restart-${stamp}.err.log`);
  try {
    const helper = spawnImpl(process.execPath, ['-e', helperSource(launch, port, outLog, errLog)], {
      detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
    });
    helper.on?.('error', () => {});
    helper.unref?.();
    if (!helper.pid) return { ok: false, outLog, errLog, error: '重启助手没有启动' };
    setTimeout(() => { try { exit(); } catch { /* already going */ } }, delayMs);
    return { ok: true, pid: helper.pid, port, outLog, errLog };
  } catch (e) {
    return { ok: false, outLog, errLog, error: String(e?.message ?? e) };
  }
}
