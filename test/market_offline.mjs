// node test/market_offline.mjs: the wowauctions reader (dsh-web/wowauctions.js) against saved page data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coins, professionSlug, factionSlug, nextData, itemMarketText, craftProfitText, shownReagentIds, makeFetcher, itemUrl, professionUrl,
} from '../dsh-web/wowauctions.js';
import { vendorFromUsage, usageFromRpc, makeVendorLookup } from '../dsh-web/vendors.js';
import {
  HOUSE_IDS, IDS_MAX, houseKey, housesUrl, watchUrl, auctionsUrl, netOf, assess, rank, ladderIds, lotFromLadder, lotCap, cheapUnits,
  flipMarketText, makeApi,
} from '../dsh-web/foreverah.js';
import { WATCHLIST, WATCH_IDS, WATCHLIST_DATE } from '../dsh-web/watchlist.js';
import {
  historyUrl, timeProfile, steady, overall, collectTimes, timesText, readTimes, writeTimes, makeTimes, TIMES_FILE, FRESH_MS, SWING_FOR_FLIP,
} from '../dsh-web/markettimes.js';
import os from 'node:os';
import { collectCraftItems, linkCraftItems } from '../dsh-web/lib/answer.mjs';
import { register } from 'node:module';
// wowf-market-tools.js imports defineTool from dsh: stub it (identity) so the tools can run here
register('data:text/javascript,' + encodeURIComponent("export async function resolve(s, c, n) { return s === '@deepseek-ai/dsh-tools' ? { url: 'data:text/javascript,export const defineTool = (t) => t;', shortCircuit: true } : n(s, c); }"));
const { tools } = await import('../dsh-web/wowf-market-tools.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));
const asHtml = (data) => `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
const NOW = Date.parse('2026-11-20T16:23:05Z');   // one hour after the fixture scan

// helpers
assert.equal(coins(529), '5银29铜');
assert.equal(coins(20360), '2金3银60铜');
assert.equal(coins(0), '0铜');
assert.equal(coins(-867), '-8银67铜');
assert.equal(professionSlug('裁缝'), 'tailoring');
assert.equal(professionSlug('Tailoring'), 'tailoring');
assert.equal(professionSlug('first aid'), 'first-aid');
assert.equal(professionSlug('熔炼'), 'mining');
assert.equal(professionSlug('珠宝'), null);
assert.equal(factionSlug('联盟'), 'alliance');
assert.equal(factionSlug(undefined), 'horde');
assert.equal(itemUrl(14047, 'horde'), 'https://www.wowauctions.net/auctionHouse/forever-eu/pvp-forever-eu/horde/x-14047');
assert.equal(professionUrl('tailoring', 'Alliance'), 'https://www.wowauctions.net/professions/forever-eu/pvp-forever-eu/alliance/tailoring');
assert.throws(() => nextData('<html>no data</html>'), /没有数据/);

// one item (Runecloth fixture: min 529, 30d median 658 -> 80%: "偏低" boundary; vendor sell 400 < min)
const item = fixture('wa-item-14047.json');
const t1 = itemMarketText(item.props.pageProps, { faction: 'horde', url: 'U', now: NOW });
assert.ok(t1.startsWith('Runecloth（item:14047） · 欧服 PvP 部落拍卖行'), t1);
assert.ok(t1.includes('60 分钟前扫描') || t1.includes('1 小时前扫描'), t1);
assert.ok(t1.includes('最低一口价 5银29铜') && t1.includes('在售 18185 个（360 条挂单）'), t1);
assert.ok(t1.includes('30 天中位数 6银58铜，区间 1银57铜–15银79铜') && t1.includes('7 天 -21.9%'), t1);
assert.ok(t1.includes('每天约卖出 51508 个') && t1.includes('非常好卖'), t1);
// wowauctions says available_from_vendor: true for Runecloth (it does for every item): never trusted
assert.equal(item.props.pageProps.item.item_info.available_from_vendor, true);
assert.ok(t1.includes('卖店价 4银（卖给商人得到的钱，不代表商人卖它）'), t1);
assert.ok(!t1.includes('商人有卖') && !t1.includes('商人也卖') && !t1.includes('商人卖得更便宜'), t1);
assert.ok(!t1.includes('商人不卖') && !t1.includes('商人卖不卖'), t1);   // not looked up: no vendor line at all
assert.ok(t1.includes('价格正常：最低价是 30 天中位数的 80%'), t1);   // 529/658 = 80.4%, just above the 80% line
assert.ok(t1.includes('有人在压价'), t1);          // quantity +84% in 7 days while price -21.9%
assert.ok(!t1.includes('捡漏·卖店'), t1);            // 529 > vendor 400
// below vendor + high
const pp2 = structuredClone(item.props.pageProps);
pp2.v2.row.min_buyout = 300; pp2.v2.row.stats.quantity_change_7d_pct = 0;
assert.ok(itemMarketText(pp2, { faction: 'horde', url: 'U', now: NOW }).includes('捡漏·卖店：最低挂单比卖店价低 1银/个'));
pp2.v2.row.min_buyout = 900;
assert.ok(itemMarketText(pp2, { faction: 'horde', url: 'U', now: NOW }).includes('偏高'));
// not on sale
const pp3 = structuredClone(item.props.pageProps); delete pp3.v2.row;
assert.ok(itemMarketText(pp3, { faction: 'alliance', url: 'U', now: NOW }).includes('最近的扫描里没有在售'));

// vendors: 无限图鉴 item_usage answers (trimmed fixture: Runecloth none, Rune Thread 61 vendors, Empty Vial 118, 20c / 5)
const wx = fixture('wx-item-usage-vendors.json');
assert.deepEqual(vendorFromUsage(wx[14047]), { sold: false, url: 'https://wuxianwow.com/item/14047' });
const rt = vendorFromUsage(wx[14341]);
assert.ok(rt.sold && rt.vendors === 61 && rt.unit === 5000 && rt.common, JSON.stringify(rt));
const vial = vendorFromUsage(wx[3371]);
assert.ok(vial.sold && vial.unit === 4 && vial.count === 5 && vial.copper === 20, JSON.stringify(vial));
// one Classic-data vendor (Felcloth: 维尔 in Winterspring, QuestieDB): sold, but not a common good
const felcloth = vendorFromUsage(wx[14256]);
assert.ok(felcloth.sold && !felcloth.common && felcloth.vendors === 1 && felcloth.classicOnly, JSON.stringify(felcloth));
assert.deepEqual(felcloth.who, ['维尔（冬泉谷）']);
assert.ok(!rt.classicOnly && !vial.classicOnly);
assert.equal(vendorFromUsage({ outcome: 'not_found' }), null);
assert.equal(vendorFromUsage(null), null);
// the item text with a vendor answer
const noVendor = itemMarketText(item.props.pageProps, { faction: 'horde', url: 'U', now: NOW, vendor: vendorFromUsage(wx[14047]) });
assert.ok(noVendor.includes('商人不卖：无限图鉴的商人货单里没有它（https://wuxianwow.com/item/14047）'), noVendor);
assert.ok(!noVendor.includes('商人有卖') && !noVendor.includes('商人卖得更便宜'), noVendor);
const unknown = itemMarketText(item.props.pageProps, { faction: 'horde', url: 'U', now: NOW, vendor: null });
assert.ok(unknown.includes('商人卖不卖：这次没查到，不能说商人有卖'), unknown);
const pv = structuredClone(item.props.pageProps);   // pretend the page is Rune Thread, listed above the vendor price
pv.item.item_info = { ...pv.item.item_info, entry: 14341, name: 'Rune Thread', SellPrice: 1250, BuyPrice: 5000 };
pv.v2.row.min_buyout = 5116;
const sold = itemMarketText(pv, { faction: 'horde', url: 'U', now: NOW, vendor: rt });
assert.ok(sold.includes('商人有卖，50银/个（客户端基础价，尊敬起打折），61 个商人有货（无限图鉴商人货单，临时数据：https://wuxianwow.com/item/14341）'), sold);
assert.ok(sold.includes('商人卖得更便宜（50银/个），别在拍卖行买'), sold);
assert.ok(itemMarketText(pv, { faction: 'horde', url: 'U', now: NOW, vendor: vial }).includes('20铜 / 5 个'));
const pf = structuredClone(pv);
pf.item.item_info = { ...pf.item.item_info, entry: 14256, name: 'Felcloth', SellPrice: 2000, BuyPrice: 8000 };
pf.v2.row.min_buyout = 8276;
const few = itemMarketText(pf, { faction: 'horde', url: 'U', now: NOW, vendor: felcloth });
assert.ok(few.includes('只有 1 个商人有：维尔（冬泉谷），客户端基础价 80银/个（可能限量或要声望；这条是经典旧世的数据，无限服没人核实过；'
  + '无限图鉴商人货单，临时数据：https://wuxianwow.com/item/14256），要多买还是看拍卖行'), few);
assert.ok(!few.includes('商人有卖') && !few.includes('商人卖得更便宜'), few);
// lookup failed, but it is a known trade supply: fallback list with the page's base price
const fb = itemMarketText(pv, { faction: 'horde', url: 'U', now: NOW, vendor: null });
assert.ok(fb.includes('商人有卖，50银/个（客户端基础价，尊敬起打折）（常见商人材料）') && fb.includes('商人卖得更便宜'), fb);
const pv3 = structuredClone(pv); delete pv3.v2.row;
const fb3 = itemMarketText(pv3, { faction: 'horde', url: 'U', now: NOW, vendor: rt });
assert.ok(fb3.includes('最近的扫描里没有在售') && fb3.includes('卖店价 12银50铜') && fb3.includes('商人有卖'), fb3);

// JSON-RPC answers: SSE and plain JSON, errors
const rpcText = (o) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
assert.equal(usageFromRpc('event: message\ndata: ' + rpcText(wx[14341]) + '\n\n').item_id, 14341);
assert.equal(usageFromRpc(rpcText(wx[3371])).item_id, 3371);
assert.throws(() => usageFromRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'bad' } })), /bad/);
assert.throws(() => usageFromRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } })));

// the lookup: one POST per id, parallel, cached; a failure is null and retried after 2 minutes
let posts = [];
let down = false;
const fakeWx = async (url, init) => {
  const body = JSON.parse(init.body);
  posts.push(body.params.arguments.item_id);
  assert.equal(url, 'https://wuxianwow.com/mcp');
  assert.equal(init.method, 'POST');
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'item_usage');
  if (down) return { status: 503, text: async () => '' };
  const id = body.params.arguments.item_id;
  return { status: 200, text: async () => 'data: ' + rpcText(wx[id] ?? { outcome: 'not_found' }) + '\n' };
};
const lookup = makeVendorLookup(fakeWx);
let m = await lookup([14047, 14341, 3371, 14341, 'x', 0], undefined, 1000);
assert.deepEqual(posts.sort(), [14047, 14341, 3371].sort());
assert.equal(m.get(14047).sold, false);
assert.equal(m.get(14341).sold, true);
posts = [];
m = await lookup([14341, 999], undefined, 2000);
assert.deepEqual(posts, [999], 'cached ids are not fetched again');
assert.equal(m.get(999), null);
down = true; posts = [];
m = await lookup([555], undefined, 3000);
assert.equal(m.get(555), null);
m = await lookup([555], undefined, 3000 + 60 * 1000);
assert.deepEqual(posts, [555], 'failure cached for 2 minutes');
await lookup([555], undefined, 3000 + 3 * 60 * 1000);
assert.deepEqual(posts, [555, 555], 'retried after 2 minutes');

// one profession (tailoring fixture: 40 candidates, including the profitable Mooncloth cooldown)
const prof = fixture('wa-tailoring.json');
const craftOpts = { faction: 'horde', url: 'U' };
const craftRows = (text) => text.split('\n').filter((line) => line.startsWith('- '));
const t2 = craftProfitText(prof.props.pageProps, craftOpts);
assert.ok(t2.startsWith('Tailoring 制作利润 · 欧服 PvP 部落') && t2.includes('已扣拍卖行 5% 手续费'), t2);
assert.ok(t2.includes('在销量最好的 40 个配方中筛掉有制作冷却的配方'), t2);
const rows = craftRows(t2);
assert.equal(rows.length, 10, t2);
assert.match(rows[0], /^- Robe of Winter Night/);
assert.match(rows[9], /^- Mageweave Reagent Bag/);
assert.ok(!rows.some((line) => line.startsWith('- Mooncloth（')), t2);
assert.ok(rows.some((line) => line.startsWith('- Mooncloth Reagent Bag（') && line.includes('Mooncloth（item:14342）×')), t2);
assert.ok(rows.every((l) => /利润 \d/.test(l) && /item:\d+/.test(l)), t2);   // only profitable ones, with ids
assert.ok(rows.every((l) => /材料：.+（item:\d+）×\d+/.test(l)), t2);   // material ids, for the shopping-list line
assert.ok(t2.includes('Rune Thread（item:14341）×1（拍卖 51银16铜·商人有卖）'), t2);   // fallback list when not looked up
assert.ok(!/Mooncloth（item:14342）[^、]*·商人/.test(t2), t2);
assert.ok(!t2.includes('商人货单'), t2);   // no vendor lookup given: no source line
// with the vendor lookup: what 无限图鉴 says wins over the fallback list
const ids = shownReagentIds(prof.props.pageProps);
assert.ok(ids.includes(14341) && ids.length > 3 && new Set(ids).size === ids.length, String(ids));
const vmap = new Map(ids.map((id) => [id, { sold: false, url: 'W' }]));
vmap.set(14341, rt);
vmap.set(14256, felcloth);
const t2v = craftProfitText(prof.props.pageProps, { ...craftOpts, vendors: vmap });
assert.ok(t2v.includes('Rune Thread（item:14341）×1（拍卖 51银16铜·商人有卖 50银）'), t2v);
assert.equal((t2v.match(/商人有卖 /g) ?? []).length, (t2v.match(/item:14341）×/g) ?? []).length, t2v);   // only Rune Thread
assert.ok(t2v.includes('来自无限图鉴 wuxianwow.com 的商人货单'), t2v);
assert.match(t2v, /Felcloth（item:14256）×\d+（拍卖 80银32铜·少数商人有：维尔（冬泉谷））/);   // stays an AH material
vmap.set(14341, { sold: false, url: 'W' });   // 无限图鉴 says no: the fallback list does not override it
assert.ok(!craftProfitText(prof.props.pageProps, { ...craftOpts, vendors: vmap }).includes('item:14341）×1（拍卖 51银16铜·商人有卖'));
vmap.set(14341, null);                        // lookup failed for it: the fallback list answers
assert.ok(craftProfitText(prof.props.pageProps, { ...craftOpts, vendors: vmap }).includes('item:14341）×1（拍卖 51银16铜·商人有卖）'));
assert.ok(t2.includes('Loom（item:') || t2.includes('Wisdom of the Timbermaw'), t2);
assert.throws(() => craftProfitText({}, { faction: 'horde', url: 'U' }), /没有配方数据/);

// The transmute and smelting can make the same item. Only the cooling-down spell is excluded.
const smelt = { spell_id: 3308, output: { name: 'Gold Bar', item_id: 3577 }, profit: 100, reagents: [{ item_id: 2776 }] };
const transmute = { ...smelt, spell_id: '11479', profit: 200, reagents: [{ item_id: 3575 }] };
const small = { initial: { recipes: [transmute, smelt] } };
assert.deepEqual(shownReagentIds(small), [2776]);
assert.equal(craftRows(craftProfitText(small, craftOpts)).length, 1);
const noEligibleRecipes = { initial: { recipes: [transmute, { ...smelt, profit: 0 }] } };
assert.deepEqual(shownReagentIds(noEligibleRecipes), []);
assert.match(craftProfitText(noEligibleRecipes, craftOpts), /没有符合条件的盈利配方/);

// fetcher: cache, status errors
let calls = 0;
const fake = async (url) => { calls++; return { status: url.includes('missing') ? 404 : url.includes('busy') ? 503 : 200, text: async () => asHtml(item) }; };
const load = makeFetcher(fake);
await load('https://x/a', undefined, 1000);
await load('https://x/a', undefined, 1000 + 10 * 60 * 1000);
assert.equal(calls, 1, 'cached within 30 minutes');
await load('https://x/a', undefined, 1000 + 31 * 60 * 1000);
assert.equal(calls, 2, 'refetched after 30 minutes');
await assert.rejects(load('https://x/missing'), /找不到/);
await assert.rejects(load('https://x/busy'), /HTTP 503/);

// the tools: the item tool asks for its id, the profession tool for the shown reagents; a lookup failure is "unknown"
const asked = [];
const [itemTool, craftTool] = tools(async (url) => (url.includes('/professions/') ? prof.props.pageProps : item.props.pageProps),
  async (wanted) => { asked.push([...wanted]); return new Map(wanted.filter((id) => wx[id]).map((id) => [id, vendorFromUsage(wx[id])])); });
const out1 = await itemTool.execute({ itemId: 14047 }, {});
assert.deepEqual(asked[0], [14047]);
assert.ok(out1.includes('商人不卖') && !out1.includes('商人有卖'), out1);
const out2 = await craftTool.execute({ profession: '裁缝' }, {});
assert.deepEqual(asked[1], ids);
assert.equal(craftRows(out2).length, 10);
assert.ok(out2.includes('·商人有卖 50银'), out2);
const [itemTool2] = tools(async () => item.props.pageProps);   // default: nothing looked up -> unknown
assert.ok((await itemTool2.execute({ itemId: 14047 }, {})).includes('商人卖不卖：这次没查到'));

// ---- wow_flip_market: Forever AH (dsh-web/foreverah.js) and the fixed list (dsh-web/watchlist.js) ----
const fa = fixture('fa-flip.json');
const FA_NOW = Date.parse('2026-11-28T10:10:56Z');   // 49 minutes after the fixture snapshot
// the list: generated, at most one market request, no duplicates
assert.ok(WATCH_IDS.length >= 40 && WATCH_IDS.length <= IDS_MAX && new Set(WATCH_IDS).size === WATCH_IDS.length, String(WATCH_IDS.length));
assert.ok(WATCH_IDS.every((id) => Number.isInteger(id) && id > 0) && WATCHLIST.every(([, n]) => typeof n === 'string' && n));
assert.match(WATCHLIST_DATE, /^\d{4}-\d\d-\d\d$/);
assert.ok(WATCH_IDS.includes(14047) && WATCH_IDS.includes(8170), 'Runecloth and Rugged Leather are on it');
// houses: ruleset + faction -> Blizzard house id -> the API's house_key; never the pooled "All Auction Houses"
assert.equal(houseKey(fa.houses, 'eu', 'pvp', 'horde'), 21);
assert.equal(houseKey(fa.houses, 'eu', 'pvp', 'alliance'), 18);
assert.equal(houseKey(fa.houses, 'eu', 'pve', 'horde'), 22);
assert.deepEqual(HOUSE_IDS['rp-pvp'], { alliance: 123, horde: 124 });
assert.throws(() => houseKey(fa.houses, 'us', 'pvp', 'horde'), /找不到/);      // region not in the list
assert.throws(() => houseKey(fa.houses, 'eu', 'hardcore', 'horde'), /找不到/);
assert.throws(() => houseKey(null, 'eu', 'pvp', 'horde'), /找不到/);
assert.equal(watchUrl(21, [1, 2]), 'https://forever-ah.com/v1/houses/21/market?ids=1%2C2&window=24&limit=100');
assert.equal(auctionsUrl(21, 4306), 'https://forever-ah.com/v1/houses/21/items/4306/auctions');
// one row: sell 5% under the reference, pay the 5% cut; buy against the lower value, sell against the higher one
assert.equal(netOf(1000), 902);
const row = (id, min, more = {}, st = {}) => ({ item: { item_id: id, name: 'Item ' + id }, current: { min_unit: min, p10_unit: min, quantity: 500, ...more },
  stats: { market_value: 1000, historical_value: 1200, trend_pct: 0, days_seen: 14, sold_per_day: 100, ...st } });
const a1 = assess(row(1, 600));
assert.ok(a1.buyRef === 1000 && a1.sellRef === 1200 && a1.net === 902 && a1.ceiling === 693, JSON.stringify(a1));   // 902 / 1.3
assert.ok(Math.abs(a1.roi - (902 / 600 - 1)) < 1e-9 && Math.abs(a1.premium - (600 / 1200 - 1)) < 1e-9);
assert.equal(assess(row(1, 600, {}, { historical_value: 0 })).sellRef, 1000);   // no long-run value yet: the market value
assert.equal(assess(row(1, 600, {}, { sold_per_day: 19 })), null);
assert.equal(assess(row(1, 600, {}, { days_seen: 6 })), null);
assert.equal(assess(row(1, undefined)), null);                                   // not listed right now
assert.equal(assess({ item: { item_id: 1, name: null }, current: { min_unit: 5 }, stats: {} }), null);
// ranking: buys by return without falling items, sells by premium
const made = { as_of: '2026-11-28T09:21:56Z', rows: [row(1, 600), row(2, 680), row(3, 900), row(4, 500, {}, { trend_pct: -10 }), row(5, 1500), row(6, 1300),
  row(7, 400, {}, { sold_per_day: 5 })] };
const rk = rank(made);
assert.deepEqual(rk.buys.map((a) => a.id), [1, 2, 3, 6, 5]);
assert.deepEqual(rk.wait.map((a) => a.id), [4]);
assert.deepEqual(rk.sells.slice(0, 2).map((a) => a.id), [5, 6]);
assert.equal(rk.judged.length, 6);
assert.deepEqual(ladderIds(made), [1, 2]);            // +50% and +33% at their lowest price
assert.deepEqual(rank(null), { judged: [], buys: [], sells: [], wait: [] });
// the cheap end of the auctions (a1 sells 100 a day: a lot holds at most 50 units)
const lad = (...rows) => ({ rows: rows.map(([unit, quantity, count = 1]) => ({ unit_buyout: unit, quantity, count, buyout: unit * quantity })) });
assert.equal(lotCap(a1), 50);
// 50 units up to 6s40c, then 9s90c: resold under 9s89c -> 9s39c -> nets 8s92c
const lot1 = lotFromLadder(lad([640, 20, 2], [990, 100], [600, 10]), a1);
assert.ok(lot1.units === 50 && lot1.low === 600 && lot1.high === 640 && lot1.next === 990 && lot1.sell === 939, JSON.stringify(lot1));
assert.ok(lot1.cost === 31600 && lot1.profit === 13000 && !lot1.near && lot1.ceiling === 686, JSON.stringify(lot1));   // +41% over the lot
// buying only the cheapest leaves the next ones to undercut the resale: 6s then 6s50c then 6s90c x400 -> nothing
assert.equal(lotFromLadder(lad([600, 10], [650, 5], [690, 400], [2000, 1]), a1), null);
assert.equal(lotFromLadder(lad([600, 10], [700, 50]), a1), null);                       // resold under 7s: +5%
const lotNear = lotFromLadder(lad([680, 30], [1100, 5]), a1);                           // 902 / 680 = +32.6%
assert.ok(lotNear.near && lotNear.ceiling === 693 && lotNear.units === 30 && lotNear.profit === 6660, JSON.stringify(lotNear));
const lotAll = lotFromLadder(lad([600, 10]), a1);                                       // nothing left standing: the reference
assert.ok(lotAll.units === 10 && lotAll.next === undefined && lotAll.sell === 950 && lotAll.profit === 3020, JSON.stringify(lotAll));
// more cheap units than half a day of sales: this is the price now, not a find
const deep = lad([600, 200, 3], [1500, 1]);
assert.equal(lotFromLadder(deep, a1), null);
assert.equal(cheapUnits(deep, a1), 600);
assert.equal(lotFromLadder({ rows: [] }, a1), null);
assert.equal(lotFromLadder(null, a1), null);
// the text on made-up rows: a real lot, an unread one, the rest by distance
const ladders = new Map([[1, lad([600, 10], [640, 20, 2], [990, 100])], [2, null]]);
const madeText = flipMarketText({ market: made, ladders, listed: 80, listDate: '2026-11-28', faction: 'horde', now: FA_NOW });
const madeRows = madeText.split('\n');
assert.ok(madeRows[0].startsWith('买卖行情 · 欧服 PvP 部落拍卖行（Forever AH forever-ah.com，数据来自暴雪 Battle.net API，49 分钟前的快照）'), madeRows[0]);
assert.ok(madeRows[1].includes('固定清单里的 80 种大交易量常见物品（2026-11-28 按全区日成交额选的），这次 6 种有足够的数据'), madeRows[1]);
assert.ok(madeText.includes('【现在最值得买】达标 1 种，接近 1 种：'), madeText);
assert.ok(madeText.includes('- Item 1（item:1）【达标】：一口价 6银–6银40铜/个 的共 50 个，下一档 9银90铜；入手上限 6银86铜，预期卖 9银39铜，预计净利 +41%；全买下约花 3金16银，预计赚 1金30银；日销约 100'), madeText);
assert.ok(madeText.includes('- Item 2（item:2）【接近】：最低 6银80铜，入手上限 6银93铜，按最低价算净利 +33%（这次没读到挂单明细'), madeText);
assert.ok(madeText.includes('- Item 3（item:3）：最低 9银，入手上限 6银93铜（还要再跌 23%），市场价 10银，在售 500 个，日销约 100，市场价趋势 0%'), madeText);
assert.ok(madeText.includes('【现在最值得卖】（手里有货的话）值得卖的有 1 种：'), madeText);
assert.ok(madeText.includes('- Item 5（item:5）【值得卖】：最低 15银，比市场价 12银 高 25%；挂 14银99铜 左右，卖出到手约 14银24铜/个；在售 500 个，日销约 100'), madeText);
assert.ok(madeText.includes('- Item 6（item:6）：最低 13银，比市场价 12银 高 8%'), madeText);
assert.ok(madeText.includes('先别买（便宜，但市场价在跌）：Item 4（item:4，市场价趋势 -10%）'), madeText);
assert.ok(madeText.indexOf('Item 1（') < madeText.indexOf('Item 2（') && madeText.indexOf('Item 2（') < madeText.indexOf('Item 3（'));
// read, but no lot behind the lowest price: a stray auction, and a pile too big to clear
const strayText = flipMarketText({ market: made, ladders: new Map([[1, lad([600, 1], [700, 50])], [2, lad([680, 300], [1100, 9])]]), listed: 80, faction: 'horde', now: FA_NOW });
assert.ok(strayText.includes('达标 0 种，接近 0 种：清单里现在没有到入手价的'), strayText);
assert.ok(strayText.includes('- Item 1（item:1）：最低 6银，但只是零星低价单，买下后只能贴着下一档卖，没有赚头；入手上限 6银93铜，市场价 10银'), strayText);
assert.ok(strayText.includes('- Item 2（item:2）：最低 6银80铜，但不高于入手上限的货有 300 个，比半天的销量还多'), strayText);
// the text on the saved answers: nothing reaches the ceiling, five stand high
const flip = flipMarketText({ market: fa.market, listed: WATCH_IDS.length, listDate: WATCHLIST_DATE, faction: 'horde', now: FA_NOW });
assert.ok(flip.includes('这次 14 种有足够的数据') && flip.includes('达标 0 种，接近 0 种：清单里现在没有到入手价的'), flip);
assert.ok(flip.includes('- Thick Leather（item:4304）：最低 5银99铜，入手上限 4银87铜（还要再跌 19%），市场价 7银33铜，在售 10809 个，日销约 38422，市场价趋势 +13%'), flip);
assert.ok(flip.includes('值得卖的有 5 种') && flip.includes('- Gromsblood（item:8846）【值得卖】：最低 89银99铜，比市场价 30银18铜 高 198%；挂 89银98铜 左右，卖出到手约 85银48铜/个；在售 230 个'), flip);
assert.ok(flip.includes('先别买（便宜，但市场价在跌）：Illusion Dust（item:16204，市场价趋势 -49%）'), flip);
assert.ok(!/最值得买】[\s\S]*Arcanite Bar[\s\S]*【现在最值得卖】/.test(flip), 'an item whose market value is falling is not a buy');
assert.ok(flip.includes('先在拍卖行核实价格和数量') && flip.includes('买和卖都由玩家自己点') && flip.endsWith('https://forever-ah.com/'), flip);
assert.ok(!flip.includes('注意：这份快照'), flip);
assert.equal(lotFromLadder(fa.auctions, assess(fa.market.rows.find((r) => r.item.item_id === 4306))), null);   // Silk Cloth: 1s90c against 1s99c
const stale = flipMarketText({ market: fa.market, listed: 80, faction: 'alliance', server: '美服 PvE', now: FA_NOW + 5 * 3600 * 1000 });
assert.ok(stale.startsWith('买卖行情 · 美服 PvE 联盟拍卖行') && stale.includes('5.8 小时前的快照') && stale.includes('注意：这份快照已经是5.8 小时前的'), stale);
const empty = flipMarketText({ market: { rows: [], as_of: fa.market.as_of }, listed: 80, faction: 'horde', now: FA_NOW });
assert.ok(empty.includes('这次没有读到清单里物品的数据') && empty.includes('这次 0 种有足够的数据'), empty);
// the item links of an answer come from the listed rows (lib/answer.mjs), for both lists
const flipItems = new Map();
collectCraftItems(flipItems, flip);
assert.equal(flipItems.get('thick leather').id, '4304');
assert.equal(flipItems.get('gromsblood').id, '8846');
assert.equal(linkCraftItems('先看 Gromsblood。', flipItems), '先看 {{item:8846|Gromsblood}}。');
// the API reader: cached 10 minutes (the house list 12 hours), one request at a time, errors in Chinese
let apiCalls = [];
let apiMarket = fa.market;
const fakeApi = async (url, init) => {
  apiCalls.push(url);
  assert.equal(init.headers.accept, 'application/json');
  assert.ok(init.headers['user-agent'].includes('dsh-wow-bridge'));
  if (url.includes('/busy')) return { status: 429, text: async () => '{"error":"slow down"}' };
  if (url.includes('/down')) return { status: 503, text: async () => '' };
  if (url.includes('/html')) return { status: 200, text: async () => '<html>' };
  const body = url === housesUrl() ? fa.houses : url.includes('/auctions') ? lad([600, 10], [640, 20, 2], [990, 100]) : url.includes('ids=') ? apiMarket : {};
  return { status: 200, text: async () => JSON.stringify(body) };
};
const api = makeApi(fakeApi, { gapMs: 0 });
const wUrl = watchUrl(21, WATCH_IDS);
assert.equal((await api(wUrl, undefined, 1000)).rows.length, fa.market.rows.length);
await api(wUrl, undefined, 1000 + 9 * 60 * 1000);
assert.equal(apiCalls.length, 1, 'cached within 10 minutes');
await api(wUrl, undefined, 1000 + 11 * 60 * 1000);
assert.equal(apiCalls.length, 2, 'read again after 10 minutes');
await api(housesUrl(), undefined, 1000);
await api(housesUrl(), undefined, 1000 + 11 * 3600 * 1000);
assert.equal(apiCalls.length, 3, 'the house list is kept 12 hours');
await assert.rejects(api('https://forever-ah.com/v1/busy'), /太频繁/);
await assert.rejects(api('https://forever-ah.com/v1/down'), /HTTP 503/);
await assert.rejects(api('https://forever-ah.com/v1/html'), /不是 JSON/);
const spaced = makeApi(fakeApi, { gapMs: 60 });
const tSpaced = Date.now();
await Promise.all([spaced('https://forever-ah.com/v1/a'), spaced('https://forever-ah.com/v1/b'), spaced('https://forever-ah.com/v1/c')]);
assert.ok(Date.now() - tSpaced >= 110, 'three requests are 60 ms apart, took ' + (Date.now() - tSpaced) + ' ms');
// the tool: the house list, one market request for the whole list; auctions only for buys that reach 30%
apiCalls = [];
const flipTool = tools(async () => item.props.pageProps, undefined, makeApi(fakeApi, { gapMs: 0 }))[2];
assert.equal(flipTool.name, 'wow_flip_market');
const out3 = await flipTool.execute({}, {});
assert.deepEqual(apiCalls, [housesUrl(), wUrl], 'nothing reaches 30%: no auctions read');
assert.ok(out3.includes('部落拍卖行') && out3.includes('固定清单里的 ' + WATCH_IDS.length + ' 种') && out3.includes('Gromsblood（item:8846）【值得卖】'), out3);
apiCalls = [];
apiMarket = made;
const outA = await flipTool.execute({ faction: 'alliance' }, {});   // another house; the house list comes from the cache
assert.deepEqual(apiCalls, [watchUrl(18, WATCH_IDS), auctionsUrl(18, 1), auctionsUrl(18, 2)]);
assert.ok(outA.includes('联盟拍卖行') && outA.includes('达标 2 种') && outA.includes('Item 1（item:1）【达标】：一口价 6银–6银40铜/个 的共 50 个'), outA);   // the fake ladder answers for both
// an auctions request failing does not fail the answer: the item is listed as unread
const noLadder = async (url, init) => (url.includes('/auctions') ? { status: 503, text: async () => '' } : fakeApi(url, init));
const out4 = await tools(async () => item.props.pageProps, undefined, makeApi(noLadder, { gapMs: 0 }))[2].execute({}, {});
assert.ok(out4.includes('Item 1（item:1）【达标】：最低 6银，入手上限 6银93铜，按最低价算净利 +50%（这次没读到挂单明细'), out4);
apiMarket = fa.market;
// not connected (the default): a clear error, not a crash
await assert.rejects(tools(async () => item.props.pageProps)[2].execute({}, {}), /Forever AH/);

// ---- when to buy and sell: hour patterns from the hourly history (dsh-web/markettimes.js) ----
// made-up history: 2s cheaper at 02-04 UTC, dearer at 19-21 UTC, prices drifting up 1% a day (the trend must not matter)
const HOUR = 3600 * 1000, T0 = Date.parse('2026-11-01T00:30:00Z');   // a Sunday
const history = (days, shape = (h) => (h >= 2 && h <= 4 ? 0.9 : h >= 19 && h <= 21 ? 1.1 : 1), drift = 0.01) => {
  const points = [];
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    points.push({ ts: new Date(T0 + (d * 24 + h) * HOUR).toISOString(), p10_unit: Math.round(1000 * (1 + drift * d) * shape(h, d)), min_unit: 1 });
  }
  return points;
};
assert.ok(historyUrl(21, 4306, Date.parse('2026-11-28T10:00:00Z')).startsWith('https://forever-ah.com/v1/houses/21/items/4306/history?resolution=hour&from=2026-10-29T10%3A00%3A00.000Z&to=2026-11-28T10'));
const hourProf = timeProfile(history(14), 'UTC');
assert.ok(hourProf.days === 14 && hourProf.cheap.start === 2 && hourProf.dear.start === 19, JSON.stringify(hourProf));
assert.ok(hourProf.hours[3] === 0.9 && hourProf.hours[20] === 1.1 && hourProf.hours[12] === 1, JSON.stringify(hourProf.hours));
assert.ok(Math.abs(hourProf.swing - (1.1 / 0.9 - 1)) < 0.002 && hourProf.held === 14 && hourProf.both === 14 && hourProf.weekdays === null, JSON.stringify(hourProf));
assert.ok(steady(hourProf));
assert.equal(timeProfile(history(14), 'Asia/Shanghai').cheap.start, 10);            // the same hours on a clock 8 hours ahead
assert.equal(timeProfile(history(6), 'UTC'), null);                                  // under a week
assert.equal(timeProfile(history(14).filter((_, i) => i % 3 === 0), 'UTC'), null);   // 8 points a day: no day counts
assert.equal(timeProfile(null, 'UTC'), null);
const flatProf = timeProfile(history(14, () => 1), 'UTC');
assert.ok(flatProf.swing === 0 && !steady(flatProf), JSON.stringify(flatProf));
// one spike does not make an hour dear (the median over the days)
const spiky = timeProfile(history(14, (h, d) => (h === 12 && d === 3 ? 5 : 1)), 'UTC');
assert.equal(spiky.hours[12], 1);
// weekdays need three of each: 21 days, Saturdays 20% dearer (no drift)
const weekly = timeProfile(history(21, (h, d) => (new Date(T0 + d * 24 * HOUR).getUTCDay() === 6 ? 1.2 : 1), 0), 'UTC');
assert.ok(weekly.weekdays && weekly.weekdays[5] === 1.2 && weekly.weekdays[0] === 1, JSON.stringify(weekly.weekdays));
assert.ok(Math.abs(SWING_FOR_FLIP - 0.4404) < 0.001);
// a run over the list: failed and thin items are skipped, nothing read at all is an error
const histApi = async (url) => {
  const id = Number(/items\/(\d+)\/history/.exec(url)?.[1]);
  if (id === 2) throw new Error('HTTP 503');
  return { item: { item_id: id, name: 'Item ' + id }, points: id === 3 ? history(3) : id === 4 ? history(14, () => 1) : history(14) };
};
const tStats = await collectTimes(histApi, 21, [1, 2, 3, 4], { timeZone: 'UTC', now: T0 + 15 * 24 * HOUR });
assert.ok(tStats.items.length === 2 && tStats.failed === 1 && tStats.thin === 1 && tStats.asked === 4 && tStats.days === 14 && tStats.key === 21, JSON.stringify({ ...tStats, items: 0 }));
await assert.rejects(collectTimes(histApi, 21, [2], { timeZone: 'UTC' }), /读不到/);
await assert.rejects(collectTimes(histApi, 21, [3], { timeZone: 'UTC' }), /不够一周/);
const allItems = overall(tStats.items);
assert.ok(allItems.cheap.start === 2 && allItems.dear.start === 19 && allItems.weekdays === null, JSON.stringify(allItems));
// the text
const tText = timesText({ stats: tStats, faction: 'horde', now: T0 + 15 * 24 * HOUR + 3 * HOUR });
assert.ok(tText.startsWith('买卖时段统计 · 欧服 PvP 部落拍卖行（Forever AH forever-ah.com 的逐小时快照') && tText.includes('清单里 2 种物品、近 14 天；时间是这台电脑的时区 UTC；3 小时前算的'), tText);
assert.ok(tText.includes('整体：一天里 02–05 点最便宜（比当天中位价 -5%），19–22 点最贵（+5%）'), tText);
assert.ok(tText.includes('有 1 种：') && tText.includes('- Item 1（item:1）：02–05 点最便宜（-10%），19–22 点最贵（+10%），日内价差约 22%，14 天里 14 天成立'), tText);
assert.ok(!tText.includes('Item 4') && tText.includes('星期：现在只有 14 天的数据') && tText.includes('这次没有哪种到这个水平'), tText);
assert.ok(timesText({ stats: tStats, faction: 'alliance', note: 'NOTE' }).split('\n')[1] === 'NOTE');
const bigSwing = { ...tStats, items: [{ ...tStats.items[0], swing: 0.5 }] };
assert.ok(timesText({ stats: bigSwing, faction: 'horde' }).includes('【价差够倒卖】') && timesText({ stats: bigSwing, faction: 'horde' }).includes('这次有 1 种到了这个水平'));
// the stored file: one entry per auction house
const tmpTimes = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-times-'));
assert.equal(readTimes(tmpTimes, 21), null);
writeTimes(tmpTimes, 21, tStats);
writeTimes(tmpTimes, 18, { ...tStats, key: 18 });
assert.equal(readTimes(tmpTimes, 21).items.length, 2);
assert.equal(readTimes(tmpTimes, 18).key, 18);
assert.equal(readTimes(tmpTimes, 22), null);
assert.deepEqual(fs.readdirSync(tmpTimes), [TIMES_FILE]);
// runs: one at a time per house, the result lands in the file
let histCalls = 0;
const countingApi = async (url, signal) => { if (url.includes('/history')) histCalls++; return url === housesUrl() ? fa.houses : histApi(url, signal); };
const timesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-times-'));
const timeLogs = [];
const times = makeTimes(countingApi, { dataDir: () => timesDir, ids: [1, 4], log: (m) => timeLogs.push(m) });
assert.ok(!times.fresh(null) && !times.busy(21) && times.read(21) === null);
const run1 = times.refresh(21), run2 = times.refresh(21);
assert.ok(run1 === run2 && times.busy(21));
assert.equal((await run1).items.length, 2);
await new Promise((r) => setImmediate(r));
assert.ok(histCalls === 2 && !times.busy(21) && times.fresh(times.read(21)) && timeLogs.some((l) => l.includes('买卖时段统计：2 种物品')), String(timeLogs));
assert.ok(!times.fresh({ ...times.read(21), builtAt: new Date(Date.now() - FRESH_MS - 1000).toISOString() }));
// a failing run is logged, not thrown into the void
const badTimes = makeTimes(async () => { throw new Error('down'); }, { dataDir: () => timesDir, ids: [1], log: (m) => timeLogs.push(m) });
await assert.rejects(badTimes.refresh(5), /读不到/);
await new Promise((r) => setImmediate(r));
assert.ok(timeLogs.some((l) => l.includes('买卖时段统计失败')), String(timeLogs));
// the tool, view = times: fresh file -> the text, no requests; nothing yet -> starts a run and says so; wait -> the new text
histCalls = 0;
const timesTool = tools(async () => item.props.pageProps, undefined, countingApi, times)[2];
const tt1 = await timesTool.execute({ view: 'times' }, {});
assert.ok(tt1.startsWith('买卖时段统计 · 欧服 PvP 部落拍卖行') && histCalls === 0, tt1);
const tt2 = await timesTool.execute({ view: 'times', faction: 'alliance' }, {});   // house 18: nothing stored
assert.ok(tt2.includes('买卖时段统计还没有算过') && tt2.includes('两分钟后再问'), tt2);
assert.ok(times.busy(18));
const tt3 = await timesTool.execute({ view: 'TIMES', faction: 'alliance', wait: true }, {});   // joins the run that is going
assert.ok(tt3.startsWith('买卖时段统计 · 欧服 PvP 联盟拍卖行') && histCalls === 2, tt3);
// an old file: its text with a note, and a run in the background
writeTimes(timesDir, 21, { ...times.read(21), builtAt: new Date(Date.now() - FRESH_MS - 60000).toISOString() });
const tt4 = await timesTool.execute({ view: 'times' }, {});
assert.ok(tt4.includes('这份统计有点旧了，正在后台重新算') && tt4.includes('Item 1（item:1）'), tt4);
await times.refresh(21);
await new Promise((r) => setImmediate(r));
assert.ok(times.fresh(times.read(21)));
await assert.rejects(tools(async () => item.props.pageProps, undefined, countingApi)[2].execute({ view: 'times' }, {}), /时段统计没有接上/);
assert.equal(timesTool.timeoutMs, 240000);
fs.rmSync(tmpTimes, { recursive: true, force: true });
fs.rmSync(timesDir, { recursive: true, force: true });

console.log('market_offline: ok');
console.log('\n--- sample item output ---\n' + t1 + '\n\n--- sample profession output ---\n' + t2 + '\n\n--- sample flip output ---\n' + flip);
