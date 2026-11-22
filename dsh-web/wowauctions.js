// wowauctions.net reader for the wowf market tools (no DSH imports, so it can be unit-tested). Online prices only, from wowauctions.net (EU / US Forever, every ruleset; the realm comes from the settings page): the pages embed their data
// as Next.js __NEXT_DATA__ JSON, which is parsed instead of the visible text.
//   wow_item_market(itemId, faction?)        one item: price, 30-day median/range, change, sales, verdicts
//   wow_craft_profit(profession, faction?)   the profitable recipes among a profession's 40 best sellers
// Each page is fetched at most once per CACHE_MS; honest User-Agent; nothing here may throw out of a callback
// (dsh web exits on uncaught errors) — execute() errors are caught by the tool registry and returned as isError.
const BASE = 'https://www.wowauctions.net';
export const REALM = 'forever-eu/pvp-forever-eu';   // default realm path (EU PvP)
const UA = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai) dsh-wow-bridge';
const CACHE_MS = 30 * 60 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;

export const PROFESSIONS = {
  alchemy: ['炼金', '炼金术'], blacksmithing: ['锻造'], cooking: ['烹饪'], enchanting: ['附魔'], engineering: ['工程', '工程学'],
  'first-aid': ['急救'], leatherworking: ['制皮'], mining: ['采矿', '熔炼'], tailoring: ['裁缝'],
};

export function professionSlug(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (PROFESSIONS[s]) return s;
  for (const [slug, names] of Object.entries(PROFESSIONS)) if (names.some((n) => s.includes(n))) return slug;
  return null;
}

export const factionSlug = (f) => (/^(alliance|联盟)$/i.test(String(f ?? '').trim()) ? 'alliance' : 'horde');
const factionZh = (slug) => (slug === 'alliance' ? '联盟' : '部落');

export function coins(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return '—';
  const sign = c < 0 ? '-' : '';
  c = Math.round(Math.abs(c));
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100;
  const parts = [];
  if (g) parts.push(`${g}金`);
  if (s) parts.push(`${s}银`);
  if (k || !parts.length) parts.push(`${k}铜`);
  return sign + parts.join('');
}
const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)}%` : '—');
const SELL_LABEL = { very_high: '非常好卖', high: '好卖', medium: '一般', low: '难卖', very_low: '很难卖' };
const TREND_LABEL = { steady: '稳定赚', losing: '在亏', recently_profitable: '最近才开始赚', new: '新出现', volatile: '波动大' };

// Trade supplies that vendors sell (classic item ids). The profession page marks every reagent's price as an AH price,
// so without this the "商人" marker never shows and vendor materials would land on the AH shopping list.
export const VENDOR_REAGENTS = new Set([
  2320, 2321, 4291, 8343, 14341,                                   // Coarse / Fine / Silken / Heavy Silken / Rune Thread
  2324, 2325, 2604, 2605, 4340, 4341, 4342, 6260, 6261, 10290,     // Bleach and the vendor dyes
  4289,                                                            // Salt
  3371, 3372, 8925, 18256,                                         // Empty / Leaded / Crystal / Imbued Vial
  4470, 11291, 6217,                                               // Simple Wood, Star Wood, Copper Rod
  2880, 3466, 4399, 4400,                                          // Weak / Strong Flux, Wooden / Heavy Stock
  159, 1179, 2678, 2692, 3713,                                     // Spring Water, Ice Cold Milk, Mild / Hot / Soothing Spices
]);
const fromVendor = (m) => m.price_source === 'vendor' || VENDOR_REAGENTS.has(m.item_id);

export function nextData(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(String(html));
  if (!m) throw new Error('wowauctions 页面里没有数据（网站可能改版了）。');
  return JSON.parse(m[1])?.props?.pageProps ?? {};
}

function ago(iso, now) {
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${String(iso).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return '扫描时间未知';
  const min = Math.max(0, Math.round((now - t) / 60000));
  return min < 60 ? `${min} 分钟前扫描` : min < 48 * 60 ? `${Math.round(min / 60)} 小时前扫描` : `${Math.round(min / 1440)} 天前扫描`;
}

// ---- one item ----
export function itemMarketText(pp, { faction, url, server = '欧服 PvP', now = Date.now() }) {
  const info = pp?.item?.item_info ?? {};
  const row = pp?.v2?.row;
  const nameOf = `${info.name ?? '未知物品'}（item:${info.entry ?? '?'}）`;
  const head = `${nameOf} · ${server} ${factionZh(faction)}拍卖行（wowauctions.net）`;
  if (!row || typeof row.min_buyout !== 'number') {
    return `${head}\n最近的扫描里没有在售。${info.SellPrice ? `商店收购价 ${coins(info.SellPrice)}。` : ''}\n${url}`;
  }
  const st = row.stats ?? {};
  const sales = row.sales_7d ?? {};
  const min = row.min_buyout, market = row.market_value ?? row.median ?? row.avg_price;
  const lines = [head + `，${ago(row.seen_at ?? pp?.item?.realm_last_scan, now)}`];
  lines.push(`最低一口价 ${coins(min)}；市场价 ${coins(market)}；在售 ${row.quantity ?? '?'} 个（${row.auctions ?? '?'} 条挂单）`);
  if (typeof st.median_30d === 'number') {
    lines.push(`30 天中位数 ${coins(st.median_30d)}，区间 ${coins(st.min_30d)}–${coins(st.max_30d)}（${st.days ?? '?'} 天有数据）；`
      + `1 天 ${pct(st.change_1d_pct)}，7 天 ${pct(st.change_7d_pct)}；在售数量 7 天 ${pct(st.quantity_change_7d_pct)}`);
  }
  if (typeof sales.sold_per_day === 'number') {
    lines.push(`近 7 天每天约卖出 ${Math.round(sales.sold_per_day)} 个，成交率 ${pct(sales.sell_through_pct).replace('+', '')}（${SELL_LABEL[sales.sellability_label] ?? sales.sellability_label ?? '未知'}）`);
  }
  if (info.SellPrice || info.BuyPrice) {
    lines.push(`商店收购价 ${coins(info.SellPrice ?? 0)}${info.available_from_vendor && info.BuyPrice ? `；商人也卖，${coins(info.BuyPrice)}` : ''}`);
  }
  // verdicts (approximations of the 商机 rules with what one item page gives)
  const v = [];
  if (info.SellPrice > 0 && min < info.SellPrice) v.push(`捡漏·卖店：最低挂单比商店收购价低 ${coins(info.SellPrice - min)}/个，买下直接卖店（挂单数量看页面）`);
  if (info.available_from_vendor && info.BuyPrice > 0 && min > info.BuyPrice) v.push(`商人卖得更便宜（${coins(info.BuyPrice)}），别在拍卖行买`);
  if (typeof st.median_30d === 'number' && st.median_30d > 0) {
    const r = min / st.median_30d;
    if (r <= 0.8) v.push(`偏低：最低价是 30 天中位数的 ${Math.round(r * 100)}%，可以考虑低吸（不保证回升）`);
    else if (r >= 1.25) v.push(`偏高：最低价是 30 天中位数的 ${Math.round(r * 100)}%，有货可以趁高卖，想买先等等`);
    else v.push(`价格正常：最低价是 30 天中位数的 ${Math.round(r * 100)}%`);
  }
  const q7 = st.quantity_change_7d_pct, c7 = st.change_7d_pct;
  if (typeof q7 === 'number' && typeof c7 === 'number') {
    if (q7 >= 50 && c7 < 0) v.push('有人在压价：在售数量一周多了一半以上，价格在跌');
    else if (q7 <= -30 && c7 > 0) v.push('有人在扫货：在售数量一周少了三成以上，价格在涨');
  }
  if (v.length) lines.push('判断：' + v.join('；'));
  lines.push(url);
  return lines.join('\n');
}

// ---- one profession ----
export function craftProfitText(pp, { faction, url, server = '欧服 PvP', limit = 8, now = Date.now() }) {
  const ini = pp?.initial;
  if (!ini || !Array.isArray(ini.recipes)) throw new Error('wowauctions 专业页里没有配方数据（网站可能改版了）。');
  const name = pp.professionName ?? ini.name ?? '专业';
  const cut = ini.ah_cut_percent ?? 5;
  const shown = ini.recipes.length;
  const good = ini.recipes.filter((r) => typeof r.profit === 'number' && r.profit > 0)
    .sort((a, b) => (b.profit * Math.min(1, (b.output?.sales?.sold_per_day ?? 0) / 20)) - (a.profit * Math.min(1, (a.output?.sales?.sold_per_day ?? 0) / 20)));
  const lines = [`${name} 制作利润 · ${server} ${factionZh(faction)}（wowauctions.net，按近几天市场价，已扣拍卖行 ${cut}% 手续费，押金不算）`,
    `共 ${ini.total ?? '?'} 个配方，${ini.profitable ?? '?'} 个赚钱；这里看的是销量最好的 ${shown} 个，其中赚钱的 ${good.length} 个：`];
  for (const r of good.slice(0, Math.max(1, Math.min(limit, 20)))) {
    const out = r.output ?? {};
    const sales = out.sales ?? {};
    const tr = r.trend ?? {};
    const made = out.count_min && out.count_max && out.count_min !== out.count_max ? `${out.count_min}-${out.count_max}` : (out.count_min ?? 1);
    const mats = (r.reagents ?? []).slice(0, 8).map((m) => `${m.name}${m.item_id ? `（item:${m.item_id}）` : ''}×${m.count}（${coins(m.unit_price)}${fromVendor(m) ? '·商人' : ''}）`).join('、');
    lines.push(`- ${out.name ?? r.name}（item:${out.item_id ?? '?'}）×${made}：成本 ${coins(r.cost)}，卖 ${coins(r.value)}，利润 ${coins(r.profit)}；`
      + `日销约 ${Math.round(sales.sold_per_day ?? 0)}（${SELL_LABEL[sales.label] ?? sales.label ?? '?'}）；`
      + `趋势：${TREND_LABEL[tr.label] ?? tr.label ?? '?'}，${tr.profitable_days ?? '?'}/${tr.days_with_data ?? '?'} 天赚钱；材料：${mats || '—'}`);
  }
  if (!good.length) lines.push('（销量最好的这些配方现在都不赚钱）');
  lines.push(url);
  return lines.join('\n');
}

// ---- fetch with cache ----
export function makeFetcher(fetchImpl = globalThis.fetch) {
  const cache = new Map();   // url -> { t, pp }
  return async function load(url, signal, now = Date.now()) {
    const hit = cache.get(url);
    if (hit && now - hit.t < CACHE_MS) return hit.pp;
    const r = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (r.status === 404) throw new Error('wowauctions 上找不到这个页面（物品 ID 或专业名不对？）。');
    if (r.status !== 200) throw new Error(`wowauctions 返回 HTTP ${r.status}，暂时读不到，可以把网址给玩家自己看：${url}`);
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('wowauctions 页面太大，没有读。');
    const pp = nextData(text);
    cache.set(url, { t: now, pp });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return pp;
  };
}

export const itemUrl = (id, faction, realm = REALM) => `${BASE}/auctionHouse/${realm}/${factionSlug(faction)}/x-${id}`;
export const professionUrl = (slug, faction, realm = REALM) => `${BASE}/professions/${realm}/${factionSlug(faction)}/${slug}`;

