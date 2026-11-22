// @local/dsh-wow-bridge: the WoW Forever "DSH Chat" bridge as a Host plugin inside `dsh web` (profile "web").
//   game [DSH] channel -> silent voice -> \\.\pipe\DSHBridge (or %APPDATA%\DSHBridge\tts-inbox\*.txt)
//   -> ONE persistent DSH session per character (agent preset "wowf", read-only, approval "never")
//   -> the answer is written into Interface\AddOns\DSHChat\mail\NNNNN.ttf exactly as ../bridge/bridge.mjs does.
//
// dsh web exits on ANY uncaught exception or unhandled rejection (dsh-app-boot installFailLoud). So:
//   * every event-listener, timer, socket and fs.watch callback body runs inside try/catch;
//   * every promise that is not awaited gets .catch(...);
//   * apply() never awaits DSH work (the preset registry may wait for the whole Loader tree): sessions are made lazily;
//   * after disposal (HMR or uninstall) nothing is written to the mailbox.
// No `export default`: the plugin loader takes exports.default first.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Intake } from './lib/intake.mjs';
import { GameWatch, wowPid } from './lib/game.mjs';
import { prompt as buildPrompt, translatePrompt, factionOf } from './lib/answer.mjs';
import * as MB from './lib/fontmail.mjs';
import { readAdvances } from './lib/ttf.mjs';
import { findAddOns, addOnsOf, syncAddon, addonState, addonVersion, pickFolder, saveLocalConfig, FLAVOR } from './lib/setup.mjs';
import { readSettings, serverInfo, SERVERS, FACTIONS } from './lib/settings.mjs';
import { voiceStatus, runVoiceScript } from './lib/voice.mjs';
import { packageInfo, checkUpdate } from './lib/update.mjs';

export const name = 'wow-dsh-bridge';
export const inject = ['sessionController', 'agents'];   // optional, via ctx.get(): approval, permissionPresets,
                                                          // workspaceRegistry, sessionTitle

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULTS = {
  addons: null,               // the Interface\AddOns folder; null = found from wowDir, Battle.net or common folders
  wowDir: null,               // the WoW folder (…\World of Warcraft or …\_forever_); used when addons is not set
  flavor: FLAVOR,
  installAddon: true,         // install / update DSHChat from this package (new files only while the game is closed)
  updateCheck: true,          // look for a newer version on GitHub (package.json repository) every 6 hours
  dataDir: path.join(APPDATA, 'DSHBridge'),   // web-sessions.json, web-bridge.log, tts-inbox/, workspace/, config.json
  pipeName: 'DSHBridge',
  preset: 'wowf',
  answerTimeoutMs: 110000,
  staleS: 140,                // the addon gives up after 150 s (a late answer still prints)
  gameWatch: true,            // false = act as if the game were running (tests)
  workspaceTitle: '魔兽世界无限服', // '' = plain cwd
  workspacePath: null,        // the workspace folder (and the game sessions' cwd); null = <dataDir>/workspace
  titlePrefix: '魔兽',
  model: null,                // optional { provider, model, reasoningEffort }: selected on new AND resumed sessions
                              // (select() is a no-op when unchanged); the wowf preset cannot set an effort itself
  maxTurns: 12,               // roll a character's session over after this many answered turns...
  rolloverTokens: 45000,      // ...or once the last prompt reached this size: history is never trimmed otherwise
                              // (compaction only triggers at ~680k), and every question re-reads all of it
};
const RESET_WORDS = /^\s*(新对话|重新开始|#reset)\s*$/i;
const PIPE_MAX = 800000;

// ---------------- transport: reuse ./lib, but never exit and never leak ----------------
class HostIntake extends Intake {
  // Intake.startPipe calls process.exit(2) on EADDRINUSE, which would kill dsh web: never call super.startPipe().
  // On any pipe error, retry every 5 s (covers an HMR overlap or a standalone bridge.mjs still running).
  startPipe(pipePath) {
    this.closed = false;
    const listen = () => {
      if (this.closed) return;
      const server = net.createServer((sock) => {
        const chunks = [];
        let size = 0;
        sock.on('data', (d) => {
          try { size += d.length; if (size > PIPE_MAX) { sock.destroy(); return; } chunks.push(d); } catch { /* ignore */ }
        });
        sock.on('end', () => {
          try { this.accept(Buffer.concat(chunks).toString('utf8'), 'pipe'); } catch (e) { this.log(`pipe message error: ${e?.message}`); }
        });
        sock.on('error', () => {});
      });
      server.on('error', (e) => {
        try {
          this.log(`管道错误 ${e?.code || e?.message}${e?.code === 'EADDRINUSE' ? '：被占用（独立桥接 bridge.mjs 还开着？）' : ''}，5 秒后重试`);
          if (this.server === server) this.server = undefined;
          try { server.close(); } catch { /* not listening */ }
          if (!this.closed) this.retry = setTimeout(() => { try { listen(); } catch (err) { this.log(`pipe retry: ${err?.message}`); } }, 5000);
        } catch { /* never throw from an emitter callback */ }
      });
      this.server = server;
      try { server.listen(pipePath, () => { try { this.log(`listening on ${pipePath}`); } catch { /* ignore */ } }); }
      catch (e) { server.emit('error', e); }
    };
    listen();
  }

  startInbox() { try { super.startInbox(); } catch (e) { this.log(`收件夹启动失败：${e?.message}`); } }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    try { this.server?.close(); } catch { /* ignore */ }
    try { this.watcher?.close(); } catch { /* ignore */ }
  }
}

// GameWatch.stop() does not stop a tick already running (it re-arms the timer after it): a stopped flag fixes that.
class HostGameWatch extends GameWatch {
  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (e) { try { this.log(`game watch error: ${e?.message}`); } catch { /* ignore */ } }
      if (!this.stopped) this.timer = setTimeout(() => { loop().catch(() => {}); }, this.everyMs);
    };
    return loop().catch(() => {});
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

function readProc(addonDir) {
  try {
    const adv = readAdvances(fs.readFileSync(MB.procPath(addonDir)));
    const bytes = Buffer.from(adv.slice(2).map((a) => a / 16 - 16));
    if (bytes.toString('latin1', 0, 2) !== 'WF') return null;
    return bytes.toString('utf8', 4, 4 + bytes.readUInt16BE(2));
  } catch { return null; }
}

// %APPDATA%/DSHBridge/web-sessions.json = { version: 1, chars: { "<name>-<realm>": { sessionId, pending?, at } } }
function makeStore(file, log) {
  let data = { version: 1, chars: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.chars === 'object' && j.chars) data = j; } catch { /* fresh */ }
  const save = () => {
    try { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); }
    catch (e) { log(`会话表保存失败：${e?.message}`); }
  };
  return {
    get: (k) => data.chars[k],
    set: (k, v) => { data.chars[k] = v; save(); },
    drop: (k) => { delete data.chars[k]; save(); },
    // every character's session is rolled over before its next question (the server or faction changed: the first
    // message of a session carries the server line)
    rollAll: () => { for (const e of Object.values(data.chars)) if (e && typeof e === 'object' && !e.pending) e.turns = 1e9; save(); },
  };
}

const charKeyOf = (req) => {
  const c = req && typeof req.ctx === 'object' && req.ctx ? req.ctx : {};
  const n = String(c.name ?? '').trim();
  const r = String(c.realm ?? '').trim();
  return n ? (r ? `${n}-${r}` : n) : 'default';
};
async function jsonBody(req) {
  let text = '';
  try { text = await req.text(); } catch { /* empty */ }
  if (!text) return {};
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* below */ }
  throw Object.assign(new Error('请求内容不是 JSON 对象'), { status: 400 });
}
const textOf = (message) => (message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');

// ---------------- plugin ----------------
// <dataDir>/config.json: this computer's settings (WoW folder, workspace), merged over the bundle/profile config so a
// profile override does not have to repeat the whole row. dataDir itself cannot be set there.
function localConfig(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const { dataDir: _ignored, ...rest } = j;
    return rest;
  } catch { return {}; }
}

export function apply(ctx, config) {
  const given = config && typeof config === 'object' ? config : {};
  const dataDir = given.dataDir || DEFAULTS.dataDir;
  const local = localConfig(dataDir);
  const cfg = { ...DEFAULTS, ...given, ...local, dataDir };
  const workCwd = cfg.workspacePath ? path.resolve(cfg.workspacePath) : path.join(cfg.dataDir, 'workspace');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const logFile = path.join(cfg.dataDir, 'web-bridge.log');
  const logger = (() => { try { return ctx.logger(name); } catch { return undefined; } })();
  const log = (msg) => {
    try {
      const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`;
      console.log(`[wow-dsh-bridge] ${line}`);
      try { logger?.info('%s', msg); } catch { /* ignore */ }
      fs.appendFile(logFile, line + '\n', () => {});
    } catch { /* logging must never throw */ }
  };

  // ----- the game folder: set on the settings page (config.json wowDir / addons), else found automatically -----
  const configFile = path.join(cfg.dataDir, 'config.json');
  const life = new AbortController();
  let disposed = false;
  const store = makeStore(path.join(cfg.dataDir, 'web-sessions.json'), log);
  let gameUp = !cfg.gameWatch;
  let nextWrite = 1;
  let found = null;             // { addons, via: 'config' | 'battle.net' | 'common' }
  let ADDON_DIR = null;
  let notFound = '';
  let mailboxReady = false;
  let installWaiting = false;   // new addon files or placeholders wait for the game to close
  const locate = () => {
    const local = localConfig(cfg.dataDir);           // re-read: the settings page writes it
    const addons = local.addons ?? cfg.addons;
    const wowDir = local.wowDir ?? cfg.wowDir;
    found = addons ? { addons: path.resolve(addons), via: 'config' } : findAddOns({ wowDir, flavor: cfg.flavor });
    if (found && wowDir && !addons) found.via = 'config';
    ADDON_DIR = found ? path.join(found.addons, 'DSHChat') : null;
    notFound = wowDir ? `游戏目录「${wowDir}」里没找到 ${cfg.flavor}\\Wow.exe` : `没找到《魔兽世界：无限》（${cfg.flavor}）`;
    mailboxReady = !!ADDON_DIR && MB.countPlaceholders(ADDON_DIR) >= MB.POOL;
  };
  locate();
  const addonInstalled = () => !!ADDON_DIR && fs.existsSync(path.join(ADDON_DIR, 'DSHChat.toc'));

  // Installs / updates DSHChat (never throws). gameRunning: only changed existing files are written.
  const install = (gameRunning) => {
    if (!ADDON_DIR || disposed) return null;
    let r = null;
    try {
      r = syncAddon(ADDON_DIR, { gameRunning });
      if (r.copied.length || r.made) {
        log(`DSHChat ${addonVersion()}：${r.copied.length ? `更新了 ${r.copied.join('、')}` : ''}${r.copied.length && r.made ? '，' : ''}${r.made ? `新建 ${r.made} 个回信槽位` : ''}`
          + (gameRunning ? '（游戏开着：/reload 生效）' : '（下次开游戏生效）'));
      }
      if (r.waiting && !installWaiting) log('游戏开着，新文件装不进去：退出游戏后自动装好，下次开游戏就能用');
      installWaiting = r.waiting;
    } catch (e) { log(`安装 DSHChat 失败：${e?.message}`); r = { error: String(e?.message ?? e) }; }
    mailboxReady = MB.countPlaceholders(ADDON_DIR) >= MB.POOL;
    return r;
  };
  const queue = [];
  let busy = false;
  let wsId;

  const sleep = (ms) => new Promise((resolve) => {
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { life.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    life.signal.addEventListener('abort', onAbort, { once: true });
  });
  const safeOn = (offs, event, fn) => {
    try { offs.push(ctx.on(event, (...args) => { try { fn(...args); } catch (e) { log(`${event} listener: ${e?.message}`); } })); }
    catch (e) { log(`ctx.on(${event}) failed: ${e?.message}`); }
  };

  // ----- game process: like bridge.mjs onStart/onExit, re-checking `disposed` after every await -----
  const onStart = async (pid, firstLook) => {
    if (disposed) return;
    gameUp = true;
    if (!mailboxReady) return log(`发现游戏进程 ${pid}，但 DSHChat 还没装好：退出游戏后自动安装`);
    const stamp = `P${pid}`;
    if (firstLook && readProc(ADDON_DIR) === stamp) {
      nextWrite = MB.lastWritten(ADDON_DIR) + 1;
      return log(`游戏进程 ${pid} 还是上次那个：从槽位 ${nextWrite} 接着写`);
    }
    const n = await MB.resetSlots(ADDON_DIR);
    if (disposed) return;
    await MB.writeProc(ADDON_DIR, stamp);
    if (disposed) return;
    nextWrite = 1;
    log(`发现游戏进程 ${pid}：清空了 ${n} 个用过的槽位，写入进程戳`);
  };
  const onExit = async (pid) => {
    if (disposed) return;
    gameUp = false;
    if (installWaiting || !mailboxReady) install(false);
    if (!mailboxReady) return;
    const n = await MB.resetSlots(ADDON_DIR);
    if (disposed) return;
    await MB.writeProc(ADDON_DIR, '?');
    if (disposed) return;
    nextWrite = 1;
    log(`游戏进程 ${pid} 已退出：清空了 ${n} 个用过的槽位`);
  };

  // ----- session per character -----
  const isArchived = (id) => { try { return !!ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(id); } catch { return false; } };

  async function workspaceId() {
    if (!cfg.workspaceTitle) return undefined;
    if (wsId) return wsId;
    try {
      fs.mkdirSync(workCwd, { recursive: true });
      const ws = await ctx.get('workspaceRegistry')?.create(workCwd, cfg.workspaceTitle);
      wsId = ws?.id;
      if (wsId) log(`工作区「${ws.title ?? cfg.workspaceTitle}」：${workCwd}`);
    } catch (e) { log(`工作区注册失败，改用 cwd：${e?.message}`); }
    return wsId;
  }

  // 'wowf' registers asynchronously: right after dsh web starts it may not exist yet.
  const presetMissing = (e) => e?.code === 'agent-preset/not-found'
    || (e?.code === 'gateway/internal' && /preset/i.test(String(e?.message ?? '')));
  async function withPresetRetry(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!presetMissing(e) || i >= 5 || disposed) throw e;
        await sleep(2000);
      }
    }
  }

  // Read-only sandbox + approval 'never' (rejects every ask before dispatch). The browser can change both, so this is
  // checked again before every question.
  function harden(agent, fresh) {
    const session = agent.session;
    const approval = ctx.get('approval');
    const presets = ctx.get('permissionPresets');
    try {
      const mode = presets?.current(session);
      if (fresh || approval?.overrideOf(session) !== 'never' || mode === 'danger-full-access' || mode === 'auto') {
        try { presets?.set(session, 'read-only'); } catch (e) { log(`read-only 设置失败：${e?.message}`); }
        session.append('approval/policy', { policy: 'never' });
      }
      if (approval && approval.overrideOf(session) !== 'never') log(`警告：会话 ${agent.id} 审批策略不是 never`);
    } catch (e) { log(`审批策略设置失败：${e?.message}`); }
    return agent;
  }

  // provider / model / reasoning effort from the config, also on resumed sessions (a session records its own choice,
  // which wins over the profile default; 'high' thinking was ~80% of the output tokens). agent.model.select only
  // appends an event when the selection changes.
  function selectModel(agent) {
    if (!(cfg.model?.provider && cfg.model?.model)) return;
    try { agent.model.select(cfg.model); } catch (e) { log(`选模型失败：${e?.message}`); }
  }

  // Resume with resolveAgent (it auto-resumes a cold session). Never pass an old id to create(): create() mints a
  // NEW session for an id that already has turns.
  async function ensureAgent(key) {
    const sc = ctx.sessionController;
    const known = store.get(key)?.sessionId;
    if (known && !isArchived(known)) {
      const r = await withPresetRetry(async () => {
        const res = await sc.resolveAgent(known);
        if ('error' in res && presetMissing(res.error)) throw res.error;
        return res;
      });
      if (!('error' in r)) {
        // a 'pending' entry whose session exists (create() threw after creating it, or dsh web stopped in between):
        // nothing was asked there yet, so it starts counting from 0 and its first message gets the rules
        const e = store.get(key);
        if (e?.pending && e.sessionId === known) {
          store.set(key, { sessionId: known, at: new Date().toISOString(), turns: 0, ...(e.carry ? { carry: e.carry } : {}) });
        }
        selectModel(r.agent);
        return harden(r.agent, false);
      }
      if (r.error?.code !== 'session/not-found') throw r.error;
      log(`会话 ${known} 已不存在：新建`);
    }
    const ws = await workspaceId();
    const reserved = `session-${randomUUID()}`;
    const carry = store.get(key)?.carry;   // the rolled-over session's last exchange, kept until a first answer lands
    const keep = carry ? { carry } : {};
    store.set(key, { sessionId: reserved, pending: true, at: new Date().toISOString(), ...keep });
    if (!ws) fs.mkdirSync(workCwd, { recursive: true });
    const created = await withPresetRetry(() => sc.create({
      sessionId: reserved, ...(ws ? { workspaceId: ws } : { cwd: workCwd }), agentPreset: cfg.preset,
    }));
    // turns: 0 marks a session this plugin opened, whose first message must carry the format rules
    store.set(key, { sessionId: created.sessionId, at: new Date().toISOString(), turns: 0, ...keep });
    const r = await sc.resolveAgent(created.sessionId);
    if ('error' in r) throw r.error;
    try { ctx.get('sessionTitle')?.rename(r.agent.session, `${cfg.titlePrefix} · ${key}`); } catch (e) { log(`改标题失败：${e?.message}`); }
    selectModel(r.agent);
    log(`新对话 ${created.sessionId}（${key}，预设 ${created.agentPreset ?? cfg.preset}）`);
    return harden(r.agent, true);
  }

  // On timeout: remove our message if still queued, otherwise cancel only our own open turn (keepInbox: messages typed
  // in the browser stay).
  function cancelOurs(agent, requestId, myTurn) {
    try {
      const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find((m) => m?.source?.rpcId === requestId);
      if (queued) { agent.inbox.remove(queued.id); return 'removed'; }
      if (myTurn !== undefined) {
        const b = ctx.agents.turnBoundaryOf(agent.session);
        if (b.openTurnStartSeq !== null && b.lastTurn === myTurn) {
          agent.cancel({ kind: 'hook', reason: 'wow-dsh-bridge: answer timeout' }, { keepInbox: true });
          return 'cancelled';
        }
      }
    } catch (e) { log(`取消失败：${e?.message}`); }
    return 'none';
  }

  // One question as a normal 'user' message (source {kind:'user', rpcId}), matched to its own turn.
  async function askSession(agent, text, budgetMs) {
    const requestId = `wow-${randomUUID()}`;
    const sessionId = agent.id;
    let myTurn, answer = '', settled = false, settle;
    // token usage of this turn: summed over its model calls; prompt = the last call's full prompt size
    const usage = { steps: 0, uncached: 0, cached: 0, output: 0, prompt: 0 };
    const done = new Promise((resolve) => { settle = (v) => { if (!settled) { settled = true; resolve(v); } }; });
    const offs = [];
    safeOn(offs, 'agent/inbox/claimed', ({ agent: a, message, turn }) => {
      if (a === agent && message?.source?.rpcId === requestId) myTurn = turn;
    });
    safeOn(offs, 'session/event', (session, ev) => {
      if (myTurn === undefined || session?.id !== sessionId) return;
      if (ev?.type === 'assistant/message' && ev.data?.turn === myTurn) {
        const t = textOf(ev.data.message); if (t) answer = t;
        const u = ev.data.usage;
        if (u && typeof u === 'object') {
          const n = (x) => (Number.isFinite(x) ? x : 0);
          usage.steps++;
          usage.uncached += n(u.inputTokens);
          usage.cached += n(u.cacheReadTokens);
          usage.output += n(u.outputTokens);
          usage.prompt = n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
        }
      } else if (ev?.type === 'turn/end' && ev.data?.turn === myTurn) settle(ev.data.reason ?? { kind: 'completed' });
    });
    safeOn(offs, 'agent/disposed', ({ agent: a }) => { if (a === agent) settle({ kind: 'agent-disposed' }); });
    const onLife = () => settle({ kind: 'plugin-disposed' });
    life.signal.addEventListener('abort', onLife, { once: true });
    const timer = setTimeout(() => settle({ kind: 'timeout' }), Math.max(1000, budgetMs));
    try {
      try {
        await ctx.sessionController.prompt(
          { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          AbortSignal.any([life.signal, AbortSignal.timeout(30000)]),
        );
      } catch (e) { return { answer: '', reason: { kind: 'prompt-rejected', error: e?.code || e?.message } }; }
      const reason = await done;
      if (reason.kind === 'timeout') log(`超时处理：${cancelOurs(agent, requestId, myTurn)}`);
      return { answer, reason, turn: myTurn, usage };
    } finally {
      clearTimeout(timer);
      life.signal.removeEventListener('abort', onLife);
      for (const off of offs) { try { off(); } catch { /* fiber gone */ } }
    }
  }

  // Roll a long session over before the next question: a new session starts small again (its first message carries
  // the format rules and the last exchange of the old one). Entries from before this rule (no turn count) are rolled
  // over once too: they were the 89-117k-token sessions. The old session stays in dsh web's list.
  function rollOverIfLong(key) {
    const e = store.get(key);
    if (!e?.sessionId || e.pending) return undefined;
    const turns = Number.isFinite(e.turns) ? e.turns : Infinity;
    const big = Number.isFinite(e.lastPrompt) && e.lastPrompt >= cfg.rolloverTokens;
    if (turns < cfg.maxTurns && !big) return;
    // the last exchange waits in the store (no sessionId, so ensureAgent creates a session) until the new session's
    // first answer lands: a failed first try must not lose it
    if (e.lastQA) store.set(key, { carry: e.lastQA, at: new Date().toISOString() });
    else store.drop(key);
    log(`会话 ${e.sessionId}（${key}）${Number.isFinite(e.turns) ? `${e.turns} 轮` : '旧会话'}${big ? `，上次 ${e.lastPrompt} token` : ''}：下个问题开新对话`);
  }

  // the answer as remembered for a carry-over: 300 chars, but a trailing {{buy:…}} line survives whole (the next
  // question may be "加进购物清单"), and no half token is left at the cut
  function qaAnswer(text) {
    const a = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (a.length <= 300) return a;
    const buys = a.match(/\{\{buy:[^{}]*\}\}/g);
    const buy = buys ? buys[buys.length - 1] : '';
    const room = buy && buy.length <= 200 ? 300 - buy.length - 2 : 300;
    const head = (buy ? a.replace(buy, ' ') : a).slice(0, room).replace(/\{\{[^}]*$/, '').trim();
    return buy && buy.length <= 200 ? `${head}… ${buy}` : `${head}…`;
  }

  async function answerInSession(key, req, budgetMs, retried = false) {
    const t0 = Date.now();
    rollOverIfLong(key);
    let agent;
    try { agent = await ensureAgent(key); } catch (e) {
      if (disposed) return null;
      log(`会话准备失败：${e?.code ?? ''} ${e?.message}`);
      return e?.code === 'session/writer-held'
        ? 'DSH 对话被别的程序占着（另一个 dsh 进程？），请关掉它再问。'
        : `DSH 出错了（${e?.code || e?.message}），看 dsh web 窗口或 web-bridge.log。`;
    }
    // the format rules only in a session's first message (turns 0 = a session this plugin opened, nothing answered yet)
    const entry = store.get(key);
    const first = entry?.sessionId === agent.id && entry.turns === 0;
    const left = budgetMs - (Date.now() - t0);
    const server = serverInfo(readSettings(cfg.dataDir), factionOf(req.ctx ?? {}));
    const text = req.type === 'translate' ? translatePrompt(req)
      : buildPrompt(req, { rules: first, carry: first ? entry.carry : undefined, server });
    const r = await askSession(agent, text, left);
    const u = r.usage ?? {};
    log(`会话 ${agent.id} 第 ${r.turn ?? '?'} 轮：${r.reason.kind}，${((Date.now() - t0) / 1000).toFixed(1)} 秒`
      + (u.steps ? `；${u.steps} 次调用，提示 ${u.prompt} token（未缓存 ${u.uncached}，缓存 ${u.cached}），输出 ${u.output}` : ''));
    if (r.reason.kind === 'completed' || r.reason.kind === 'max-tokens') {
      const now = store.get(key);
      if (now?.sessionId === agent.id && !now.pending) {   // not reset meanwhile
        const { carry: _sent, ...rest } = now;              // the carry-over is in this session's history now
        store.set(key, {
          ...rest,
          turns: (Number.isFinite(now.turns) ? now.turns : 0) + 1,
          ...(u.prompt ? { lastPrompt: u.prompt } : {}),
          lastQA: { q: String(req.q ?? '').slice(0, 200), a: qaAnswer(r.answer) },
          at: new Date().toISOString(),
        });
      }
    }
    switch (r.reason.kind) {
      case 'completed': return r.answer.trim() || '（DSH 没给出文字回答）';
      case 'max-tokens': return `${r.answer.trim()}\n（回答太长，被截断了）`;
      case 'blocked':
        if (isArchived(agent.id)) {          // archived in the web UI: forget it and retry once in a fresh session
          store.drop(key);
          if (!retried && budgetMs - (Date.now() - t0) > 30000) return answerInSession(key, req, budgetMs - (Date.now() - t0), true);
          return '这个对话在 dsh web 里被归档了：已为你开新对话，请再问一次。';
        }
        return 'DSH 拒绝了这一轮（可能在计划模式或目标模式里），去 dsh web 里看看这个对话。';
      case 'timeout': return `DSH 超时了（${Math.round(left / 1000)} 秒没答完），这一轮已取消。请再问一次或把问题说短一点。`;
      case 'aborted': return 'DSH 这一轮被取消了（可能在网页里点了停止），请再问一次。';
      case 'error': return `DSH 出错了：${String(r.reason.error?.message ?? '').slice(0, 200)}`;
      case 'agent-disposed': return 'DSH 会话被关掉了（在网页里删除了？），下个问题会自动开新对话。';
      case 'plugin-disposed': return null;
      case 'prompt-rejected': return `DSH 没收下这个问题（${r.reason.error}）。`;
      default: return r.answer.trim() || `DSH 没答完（${r.reason.kind}）。`;
    }
  }

  // ----- one request -----
  async function handle(req, via) {
    const id = String(req.id);
    const asked = +id.slice(0, 10);
    const age = asked ? Date.now() / 1000 - asked : 0;
    if (!gameUp) return log(`丢弃 ${id}：游戏没在运行`);
    if (!ADDON_DIR) return log(`丢弃 ${id}：还不知道游戏目录（${notFound}）`);
    if (!mailboxReady) return log(`丢弃 ${id}：回信槽位还没装好（退出游戏后自动安装）`);
    if (asked && age > cfg.staleS) return log(`丢弃 ${id}：已经过时（${Math.round(age)} 秒前的问题）`);
    // the faction on the settings page wins over the character's (auto = the character's)
    const chosen = readSettings(cfg.dataDir).faction;
    if (chosen !== 'auto') req.ctx = { ...(req.ctx && typeof req.ctx === 'object' ? req.ctx : {}), faction: chosen };
    const q = String(req.q ?? '');
    const type = req.type === 'ping' ? 'ping' : req.type === 'translate' ? 'translate'
      : (req.type === 'reset' || RESET_WORDS.test(q)) ? 'reset' : 'ask';
    // translations get their own session per character: they must not fill the question session's context
    const key = type === 'translate' ? `${charKeyOf(req)}·翻译` : charKeyOf(req);
    log(`收到 ${id}（${via}，${key}，${type}）${type === 'ask' || type === 'translate' ? `：${q.slice(0, 60)}${q.length > 60 ? '…' : ''}` : ''}`);
    let text;
    if (type === 'ping') {
      text = `链路正常：语音上行、字体回传都通了。桥接模式：dsh web 插件（预设 ${cfg.preset}，${store.get(key)?.sessionId ? '续接已有对话' : '下个问题开新对话'}）。`;
    } else if (type === 'reset') {
      store.drop(key);
      text = '好的，已开新对话：之后的问题不再带之前的上下文（旧对话还在 dsh web 的会话列表里）。';
    } else {
      // what is left before the addon gives up (at least 20 s), never more than the configured timeout
      const budget = Math.min(cfg.answerTimeoutMs, Math.max(20000, (cfg.staleS + 5 - age) * 1000));
      text = await answerInSession(key, req, budget);
    }
    if (text == null || disposed) return log(`${id}：插件已停止，不写回信`);
    if (!gameUp) return log(`${id}：游戏已退出，不写回信`);
    const parts = MB.splitText(id, text);
    const slot = Math.max(nextWrite, Number.isInteger(req.slot) ? req.slot : 1, 1);
    if (slot + parts.length - 1 > MB.POOL) return log(`回信槽位用完了（需要 ${slot}..${slot + parts.length - 1}）：请完整重启游戏`);
    for (let i = 0; i < parts.length; i++) {
      if (disposed) return log(`${id}：写到一半插件停止了`);
      await MB.writeSlot(ADDON_DIR, slot + i, i + 1, parts.length, id, parts[i]);
    }
    nextWrite = slot + parts.length;
    log(`已回信 ${id}：槽位 ${slot}${parts.length > 1 ? `..${slot + parts.length - 1}` : ''}，${Buffer.byteLength(text)} 字节`);
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !disposed) {
        const { req, via } = queue.shift();
        try { await handle(req, via); } catch (e) { log(`处理 ${req?.id} 出错：${e?.stack || e?.message}`); }
      }
    } finally { busy = false; }
  }

  // ----- settings page (client.js): server, faction, game folder, addon, voice, updates; served as exact routes -----
  const info = packageInfo();
  const update = { checking: false, applying: false, result: null, message: '' };
  let voiceBusy = false;
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const installedVersion = () => {
    try { return /^## Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(ADDON_DIR, 'DSHChat.toc'), 'utf8'))?.[1] ?? null; } catch { return null; }
  };

  async function statusOf() {
    locate();
    const local = localConfig(cfg.dataDir);
    let detected = null;
    try { detected = findAddOns({ flavor: cfg.flavor })?.addons ?? null; } catch { /* none */ }
    let running = gameUp;
    try { if (cfg.gameWatch) running = !!(await wowPid()); } catch { /* keep */ }
    const st = ADDON_DIR ? addonState(ADDON_DIR) : null;
    return {
      plugin: { name: info.name, version: info.version, repo: info.repo ? `${info.repo.owner}/${info.repo.name}` : null },
      settings: { ...readSettings(cfg.dataDir), wowDir: local.wowDir ?? null, autoUpdate: local.autoUpdate !== false },
      servers: Object.entries(SERVERS).map(([key, v]) => ({ key, label: v.label })),
      game: { addons: found?.addons ?? null, via: found?.via ?? null, detected, running, notFound: found ? null : notFound },
      addon: {
        shipped: addonVersion(), installed: ADDON_DIR ? installedVersion() : null, complete: st?.complete ?? false,
        missing: st?.missing ?? [], changed: st?.changed ?? [], slots: st?.slots ?? 0, waiting: installWaiting,
      },
      voice: { ...(await voiceStatus()), busy: voiceBusy },
      update: { ...(update.result ?? {}), checking: update.checking, applying: update.applying, message: update.message },
    };
  }

  function applySettings(b) {
    const patch = {};
    if (b.server !== undefined) {
      if (!Object.hasOwn(SERVERS, String(b.server))) throw bad(`不认识的服务器「${b.server}」`);
      patch.server = String(b.server);
    }
    if (b.faction !== undefined) {
      if (!FACTIONS.includes(b.faction)) throw bad('阵营只能是 auto、Horde 或 Alliance');
      patch.faction = b.faction;
    }
    if (b.autoUpdate !== undefined) patch.autoUpdate = !!b.autoUpdate;
    if (b.wowDir !== undefined) {
      const dir = String(b.wowDir ?? '').trim();
      if (dir && !addOnsOf(dir, cfg.flavor)) throw bad(`「${dir}」里没有《魔兽世界：无限》（${cfg.flavor}\\Wow.exe）`);
      patch.wowDir = dir || undefined;   // '' = find it automatically
      patch.addons = undefined;          // a chosen folder replaces an AddOns path set by hand
    }
    const before = readSettings(cfg.dataDir);
    saveLocalConfig(cfg.dataDir, patch);
    const after = readSettings(cfg.dataDir);
    locate();
    if (b.wowDir !== undefined) log(`游戏目录：${ADDON_DIR ?? notFound}`);
    if (before.server !== after.server || before.faction !== after.faction) {
      const s = serverInfo(after);
      log(`服务器 ${s.label}，阵营 ${after.faction === 'auto' ? '按角色' : after.faction}：价格来自 ${s.prices === 'wuxianwow' ? '无限图鉴' : 'wowauctions'}；各角色下个问题开新对话`);
      store.rollAll();
      try { ctx.emit('wow-dsh-bridge/settings', after); } catch (e) { log(`通知工具策略失败：${e?.message}`); }
    }
  }

  async function checkNow() {
    if (update.checking) return;
    update.checking = true;
    try {
      update.result = await checkUpdate({ info, signal: AbortSignal.any([life.signal, AbortSignal.timeout(20000)]) });
      if (update.result.error) log(`检查更新失败：${update.result.error}`);
      else if (update.result.newer) log(`GitHub 上有新版本 ${update.result.latest}（现在 ${info.version}）`);
    } finally { update.checking = false; }
  }

  // DSH's own plugin manager does the update (with HMR: removes this version, installs the new one, restores the old
  // one when that fails). Only a copy installed from a Git spec pinning a commit can be updated this way.
  async function startUpdate(why) {
    if (update.applying) return { error: '正在升级' };
    if (!update.result?.newer) await checkNow();
    const r = update.result;
    if (!r || r.error) return { error: r?.error ?? '检查更新失败' };
    if (!r.newer) return { error: `已经是最新版本（${info.version}）` };
    const pm = ctx.get('pluginManager');
    if (!pm?.updateBundle || !pm?.listBundles) return { error: '这个 DSH 没有插件管理服务：请在「插件」页重新安装下面的地址', spec: r.spec };
    let mine;
    try { mine = (await pm.listBundles()).find((x) => x?.name === info.name); } catch (e) { return { error: `读不到插件列表：${e?.message}` }; }
    if (mine?.update !== 'git') {
      return { error: '这个插件不是从 GitHub 的固定版本装的（比如开发用的本地链接），不能在这里升级：请在「插件」页用下面的地址重新安装', spec: r.spec };
    }
    if (busy || queue.length) return { error: '正在回答游戏里的问题，等回答完再升级' };
    update.applying = true;
    update.message = `正在升级到 ${r.latest}…`;
    log(`${why === 'auto' ? '自动' : ''}升级到 ${r.latest}（提交 ${r.sha.slice(0, 7)}）`);
    pm.updateBundle(info.name, r.latest, { spec: r.spec }).then((res) => {
      const how = res?.result?.application ?? 'unknown';
      log(`升级结果：${res?.from ?? '?'} → ${res?.to ?? '?'}，${how}${res?.restore ? '（失败，已装回原版本）' : ''}`);
      update.message = res?.restore || how === 'failed' ? '升级失败，已保留原版本（看 web-bridge.log）' : `已升级到 ${r.latest}`;
    }).catch((e) => {
      log(`升级失败：${e?.message}`);
      update.message = `升级失败：${e?.message}`;
    }).finally(() => { update.applying = false; });
    return { started: true, to: r.latest };
  }

  // a check one minute after start, then every 6 hours; with autoUpdate (default on) a newer version is installed
  function startUpdateChecks() {
    const timers = [];
    if (!info.repo || !cfg.updateCheck) return timers;
    let told = false;
    const tick = async () => {
      if (disposed) return;
      await checkNow();
      if (!disposed && update.result?.newer && localConfig(cfg.dataDir).autoUpdate !== false) {
        const r = await startUpdate('auto');
        if (r?.error && !told) { told = true; log(`没有自动升级：${r.error}`); }
      }
      if (!disposed) timers.push(setTimeout(() => { tick().catch((e) => log(`检查更新：${e?.message}`)); }, 6 * 3600 * 1000));
    };
    timers.push(setTimeout(() => { tick().catch((e) => log(`检查更新：${e?.message}`)); }, 60 * 1000));
    return timers;
  }

  const ROUTES = {
    status: ['GET', () => statusOf()],
    settings: ['POST', async (req) => { applySettings(await jsonBody(req)); return statusOf(); }],
    'pick-folder': ['POST', async () => {
      if (process.platform !== 'win32') throw bad('只有 Windows 能弹出选择窗口：请直接填路径');
      const picked = await pickFolder({ title: 'DSH 频道：选择《魔兽世界：无限》的游戏文件夹（World of Warcraft 或里面的 _forever_）', signal: life.signal });
      if (picked) applySettings({ wowDir: picked });
      return { ...(await statusOf()), picked: picked ?? null };
    }],
    'install-addon': ['POST', async () => {
      locate();
      if (!ADDON_DIR) throw bad(`${notFound}：先选择游戏目录`);
      const running = cfg.gameWatch ? !!(await wowPid()) : false;
      const result = install(running);
      if (result?.error) throw Object.assign(new Error(`安装失败：${result.error}`), { status: 500 });
      return { ...(await statusOf()), result, gameRunning: running };
    }],
    'install-voice': ['POST', async () => {
      if (process.platform !== 'win32') throw bad('静音语音只能装在 Windows 上');
      if (voiceBusy) throw bad('正在安装静音语音');
      voiceBusy = true;
      try {
        const result = await runVoiceScript();
        log(`静音语音安装${result.ok ? '完成' : '失败'}：${result.output.split(/\r?\n/).filter(Boolean).pop() ?? ''}`);
        return { ...(await statusOf()), result };
      } finally { voiceBusy = false; }
    }],
    'update-check': ['POST', async () => { await checkNow(); return statusOf(); }],
    update: ['POST', async () => ({ ...(await startUpdate('manual')), status: await statusOf() })],
  };
  const reply = (v, status = 200) => new Response(JSON.stringify(v), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  // The routes need DSH's connection service (owner-only exact routes below /api); without it the plugin still runs.
  const serveRoutes = (c) => {
    for (const [n, [method, run]] of Object.entries(ROUTES)) {
      c.effect(() => c.connection.fetch.register({
        path: `/api/wow-dsh-bridge/${n}`, methods: [method], requestBody: 'buffered',
        fetch: async (req) => {
          try { return reply(await run(req)); } catch (e) { return reply({ error: String(e?.message ?? e) }, e?.status ?? 500); }
        },
      }), `wow-dsh-bridge: /api/wow-dsh-bridge/${n}`);
    }
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['connection'], (c) => { try { serveRoutes(c); } catch (e) { log(`设置页接口：${e?.message}`); } });
    else log('这个 DSH 不支持 ctx.inject：设置页不可用');
  } catch (e) { log(`设置页接口：${e?.message}`); }

  // ----- resources: one effect; dispose = stop + abort, no mailbox writes afterwards -----
  ctx.effect(() => {
    const intake = new HostIntake({
      inboxDir: path.join(cfg.dataDir, 'tts-inbox'),
      log,
      onRequest: (req, via) => {
        try {
          if (disposed) return;
          queue.push({ req, via });
          pump().catch((e) => log(`pump: ${e?.message}`));
        } catch (e) { log(`onRequest: ${e?.message}`); }
      },
    });
    const watch = new HostGameWatch({ log, onStart, onExit });
    log(`启动：dsh web 插件，预设 ${cfg.preset}，`
      + (found ? `插件目录 ${ADDON_DIR}（${found.via === 'config' ? '配置' : found.via === 'battle.net' ? 'Battle.net 安装记录' : '常见安装位置'}）` : notFound));
    // keep an installed addon in step with this package (after a plugin update too; the game check decides what may
    // be written), then follow the game. The first install is the player's click on the settings page.
    (async () => {
      if (!ADDON_DIR) return log(`${notFound}：在 DSH「插件」页打开本插件的设置，选择游戏目录`);
      const running = cfg.gameWatch ? !!(await wowPid()) : false;
      if (disposed) return;
      if (addonInstalled() && cfg.installAddon) install(running);
      else if (!addonInstalled()) log('DSHChat 游戏插件还没装：在 DSH「插件」页打开本插件的设置，点“安装游戏插件”');
      if (cfg.gameWatch) watch.start();
      else if (mailboxReady) await MB.writeProc(ADDON_DIR, 'TEST');
    })().catch((e) => log(`启动：${e?.message}`));
    const updateTimers = startUpdateChecks();
    intake.startPipe('\\\\.\\pipe\\' + cfg.pipeName);
    intake.startInbox();
    // register the workspace now (detached: apply() must not wait on DSH services), so it shows up in dsh web
    // before the first in-game question
    const early = setTimeout(() => { if (!disposed) workspaceId().catch((e) => log(`工作区：${e?.message}`)); }, 3000);
    return async () => {
      disposed = true;
      clearTimeout(early);
      for (const t of updateTimers) clearTimeout(t);
      life.abort();
      watch.stop();
      intake.close();
      log('停止（插件被卸载或热重载）');
    };
  }, 'wow-dsh-bridge: pipe + tts-inbox + game watch');
}
