// Finds the WoW Forever AddOns folder and installs / updates the DSHChat addon shipped in this package (../addon).
// Shared by the dsh web plugin (index.js) and the standalone bridge (../../bridge/bridge.mjs). No DSH imports.
//
// The game only finds files that exist when it starts: new addon files and the mailbox placeholders are written only
// while the game is closed. Changed existing files may be written any time (a /reload picks them up).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MB from './fontmail.mjs';
import { forgetConfigCache } from './settings.mjs';

export const FLAVOR = '_forever_';
export const ADDON_NAME = 'DSHChat';
export const ADDON_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'addon', ADDON_NAME);
const ADDON_FILE = /\.(lua|toc|xml)$/i;

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// A path the user gave or one we guessed -> the flavor's Interface\AddOns folder, or null.
// Accepts the AddOns folder, the flavor folder (…\_forever_) or the WoW root (…\World of Warcraft).
export function addOnsOf(p, flavor = FLAVOR) {
  if (!p) return null;
  const dir = path.resolve(String(p).trim().replace(/^"|"$/g, ''));
  if (path.basename(dir).toLowerCase() === 'addons' && path.basename(path.dirname(dir)).toLowerCase() === 'interface') {
    return isDir(path.dirname(dir)) ? dir : null;
  }
  for (const game of [dir, path.join(dir, flavor)]) {
    if (isFile(path.join(game, 'Wow.exe')) && path.basename(game).toLowerCase() === flavor.toLowerCase()) {
      return path.join(game, 'Interface', 'AddOns');
    }
  }
  return null;
}

// WoW install folders Battle.net knows about: its product.db (protobuf; the install path is a plain string in it) and
// the "World of Warcraft" uninstall entry. Both are read-only lookups.
function battleNetRoots() {
  const out = [];
  const programData = process.env.ProgramData || 'C:/ProgramData';
  try {
    const text = fs.readFileSync(path.join(programData, 'Battle.net', 'Agent', 'product.db')).toString('utf8');
    for (const m of text.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"]{0,200}?World of Warcraft/g)) out.push(m[0]);
  } catch { /* no Battle.net */ }
  for (const view of ['WOW6432Node\\', '']) {
    try {
      const r = execFileSync('reg.exe', ['query', `HKLM\\SOFTWARE\\${view}Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft`, '/v', 'InstallLocation'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(r);
      if (m) out.push(m[1].trim());
    } catch { /* key missing */ }
  }
  return out;
}

function commonRoots() {
  const out = [];
  for (let c = 67; c <= 90; c++) {           // C: .. Z:
    const drive = `${String.fromCharCode(c)}:/`;
    if (!isDir(drive)) continue;
    for (const sub of ['Program Files', 'Program Files (x86)', '', 'Games', 'Battle.net', 'Blizzard']) {
      out.push(path.join(drive, sub, 'World of Warcraft'));
    }
  }
  return out;
}

// { addons, via } or null. `wowDir` (any form addOnsOf accepts) wins; then Battle.net; then common folders.
export function findAddOns({ wowDir, flavor = FLAVOR } = {}) {
  if (wowDir) {
    const a = addOnsOf(wowDir, flavor);
    return a ? { addons: a, via: 'config' } : null;
  }
  const seen = new Set();
  for (const [via, roots] of [['battle.net', battleNetRoots()], ['common', commonRoots()]]) {
    for (const root of roots) {
      const key = path.resolve(root).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const a = addOnsOf(root, flavor);
      if (a) return { addons: a, via };
    }
  }
  return null;
}

export const addonFiles = (src = ADDON_SRC) => fs.readdirSync(src).filter((n) => ADDON_FILE.test(n)).sort();

// What differs between the shipped addon and the installed one.
export function addonState(addonDir, src = ADDON_SRC) {
  const missing = [];
  const changed = [];
  for (const name of addonFiles(src)) {
    const dst = path.join(addonDir, name);
    if (!isFile(dst)) missing.push(name);
    else if (!fs.readFileSync(dst).equals(fs.readFileSync(path.join(src, name)))) changed.push(name);
  }
  const slots = MB.countPlaceholders(addonDir);
  return { missing, changed, slots, complete: !missing.length && slots >= MB.POOL };
}

// Writes the addon. gameRunning: only changed existing files (new files and placeholders wait for the game to close).
// Returns { copied: [names], made, waiting: bool } where waiting = something still needs the game closed.
export function syncAddon(addonDir, { gameRunning = false, src = ADDON_SRC } = {}) {
  const st = addonState(addonDir, src);
  const copy = gameRunning ? st.changed : [...st.missing, ...st.changed];
  if (copy.length) fs.mkdirSync(addonDir, { recursive: true });
  for (const name of copy) {
    const dst = path.join(addonDir, name);
    const tmp = `${dst}.tmp`;
    fs.copyFileSync(path.join(src, name), tmp);
    fs.renameSync(tmp, dst);
  }
  const made = gameRunning ? 0 : MB.installPlaceholders(addonDir);
  const waiting = gameRunning && (st.missing.length > 0 || st.slots < MB.POOL);
  return { copied: copy, made, waiting };
}

// Windows folder dialog (Windows PowerShell + WinForms, on top of other windows). Resolves the chosen path, or null when
// cancelled or aborted; rejects only when the dialog cannot be shown.
export function pickFolder({ title = '', signal } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = $env:DSHB_PICK_TITLE',
    '$d.ShowNewFolderButton = $false',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
  ].join('\n');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(null);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: false, env: { ...process.env, DSHB_PICK_TITLE: title }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return resolve(null);
      if (code !== 0 && !out.trim()) return reject(new Error(err.trim() || `powershell exit ${code}`));
      resolve(out.trim() || null);
    });
  });
}

// Merges keys into <dataDir>/config.json (this computer's settings), keeping the others.
export function saveLocalConfig(dataDir, patch) {
  const file = path.join(dataDir, 'config.json');
  let cur = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { /* new */ }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...cur, ...patch }, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  forgetConfigCache();
}

// The addon version from its TOC (for logs).
export function addonVersion(src = ADDON_SRC) {
  try { return /^## Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(src, `${ADDON_NAME}.toc`), 'utf8'))?.[1] ?? '?'; } catch { return '?'; }
}
