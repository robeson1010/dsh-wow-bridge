// node test/market_offline.mjs: the wowauctions reader (dsh-web/wowauctions.js) against saved page data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coins, professionSlug, factionSlug, nextData, itemMarketText, craftProfitText, shownReagentIds, makeFetcher, itemUrl, professionUrl,
} from '../dsh-web/wowauctions.js';
import { vendorFromUsage, usageFromRpc, makeVendorLookup } from '../dsh-web/vendors.js';
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

// one profession (tailoring fixture: 470 recipes, 104 profitable, 40 shown)
const prof = fixture('wa-tailoring.json');
const t2 = craftProfitText(prof.props.pageProps, { faction: 'horde', url: 'U', limit: 5, now: NOW });
assert.ok(t2.startsWith('Tailoring 制作利润 · 欧服 PvP 部落') && t2.includes('已扣拍卖行 5% 手续费'), t2);
assert.ok(t2.includes('共 470 个配方，104 个赚钱；这里看的是销量最好的 40 个'), t2);
const rows = t2.split('\n').filter((l) => l.startsWith('- '));
assert.equal(rows.length, 5, t2);
assert.ok(rows.every((l) => /利润 \d/.test(l) && /item:\d+/.test(l)), t2);   // only profitable ones, with ids
assert.ok(rows.every((l) => /材料：.+（item:\d+）×\d+/.test(l)), t2);   // material ids, for the shopping-list line
assert.ok(t2.includes('Rune Thread（item:14341）×1（拍卖 51银16铜·商人有卖）'), t2);   // fallback list when not looked up
assert.ok(!/Mooncloth（item:14342）[^、]*·商人/.test(t2), t2);
assert.ok(!t2.includes('商人货单'), t2);   // no vendor lookup given: no source line
// with the vendor lookup: what 无限图鉴 says wins over the fallback list
const ids = shownReagentIds(prof.props.pageProps, 5);
assert.ok(ids.includes(14341) && ids.length > 3 && new Set(ids).size === ids.length, String(ids));
const vmap = new Map(ids.map((id) => [id, { sold: false, url: 'W' }]));
vmap.set(14341, rt);
vmap.set(14256, felcloth);
const t2v = craftProfitText(prof.props.pageProps, { faction: 'horde', url: 'U', limit: 5, now: NOW, vendors: vmap });
assert.ok(t2v.includes('Rune Thread（item:14341）×1（拍卖 51银16铜·商人有卖 50银）'), t2v);
assert.equal((t2v.match(/商人有卖 /g) ?? []).length, (t2v.match(/item:14341）×/g) ?? []).length, t2v);   // only Rune Thread
assert.ok(t2v.includes('来自无限图鉴 wuxianwow.com 的商人货单'), t2v);
assert.ok(t2v.includes('Felcloth（item:14256）×2（拍卖 80银32铜·少数商人有：维尔（冬泉谷））'), t2v);   // stays an AH material
vmap.set(14341, { sold: false, url: 'W' });   // 无限图鉴 says no: the fallback list does not override it
assert.ok(!craftProfitText(prof.props.pageProps, { faction: 'horde', url: 'U', limit: 5, now: NOW, vendors: vmap }).includes('·商人有卖'));
vmap.set(14341, null);                        // lookup failed for it: the fallback list answers
assert.ok(craftProfitText(prof.props.pageProps, { faction: 'horde', url: 'U', limit: 5, now: NOW, vendors: vmap }).includes('·商人有卖）'));
assert.ok(t2.includes('Loom（item:') || t2.includes('Wisdom of the Timbermaw'), t2);
assert.throws(() => craftProfitText({}, { faction: 'horde', url: 'U' }), /没有配方数据/);

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
const out2 = await craftTool.execute({ profession: '裁缝', limit: 5 }, {});
assert.deepEqual(asked[1], ids);
assert.ok(out2.includes('·商人有卖 50银'), out2);
const [itemTool2] = tools(async () => item.props.pageProps);   // default: nothing looked up -> unknown
assert.ok((await itemTool2.execute({ itemId: 14047 }, {})).includes('商人卖不卖：这次没查到'));

console.log('market_offline: ok');
console.log('\n--- sample item output ---\n' + t1 + '\n\n--- sample profession output ---\n' + t2);
