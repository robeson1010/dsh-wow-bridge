// Tool policy for agent preset "wowf" (child row of preset-wowf, so `ctx` is the preset scope and everything here
// applies only to agents bound to wowf). Game text is untrusted input, so:
//  1. guard: exact-name allowlist + web_fetch host allowlist. The security boundary; a guard denial is final.
//  2. per-agent deny: hides every tool a wowf agent can see that is not allowlisted (host tools, MCP resource tools,
//     wuxianwow tools we do not use). Saves tokens; the guard still blocks anything left visible.
//  3. preset-scope deny of the current GLOBAL tool names (backup for 2).
// Why not restrict({allow}) in preset scope: preset-layer tools count as 'inherited' for the agent, so an allow mask
// there hides the preset's own web/MCP tools too, and restrict() only accepts global names (dsh-tools index.ts).
// dsh web exits on any uncaught error: every listener catches, nothing awaits a DSH service.
import { readSettings, serverInfo } from './lib/settings.mjs';

export const name = 'wowf-tool-policy';
export const inject = ['tools'];

const PRESET_ID = 'wowf';
const MCP = 'mcp__wuxianwow__';
// 15 of wuxianwow's tools (game data for Q&A). Every definition rides on every model call (the 31 tools of 2026-11-20
// were ~20k tokens per call), so only what answers player questions stays. Left out:
//  - report_issue (the only write tool), stage, revise, retell, stage_project, trip (director / video / 3D), addon_api,
//    stats, lore_* (novel lore), npc_looks, bundle, builds, hotfixes, build_changes, entity_history, sim;
//  - never called in 70 real turns (2026-11-21): gear_items, epic_items, item_sets, titles, races, list_categories, list_professions, camping (camp-facility
//    recipes, not farming spots), leveling_route (profession plans at China prices), talents and atlas (still reachable
//    through fetch talents:<class> / map:<id>; map pins use quests / npcs / instances / profession_guide coordinates).
export const MCP_TOOLS = [
  'search', 'fetch', 'quests', 'item_usage', 'npcs', 'instances', 'gathering', 'topic', 'spellbook', 'recipes',
  'profession_guide', 'factions', 'achievements', 'insights', 'legacy_tree',
];
// our own read-only market tools (./wowf-market-tools.js)
export const OWN_TOOLS = ['wow_item_market', 'wow_craft_profit'];
// prices by the server on the settings page (lib/settings.mjs): China -> 无限图鉴's auction_house; EU / US -> our
// wowauctions tools. The other side's price tools are hidden and refused, so the model cannot quote the wrong region.
export const CN_PRICE_TOOLS = [`${MCP}auction_house`];
export const ALLOW = new Set(['web_search', 'web_fetch', ...OWN_TOOLS, ...CN_PRICE_TOOLS, ...MCP_TOOLS.map((n) => MCP + n)]);
export const offRegion = (settings = readSettings()) =>
  new Set(serverInfo(settings).prices === 'wuxianwow' ? OWN_TOOLS : CN_PRICE_TOOLS);

// web_fetch: these domains and their subdomains only; https, default port, no credentials.
// wowauctions.net: EU Forever AH prices per ruleset/faction (plain pages, robots.txt allows all; checked 2026-11-20).
export const FETCH_DOMAINS = ['wowhead.com', 'wuxianwow.com', 'warcraft.wiki.gg', 'wowpedia.fandom.com', 'icy-veins.com',
  'wowauctions.net'];

// ---- slimmer wuxianwow results (every result is first sent to the model as uncached input, then stays in history) ----
// Measured 2026-11-21: a quest detail is ~10k chars, half of it a provenance `note` identical in every result; the
// *_note fields, null / empty values and item_usage's China-region `auction` block add more. Only content changes (the
// tool value is kept); anything that does not parse as JSON is only length-capped.
const NOTE_KEYS = new Set(['note', 'notes']);          // provenance text: dropped near the top (depth <= 2)
const DROP_BY_TOOL = { item_usage: ['auction'] };       // China-region AH prices: dropped unless the server is China
export const RESULT_MAX_CHARS = 8000;
const HEAD_CHARS = 6000, TAIL_CHARS = 1500;

export function slimValue(v, depth = 0) {
  if (Array.isArray(v)) {
    const a = [];
    for (const x of v) { const y = slimValue(x, depth + 1); if (y !== undefined) a.push(y); }
    return a.length ? a : undefined;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('_note') || (depth <= 2 && NOTE_KEYS.has(k))) continue;
      const y = slimValue(x, depth + 1);
      if (y !== undefined) o[k] = y;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === '' ? undefined : v;   // false and 0 stay
}

export function capText(text, max = RESULT_MAX_CHARS) {
  if (text.length <= max) return text;
  const cut = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n\n[……结果太长，中间省略 ${cut} 字；需要那部分就换更窄的查询……]\n\n${text.slice(-TAIL_CHARS)}`;
}

// A JSON result over the cap: shorten the longest lists (top two levels) from the end, one at a time, and say so next
// to each list, so every short field (standings, reputation quests, counts, map marks) stays whole. A plain head/tail
// cut would drop whatever sits in the middle. Deterministic, so a repeated call stays cacheable.
export function fitJson(v, max = RESULT_MAX_CHARS) {
  let s = JSON.stringify(v);
  if (s.length <= max || !v || typeof v !== 'object') return s;
  const root = Array.isArray(v) ? { items: v } : v;
  const orig = new Map();   // trimmed array -> original length
  for (let guard = 0; guard < 100 && s.length > max; guard++) {
    let best = null;
    const visit = (node, depth) => {
      for (const [k, x] of Object.entries(node)) {
        if (Array.isArray(x) && x.length > 1) {
          const len = JSON.stringify(x).length;
          if (!best || len > best.len) best = { node, k, len };
        } else if (x && typeof x === 'object' && !Array.isArray(x) && depth < 1) visit(x, depth + 1);
      }
    };
    visit(root, 0);
    if (!best) break;
    const arr = best.node[best.k];
    if (!orig.has(arr)) orig.set(arr, arr.length);
    const over = s.length - max;
    const keep = Math.max(1, Math.min(arr.length - 1, Math.floor(arr.length * (1 - (over + 200) / best.len))));
    const total = orig.get(arr);
    const cut = arr.slice(0, keep);
    orig.set(cut, total);
    best.node[best.k] = cut;
    best.node[`${best.k}_省略`] = `共 ${total} 条，这里只列前 ${keep} 条；要看其余的换更窄的查询（或用 limit/offset 翻页）`;
    s = JSON.stringify(root);   // a top-level list becomes { items, items_省略 }
  }
  return s;
}

// one wuxianwow result text -> the slimmer text (unchanged when nothing applies)
export function slimResultText(tool, text, { keepPrices = false } = {}) {
  let out = text;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (!keepPrices) for (const k of DROP_BY_TOOL[tool] ?? []) delete j[k];
      const slim = slimValue(j) ?? {};
      out = fitJson(slim);
      if (out.length <= RESULT_MAX_CHARS) return out;
    }
  } catch { /* not JSON: length cap only */ }
  return capText(out);
}

const under = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const hideable = (n, off = offRegion()) => typeof n === 'string' && (!ALLOW.has(n) || off.has(n)) && n !== 'run_code';

export function fetchDenial(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { return 'web_fetch: 网址无效。'; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    return 'web_fetch: 只能读 https 网址（默认端口，不带账号密码）。';
  }
  if (!FETCH_DOMAINS.some((d) => under(host, d))) {
    return `web_fetch: ${host} 不在白名单，只能读 ${FETCH_DOMAINS.join('、')}（含子域名）。`;
  }
  return undefined;
}

// ToolGuard: undefined = allow, string = final denial (the model sees "Error: <reason>").
export function denial(exec) {
  try {
    const n = exec?.name;
    if (!ALLOW.has(n)) return `工具 ${String(n)} 在这个预设里不可用。`;
    if (offRegion().has(n)) return `工具 ${String(n)} 不适用于设置里的服务器：${serverInfo(readSettings()).label}。`;
    return n === 'web_fetch' ? fetchDenial(exec.arguments?.url) : undefined;
  } catch {
    return 'wowf 工具策略出错，已拒绝。';   // fail closed
  }
}

export function apply(ctx) {
  const warn = (m) => { try { ctx.logger?.warn?.(`wowf-tool-policy: ${m}`); } catch { /* logging only */ } };
  const ours = (agent) => {
    try { return ctx.get('agentPresets')?.composedPreset(agent.ctx) === PRESET_ID; } catch { return false; }
  };
  let disposed = false;

  // 1. the boundary (tools.guard registers its own effect: lifted when this row unloads)
  ctx.tools.guard(denial);

  // backstop on the FINAL url (the http provider never follows cross-origin redirects; another provider might)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (exec?.name === 'web_fetch' && (!exec.agent || ours(exec.agent))) {
        const url = result?.value?.url;
        if (typeof url === 'string' && fetchDenial(url)) {
          return { kind: 'block', feedback: [{ type: 'text', text: `web_fetch: 最终网址 ${url} 不在白名单，结果已丢弃。` }] };
        }
      }
    } catch { /* fall through */ }
    return next();
  });

  // slimmer wuxianwow results, after everything downstream decided (the same shape dsh-spill-policy uses)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    try {
      const n = exec?.name;
      if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value') || result?.isError) return decision;
      if (typeof n !== 'string' || !n.startsWith(MCP) || (exec.agent && !ours(exec.agent))) return decision;
      const content = decision.content ?? result?.content;
      if (!Array.isArray(content) || !content.length || content.some((b) => b?.type !== 'text')) return decision;
      const text = content.map((b) => b.text ?? '').join('');
      const slim = slimResultText(n.slice(MCP.length), text, { keepPrices: serverInfo(readSettings()).prices === 'wuxianwow' });
      if (slim === text) return decision;
      return { ...decision, kind: 'accept', content: [{ type: 'text', text: slim }] };
    } catch (err) { warn(`slim ${exec?.name}: ${err?.message}`); return decision; }
  });

  // 3. preset-scope deny of GLOBAL names; allowlisted names are never denied
  let presetOff = null, presetKey = null;
  const syncPresetDeny = () => {
    const off = offRegion();
    const names = ctx.tools.definitions().map((d) => d.name).filter((n) => hideable(n, off)).sort();
    const key = names.join('\n');
    if (key === presetKey) return;
    const prev = presetOff;
    presetKey = key;
    presetOff = names.length ? ctx.tools.restrict({ deny: names }) : null;
    if (prev) { try { prev(); } catch { /* already gone */ } }
  };

  // 2. per-agent deny. Agent-own tools cannot be restricted from any scope: they go to `skip`, left to the guard.
  const perAgent = new Map();   // Agent -> { offs, skip }
  const lift = (agent) => {
    const e = perAgent.get(agent);
    perAgent.delete(agent);
    for (const off of e?.offs ?? []) { try { off(); } catch { /* agent gone */ } }
  };
  const hide = (agent) => {
    let e = perAgent.get(agent);
    if (!e) perAgent.set(agent, (e = { offs: [], skip: new Set() }));
    const off = offRegion();
    const extra = ctx.tools.definitions(agent).map((d) => d.name).filter((n) => hideable(n, off) && !e.skip.has(n));
    if (!extra.length) return;
    try { e.offs.push(agent.ctx.tools.restrict({ deny: extra })); return; } catch { /* some name is agent-own */ }
    for (const n of extra) {
      try { e.offs.push(agent.ctx.tools.restrict({ deny: [n] })); } catch { e.skip.add(n); }
    }
  };

  let busy = false;   // our own restrict() calls re-emit tools/change synchronously
  const sweep = (also) => {
    if (busy || disposed) return;
    busy = true;
    try {
      try { syncPresetDeny(); } catch (err) { warn(`preset deny: ${err?.message}`); }
      for (const a of [...perAgent.keys()]) if (!ours(a)) lift(a);   // switched to another preset, or gone
      const agents = new Set(ctx.get('agents')?.list?.() ?? []);
      if (also) agents.add(also);
      for (const a of agents) {
        if (!ours(a)) continue;
        try { hide(a); } catch (err) { warn(`agent ${a?.id}: ${err?.message}`); }
      }
    } catch (err) { warn(err?.message); } finally { busy = false; }
  };
  let queued = false;
  const later = () => {   // tools/change may fire inside another plugin's registry update: re-sweep right after it
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; try { sweep(); } catch { /* sweep catches */ } });
  };

  ctx.on('agent/created', (ev) => { try { sweep(ev?.agent); } catch { /* never fail agent creation */ } });
  ctx.on('agent-preset/selected', () => { try { sweep(); } catch { /* ignore */ } });
  ctx.on('agent/disposed', (ev) => { try { perAgent.delete(ev?.agent); } catch { /* ignore */ } });
  ctx.on('tools/change', () => { try { later(); } catch { /* ignore */ } });
  // the server changed on the settings page: re-hide from scratch (a region's price tools may have to come back)
  let region = [...offRegion()].join();
  ctx.on('wow-dsh-bridge/settings', () => {
    try {
      const now = [...offRegion()].join();
      if (now === region) return;
      region = now;
      for (const a of [...perAgent.keys()]) lift(a);
      presetKey = null;
      sweep();
    } catch (err) { warn(`settings: ${err?.message}`); }
  });
  ctx.effect(() => () => {
    disposed = true;
    for (const a of [...perAgent.keys()]) lift(a);
    if (presetOff) { try { presetOff(); } catch { /* ignore */ } }
    presetOff = null;
    presetKey = null;
  }, 'wowf: lift tool restrictions');
  sweep();
}
