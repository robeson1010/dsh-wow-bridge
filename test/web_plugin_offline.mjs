// Offline test of the dsh web plugin (dsh-web/index.js) against a fake DSH host: no dsh web, no model calls.
// Run: node test/web_plugin_offline.mjs
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../dsh-web/index.js';
import * as MB from '../dsh-web/lib/fontmail.mjs';
import { readAdvances } from '../dsh-web/lib/ttf.mjs';

const fatal = [];
process.on('unhandledRejection', (e) => fatal.push(`unhandledRejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => fatal.push(`uncaughtException: ${e?.stack || e}`));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-'));
const addons = path.join(tmp, 'AddOns');
const addonDir = path.join(addons, 'DSHChat');
const dataDir = path.join(tmp, 'data');
MB.installPlaceholders(addonDir);
const PIPE = 'DSHBridgeTestWeb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ---------------- fake host ----------------
const bus = new EventEmitter();
const calls = { create: 0, resolve: [], cancel: [], removed: [], appended: [], presetSet: [], select: [] };
let answerDelay = 50;
let createFail = null;   // 'attach': create the session, then throw like workspace.attachSession failing
const agents = new Map();

function makeAgent(id) {
  const session = { id, append: (type, data) => calls.appended.push([id, type, data?.policy]) };
  const agent = {
    id, session, turns: 0, history: [],
    inbox: { nextTurn: [], nextStep: [], remove: (mid) => { calls.removed.push(mid); agent.inbox.nextTurn = agent.inbox.nextTurn.filter((m) => m.id !== mid); } },
    cancel: (cause, opts) => { calls.cancel.push([cause?.kind, opts?.keepInbox]); agent.cancelled = true; },
    model: { select: (m) => calls.select.push([id, m?.reasoningEffort]) },
  };
  agents.set(id, agent);
  return agent;
}

const routes = {};
const ctx = {
  logger: () => ({ info: () => {} }),
  disposers: [],
  effect(fn) { this.disposers.push(fn()); },
  emit(event, ...args) { bus.emit(event, ...args); },
  // DSH's connection service: exact routes below /api (the settings page's backend)
  inject(names, cb) {
    cb({
      effect: (fn) => ctx.disposers.push(fn()),
      connection: { fetch: { register: (r) => { routes[r.path] = r; return async () => { delete routes[r.path]; }; } } },
    });
  },
  on(event, cb) {
    const h = (...args) => cb(...args);
    bus.on(event, h);
    return () => bus.off(event, h);
  },
  get(nameOf) {
    return {
      approval: { overrideOf: (s) => [...calls.appended].reverse().find((a) => a[0] === s.id && a[1] === 'approval/policy')?.[2] },
      permissionPresets: { set: (s, p) => calls.presetSet.push([s.id, p]), current: () => 'custom' },
      workspaceRegistry: { create: async () => ({ id: 'ws-1' }), archivedSessionIds: [] },
      sessionTitle: { rename: () => {} },
    }[nameOf];
  },
  sessionController: {
    async resolveAgent(id) {
      calls.resolve.push(id);
      const a = agents.get(id);
      return a ? { agent: a } : { error: { code: 'session/not-found' } };
    },
    async create({ sessionId, agentPreset }) {
      calls.create++;
      makeAgent(sessionId);
      if (createFail === 'attach') {
        createFail = null;
        throw Object.assign(new Error(`session ${sessionId} was created but could not attach`), { code: 'session/workspace-attach-failed' });
      }
      return { sessionId, agentPreset };
    },
    async prompt(req, signal) {
      signal.throwIfAborted();
      const agent = agents.get(req.sessionId);
      const message = { id: `m-${req.requestId}`, source: { kind: 'user', rpcId: req.requestId }, text: req.content[0].text };
      agent.inbox.nextTurn.push(message);
      setTimeout(() => {
        if (!agent.inbox.nextTurn.includes(message)) return;      // removed while queued
        agent.inbox.nextTurn = agent.inbox.nextTurn.filter((m) => m !== message);
        const turn = ++agent.turns;
        agent.history.push(message.text);
        bus.emit('agent/inbox/claimed', { agent, message, turn });
        const q = /(?:玩家的问题|原文)：\n([\s\S]*)$/.exec(message.text)?.[1] ?? '?';
        setTimeout(() => {
          if (agent.cancelled) { agent.cancelled = false; bus.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'aborted' } } }); return; }
          bus.emit('session/event', agent.session, { type: 'assistant/message', data: { turn, usage: { inputTokens: 300, cacheReadTokens: 1000 * turn, outputTokens: 50 }, message: { content: [{ type: 'text', tool: 1, text: '' }] } } });
          const text = q === '长' ? `${'很长的回答。'.repeat(70)} {{item:14047|符文布}}\n{{buy:厚符文布绷带×5|14047×10}}` : `答「${q}」：第${turn}轮，会话 ${agent.id.slice(0, 16)}`;
          bus.emit('session/event', agent.session, { type: 'assistant/message', data: { turn, usage: { inputTokens: 500, cacheReadTokens: 1000 * turn, outputTokens: 100 }, message: { content: [{ type: 'text', text }] } } });
          bus.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
        }, answerDelay);
      }, 10);
      return { accepted: true };
    },
  },
  agents: { turnBoundaryOf: (s) => ({ openTurnStartSeq: 1, lastTurn: agents.get(s.id)?.turns }) },
};

// ---------------- helpers ----------------
let seq = 0;
async function send(body, pipe = PIPE) {
  const id = `${Math.floor(Date.now() / 1000)}${String(++seq).padStart(3, '0')}`;
  const json = JSON.stringify({ v: 1, id, slot: 1, ctx: { name: 'Tester', realm: 'Forever', zone: 'Westfall' }, ...body });
  const frame = `DSHB:${id}:1/1:${Buffer.from(json).toString('base64')}`;
  await new Promise((resolve, reject) => {
    const c = net.connect(`\\\\.\\pipe\\${pipe}`, () => c.end(frame));
    c.on('close', resolve);
    c.on('error', reject);
  });
  return id;
}
function readSlot(k) {
  try {
    const adv = readAdvances(fs.readFileSync(MB.slotPath(addonDir, k)));
    const b = Buffer.from(adv.slice(2).map((a) => a / 16 - 16));
    const n = b.readUInt16BE(2);
    const p = b.subarray(4, 4 + n);
    const idLen = p[10];
    return { slot: p.readUInt32BE(4), id: p.toString('utf8', 11, 11 + idLen), text: p.toString('utf8', 11 + idLen) };
  } catch { return null; }
}
async function waitSlot(k, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = readSlot(k); if (s) return s; await sleep(50); }
  return null;
}
const sessions = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'web-sessions.json'), 'utf8')).chars; } catch { return {}; } };

// ---------------- run ----------------
// a mapping from before the turn counter (2026-11-20 sessions): must be rolled over, never resumed
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'web-sessions.json'), JSON.stringify({ version: 1, chars: { 'Tester-Forever': { sessionId: 'session-legacy', at: '2026-11-20T12:00:00Z' } } }));
makeAgent('session-legacy');
const MODEL = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' };
const RULES = '回答格式：';

// (f) a dummy holds the pipe first: the plugin must retry, not exit
const dummy = net.createServer(() => {}).listen(`\\\\.\\pipe\\${PIPE}`);
await sleep(100);
// (g) this computer's settings come from <dataDir>/config.json (here: the AddOns folder), merged over the row config
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ addons, dataDir: path.join(tmp, 'elsewhere') }));
apply(ctx, { dataDir, pipeName: PIPE, gameWatch: false, answerTimeoutMs: 3000, staleS: 140, model: MODEL, maxTurns: 3 });
await sleep(300);
const logText = () => { try { return fs.readFileSync(path.join(dataDir, 'web-bridge.log'), 'utf8'); } catch { return ''; } };
check(logText().includes(`插件目录 ${addonDir}`) && !fs.existsSync(path.join(tmp, 'elsewhere')), '(g) config.json sets the AddOns folder; dataDir there is ignored');
check(!fs.existsSync(path.join(addonDir, 'Core.lua')) && logText().includes('还没装'), '(g) nothing is installed before the player asks for it');
const api = async (name, body) => {
  const r = routes[`/api/wow-dsh-bridge/${name}`];
  const res = await r.fetch(new Request(`http://localhost/api/wow-dsh-bridge/${name}`, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
check(['status', 'settings', 'pick-folder', 'install-addon', 'install-voice', 'update-check', 'update'].every((n) => routes[`/api/wow-dsh-bridge/${n}`]), '(l) the settings page routes are served');
let st = await api('status');
check(st.status === 200 && st.body.game.addons === addons && st.body.addon.installed === null && st.body.settings.server === 'eu-pvp'
  && st.body.settings.faction === 'auto' && st.body.servers.length === 11, `(l) status: ${JSON.stringify(st.body.addon)}`);
const inst = await api('install-addon', {});
check(inst.status === 200 && ['DSHChat.toc', 'Core.lua', 'QuickMenu.lua', 'Bindings.xml'].every((n) => fs.existsSync(path.join(addonDir, n)))
  && inst.body.addon.installed && inst.body.addon.complete, '(l) 安装游戏插件 installs the DSHChat files from the package');
const badServer = await api('settings', { server: 'mars' });
const badDir = await api('settings', { wowDir: tmp });
check(badServer.status === 400 && badDir.status === 400 && badDir.body.error.includes('Wow.exe'), `(l) bad settings refused: ${badDir.body.error}`);
check(logText().includes(`EADDRINUSE`), '(f) pipe busy: the plugin logs EADDRINUSE and keeps running');
dummy.close();
await sleep(5600);
check(logText().includes('listening on'), '(f) after the pipe is free the plugin takes it over');

// (a) a question is answered into slot 1 and the character gets a session
const id1 = await send({ type: 'ask', q: '我在哪？' });
const s1 = await waitSlot(1);
check(s1?.id === id1 && s1.text.includes('答「我在哪？」：第1轮'), `(a) answer in slot 1: ${s1?.text}`);
const sid = sessions()['Tester-Forever']?.sessionId;
check(!!sid && !sessions()['Tester-Forever'].pending, `(a) state file maps Tester-Forever -> ${sid}`);
check(calls.appended.some((a) => a[0] === sid && a[1] === 'approval/policy' && a[2] === 'never') && calls.presetSet.some((p) => p[1] === 'read-only'),
  '(a) the new session gets read-only + approval never');
check(!calls.resolve.includes('session-legacy') && logText().includes('旧会话'), '(h) a pre-counter session is rolled over, not resumed');
check(agents.get(sid).history[0].includes(RULES) && calls.select.some((c) => c[0] === sid && c[1] === 'low'), '(h) first message carries the rules; effort low on the new session');
check(sessions()['Tester-Forever'].turns === 1 && sessions()['Tester-Forever'].lastPrompt === 1500, `(h) turn count and last prompt size recorded: ${JSON.stringify(sessions()['Tester-Forever'])}`);
check(/2 次调用，提示 1500 token（未缓存 800，缓存 2000），输出 150/.test(logText()), '(h) per-turn usage logged');

// (b) a follow-up reuses the same session (turn 2)
const id2 = await send({ type: 'ask', q: '那下一步呢？' });
const s2 = await waitSlot(2);
check(s2?.id === id2 && s2.text.includes('第2轮') && calls.create === 1, `(b) follow-up in the same session: ${s2?.text}`);
check(!agents.get(sid).history[1].includes(RULES) && agents.get(sid).history[1].includes('回答格式照本对话第一条消息'), '(h) later messages: a reminder, not the rules');
check(calls.select.filter((c) => c[0] === sid).length >= 2, '(h) the effort is (re)selected on the resumed session too');

// (c) reset by request and by typing 新对话
const id3 = await send({ type: 'reset', q: 'reset' });
const s3 = await waitSlot(3);
check(s3?.id === id3 && s3.text.includes('已开新对话') && !sessions()['Tester-Forever'], '(c) reset request drops the mapping');
await send({ type: 'ask', q: '你好' });
const s4 = await waitSlot(4);
check(s4?.text.includes('第1轮') && calls.create === 2, `(c) the next question opens a new session: ${s4?.text}`);
await send({ type: 'ask', q: '新对话' });
const s5 = await waitSlot(5);
check(s5?.text.includes('已开新对话') && !sessions()['Tester-Forever'], '(c) typing 新对话 also resets');

// (i) rollover after maxTurns (3): the 4th question opens a new session whose first message has the rules + last exchange
for (const [k, q] of [[6, '一'], [7, '二'], [8, '三']]) { await send({ type: 'ask', q }); await waitSlot(k); }
const sidC = sessions()['Tester-Forever']?.sessionId;
check(sessions()['Tester-Forever'].turns === 3 && calls.create === 3, `(i) three turns in one session: ${JSON.stringify(sessions()['Tester-Forever'])}`);
await send({ type: 'ask', q: '四' });
const s9 = await waitSlot(9);
const sidD = sessions()['Tester-Forever']?.sessionId;
check(s9?.text.includes('第1轮') && sidD !== sidC && calls.create === 4, `(i) 4th question in a new session: ${s9?.text}`);
const firstD = agents.get(sidD).history[0];
check(firstD.includes(RULES) && firstD.includes('问：三') && firstD.includes('答：答「三」'), '(i) new session: rules + the old session\'s last exchange');

// (j) a long last answer keeps its trailing {{buy:…}} line in the carry-over; the carry survives a session that was
// created but failed to attach (pending entry), and that session is repaired: rules + carry in its first message
for (const [k, q] of [[10, '五'], [11, '长']]) { await send({ type: 'ask', q }); await waitSlot(k); }
const qa = sessions()['Tester-Forever'].lastQA;
check(sessions()['Tester-Forever'].turns === 3 && qa.a.endsWith('{{buy:厚符文布绷带×5|14047×10}}') && qa.a.length <= 302, `(j) carry keeps the buy line: ${qa.a.slice(-60)} (${qa.a.length})`);
createFail = 'attach';
await send({ type: 'ask', q: '七' });
const s12 = await waitSlot(12);
const pend = sessions()['Tester-Forever'];
check(s12?.text.includes('workspace-attach-failed') && pend.pending && pend.carry?.q === '长', `(j) attach failed: pending entry keeps the carry: ${JSON.stringify(pend).slice(0, 120)}`);
await send({ type: 'ask', q: '八' });
const s13 = await waitSlot(13);
const sidE = sessions()['Tester-Forever'].sessionId;
const firstE = agents.get(sidE).history[0];
check(sidE === pend.sessionId && s13?.text.includes('第1轮'), `(j) the pending session is resumed: ${s13?.text}`);
check(firstE.includes(RULES) && firstE.includes('问：长') && firstE.includes('{{buy:厚符文布绷带×5|14047×10}}'), '(j) repaired session: rules + carry in its first message');
check(sessions()['Tester-Forever'].turns === 1 && !sessions()['Tester-Forever'].carry && !sessions()['Tester-Forever'].pending, '(j) counted from 1, carry cleared');

// (k) translation: its own session per character, the translate prompt (no format rules), and 新对话 is translated,
// not a reset
const sidBefore = sessions()['Tester-Forever'].sessionId;
await send({ type: 'translate', q: '新对话' });
const sT = await waitSlot(14);
const tr = sessions()['Tester-Forever·翻译'];
const firstT = tr && agents.get(tr.sessionId)?.history[0];
check(sT?.text.includes('答「新对话」') && tr?.turns === 1 && sessions()['Tester-Forever']?.sessionId === sidBefore,
  `(k) translation in its own session, the question session untouched: ${sT?.text}`);
check(firstT?.includes('翻译任务') && !firstT.includes(RULES), '(k) translate prompt without the answer format rules');

// (d) a slow answer times out: the turn is cancelled with keepInbox and the timeout text is written
answerDelay = 6000;
await send({ type: 'ask', q: '慢问题' });
const s6 = await waitSlot(15, 9000);
check(s6?.text.includes('超时') && calls.cancel.some((c) => c[0] === 'hook' && c[1] === true), `(d) timeout -> cancel keepInbox: ${s6?.text}`);
check(sessions()['Tester-Forever'].turns === 1, '(d) a timed-out turn is not counted');
await sleep(3500);   // let the fake finish its aborted turn

// (l) server + faction on the settings page: every session rolls over, the new first message names the server, the
// faction overrides the character's, prices come from 无限图鉴
const before = sessions()['Tester-Forever'].sessionId;
const set = await api('settings', { server: 'cn-pvp', faction: 'Alliance' });
check(set.status === 200 && set.body.settings.server === 'cn-pvp' && sessions()['Tester-Forever'].turns >= 1e9, '(l) settings saved, sessions marked for rollover');
check(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).server === 'cn-pvp', '(l) saved in config.json');
answerDelay = 50;
await send({ type: 'ask', q: '国服问题' });
const sCN = await waitSlot(16);
const sidCN = sessions()['Tester-Forever'].sessionId;
const firstCN = agents.get(sidCN).history[0];
check(sCN?.text.includes('第1轮') && sidCN !== before, `(l) a new session after the change: ${sCN?.text}`);
check(firstCN.includes('服务器：国服 PvP，联盟') && firstCN.includes('"pvp-alliance"') && firstCN.includes('"faction":"Alliance"'), '(l) server line + faction override in the first message');

// (e) dispose in the middle of a question: no slot is written
answerDelay = 1500;
await send({ type: 'ask', q: '卸载时的问题' });
await sleep(300);
for (const d of ctx.disposers) await d();
await sleep(2500);
check(readSlot(17) === null, '(e) no mailbox write after the plugin was disposed');

// (g) nothing escaped as an uncaught exception or unhandled rejection
check(fatal.length === 0, `(g) no uncaught exceptions / unhandled rejections${fatal.length ? `: ${fatal.join(' | ')}` : ''}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'ALL OK');
process.exit(failures ? 1 : 0);
