// When to buy and when to sell: hour-of-day (and, with enough weeks, weekday) price patterns of the watchlist items,
// from Forever AH's hourly price history (see ./foreverah.js for the API and its terms). No DSH imports.
//   GET /v1/houses/{key}/items/{id}/history?resolution=hour&from=…&to=…   hourly points, up to 62 days back
// One request per item, a second apart: a full run over the list takes about a minute and a half, so the result is
// kept in a file (<dataDir>/market-times.json, one entry per auction house) and answers read that file. A DSH
// scheduled task (index.js, opt-in on the settings page) asks for a fresh run once a week; a question that finds the
// file old starts a run in the background.
// Method, per item: every hourly price (the 10th-percentile unit price: steadier than the single cheapest auction) is
// divided by the median of its own local day, which removes the day-to-day trend; per hour of the day the median of
// those ratios over the days is taken; the cheapest and the dearest 3-hour blocks are reported with how many days the order held.
import fs from 'node:fs';
import path from 'node:path';
import { AH_CUT, HAGGLE, ROI_NEAR } from './foreverah.js';

const BASE = 'https://forever-ah.com/v1';
export const HISTORY_DAYS = 30;
export const FRESH_MS = 26 * 60 * 60 * 1000;      // a question starts a new run when the file is older than this
const MIN_DAY_POINTS = 12;                        // hourly points a day needs to count
export const MIN_DAYS = 7;                        // days an item needs for an hour pattern
const MIN_HOUR_DAYS = 5;                          // days behind one hour's average
const MIN_WEEKDAY_SAMPLES = 3;                    // weeks behind one weekday's average
const BLOCK = 3;                                  // hours in a block
export const SWING_MIN = 0.04;                    // a pattern worth telling: dearest block this far above the cheapest
export const HOLD_MIN = 0.7;                      // ... on this share of the days
const SHOW = 8;
// the intraday swing a same-day flip would need for ROI_NEAR: (1 + ROI) / ((1 - haggle) * (1 - cut)) - 1
export const SWING_FOR_FLIP = (1 + ROI_NEAR) / ((1 - HAGGLE) * (1 - AH_CUT)) - 1;

export const historyUrl = (key, id, now = Date.now(), days = HISTORY_DAYS) =>
  `${BASE}/houses/${key}/items/${id}/history?${new URLSearchParams({ resolution: 'hour', from: new Date(now - days * 864e5).toISOString(), to: new Date(now).toISOString() })}`;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((n, x) => n + x, 0) / a.length;
const pct = (r) => `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`;
const hh = (h) => String(((h % 24) + 24) % 24).padStart(2, '0');
const span = (start) => `${hh(start)}–${hh(start + BLOCK)} 点`;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// local { day: 'YYYY-MM-DD', hour: 0-23, weekday: 0 (Mon) - 6 } of a timestamp
function localParts(fmt, t) {
  const p = {};
  for (const x of fmt.formatToParts(t)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: WD[p.weekday] };
}

// the 3-hour block (wrapping past midnight) with the lowest / highest average; null when no block is complete
function blocks(hours) {
  let cheap = null, dear = null;
  for (let s = 0; s < 24; s++) {
    const v = [];
    for (let i = 0; i < BLOCK; i++) v.push(hours[(s + i) % 24]);
    if (v.some((x) => x === null)) continue;
    const m = mean(v);
    if (!cheap || m < cheap.ratio) cheap = { start: s, ratio: m };
    if (!dear || m > dear.ratio) dear = { start: s, ratio: m };
  }
  return cheap && dear ? { cheap, dear } : null;
}
const inBlock = (hour, start) => ((hour - start + 24) % 24) < BLOCK;

// hourly points of one item -> its pattern, or null with too little history
export function timeProfile(points, timeZone = localZone()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
  const days = new Map();   // day -> { weekday, rows: [{ hour, price }] }
  for (const p of Array.isArray(points) ? points : []) {
    const t = Date.parse(p?.ts), price = num(p?.p10_unit) ?? num(p?.min_unit);
    if (!Number.isFinite(t) || !(price > 0)) continue;
    const lp = localParts(fmt, t);
    if (!days.has(lp.day)) days.set(lp.day, { weekday: lp.weekday, rows: [] });
    days.get(lp.day).rows.push({ hour: lp.hour, price });
  }
  const full = [...days.values()].filter((d) => d.rows.length >= MIN_DAY_POINTS);
  if (full.length < MIN_DAYS) return null;
  for (const d of full) {
    d.median = median(d.rows.map((r) => r.price));
    for (const r of d.rows) r.ratio = r.price / d.median;
  }
  const byHour = Array.from({ length: 24 }, () => []);
  for (const d of full) {
    const seen = new Map();   // an hour scanned twice in a day counts once (its average)
    for (const r of d.rows) seen.set(r.hour, [...(seen.get(r.hour) ?? []), r.ratio]);
    for (const [hour, v] of seen) byHour[hour].push(mean(v));
  }
  const hours = byHour.map((v) => (v.length >= MIN_HOUR_DAYS ? median(v) : null));   // the median: one thin-stock spike must not make an hour dear
  const b = blocks(hours);
  if (!b) return null;
  // on how many days was the dear block really dearer than the cheap one
  let both = 0, held = 0;
  for (const d of full) {
    const c = d.rows.filter((r) => inBlock(r.hour, b.cheap.start)).map((r) => r.ratio);
    const e = d.rows.filter((r) => inBlock(r.hour, b.dear.start)).map((r) => r.ratio);
    if (!c.length || !e.length) continue;
    both++;
    if (mean(e) > mean(c)) held++;
  }
  // weekdays: each day's median against the median of all days (only with enough weeks: a trend would pass for a pattern)
  const all = median(full.map((d) => d.median));
  const byWd = Array.from({ length: 7 }, () => []);
  for (const d of full) if (d.weekday !== undefined) byWd[d.weekday].push(d.median / all);
  const weekdays = byWd.every((v) => v.length >= MIN_WEEKDAY_SAMPLES) ? byWd.map(mean) : null;
  const round = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
  return {
    days: full.length, hours: hours.map(round),
    cheap: { start: b.cheap.start, ratio: round(b.cheap.ratio) }, dear: { start: b.dear.start, ratio: round(b.dear.ratio) },
    swing: round(b.dear.ratio / b.cheap.ratio - 1), held, both,
    weekdays: weekdays ? weekdays.map(round) : null,
  };
}

export const steady = (p) => !!p && p.swing >= SWING_MIN && p.both > 0 && p.held / p.both >= HOLD_MIN;

// all items together: the average of their hour (and weekday) profiles
export function overall(items) {
  const hours = Array.from({ length: 24 }, (_, h) => {
    const v = items.map((x) => x.hours?.[h]).filter((x) => typeof x === 'number');
    return v.length >= Math.max(1, Math.ceil(items.length / 2)) ? mean(v) : null;
  });
  const b = blocks(hours);
  const wd = items.filter((x) => x.weekdays);
  const weekdays = wd.length >= Math.max(1, Math.ceil(items.length / 2)) ? Array.from({ length: 7 }, (_, d) => mean(wd.map((x) => x.weekdays[d]))) : null;
  return { hours, cheap: b?.cheap ?? null, dear: b?.dear ?? null, weekdays };
}

// Reads the history of every id (one request at a time through `api`, which spaces them) and returns the stats object
// that is stored. A failed item is skipped; with nothing read at all the run fails.
export async function collectTimes(api, key, ids, { timeZone = localZone(), signal, now = Date.now(), days = HISTORY_DAYS } = {}) {
  const items = [];
  let failed = 0, thin = 0;
  for (const id of ids) {
    if (signal?.aborted) throw new Error('统计被中止了。');
    let h;
    try { h = await api(historyUrl(key, id, now, days), signal); } catch { failed++; continue; }
    const p = timeProfile(h?.points, timeZone);
    if (!p) { thin++; continue; }
    items.push({ id, name: h?.item?.name ?? `item ${id}`, ...p });
  }
  if (!items.length) throw new Error(failed ? 'Forever AH 的历史价格这次读不到。' : '历史价格还不够一周，暂时算不出时段规律。');
  return { builtAt: new Date(now).toISOString(), key, timeZone, asked: ids.length, failed, thin, days: Math.max(...items.map((x) => x.days)), items };
}

// ---- the stored file: { [house key]: stats } ----
export const TIMES_FILE = 'market-times.json';
export function readTimes(dataDir, key) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, TIMES_FILE), 'utf8'));
    const s = j && typeof j === 'object' ? j[String(key)] : null;
    return s && Array.isArray(s.items) && Number.isFinite(Date.parse(s.builtAt)) ? s : null;
  } catch { return null; }
}
export function writeTimes(dataDir, key, stats) {
  const file = path.join(dataDir, TIMES_FILE);
  let all = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) all = j; } catch { /* a new file */ }
  all[String(key)] = stats;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, file);
}

function ageText(builtAt, now) {
  const min = Math.max(0, Math.round((now - Date.parse(builtAt)) / 60000));
  return min < 90 ? `${min} 分钟前算的` : min < 48 * 60 ? `${Math.round(min / 60)} 小时前算的` : `${Math.round(min / 1440)} 天前算的`;
}

// stats: what collectTimes returned (or readTimes read); note: an extra first-paragraph line (e.g. "being updated")
export function timesText({ stats, faction, server = '欧服 PvP', now = Date.now(), note }) {
  const side = faction === 'alliance' ? '联盟' : '部落';
  const items = stats.items ?? [];
  const o = overall(items);
  const lines = [
    `买卖时段统计 · ${server} ${side}拍卖行（Forever AH forever-ah.com 的逐小时快照，数据来自暴雪 Battle.net API；清单里 ${items.length} 种物品、近 ${stats.days} 天；`
      + `时间是这台电脑的时区 ${stats.timeZone}；${ageText(stats.builtAt, now)}）`,
  ];
  if (note) lines.push(note);
  lines.push('算法：每个小时的价格（挂单里第 10 百分位的单价）除以当天的中位价，再按一天里的钟点取各天的中位数；比较的是连续 3 小时的时段。');
  if (o.cheap && o.dear) {
    lines.push(`整体：一天里 ${span(o.cheap.start)}最便宜（比当天中位价 ${pct(o.cheap.ratio)}），${span(o.dear.start)}最贵（${pct(o.dear.ratio)}）。`
      + `想买就挑便宜的时段去看，想卖就在贵的时段前挂上。`);
  }
  const good = items.filter(steady).sort((a, b) => b.swing - a.swing);
  lines.push(`【哪些物品的时段差最明显】日内价差 ${Math.round(SWING_MIN * 100)}% 以上、而且七成以上的日子都成立的有 ${good.length} 种${good.length > SHOW ? `，列前 ${SHOW}` : ''}：`);
  for (const p of good.slice(0, SHOW)) {
    lines.push(`- ${p.name}（item:${p.id}）${p.swing >= SWING_FOR_FLIP ? '【价差够倒卖】' : ''}：${span(p.cheap.start)}最便宜（${pct(p.cheap.ratio)}），${span(p.dear.start)}最贵（${pct(p.dear.ratio)}），`
      + `日内价差约 ${Math.round(p.swing * 100)}%，${p.both} 天里 ${p.held} 天成立`);
  }
  if (!good.length) lines.push('这些物品一天里的价格都差不多，没有稳定的便宜时段或贵的时段。');
  if (o.weekdays) {
    const order = o.weekdays.map((r, d) => ({ r, d })).sort((a, b) => a.r - b.r);
    lines.push(`星期：${WEEKDAYS[order[0].d]}最便宜（${pct(order[0].r)}），${WEEKDAYS[order[6].d]}最贵（${pct(order[6].r)}）。`);
  } else {
    lines.push(`星期：现在只有 ${stats.days} 天的数据，每个星期几至少要有 ${MIN_WEEKDAY_SAMPLES} 次才能比，满三周后这里会有结果。`);
  }
  const flips = good.filter((p) => p.swing >= SWING_FOR_FLIP).length;
  lines.push(`说明：同一天里低买高卖要有 ${Math.round(ROI_NEAR * 100)}% 净利，日内价差得到 ${Math.round(SWING_FOR_FLIP * 100)}% 左右（让价 ${HAGGLE * 100}%、手续费 ${AH_CUT * 100}%），`
    + `${flips ? `这次有 ${flips} 种到了这个水平` : '这次没有哪种到这个水平'}；其余的用处是选时间：在便宜的时段进货，在贵的时段出货。`
    + '这些是挂单价不是成交价，贵的时段挂得出去不等于卖得掉；规律是过去的统计，不保证明天还成立。');
  lines.push('https://forever-ah.com/');
  return lines.join('\n');
}

// One run at a time per auction house; a question never waits for a run unless it asks to.
export function makeTimes(api, { dataDir, log = () => {}, ids, signal: life } = {}) {
  const running = new Map();   // key -> Promise<stats>
  const dir = () => (typeof dataDir === 'function' ? dataDir() : dataDir);
  const start = (key) => {
    if (running.has(key)) return running.get(key);
    const t0 = Date.now();
    const p = (async () => {
      const stats = await collectTimes(api, key, ids, { signal: life });
      writeTimes(dir(), key, stats);
      log(`买卖时段统计：${stats.items.length} 种物品、${stats.days} 天，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
      return stats;
    })();
    running.set(key, p);
    p.catch((e) => log(`买卖时段统计失败：${e?.message}`)).finally(() => running.delete(key));
    return p;
  };
  return {
    read: (key) => readTimes(dir(), key),
    fresh: (stats, now = Date.now()) => !!stats && now - Date.parse(stats.builtAt) < FRESH_MS,
    busy: (key) => running.has(key),
    refresh: start,
  };
}
