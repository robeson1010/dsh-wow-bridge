// Forever AH reader for the wowf tool wow_flip_market (no DSH imports, so it can be unit-tested).
// forever-ah.com publishes a free, read-only JSON API (no key; https://forever-ah.com/api/): hourly snapshots of
// every auction house from Blizzard's Battle.net API. Its terms: cache what you can, about one request a second,
// credit "Forever AH" and Blizzard's Battle.net API. So: every request waits its turn (GAP_MS apart), answers are
// cached, and the tool text names the source.
// Checked 2026-11-28 against wowauctions.net for the same snapshot: lowest price and quantity identical for 50 of 50
// items, and the house numbers below matched all 16 EU and US houses.
//   GET /v1/houses                              every house: house_key (used in paths), region, house_id
//   GET /v1/houses/{key}/market?ids=1,2,3       current price and stats of up to 100 items
//   GET /v1/houses/{key}/items/{id}/auctions    one item's auctions right now (identical ones share a row: count)
// The tool looks only at the fixed list in ./watchlist.js (common items with a large turnover) and says which of them
// are worth buying and which are worth selling right now. The player checks the prices in game and buys or sells.
// Nothing here may throw out of a callback (dsh web exits on uncaught errors): execute() errors are caught by the
// tool registry and returned as isError.
import { coins } from './wowauctions.js';

const BASE = 'https://forever-ah.com/v1';
export const SITE = 'https://forever-ah.com/';
const UA = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai) dsh-wow-bridge';
const GAP_MS = 1000;                      // "keep to about one request a second"
const CACHE_MS = 10 * 60 * 1000;          // snapshots are hourly
const HOUSES_CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;
export const IDS_MAX = 100;               // ids one market request takes

// ruleset (lib/settings.mjs) -> Blizzard auction house id per faction; the same numbers in every region
export const HOUSE_IDS = {
  pvp: { alliance: 110, horde: 113 },
  pve: { alliance: 111, horde: 114 },
  rp: { alliance: 119, horde: 120 },
  'rp-pvp': { alliance: 123, horde: 124 },
};

// ---- the rules (agreed 2026-11-28; trial thresholds, to be tuned from the player's own sales) ----
export const AH_CUT = 0.05;               // the auction house keeps 5% of a sale
export const HAGGLE = 0.05;               // sell 5% under the reference price
export const ROI_OK = 0.40;               // buy: on paper; the real target is 30%
export const ROI_NEAR = 0.30;
export const SELL_OK = 0.15;              // sell: the lowest price is this far above both reference prices
export const MIN_SOLD = 20;               // units a day in this house (an estimate that also counts cancelled auctions)
export const MIN_DAYS = 7;                // days of history behind the market value
export const FALLING_PCT = -10;           // market value trend at or below this: do not buy yet
export const LADDERS = 3;                 // items whose auctions are read to count the cheap units
const SHOW = 5, SHOW_WAIT = 5;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const pct = (x) => `${x > 0 ? '+' : ''}${Math.round(x)}%`;
const factionZh = (f) => (f === 'alliance' ? '联盟' : '部落');
const stock = (a) => (a.quantity !== undefined ? `在售 ${a.quantity} 个，` : '');

export function houseKey(houses, region, ruleset, faction) {
  const id = HOUSE_IDS[ruleset]?.[faction === 'alliance' ? 'alliance' : 'horde'];
  const h = Array.isArray(houses) ? houses.find((x) => x?.region === region && x.house_id === id && x.house_type === 'real') : undefined;
  if (!h || typeof h.house_key !== 'number') throw new Error('Forever AH 上找不到设置里这个服务器的拍卖行。');
  return h.house_key;
}

export const housesUrl = () => `${BASE}/houses`;
export const watchUrl = (key, ids) => `${BASE}/houses/${key}/market?${new URLSearchParams({ ids: ids.slice(0, IDS_MAX).join(','), window: '24', limit: String(IDS_MAX) })}`;
export const auctionsUrl = (key, id) => `${BASE}/houses/${key}/items/${id}/auctions`;

// what one unit brings after selling HAGGLE under `ref` and paying the cut
export const netOf = (ref) => Math.floor(Math.floor(ref * (1 - HAGGLE)) * (1 - AH_CUT));

// One market row -> the numbers both lists use; null when the row cannot be judged (not listed, sells too little,
// too little history). Buying is judged against the LOWER of the 14-day market value and the long-run value, selling
// against the HIGHER one: both err on the careful side.
export function assess(row) {
  const item = row?.item ?? {}, cur = row?.current ?? {}, st = row?.stats ?? {};
  const min = num(cur.min_unit), value = num(st.market_value), sold = num(st.sold_per_day);
  if (!item.name || !(min > 0) || !(value > 0) || !(sold >= MIN_SOLD) || !(st.days_seen >= MIN_DAYS)) return null;
  const hist = num(st.historical_value) > 0 ? st.historical_value : value;
  const buyRef = Math.min(value, hist), sellRef = Math.max(value, hist);
  const net = netOf(buyRef);
  return {
    id: item.item_id, name: item.name, min, p10: num(cur.p10_unit), quantity: num(cur.quantity), value, sold, trend: num(st.trend_pct),
    buyRef, net, roi: net / min - 1, ceiling: Math.floor(net / (1 + ROI_NEAR)),   // the most to pay for 30%
    sellRef, premium: min / sellRef - 1,
  };
}

const ladderRows = (auctions) => (Array.isArray(auctions?.rows) ? auctions.rows : [])
  .filter((r) => num(r?.unit_buyout) > 0 && num(r.quantity) > 0)
  .sort((x, y) => x.unit_buyout - y.unit_buyout);
const unitsOf = (r) => r.quantity * (num(r.count) > 0 ? r.count : 1);
// what the market takes in half a day (the sales estimate over-counts): the most one lot may hold
export const lotCap = (a) => Math.max(1, Math.floor(a.sold / 2));
// units listed at or under the item's ceiling
export const cheapUnits = (auctions, a) => ladderRows(auctions).filter((r) => r.unit_buyout <= a.ceiling).reduce((n, r) => n + unitsOf(r), 0);

// The cheap end of one item's auctions as a lot to buy out: every auction up to some price, no more units than
// lotCap, resold under the item's reference AND under the next listing left standing (buying only part of the cheap
// units leaves the others to undercut the resale). The largest such lot whose dearest unit still returns ROI_NEAR;
// null when there is none: a stray cheap auction right below normal prices, or more cheap units than can be cleared.
export function lotFromLadder(auctions, a) {
  const rows = ladderRows(auctions);
  const cap = lotCap(a);
  const cum = [];
  for (const r of rows) cum.push((cum.at(-1) ?? 0) + unitsOf(r));
  for (let k = rows.findLastIndex((r, i) => r.unit_buyout <= a.ceiling && cum[i] <= cap) + 1; k >= 1; k--) {
    const last = rows[k - 1], next = rows[k]?.unit_buyout;
    if (next === last.unit_buyout) continue;                    // cut between prices, not inside one
    const ref = next === undefined ? a.buyRef : Math.min(a.buyRef, next - 1);
    const net = netOf(ref);
    if (net / last.unit_buyout - 1 < ROI_NEAR) continue;
    const units = cum[k - 1];
    const cost = rows.slice(0, k).reduce((n, r) => n + unitsOf(r) * r.unit_buyout, 0);
    const profit = units * net - cost;
    return { units, cost, profit, roi: profit / cost, near: profit / cost < ROI_OK, low: rows[0].unit_buyout, high: last.unit_buyout, next,
      sell: Math.floor(ref * (1 - HAGGLE)), ceiling: Math.floor(net / (1 + ROI_NEAR)) };
  }
  return null;
}

// market rows -> { judged, buys, sells, wait }: buys by expected return, without the items whose market value is
// falling (those that would qualify go to `wait`); sells by how far the lowest price stands above the reference.
export function rank(market) {
  const judged = (Array.isArray(market?.rows) ? market.rows : []).map(assess).filter(Boolean);
  const falling = (a) => a.trend !== undefined && a.trend <= FALLING_PCT;
  const buys = judged.filter((a) => !falling(a)).sort((a, b) => b.roi - a.roi);
  const wait = judged.filter((a) => falling(a) && a.roi >= ROI_NEAR).sort((a, b) => b.roi - a.roi);
  const sells = [...judged].sort((a, b) => b.premium - a.premium);
  return { judged, buys, sells, wait };
}

// the items whose auctions are worth reading: the best buys that reach ROI_NEAR at their lowest price
export const ladderIds = (market) => rank(market).buys.filter((a) => a.roi >= ROI_NEAR).slice(0, LADDERS).map((a) => a.id);

function ago(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { text: '时间未知的快照', min: Infinity };
  const min = Math.max(0, Math.round((now - t) / 60000));
  return { text: min < 60 ? `${min} 分钟前的快照` : `${(min / 60).toFixed(1)} 小时前的快照`, min };
}

// market: the watch request's answer; ladders: Map(item id -> auctions answer, or null when it could not be read);
// listed: how many items the watchlist has; listDate: when it was last rebuilt
export function flipMarketText({ market, ladders = new Map(), listed, listDate, faction, server = '欧服 PvP', now = Date.now() }) {
  const age = ago(market?.as_of, now);
  const { judged, buys, sells, wait } = rank(market);
  // a buy stands on its lot when the auctions were read; a lowest price with no lot behind it does not count
  const entries = buys.slice(0, Math.max(SHOW, LADDERS)).map((a) => {
    if (a.roi < ROI_NEAR) return { a, kind: 'far' };
    if (!ladders.has(a.id) || ladders.get(a.id) === null) return { a, kind: 'unread', near: a.roi < ROI_OK };
    const lot = lotFromLadder(ladders.get(a.id), a);
    return lot ? { a, kind: 'lot', lot, near: lot.near } : { a, kind: 'stray', cheap: cheapUnits(ladders.get(a.id), a) };
  });
  const order = { lot: 0, unread: 1, stray: 2, far: 3 };
  entries.sort((x, y) => order[x.kind] - order[y.kind] || (y.lot?.profit ?? 0) - (x.lot?.profit ?? 0) || y.a.roi - x.a.roi);
  const good = entries.filter((e) => (e.kind === 'lot' || e.kind === 'unread') && !e.near).length;
  const near = entries.filter((e) => (e.kind === 'lot' || e.kind === 'unread') && e.near).length;
  const high = sells.filter((a) => a.premium >= SELL_OK);

  const lines = [
    `买卖行情 · ${server} ${factionZh(faction)}拍卖行（Forever AH forever-ah.com，数据来自暴雪 Battle.net API，${age.text}）`,
    `范围：固定清单里的 ${listed ?? '?'} 种大交易量常见物品${listDate ? `（${listDate} 按全区日成交额选的）` : ''}，这次 ${judged.length} 种有足够的数据。`,
    `算法：买，预期卖价取“近 14 天市场价、历史价、下一档挂单价”里最低的再让 ${HAGGLE * 100}%，扣 ${AH_CUT * 100}% 手续费；入手上限是净利正好 ${ROI_NEAR * 100}% 的买价，`
      + `净利到 ${ROI_OK * 100}% 标达标（留了余量），${ROI_NEAR * 100}–${ROI_OK * 100}% 标接近，押金不算；低价货要能一次买完（不超过半天销量）才算。`
      + `卖，最低价比市场价和历史价都高出 ${SELL_OK * 100}% 以上算值得卖。`,
  ];
  if (age.min > 150) lines.push(`注意：这份快照已经是${age.text.replace('的快照', '')}的，平时每小时更新一次，现在的价格可能差得多。`);

  lines.push(`【现在最值得买】达标 ${good} 种，接近 ${near} 种${good + near ? '' : '：清单里现在没有到入手价的，下面是离入手上限最近的，等跌到上限再买'}：`);
  for (const e of entries.slice(0, SHOW)) {
    const { a } = e, head = `- ${a.name}（item:${a.id}）`;
    if (e.kind === 'lot') {
      const l = e.lot, price = l.low === l.high ? `${coins(l.high)}/个` : `${coins(l.low)}–${coins(l.high)}/个`;
      lines.push(`${head}${l.near ? '【接近】' : '【达标】'}：一口价 ${price} 的共 ${l.units} 个${l.next ? `，下一档 ${coins(l.next)}` : ''}；入手上限 ${coins(l.ceiling)}，预期卖 ${coins(l.sell)}，`
        + `预计净利 ${pct(l.roi * 100)}；全买下约花 ${coins(l.cost)}，预计赚 ${coins(l.profit)}；日销约 ${Math.round(a.sold)}`);
    } else if (e.kind === 'unread') {
      lines.push(`${head}${e.near ? '【接近】' : '【达标】'}：最低 ${coins(a.min)}，入手上限 ${coins(a.ceiling)}，按最低价算净利 ${pct(a.roi * 100)}`
        + `（这次没读到挂单明细，低价的有几个要在拍卖行看）；日销约 ${Math.round(a.sold)}`);
    } else if (e.kind === 'stray') {
      const why = e.cheap > lotCap(a)
        ? `不高于入手上限的货有 ${e.cheap} 个，比半天的销量还多，买不完，价格就压在这里`
        : '只是零星低价单，买下后只能贴着下一档卖，没有赚头';
      lines.push(`${head}：最低 ${coins(a.min)}，但${why}；入手上限 ${coins(a.ceiling)}，市场价 ${coins(a.value)}`);
    } else {
      lines.push(`${head}：最低 ${coins(a.min)}，入手上限 ${coins(a.ceiling)}（还要再跌 ${Math.round((1 - a.ceiling / a.min) * 100)}%），市场价 ${coins(a.value)}，`
        + `${stock(a)}日销约 ${Math.round(a.sold)}${a.trend !== undefined ? `，市场价趋势 ${pct(a.trend)}` : ''}`);
    }
  }
  if (!entries.length) lines.push('这次没有读到清单里物品的数据。');

  lines.push(`【现在最值得卖】（手里有货的话）值得卖的有 ${high.length} 种${high.length ? '' : '：现在没有明显偏高的，下面是相对最高的'}：`);
  for (const a of sells.slice(0, SHOW)) {
    const list = Math.max(1, a.min - 1);
    lines.push(`- ${a.name}（item:${a.id}）${a.premium >= SELL_OK ? '【值得卖】' : ''}：最低 ${coins(a.min)}，比市场价 ${coins(a.sellRef)} ${a.premium >= 0 ? '高' : '低'} ${Math.abs(Math.round(a.premium * 100))}%；`
      + `挂 ${coins(list)} 左右，卖出到手约 ${coins(Math.floor(list * (1 - AH_CUT)))}/个；${stock(a)}日销约 ${Math.round(a.sold)}${a.trend !== undefined ? `，市场价趋势 ${pct(a.trend)}` : ''}`);
  }
  if (wait.length) {
    lines.push('先别买（便宜，但市场价在跌）：' + wait.slice(0, SHOW_WAIT).map((a) => `${a.name}（item:${a.id}，市场价趋势 ${pct(a.trend)}）`).join('、'));
  }
  lines.push(`提醒：这是 ${age.text}，低价单可能已经被买走，日销量也把撤单算了进去：先在拍卖行核实价格和数量，高于入手上限就不买，第一次做的物品先买少量试卖。买和卖都由玩家自己点。`);
  lines.push(SITE);
  return lines.join('\n');
}

// ---- fetch: one request at a time, GAP_MS apart, cached ----
export function makeApi(fetchImpl = globalThis.fetch, { gapMs = GAP_MS } = {}) {
  const cache = new Map();   // url -> { t, value }
  let last = 0, chain = Promise.resolve();
  const turn = () => {
    const p = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    });
    chain = p.catch(() => {});
    return p;
  };
  return async function load(url, signal, now = Date.now()) {
    const ttl = url === housesUrl() ? HOUSES_CACHE_MS : CACHE_MS;
    const hit = cache.get(url);
    if (hit && now - hit.t < ttl) return hit.value;
    await turn();
    const r = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (r.status === 429) throw new Error('Forever AH 说请求太频繁了，过一分钟再问。');
    if (r.status !== 200) throw new Error(`Forever AH 返回 HTTP ${r.status}，暂时读不到；单件物品的行情可以改用 wow_item_market。`);
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('Forever AH 的回答太大，没有读。');
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('Forever AH 的回答不是 JSON（网站可能改版了）。'); }
    cache.set(url, { t: now, value });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return value;
  };
}
