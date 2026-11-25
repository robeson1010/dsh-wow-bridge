// Market tools for agent preset "wowf" (child row of preset-wowf, so the tools live in the preset scope: only wowf
// agents see them). Online prices only, from wowauctions.net (EU / US Forever; realm and default faction from the
// settings page, lib/settings.mjs); see ./wowauctions.js. On a China server the tools refuse: prices come from
// 无限图鉴's auction_house there (wowf-tool-policy.js hides these two tools then).
//   wow_item_market(itemId, faction?)        one item: price, 30-day median/range, change, sales, verdicts
//   wow_craft_profit(profession, faction?)   up to 10 profitable recipes without crafting cooldowns
// Whether a vendor sells an item (or a shown reagent) is looked up in 无限图鉴's vendor lists (./vendors.js): the
// wowauctions pages cannot tell. A failed lookup never fails the tool; the text then says it is unknown.
// execute() errors are caught by the tool registry and returned to the model as isError.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { professionSlug, itemUrl, professionUrl, itemMarketText, craftProfitText, shownReagentIds, makeFetcher } from './wowauctions.js';
import { makeVendorLookup } from './vendors.js';
import { marketTarget as target } from './lib/settings.mjs';

export const name = 'wowf-market-tools';
export const inject = ['tools'];

export function tools(load, vendorsOf = async () => new Map()) {
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
  ];
}

export function apply(ctx) {
  const load = makeFetcher();
  const lookup = makeVendorLookup();
  const vendorsOf = async (ids, signal) => { try { return await lookup(ids, signal); } catch { return new Map(); } };
  for (const t of tools(load, vendorsOf)) {
    try { ctx.tools.register(t); } catch (e) { console.error(`[wow-dsh-bridge] register ${t?.name}: ${e?.message}`); }
  }
}
