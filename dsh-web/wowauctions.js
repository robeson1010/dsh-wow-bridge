// wowauctions.net reader for the wowf market tools (no DSH imports, so it can be unit-tested). Online prices only, from wowauctions.net (EU / US Forever, every ruleset; the realm comes from the settings page): the pages embed their data
// as Next.js __NEXT_DATA__ JSON, which is parsed instead of the visible text.
//   wow_item_market(itemId, faction?)        one item: price, 30-day median/range, change, sales, verdicts
//   wow_craft_profit(profession, faction?)   up to 10 profitable recipes without crafting cooldowns
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

// Trade supplies that vendors sell (classic item ids). Only a fallback now: whether a vendor sells an item comes from
// 无限图鉴's vendor lists (./vendors.js); this list answers when that lookup failed. Never use wowauctions'
// available_from_vendor (true for every item) or price_source (always "ah").
export const VENDOR_REAGENTS = new Set([
  2320, 2321, 4291, 8343, 14341,                                   // Coarse / Fine / Silken / Heavy Silken / Rune Thread
  2324, 2325, 2604, 2605, 4340, 4341, 4342, 6260, 6261, 10290,     // Bleach and the vendor dyes
  4289,                                                            // Salt
  3371, 3372, 8925, 18256,                                         // Empty / Leaded / Crystal / Imbued Vial
  4470, 11291, 6217,                                               // Simple Wood, Star Wood, Copper Rod
  2880, 3466, 4399, 4400,                                          // Weak / Strong Flux, Wooden / Heavy Stock
  159, 1179, 2678, 2692, 3713,                                     // Spring Water, Ice Cold Milk, Mild / Hot / Soothing Spices
]);
// vendor answer for one item: the 无限图鉴 lookup when known, else the fallback list (base price from the item page)
function vendorOf(id, looked, buyPrice) {
  if (looked && typeof looked === 'object') return looked;
  if (VENDOR_REAGENTS.has(id)) return { sold: true, common: true, fallback: true, unit: buyPrice > 0 ? buyPrice : undefined };
  return looked === undefined ? undefined : null;   // undefined: not looked up; null: lookup failed
}
const perStack = (v) => (v.count > 1 && v.copper ? `${coins(v.copper)} / ${v.count} 个` : `${coins(v.unit)}/个`);
function vendorLine(v) {
  if (v?.sold && !v.common) {
    const price = v.unit ? `，客户端基础价 ${perStack(v)}` : '';
    const names = v.who?.length ? `：${v.who.join('、')}` : '';
    const classic = v.classicOnly ? '；这条是经典旧世的数据，无限服没人核实过' : '';
    return `只有 ${v.vendors} 个商人有${names}${price}（可能限量或要声望${classic}；无限图鉴商人货单，临时数据：${v.url}），要多买还是看拍卖行`;
  }
  if (v?.sold) {
    const price = v.unit ? `，${perStack(v)}（客户端基础价，尊敬起打折）` : '';
    const src = v.fallback ? '（常见商人材料）' : `，${v.vendors} 个商人有货（无限图鉴商人货单，临时数据：${v.url}）`;
    return `商人有卖${price}${src}`;
  }
  if (v && v.sold === false) return `商人不卖：无限图鉴的商人货单里没有它（${v.url}），只能拍卖行买或自己打、做`;
  if (v === null) return '商人卖不卖：这次没查到，不能说商人有卖';
  return '';
}

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
// vendor: the vendors.js answer for this item (undefined = not looked up, null = lookup failed)
export function itemMarketText(pp, { faction, url, server = '欧服 PvP', now = Date.now(), vendor }) {
  const info = pp?.item?.item_info ?? {};
  const ven = vendorOf(Number(info.entry), vendor, info.BuyPrice);
  const sellLine = info.SellPrice ? `卖店价 ${coins(info.SellPrice)}（卖给商人得到的钱，不代表商人卖它）` : '';
  const venLine = vendorLine(ven);
  const row = pp?.v2?.row;
  const nameOf = `${info.name ?? '未知物品'}（item:${info.entry ?? '?'}）`;
  const head = `${nameOf} · ${server} ${factionZh(faction)}拍卖行（wowauctions.net）`;
  if (!row || typeof row.min_buyout !== 'number') {
    return [head, '最近的扫描里没有在售。', sellLine, venLine, url].filter(Boolean).join('\n');
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
  if (sellLine) lines.push(sellLine);
  if (venLine) lines.push(venLine);
  // verdicts (approximations of the 商机 rules with what one item page gives)
  const v = [];
  if (info.SellPrice > 0 && min < info.SellPrice) v.push(`捡漏·卖店：最低挂单比卖店价低 ${coins(info.SellPrice - min)}/个，买下直接卖店（挂单数量看页面）`);
  if (ven?.sold && ven.common && ven.unit > 0 && min > ven.unit) v.push(`商人卖得更便宜（${coins(ven.unit)}/个），别在拍卖行买`);
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
const PROFIT_LIMIT = 10;
// WoWAuctions supplies spell IDs but no cooldown field. Match the crafting spell so a shared output
// or the use of a cooldown-gated reagent does not hide a recipe that can be crafted repeatedly.
const COOLDOWN_RECIPE_SPELLS = new Set([
  11479, 11480, 17187, 25146, 1317279,                    // Iron to Gold, Mithril to Truesilver, Arcanite, Elemental Fire, Legionite
  17559, 17560, 17561, 17562, 17563, 17564, 17565, 17566, // Essence transmutes
  18560, 19566,                                           // Mooncloth and using the Salt Shaker
]);
function profitable(ini) {
  return ini.recipes.filter((r) => typeof r.profit === 'number' && r.profit > 0 && !COOLDOWN_RECIPE_SPELLS.has(Number(r.spell_id)))
    .sort((a, b) => (b.profit * Math.min(1, (b.output?.sales?.sold_per_day ?? 0) / 20)) - (a.profit * Math.min(1, (a.output?.sales?.sold_per_day ?? 0) / 20)));
}
// the reagent ids craftProfitText will show (to look up their vendors first)
export function shownReagentIds(pp) {
  const ini = pp?.initial;
  if (!ini || !Array.isArray(ini.recipes)) return [];
  return [...new Set(profitable(ini).slice(0, PROFIT_LIMIT).flatMap((r) => (r.reagents ?? []).slice(0, 8).map((m) => m.item_id)).filter(Boolean))];
}

// vendors: Map(id -> vendors.js answer) for the shown reagents (optional)
export function craftProfitText(pp, { faction, url, server = '欧服 PvP', vendors }) {
  const ini = pp?.initial;
  if (!ini || !Array.isArray(ini.recipes)) throw new Error('wowauctions 专业页里没有配方数据（网站可能改版了）。');
  const name = pp.professionName ?? ini.name ?? '专业';
  const cut = ini.ah_cut_percent ?? 5;
  const shown = ini.recipes.length;
  const good = profitable(ini);
  const matTag = (m) => {
    const v = vendorOf(m.item_id, vendors?.get(m.item_id), undefined);
    if (v?.sold && !v.common) return `·少数商人有${v.who?.length ? `：${v.who[0]}` : ''}`;
    return v?.sold ? `·商人有卖${v.unit ? ` ${coins(v.unit)}` : ''}` : '';
  };
  const lines = [`${name} 制作利润 · ${server} ${factionZh(faction)}（wowauctions.net，按近几天市场价，已扣拍卖行 ${cut}% 手续费，押金不算）`,
    `在销量最好的 ${shown} 个配方中筛掉有制作冷却的配方，剩下 ${good.length} 个盈利配方。以下按排名列出 ${Math.min(good.length, PROFIT_LIMIT)} 个：`];
  for (const r of good.slice(0, PROFIT_LIMIT)) {
    const out = r.output ?? {};
    const sales = out.sales ?? {};
    const tr = r.trend ?? {};
    const made = out.count_min && out.count_max && out.count_min !== out.count_max ? `${out.count_min}-${out.count_max}` : (out.count_min ?? 1);
    const mats = (r.reagents ?? []).slice(0, 8).map((m) => `${m.name}${m.item_id ? `（item:${m.item_id}）` : ''}×${m.count}（拍卖 ${coins(m.unit_price)}${matTag(m)}）`).join('、');
    lines.push(`- ${out.name ?? r.name}（item:${out.item_id ?? '?'}）×${made}：成本 ${coins(r.cost)}，卖 ${coins(r.value)}，利润 ${coins(r.profit)}；`
      + `日销约 ${Math.round(sales.sold_per_day ?? 0)}（${SELL_LABEL[sales.label] ?? sales.label ?? '?'}）；`
      + `趋势：${TREND_LABEL[tr.label] ?? tr.label ?? '?'}，${tr.profitable_days ?? '?'}/${tr.days_with_data ?? '?'} 天赚钱；材料：${mats || '—'}`);
  }
  if (!good.length) lines.push('这批配方里没有符合条件的盈利配方。');
  if (vendors?.size) lines.push('材料标“商人有卖”的来自无限图鉴 wuxianwow.com 的商人货单（临时数据，价格是客户端基础价）；成本按拍卖价算，商人有卖的材料实际更便宜，不进拍卖行采购清单。标“少数商人有”的只有一两个商人卖（可能限量或要声望），照常算拍卖行材料。');
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

