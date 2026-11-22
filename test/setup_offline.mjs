// node test/setup_offline.mjs: WoW folder detection and the DSHChat installer (dsh-web/lib/setup.mjs) on a fake WoW tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addOnsOf, findAddOns, syncAddon, addonState, addonFiles, ADDON_SRC } from '../dsh-web/lib/setup.mjs';
import * as MB from '../dsh-web/lib/fontmail.mjs';
import { saveLocalConfig } from '../dsh-web/lib/setup.mjs';
import { apply } from '../dsh-web/index.js';
import { newer, gitSpec, checkUpdate, packageInfo } from '../dsh-web/lib/update.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshsetup-'));
const root = path.join(tmp, 'World of Warcraft');
const game = path.join(root, '_forever_');
fs.mkdirSync(path.join(game, 'Interface'), { recursive: true });
fs.writeFileSync(path.join(game, 'Wow.exe'), '');
fs.mkdirSync(path.join(root, '_retail_', 'Interface'), { recursive: true });
fs.writeFileSync(path.join(root, '_retail_', 'Wow.exe'), '');
const addons = path.join(game, 'Interface', 'AddOns');
const addonDir = path.join(addons, 'DSHChat');

check(addOnsOf(root) === addons, 'WoW root -> _forever_/Interface/AddOns');
check(addOnsOf(game) === addons, '_forever_ folder -> its AddOns');
check(addOnsOf(addons) === addons, 'an AddOns folder is taken as it is');
check(addOnsOf(path.join(root, '_retail_')) === null, 'another flavor is not taken');
check(addOnsOf(tmp) === null, 'a folder without the game is not taken');
check(findAddOns({ wowDir: root })?.addons === addons && findAddOns({ wowDir: root }).via === 'config', 'findAddOns uses wowDir');
check(findAddOns({ wowDir: tmp }) === null, 'a wrong wowDir is reported, not guessed around');

let r = syncAddon(addonDir, { gameRunning: true });
check(r.copied.length === 0 && r.made === 0 && r.waiting && !fs.existsSync(addonDir), 'game running, nothing installed: no new files, waits for the game to close');
r = syncAddon(addonDir);
check(r.copied.length === addonFiles().length && r.made === MB.POOL && !r.waiting, `game closed: ${r.copied.length} files and ${r.made} placeholders`);
check(addonState(addonDir).complete && fs.existsSync(MB.procPath(addonDir)), 'installed addon is complete, proc.ttf made');
check(!fs.existsSync(path.join(addonDir, 'mail', '..', 'Core.lua.tmp')), 'no temp files left');
r = syncAddon(addonDir);
check(r.copied.length === 0 && r.made === 0, 'second run changes nothing');

fs.writeFileSync(path.join(addonDir, 'Core.lua'), '-- old');
fs.unlinkSync(path.join(addonDir, 'QuickMenu.lua'));
fs.writeFileSync(MB.slotPath(addonDir, 5), 'packet');
r = syncAddon(addonDir, { gameRunning: true });
check(r.copied.join() === 'Core.lua' && r.waiting && !fs.existsSync(path.join(addonDir, 'QuickMenu.lua')), 'game running: a changed file is updated, a new file waits');
check(fs.readFileSync(path.join(addonDir, 'Core.lua')).equals(fs.readFileSync(path.join(ADDON_SRC, 'Core.lua'))), 'Core.lua now matches the package');
r = syncAddon(addonDir);
check(r.copied.join() === 'QuickMenu.lua' && !r.waiting, 'after the game closed the new file is installed');
check(fs.readFileSync(MB.slotPath(addonDir, 5), 'utf8') === 'packet', 'slots holding packets are not touched by the installer');

// config.json merge keeps the other keys
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ workspaceTitle: '魔兽世界' }));
saveLocalConfig(dataDir, { wowDir: root });
const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
check(saved.workspaceTitle === '魔兽世界' && saved.wowDir === root, 'saveLocalConfig merges into config.json');

// the plugin without a game folder (and no dialog): starts, logs what to do, does not throw
const fatal = [];
process.on('unhandledRejection', (e) => fatal.push(String(e)));
process.on('uncaughtException', (e) => fatal.push(String(e)));
const effects = [];
const ctx = { effect: (fn) => effects.push(fn()), on: () => () => {}, get: () => undefined, logger: () => { throw new Error('no logger'); } };
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ wowDir: tmp }));
let threw = null;
try { apply(ctx, { dataDir, pickFolder: false, gameWatch: false, pipeName: 'DSHBridgeTestSetup' }); } catch (e) { threw = e; }
await new Promise((r) => setTimeout(r, 500));
const logText = fs.readFileSync(path.join(dataDir, 'web-bridge.log'), 'utf8');
check(!threw && logText.includes('里没找到 _forever_\\Wow.exe') && logText.includes('插件」页'), 'no game folder: the plugin keeps running and points to the settings page');

// updates from GitHub: version compare, the pinned spec DSH can update to, the check against a fake GitHub
check(newer('0.6.0', '0.5.0') && newer('0.5.1', '0.5.0') && !newer('0.5.0', '0.5.0') && !newer('0.4.9', '0.5.0')
  && newer('0.5.0', '0.5.0-rc.1') && !newer('0.5.0-rc.1', '0.5.0') && !newer('x', '0.5.0'), 'newer() compares x.y.z');
const repo = { owner: 'someone', name: 'dsh-wow-bridge', dir: 'dsh-web', branch: 'main' };
const sha = 'a'.repeat(40);
check(gitSpec(repo, sha) === `git+https://github.com/someone/dsh-wow-bridge.git#${sha}&path:/dsh-web`, 'pinned spec with path:');
const seen = [];
const fakeFetch = async (url) => {
  seen.push(String(url));
  if (String(url).startsWith('https://api.github.com/repos/someone/dsh-wow-bridge/commits/main')) return new Response(JSON.stringify({ sha }));
  if (String(url) === `https://raw.githubusercontent.com/someone/dsh-wow-bridge/${sha}/dsh-web/package.json`) return new Response(JSON.stringify({ version: '0.6.0' }));
  return new Response('no', { status: 404 });
};
const up = await checkUpdate({ info: { name: '@local/dsh-wow-bridge', version: '0.5.0', repo }, fetchImpl: fakeFetch });
check(up.newer === true && up.latest === '0.6.0' && up.sha === sha && up.spec.endsWith('&path:/dsh-web') && seen.length === 2, `checkUpdate finds 0.6.0: ${JSON.stringify(up)}`);
const down = await checkUpdate({ info: { name: 'x', version: '0.5.0', repo: { ...repo, owner: 'nobody' } }, fetchImpl: fakeFetch });
check(typeof down.error === 'string' && down.error.includes('404'), `a failed check reports an error: ${down.error}`);
const pi = packageInfo();
check(pi.name === '@local/dsh-wow-bridge' && pi.repo?.dir === 'dsh-web' && pi.repo?.name === 'dsh-wow-bridge', 'package.json names the GitHub repo and directory');
for (const dispose of effects) await dispose?.();
await new Promise((r) => setTimeout(r, 200));
check(fatal.length === 0, `no uncaught errors${fatal.length ? `: ${fatal.join('; ')}` : ''}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'ALL OK');
process.exit(failures ? 1 : 0);
