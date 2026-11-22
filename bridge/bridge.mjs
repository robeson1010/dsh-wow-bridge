#!/usr/bin/env node
// DSH Bridge: in-game [DSH] chat channel <-> your DeepSeek Harness.
//
//   node bridge.mjs install            copy the DSHChat addon into WoW Forever and make the mailbox placeholders
//                                      (with the game closed: the client only sees files that exist when it starts)
//   node bridge.mjs run                answer with DSH (profile "wowf")
//   node bridge.mjs run --echo         answer with an echo (tests the link without DSH)
//
// Options: --addons <AddOns folder> | --wow <WoW folder> (default: found like the dsh web plugin does)
//          --profile <dsh profile>  --data <data folder>  --pipe <pipe name>
//          --no-game-watch (tests: act as if the game were running)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Intake } from '../dsh-web/lib/intake.mjs';
import { GameWatch, wowPid } from '../dsh-web/lib/game.mjs';
import { answer } from '../dsh-web/lib/answer.mjs';
import * as MB from '../dsh-web/lib/fontmail.mjs';
import { readAdvances } from '../dsh-web/lib/ttf.mjs';
import { findAddOns, syncAddon, addonVersion } from '../dsh-web/lib/setup.mjs';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args.shift() : 'run';
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const found = opt('addons') ? { addons: path.resolve(opt('addons')) } : findAddOns({ wowDir: opt('wow') });
if (!found) {
  console.error('没找到《魔兽世界：无限》（_forever_）：用 --wow "…\World of Warcraft" 指定游戏目录。');
  process.exit(1);
}
const ADDONS = found.addons;
const ADDON_DIR = path.join(ADDONS, 'DSHChat');
const DATA = opt('data', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSHBridge'));
const PROFILE = opt('profile', 'wowf');
const MODE = flag('echo') ? 'echo' : 'dsh';
const STALE_S = 140;  // the addon gives up after 150 s

fs.mkdirSync(DATA, { recursive: true });
const logFile = path.join(DATA, 'bridge.log');
function log(msg) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

function readProc() {
  try {
    const adv = readAdvances(fs.readFileSync(MB.procPath(ADDON_DIR)));
    const bytes = Buffer.from(adv.slice(2).map((a) => a / 16 - 16));
    if (bytes.toString('latin1', 0, 2) !== 'WF') return null;
    const n = bytes.readUInt16BE(2);
    return bytes.toString('utf8', 4, 4 + n);
  } catch { return null; }
}

async function install() {
  if (!flag('force') && await wowPid()) {
    console.error('魔兽正在运行：请先完全退出游戏再安装（游戏只在启动时发现新文件）。');
    process.exit(1);
  }
  const r = syncAddon(ADDON_DIR);
  console.log(`已安装 DSHChat ${addonVersion()} 到 ${ADDON_DIR}（更新 ${r.copied.length} 个文件，新建 ${r.made} 个回信槽位，共 ${MB.countPlaceholders(ADDON_DIR)} 个）。`);
  console.log('下一步：启动魔兽，然后运行  node bridge.mjs run');
}

async function run() {
  if (!fs.existsSync(MB.mailDir(ADDON_DIR)) || MB.countPlaceholders(ADDON_DIR) < MB.POOL) {
    console.error(`没找到回信槽位（${MB.mailDir(ADDON_DIR)}）：先关掉游戏运行  node bridge.mjs install`);
    process.exit(1);
  }
  log(`DSH Bridge 启动：${MODE === 'dsh' ? `DSH 模式（profile ${PROFILE}）` : '回声模式'}，插件目录 ${ADDON_DIR}`);

  let gameUp = false;
  let nextWrite = 1;

  const watch = new GameWatch({
    log,
    onStart: async (pid, firstLook) => {
      gameUp = true;
      const stamp = `P${pid}`;
      if (firstLook && readProc() === stamp) {
        nextWrite = MB.lastWritten(ADDON_DIR) + 1;
        log(`游戏进程 ${pid} 还是上次那个：从槽位 ${nextWrite} 接着写`);
        return;
      }
      const n = await MB.resetSlots(ADDON_DIR);
      await MB.writeProc(ADDON_DIR, stamp);
      nextWrite = 1;
      log(`发现游戏进程 ${pid}：清空了 ${n} 个用过的槽位，写入进程戳`);
    },
    onExit: async (pid) => {
      gameUp = false;
      const n = await MB.resetSlots(ADDON_DIR);
      await MB.writeProc(ADDON_DIR, '?');
      nextWrite = 1;
      log(`游戏进程 ${pid} 已退出：清空了 ${n} 个用过的槽位`);
    },
  });
  if (flag('no-game-watch')) {
    gameUp = true;
    await MB.writeProc(ADDON_DIR, 'TEST');
  } else {
    await watch.start();
  }

  const queue = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { req, via } = queue.shift();
      try { await handle(req, via); } catch (e) { log(`处理 ${req.id} 出错：${e.stack || e.message}`); }
    }
    busy = false;
  }

  async function handle(req, via) {
    const id = String(req.id);
    const asked = +id.slice(0, 10);
    if (!gameUp) return log(`丢弃 ${id}：游戏没在运行`);
    if (asked && Date.now() / 1000 - asked > STALE_S) return log(`丢弃 ${id}：已经过时（${Math.round(Date.now() / 1000 - asked)} 秒前的问题）`);
    const q = String(req.q ?? '');
    log(`收到 ${id}（${via}）${req.type === 'ping' ? '链路测试' : `：${q.slice(0, 60)}${q.length > 60 ? '…' : ''}`}`);
    const text = await answer(req, { mode: MODE, profile: PROFILE, dataDir: DATA, log });
    const parts = MB.splitText(id, text);
    const slot = Math.max(nextWrite, Number.isInteger(req.slot) ? req.slot : 1, 1);
    if (slot + parts.length - 1 > MB.POOL) return log(`回信槽位用完了（需要 ${slot}..${slot + parts.length - 1}）：请完整重启游戏`);
    for (let i = 0; i < parts.length; i++) await MB.writeSlot(ADDON_DIR, slot + i, i + 1, parts.length, id, parts[i]);
    nextWrite = slot + parts.length;
    log(`已回信 ${id}：槽位 ${slot}${parts.length > 1 ? `..${slot + parts.length - 1}` : ''}，${Buffer.byteLength(text)} 字节`);
  }

  const intake = new Intake({
    inboxDir: path.join(DATA, 'tts-inbox'),
    log,
    onRequest: (req, via) => { queue.push({ req, via }); pump(); },
  });
  intake.startPipe(opt('pipe') ? `\\\\.\\pipe\\${opt('pipe')}` : undefined);
  intake.startInbox();

  const stop = () => { log('DSH Bridge 退出'); intake.close(); watch.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (cmd === 'install') await install();
else if (cmd === 'run') await run();
else { console.error(`未知命令：${cmd}（install | run）`); process.exit(1); }
