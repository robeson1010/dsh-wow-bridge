// node test/market_offline.mjs: the wowauctions reader (dsh-web/wowauctions.js) against saved page data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coins, professionSlug, factionSlug, nextData, itemMarketText, craftProfitText, makeFetcher, itemUrl, professionUrl,
} from '../dsh-web/wowauctions.js';

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
assert.ok(t1.includes('商店收购价 4银') && t1.includes('商人也卖，16银'), t1);
assert.ok(t1.includes('价格正常：最低价是 30 天中位数的 80%'), t1);   // 529/658 = 80.4%, just above the 80% line
assert.ok(t1.includes('有人在压价'), t1);          // quantity +84% in 7 days while price -21.9%
assert.ok(!t1.includes('捡漏·卖店'), t1);            // 529 > vendor 400
// below vendor + high
const pp2 = structuredClone(item.props.pageProps);
pp2.v2.row.min_buyout = 300; pp2.v2.row.stats.quantity_change_7d_pct = 0;
assert.ok(itemMarketText(pp2, { faction: 'horde', url: 'U', now: NOW }).includes('捡漏·卖店：最低挂单比商店收购价低 1银/个'));
pp2.v2.row.min_buyout = 900;
assert.ok(itemMarketText(pp2, { faction: 'horde', url: 'U', now: NOW }).includes('偏高'));
// not on sale
const pp3 = structuredClone(item.props.pageProps); delete pp3.v2.row;
assert.ok(itemMarketText(pp3, { faction: 'alliance', url: 'U', now: NOW }).includes('最近的扫描里没有在售'));

// one profession (tailoring fixture: 470 recipes, 104 profitable, 40 shown)
const prof = fixture('wa-tailoring.json');
const t2 = craftProfitText(prof.props.pageProps, { faction: 'horde', url: 'U', limit: 5, now: NOW });
assert.ok(t2.startsWith('Tailoring 制作利润 · 欧服 PvP 部落') && t2.includes('已扣拍卖行 5% 手续费'), t2);
assert.ok(t2.includes('共 470 个配方，104 个赚钱；这里看的是销量最好的 40 个'), t2);
const rows = t2.split('\n').filter((l) => l.startsWith('- '));
assert.equal(rows.length, 5, t2);
assert.ok(rows.every((l) => /利润 \d/.test(l) && /item:\d+/.test(l)), t2);   // only profitable ones, with ids
assert.ok(rows.every((l) => /材料：.+（item:\d+）×\d+/.test(l)), t2);   // material ids, for the shopping-list line
assert.ok(t2.includes('Rune Thread（item:14341）×1（51银16铜·商人）'), t2);   // vendor supplies are marked (kept off the AH list)
assert.ok(!/Mooncloth（item:14342）[^、]*·商人/.test(t2), t2);
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

console.log('market_offline: ok');
console.log('\n--- sample item output ---\n' + t1 + '\n\n--- sample profession output ---\n' + t2);
