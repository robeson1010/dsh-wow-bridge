// Does a vendor sell this item? For the wowf market tools (no DSH imports, so it can be unit-tested).
// wowauctions.net cannot tell: its item_info.available_from_vendor is true for every item (Runecloth, Thorium Bar,
// Linen Cloth … checked 2026-11-23) and its profession pages price every reagent as "ah". The answer comes from
// 无限图鉴's item_usage tool (https://wuxianwow.com/mcp, free, no auth): `temporary_vendors` lists the vendors players
// recorded on the Forever servers (EG Link, Polestar; third-party, "临时"), with the client base price. An item without
// it has no recorded vendor. Answers must credit 无限图鉴 with the page link and call the data 临时 (its terms).
//   lookup(ids, signal) -> Map(id -> { sold: true, unit, copper, count, vendors, common, who, classicOnly, url } | { sold: false, url } | null)
// common: a general good (无限图鉴 says common, or 5+ vendors) — bought from vendors, kept off the AH list. Otherwise only
// a few vendors have it (often limited stock or reputation, e.g. Felcloth from one vendor in Winterspring): still an AH
// material; who names them; classicOnly when every listed vendor comes from QuestieDB (Classic data, not seen on Forever).
// null = not known (request failed); the caller then falls back to the built-in VENDOR_REAGENTS list.
const MCP_URL = 'https://wuxianwow.com/mcp';
const UA = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai) dsh-wow-bridge';
const CACHE_MS = 12 * 60 * 60 * 1000;   // vendor lists change with patches, not by the hour
const FAIL_MS = 2 * 60 * 1000;          // a failed lookup is retried after 2 minutes
const TIMEOUT_MS = 8000;
const PARALLEL = 4;

// one item_usage result (parsed JSON) -> the vendor answer
export function vendorFromUsage(o) {
  if (!o || typeof o !== 'object' || (o.outcome && o.outcome !== 'ok')) return null;
  const url = typeof o.url === 'string' ? o.url : (o.item_id ? `https://wuxianwow.com/item/${o.item_id}` : undefined);
  const tv = o.temporary_vendors;
  const official = ['vendors', 'sold_by'].map((k) => o[k]).find((v) => Array.isArray(v) && v.length);   // if official data ever appears
  if (!(tv && typeof tv === 'object') && !official) return { sold: false, url };
  const bp = tv?.base_price ?? {};
  const copper = Number(bp.copper), count = Number(bp.count) > 0 ? Number(bp.count) : 1;
  const listed = Array.isArray(tv?.vendors) ? tv.vendors.length : (official?.length ?? 0);
  const vendors = Number(tv?.total_vendors) > 0 ? Number(tv.total_vendors) : listed;
  if (!vendors && !official) return { sold: false, url };
  const list = Array.isArray(tv?.vendors) ? tv.vendors : [];
  const who = list.slice(0, 2).filter((x) => x?.name).map((x) => (x.zone ? `${x.name}（${x.zone}）` : x.name));
  return {
    sold: true, url, vendors, common: tv?.common === true || vendors >= 5, who,
    classicOnly: list.length > 0 && list.every((x) => x?.source === 'QuestieDB'),
    copper: Number.isFinite(copper) && copper > 0 ? copper : undefined, count,
    unit: Number.isFinite(copper) && copper > 0 ? copper / count : undefined,
  };
}

// a JSON-RPC answer (plain JSON or one SSE "data:" line) -> the tool's parsed JSON, or throws
export function usageFromRpc(text) {
  const t = String(text);
  const m = /^data: ?(.*)$/m.exec(t);
  const rpc = JSON.parse(m ? m[1] : t);
  if (rpc.error) throw new Error(rpc.error.message ?? 'rpc error');
  const r = rpc.result;
  if (!r || r.isError) throw new Error('item_usage error');
  const part = (r.content ?? []).find((c) => c?.type === 'text');
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  return JSON.parse(part?.text ?? 'null');
}

export function makeVendorLookup(fetchImpl = globalThis.fetch) {
  const cache = new Map();   // id -> { t, ttl, v }
  let seq = 0;
  async function one(id, signal) {
    const r = await fetchImpl(MCP_URL, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'item_usage', arguments: { item_id: id } } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return vendorFromUsage(usageFromRpc(await r.text()));
  }
  return async function lookup(ids, signal, now = Date.now()) {
    const out = new Map();
    const todo = [];
    for (const id of new Set(ids.map((x) => Math.trunc(Number(x))).filter((x) => x > 0))) {
      const hit = cache.get(id);
      if (hit && now - hit.t < hit.ttl) out.set(id, hit.v); else todo.push(id);
    }
    let next = 0;
    async function worker() {
      while (next < todo.length) {
        const id = todo[next++];
        let v = null;
        try { v = await one(id, signal); } catch { v = null; }
        out.set(id, v);
        cache.set(id, { t: now, ttl: v ? CACHE_MS : FAIL_MS, v });
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
    return out;
  };
}
