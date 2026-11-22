// The silent SAPI voice "DSHBridge" (game -> PC): status and install / uninstall through ../voice/install-voice.ps1
// (compiles the engine with Windows' own C# compiler, registers it for the current user and asks once for UAC to
// write the voice token under HKLM). No DSH imports; never throws out of a callback.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'install-voice.ps1');
const CLSID = '{D6C18D54-4DF5-4B50-B4BD-5BF06FEB1F5A}';
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const DLL = path.join(LOCAL, 'DSHBridge', 'voice', 'DSHBridgeTts.dll');

const regHas = (key) => new Promise((resolve) => {
  execFile('reg.exe', ['query', key, '/reg:64'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
});

// { installed, dll, userClass, machineToken }: installed only when all three are in place
export async function voiceStatus() {
  if (process.platform !== 'win32') return { installed: false, dll: false, userClass: false, machineToken: false };
  const [userClass, machineToken] = await Promise.all([
    regHas(`HKCU\\Software\\Classes\\CLSID\\${CLSID}`),
    regHas('HKLM\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\DSHBridge'),
  ]);
  const dll = fs.existsSync(DLL);
  return { installed: dll && userClass && machineToken, dll, userClass, machineToken };
}

// Runs the script (Windows PowerShell); resolves { ok, output }. The UAC prompt appears on this PC's desktop.
export function runVoiceScript({ uninstall = false, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // UTF-8 output (Windows PowerShell writes the console code page otherwise); the path is single-quoted
      const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${SCRIPT.replace(/'/g, "''")}'${uninstall ? ' -Uninstall' : ''}; exit $LASTEXITCODE`;
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, output: String(e?.message ?? e) }); }
    const add = (d) => { out = (out + d).slice(-4000); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } add('\n超时，已停止。'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `${out}\n${e?.message ?? e}`.trim() }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}
