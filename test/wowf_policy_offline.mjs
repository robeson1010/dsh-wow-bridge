// node test/wowf_policy_offline.mjs: dsh-web/wowf-tool-policy.js against a fake preset-scoped ctx, plus prompt() checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// a private settings folder (lib/settings.mjs reads DSHB_DATA_DIR on every call): EU PvP until a test writes config.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpol-'));
process.env.DSHB_DATA_DIR = DATA;
const setServer = (server, faction = 'auto') => fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ server, faction }));
import { forgetConfigCache } from '../dsh-web/lib/settings.mjs';
import { apply, denial, fetchDenial, ALLOW, MCP_TOOLS, OWN_TOOLS, CN_PRICE_TOOLS, offRegion, slimResultText, slimValue, capText, RESULT_MAX_CHARS } from '../dsh-web/wowf-tool-policy.js';
import { prompt, factionOf, RULES_REMINDER } from '../dsh-web/lib/answer.mjs';

// ---- allowlist ----
assert.equal(ALLOW.size, MCP_TOOLS.length + OWN_TOOLS.length + CN_PRICE_TOOLS.length + 2);
assert.equal(MCP_TOOLS.length, 15, 'trimmed wuxianwow allowlist (2026-11-21)');
for (const n of ['web_search', 'wow_item_market', 'wow_craft_profit', 'wow_flip_market', 'mcp__wuxianwow__search', 'mcp__wuxianwow__quests', 'mcp__wuxianwow__npcs',
  'mcp__wuxianwow__instances', 'mcp__wuxianwow__profession_guide', 'mcp__wuxianwow__gathering', 'mcp__wuxianwow__fetch']) {
  assert.equal(denial({ name: n, arguments: {} }), undefined, n);
}
for (const n of [...['report_issue', 'stage', 'revise', 'retell', 'stage_project', 'trip', 'addon_api', 'stats',
  'lore_search', 'sim', 'hotfixes', 'auction_house', 'gear_items', 'epic_items', 'item_sets', 'titles', 'races', 'camping',
  'list_categories', 'list_professions', 'leveling_route', 'talents', 'atlas'].map((x) => `mcp__wuxianwow__${x}`),
  'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates', 'working_directory', 'create_worktree',
  'read', 'bash', 'pwsh', undefined]) {
  assert.ok(denial({ name: n, arguments: {} }), String(n));
}
assert.ok(denial(null));

// ---- prices by server (settings page): EU / US -> our wowauctions tools; China -> 无限图鉴 auction_house ----
assert.ok(denial({ name: 'mcp__wuxianwow__auction_house', arguments: {} }).includes('欧服 PvP'), 'EU: China prices refused');
setServer('us-rp'); forgetConfigCache();
assert.ok(denial({ name: 'mcp__wuxianwow__auction_house', arguments: {} }) && !denial({ name: 'wow_item_market', arguments: {} }), 'US: same as EU');
setServer('cn-pvp'); forgetConfigCache();
assert.equal(denial({ name: 'mcp__wuxianwow__auction_house', arguments: {} }), undefined, 'China: auction_house allowed');
assert.ok(denial({ name: 'wow_item_market', arguments: {} }).includes('国服 PvP') && denial({ name: 'wow_craft_profit', arguments: {} })
  && denial({ name: 'wow_flip_market', arguments: {} }).includes('国服 PvP'), 'China: the EU / US price tools refused');
assert.deepEqual([...offRegion()], OWN_TOOLS);
const cnUsage = JSON.parse(slimResultText('item_usage', JSON.stringify({ item: { id: 2320 }, auction: { realms: ['PvP · 部落'] } }), { keepPrices: true }));
assert.ok(cnUsage.auction, 'China: item_usage keeps its auction block');
fs.rmSync(path.join(DATA, 'config.json')); forgetConfigCache();

// ---- web_fetch hosts ----
for (const u of ['https://www.wowhead.com/classic/item=14047', 'https://WOWHEAD.com/', 'https://wuxianwow.com/item/14047',
  'https://warcraft.wiki.gg/wiki/Runecloth', 'https://www.icy-veins.com/wow-classic/', 'https://wowpedia.fandom.com/wiki/Runecloth',
  'https://www.wowauctions.net/auctionHouse/forever-eu/pvp-forever-eu/horde/x-14047']) {
  assert.equal(fetchDenial(u), undefined, u);
  assert.equal(denial({ name: 'web_fetch', arguments: { url: u } }), undefined, u);
}
for (const u of ['http://www.wowhead.com/', 'https://evilwowhead.com/', 'https://wowhead.com.evil.io/', 'https://u:p@wowhead.com/',
  'https://wowhead.com:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'file:///C:/x',
  'https://fandom.com/', 'https://other.fandom.com/', 'not a url', '', 'https://bootybaybroker.com/forever/ah',
  'https://wowauctions.net.evil.io/']) {
  assert.ok(fetchDenial(u), u);
}
assert.ok(denial({ name: 'web_fetch', arguments: {} }));

// ---- visibility with a fake tools service ----
const GLOBAL = ['working_directory', 'create_worktree'];
const PRESET = new Set(['web_search', 'web_fetch', 'mcp__wuxianwow__search', 'mcp__wuxianwow__report_issue', 'list_mcp_resources']);
const OWN = ['present'];   // agent-own: cannot be restricted from anywhere
const listeners = new Map(), effects = [], guards = [], warns = [];
const layer = { preset: new Set(), agent: new Set() };
let preset = 'wowf';
const emit = (ev, ...a) => (listeners.get(ev) ?? []).forEach((fn) => fn(...a));
const restrictIn = (bucket, known) => (f) => {
  const names = f.deny ?? [];
  if (names.some((n) => !known().includes(n))) throw new Error('unknown global tool');
  const r = new Set(names); layer[bucket].add(r); emit('tools/change');
  return () => { layer[bucket].delete(r); emit('tools/change'); };
};
const denied = (b, n) => [...layer[b]].some((r) => r.has(n));
const visible = () => [...GLOBAL, ...PRESET].filter((n) => !denied('preset', n) && !denied('agent', n)).concat(OWN);
const agent = { id: 's1', ctx: { tools: { restrict: restrictIn('agent', () => [...GLOBAL, ...PRESET]) } } };
const ctx = {
  tools: {
    guard: (g) => { guards.push(g); effects.push(() => guards.splice(guards.indexOf(g), 1)); },
    restrict: restrictIn('preset', () => GLOBAL),
    definitions: (scope) => (scope ? visible() : GLOBAL).map((name) => ({ name })),
  },
  on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
  effect: (fn) => { effects.push(fn()); },
  get: (n) => (n === 'agentPresets' ? { composedPreset: () => preset } : n === 'agents' ? { list: () => [agent] } : undefined),
  logger: { warn: (m) => warns.push(m) },
};
const tick = () => new Promise((r) => setImmediate(r));
apply(ctx);
emit('agent/created', { agent });
assert.deepEqual(visible().sort(), ['mcp__wuxianwow__search', 'present', 'web_fetch', 'web_search']);
assert.equal(guards.length, 1);
assert.ok(guards[0]({ name: 'present', arguments: {} }));   // a visible agent-own tool is still refused
PRESET.add('mcp__wuxianwow__trip'); emit('tools/change'); await tick();
assert.ok(!visible().includes('mcp__wuxianwow__trip'), 'a tool registered later is hidden too');
const post = listeners.get('tools/post-execute')[0];
const next = async () => ({ kind: 'accept' });
assert.equal((await post({ name: 'web_fetch', agent }, { value: { url: 'https://evil.example/' } }, next)).kind, 'block');
assert.equal((await post({ name: 'web_fetch', agent }, { value: { url: 'https://www.wowhead.com/x' } }, next)).kind, 'accept');

// ---- slimmer wuxianwow results (second post-execute listener) ----
const quest = fs.readFileSync(new URL('./fixtures/wx-quest-176.txt', import.meta.url), 'utf8');
const slimQ = slimResultText('quests', quest);
const qj = JSON.parse(slimQ);
assert.ok(slimQ.length < quest.length * 0.45, `quest detail slimmed: ${quest.length} -> ${slimQ.length}`);
assert.ok(!('note' in qj) && !('map_marks_note' in qj) && !('guide_note' in qj), 'provenance notes dropped');
assert.ok(Array.isArray(qj.map_marks) && qj.map_marks[0].map.ui_map > 0 && qj.map_marks[0].marks[0].coords, 'map marks (ui_map + coords) kept');
assert.equal(qj.id, JSON.parse(quest).id);
assert.deepEqual(slimValue({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: [null, 1], h: { x_note: 'n', y: 'k' } }), { e: false, f: 0, g: [1], h: { y: 'k' } });
assert.deepEqual(slimValue({ a: { b: { c: { note: 'deep notes are data' } } } }), { a: { b: { c: { note: 'deep notes are data' } } } }, 'note is dropped near the top only');
const iu = JSON.parse(slimResultText('item_usage', JSON.stringify({ item: { id: 2320 }, auction: { realms: ['PvP · 部落'] }, used_by: [1, 2] })));
assert.ok(!('auction' in iu) && iu.used_by.length === 2, 'item_usage loses the China-region auction block');
const long = 'x'.repeat(RESULT_MAX_CHARS + 5000);
const capped = capText(long);
assert.ok(capped.length < RESULT_MAX_CHARS && capped.includes('中间省略 5500 字'), 'long results keep head + tail');
assert.equal(slimResultText('fetch', 'plain text, not JSON'), 'plain text, not JSON');
// over the cap, JSON results lose the tail of their longest lists (with a note), never their short fields
const big = { standings: ['友善', '尊敬'], reputation_quests: [{ id: 1, title: '声望任务' }], rewards: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `奖励物品 ${i}` })) };
const fit = JSON.parse(slimResultText('factions', JSON.stringify(big)));
assert.ok(JSON.stringify(fit).length <= RESULT_MAX_CHARS, 'fits the cap');
assert.deepEqual(fit.standings, big.standings);
assert.deepEqual(fit.reputation_quests, big.reputation_quests, 'short fields stay whole');
assert.ok(fit.rewards.length < 300 && fit.rewards[0].id === 0 && /^共 300 条，这里只列前 \d+ 条/.test(fit.rewards_省略), fit.rewards_省略);
assert.equal(slimResultText('factions', JSON.stringify(big)), JSON.stringify(fit), 'deterministic (cacheable)');
const slimPost = listeners.get('tools/post-execute')[1];
const blocks = (text) => ({ content: [{ type: 'text', text }] });
const d1 = await slimPost({ name: 'mcp__wuxianwow__quests', agent }, blocks(quest), next);
assert.equal(d1.kind, 'accept');
assert.equal(d1.content[0].text, slimQ, 'the model sees the slim text');
assert.ok(!Object.hasOwn(d1, 'value'), 'only content is replaced, never the value');
const d2 = await slimPost({ name: 'web_search', agent }, blocks(quest), next);
assert.ok(!d2.content, 'other tools untouched');
const d3 = await slimPost({ name: 'mcp__wuxianwow__quests', agent }, { ...blocks(quest), isError: true }, next);
assert.ok(!d3.content, 'errors untouched');
const d4 = await slimPost({ name: 'mcp__wuxianwow__quests', agent }, blocks(quest), async () => ({ kind: 'block', feedback: [] }));
assert.equal(d4.kind, 'block', 'a downstream block wins');
const d5 = await slimPost({ name: 'mcp__wuxianwow__quests', agent }, blocks(quest), async () => ({ kind: 'accept', content: [{ type: 'text', text: '{"note":"n","id":1}' }] }));
assert.equal(d5.content[0].text, '{"id":1}', 'slims what downstream already replaced');
preset = 'standard'; emit('agent-preset/selected', 's1', 'standard');
assert.equal(layer.agent.size, 0, 'switched away: per-agent denies lifted');
preset = 'wowf'; emit('tools/change'); await tick();
assert.ok(layer.agent.size > 0);
for (const off of effects) if (typeof off === 'function') off();
await tick();
assert.equal(layer.agent.size + layer.preset.size + guards.length, 0, 'everything lifted on unload');
assert.deepEqual(warns, []);

// ---- prompt() ----
assert.equal(factionOf({}), 'Horde');
assert.equal(factionOf({ faction: 'Alliance' }), 'Alliance');
const p1 = prompt({ q: '符文布多少钱', ctx: { name: 'A', faction: 'Horde' } });
assert.ok(p1.includes('服务器：欧服 PvP，部落') && p1.includes('https://www.wowauctions.net/auctionHouse/forever-eu/pvp-forever-eu/horde/x-物品ID'));
assert.ok(p1.includes('wow_item_market') && p1.includes('国服参考价') && !p1.includes('auction_house'));
// the server and faction from the settings page
setServer('us-pve', 'Alliance'); forgetConfigCache();
const pUS = prompt({ q: '多少钱', ctx: { faction: 'Horde' } });
assert.ok(pUS.includes('服务器：美服 PvE，联盟') && pUS.includes('forever-us/pve-forever-us/alliance/x-物品ID'), 'US PvE, faction from the settings');
setServer('cn-normal'); forgetConfigCache();
const pCN = prompt({ q: '多少钱', ctx: { faction: 'Alliance' } });
assert.ok(pCN.includes('服务器：国服 普通，联盟') && pCN.includes('mcp__wuxianwow__auction_house') && pCN.includes('"normal-alliance"')
  && !pCN.includes('wowauctions') && !pCN.includes('国服参考价'), 'China: 无限图鉴 house from server + character faction');
fs.rmSync(path.join(DATA, 'config.json')); forgetConfigCache();
assert.ok(!/Auctionator|auction 字段|bootybaybroker/.test(p1));
assert.ok(p1.includes('{{loc:地图ID,x,y|名字}}') && p1.includes('{{npc:NPC ID|名字}}') && p1.includes('玩家点了才在地图上标记'), 'map rule in the user message');
assert.ok(p1.includes('{{buy:清单标题|物品ID×数量,物品ID×数量}}') && p1.includes('购买由玩家自己在拍卖行点'), 'shopping-list rule in the user message');
const p2 = prompt({ q: '多少钱', ctx: { faction: 'Alliance' }, links: [{ type: 'item', id: 14047 }] });
assert.ok(p2.includes('联盟') && p2.includes('pvp-forever-eu/alliance/x-物品ID') && p2.includes('14047'));
assert.ok(!p1.includes('atlas'), 'no atlas in MAP_RULE (tool dropped)');
// later messages of a session: no rules and no server line, a one-line reminder; links and the question stay
const p3 = prompt({ q: '那下一步呢', ctx: { name: 'A' }, links: [{ type: 'item', id: 14047 }] }, { rules: false });
assert.ok(p3.includes(RULES_REMINDER) && p3.includes('14047') && p3.endsWith('玩家的问题：\n那下一步呢'));
assert.ok(!p3.includes('{{') && !p3.includes('服务器：') && p3.length < p1.length / 3, `later message is short: ${p3.length} vs ${p1.length}`);
// the first message after a rollover carries the old session's last exchange (clipped)
const p4 = prompt({ q: '继续', ctx: {} }, { carry: { q: '霍格在哪', a: 'A'.repeat(500) } });
assert.ok(p4.includes('问：霍格在哪') && p4.includes(`答：${'A'.repeat(340)}…`) && p4.includes('{{item:'), 'carry-over + rules in a new session');
fs.rmSync(DATA, { recursive: true, force: true });
console.log('wowf_policy_offline: ok');
