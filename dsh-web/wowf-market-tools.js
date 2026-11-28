// Market tools for agent preset "wowf" (child row of preset-wowf, so the tools live in the preset scope: only wowf
// agents see them). Online prices only, from wowauctions.net (EU / US Forever; realm and default faction from the
// settings page, lib/settings.mjs); see ./wowauctions.js. On a China server the tools refuse: prices come from
// 无限图鉴's auction_house there (wowf-tool-policy.js hides these tools then).
//   wow_item_market(itemId, faction?)        one item: price, 30-day median/range, change, sales, verdicts
//   wow_craft_profit(profession, faction?)   up to 10 profitable recipes without crafting cooldowns
//   wow_flip_market(faction?)                the best buys and the best sells right now among the fixed list of common
//                                            items (./watchlist.js; Forever AH's JSON API, see ./foreverah.js): the player
//                                            checks the prices in game and buys or sells. view=times: the hours of
//                                            the day (and weekdays) when the list is cheapest and dearest
//                                            (./markettimes.js; stored in <dataDir>/market-times.json)
// Whether a vendor sells an item (or a shown reagent) is looked up in 无限图鉴's vendor lists (./vendors.js): the
// wowauctions pages cannot tell. A failed lookup never fails the tool; the text then says it is unknown.
// execute() errors are caught by the tool registry and returned to the model as isError.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { professionSlug, itemUrl, professionUrl, itemMarketText, craftProfitText, shownReagentIds, makeFetcher } from './wowauctions.js';
import { makeVendorLookup } from './vendors.js';
import { makeApi, houseKey, housesUrl, watchUrl, auctionsUrl, ladderIds, flipMarketText } from './foreverah.js';
import { WATCH_IDS, WATCHLIST_DATE } from './watchlist.js';
import { makeTimes, timesText } from './markettimes.js';
import { marketTarget as target, defaultDataDir } from './lib/settings.mjs';

export const name = 'wowf-market-tools';
export const inject = ['tools'];

// load: wowauctions pages; vendorsOf: 无限图鉴 vendor lists; api: Forever AH JSON (./foreverah.js);
// times: the stored buy/sell-hours statistics and their background runs (./markettimes.js makeTimes)
export function tools(load, vendorsOf = async () => new Map(), api = async () => { throw new Error('Forever AH 没有接上。'); }, times = null) {
  const text = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
  return [
    defineTool({
      name: 'wow_item_market',
      description: '查一件物品在玩家拍卖行（欧服或美服，按设置里的规则集和阵营）的在线行情：最低一口价、市场价、在售数量、30 天中位数和区间、1/7 天涨跌、日销量、卖店价（卖给商人得到的钱），'
        + '商人卖不卖（无限图鉴的商人货单），'
        + '并判断是否低于商店价（捡漏）、偏低（低吸）、偏高（高抛）、有人压价或扫货。数据来自 wowauctions.net，大约每小时扫描一次。物品 ID 先从玩家链接或 mcp__wuxianwow__search 拿。',
      parameters: {
        itemId: { type: 'number', required: true, description: '物品 ID（数字）' },
        faction: { type: 'string', description: '阵营：horde（部落）或 alliance（联盟）；不传按设置' },
      },
      output: text,
      async execute(args, exec) {
        const id = Math.trunc(Number(args.itemId));
        if (!(id > 0 && id < 10_000_000)) throw new Error('itemId 必须是正整数物品 ID。');
        const { realm, server, faction } = target(args.faction);
        const url = itemUrl(id, faction, realm);
        const [pp, vendors] = await Promise.all([load(url, exec?.signal), vendorsOf([id], exec?.signal)]);
        return itemMarketText(pp, { faction, url, server, vendor: vendors.has(id) ? vendors.get(id) : null });
      },
    }),
    defineTool({
      name: 'wow_craft_profit',
      description: '查一个专业在玩家拍卖行（欧服或美服，按设置里的规则集和阵营）现在哪些配方做了卖赚钱：从销量最好的 40 个配方中排除有制作冷却的配方，返回盈利排名前 10，少于 10 个就全部返回。附成本、卖价、利润、日销量、利润趋势和材料（标了“商人有卖”的材料可向商人买）。'
        + '列出每项产物时用 {{item:物品ID|工具里的英文原名}} 输出可点击物品链接。'
        + '专业：炼金、锻造、烹饪、附魔、工程、急救、制皮、采矿（熔炼）、裁缝（中英文都行）。数据来自 wowauctions.net。',
      parameters: {
        profession: { type: 'string', required: true, description: '专业名，例如 裁缝 / tailoring' },
        faction: { type: 'string', description: '阵营：horde（部落）或 alliance（联盟）；不传按设置' },
      },
      output: text,
      async execute(args, exec) {
        const slug = professionSlug(args.profession);
        if (!slug) throw new Error(`不认识的专业「${args.profession}」，可用：炼金、锻造、烹饪、附魔、工程、急救、制皮、采矿、裁缝。`);
        const { realm, server, faction } = target(args.faction);
        const url = professionUrl(slug, faction, realm);
        const pp = await load(url, exec?.signal);
        const vendors = await vendorsOf(shownReagentIds(pp), exec?.signal);
        return craftProfitText(pp, { faction, url, server, vendors });
      },
    }),
    defineTool({
      name: 'wow_flip_market',
      description: '买卖行情：玩家只说“行情”，或者问现在最值得买什么、卖什么、买什么转手能赚、低买高卖、买卖利益，而没有指定物品或专业时用。'
        + '在固定的大交易量常见物品清单（布、皮、矿、锭、草药、附魔材料、药水、包等）里，按玩家拍卖行（欧服或美服，按设置里的规则集和阵营）现在的价格，'
        + '列出最值得买的（一口价、数量、入手上限、预期卖价、预计净利）和最值得卖的（比市场价高多少、挂多少）。'
        + '玩家问什么时候（几点、星期几）买卖最划算时 view 传 times：给出这份清单一天里最便宜和最贵的时段，以及时段差最明显的物品。'
        + '数据来自 Forever AH（forever-ah.com，暴雪 Battle.net API，约每小时一份快照）。',
      parameters: {
        faction: { type: 'string', description: '阵营：horde（部落）或 alliance（联盟）；不传按设置' },
        view: { type: 'string', description: 'now（默认）：现在最值得买和卖的；times：什么时段买卖最划算的统计' },
      },
      output: text,
      async execute(args, exec) {
        const { server, faction, region, ruleset } = target(args.faction);
        const signal = exec?.signal;
        const key = houseKey(await api(housesUrl(), signal), region, ruleset, faction);
        if (String(args.view ?? '').trim().toLowerCase() === 'times') {
          if (!times) throw new Error('时段统计没有接上。');
          const stats = times.read(key);
          if (times.fresh(stats)) return timesText({ stats, faction, server });
          times.refresh(key).catch(() => {});   // one run at a time, in the background: a question never waits for it
          if (stats) return timesText({ stats, faction, server, note: '这份统计有点旧了，正在后台重新算（约两分钟），过一会儿再问就是新的。' });
          return '买卖时段统计还没有算过：已经开始在后台读这份清单近 30 天的逐小时价格（Forever AH，每秒一个请求，约两分钟）。请玩家两分钟后再问一次；现在想知道该买卖什么，可以先问“行情”。';
        }
        const market = await api(watchUrl(key, WATCH_IDS), signal);
        // the cheap end of the best buys, to count the units; a failed read is told apart from "not read" (null)
        const ladders = new Map();
        for (const id of ladderIds(market)) {
          try { ladders.set(id, await api(auctionsUrl(key, id), signal)); } catch { ladders.set(id, null); }
        }
        return flipMarketText({ market, ladders, listed: WATCH_IDS.length, listDate: WATCHLIST_DATE, faction, server });
      },
    }),
  ];
}

export function apply(ctx) {
  const load = makeFetcher();
  const lookup = makeVendorLookup();
  const vendorsOf = async (ids, signal) => { try { return await lookup(ids, signal); } catch { return new Map(); } };
  // background runs of the hours statistics stop with this plugin row
  const life = new AbortController();
  try { ctx.effect(() => () => { try { life.abort(); } catch { /* ignore */ } }, 'wowf-market-tools: stop background runs'); } catch { /* no effect support: runs end on their own */ }
  const api = makeApi();
  const times = makeTimes(api, { dataDir: defaultDataDir, ids: WATCH_IDS, signal: life.signal, log: (m) => { try { console.log(`[wow-dsh-bridge] ${m}`); } catch { /* ignore */ } } });
  for (const t of tools(load, vendorsOf, api, times)) {
    try { ctx.tools.register(t); } catch (e) { console.error(`[wow-dsh-bridge] register ${t?.name}: ${e?.message}`); }
  }
}
