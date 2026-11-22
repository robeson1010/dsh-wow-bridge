// Live driver for an isolated dsh web test instance running the plugin (see test notes in README):
//   node test/web_live_drive.mjs <AddOns dir> <pipe name> "<question 1>" "<question 2>" ...
// "ping" and "reset" send those request types. Prints each answer as the addon would read it from the font slots.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as MB from '../dsh-web/lib/fontmail.mjs';
import { readAdvances } from '../dsh-web/lib/ttf.mjs';

const [addons, pipe, ...questions] = process.argv.slice(2);
const addonDir = path.join(addons, 'DSHChat');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
let next = 1;

function readSlot(k) {
  try {
    const adv = readAdvances(fs.readFileSync(MB.slotPath(addonDir, k)));
    const b = Buffer.from(adv.slice(2).map((a) => a / 16 - 16));
    const p = b.subarray(4, 4 + b.readUInt16BE(2));
    const idLen = p[10];
    return { part: p[8], parts: p[9], id: p.toString('utf8', 11, 11 + idLen), text: p.toString('utf8', 11 + idLen) };
  } catch { return null; }
}

for (const q of questions) {
  const id = `${Math.floor(Date.now() / 1000)}${String(++seq).padStart(3, '0')}`;
  // an argument starting with "{" is JSON merged into the request (e.g. {"q":"...","links":[...]})
  const extra = q.startsWith('{') ? JSON.parse(q) : { q };
  const type = extra.q === 'ping' ? 'ping' : extra.q === 'reset' ? 'reset' : 'ask';
  const body = { v: 1, type, id, slot: next, ctx: { name: 'Tester', realm: 'Forever', level: 52, class: '战士', race: '兽人', zone: '冬泉谷', subzone: '永望镇', x: 61.2, y: 37.8, faction: 'Horde' }, ...extra };
  const frame = `DSHB:${id}:1/1:${Buffer.from(JSON.stringify(body)).toString('base64')}`;
  const t0 = Date.now();
  await new Promise((resolve, reject) => { const c = net.connect(`\\\\.\\pipe\\${pipe}`, () => c.end(frame)); c.on('close', resolve); c.on('error', reject); });
  let parts = [];
  while (Date.now() - t0 < 130000) {
    const s = readSlot(next);
    if (s && s.id === id) {
      parts[s.part - 1] = s.text;
      next++;
      if (parts.filter((x) => x !== undefined).length === s.parts) break;
    } else await sleep(200);
  }
  console.log(`\n>>> ${q}   (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${parts.join('') || '(no answer)'}`);
}
