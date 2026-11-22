// Font mailbox: the PC -> game channel. Ported from Wuxian Workshop (MIT, Copyright (c) 2026 kk8o):
// src/wuxianworkshop/core/fontpack.py and core/mailbox.py, simplified for DSH Chat.
//
// Interface\AddOns\DSHChat\mail\00001.ttf .. NNNNN.ttf are 0-byte placeholders (they must exist when the game starts)
// until the bridge writes one packet into a slot, as a font whose glyph widths carry the bytes. The addon reads the slots
// in order. The client caches a font by path until it exits (/reload included) and does not cache a failed load: an
// empty slot can be polled, and a slot is read once per game process. mail\proc.ttf carries a stamp of the game process.
//
// Font packet ("WF" envelope):   "WF" | payload length (2) | payload | CRC-16/CCITT-FALSE of everything before (2)
// DSH payload:                    "DB" | version 1 | flags | slot (4) | part (1) | parts (1) | id length (1) | id | text
// The slot's low byte is data byte 11 (as in Workshop), so the addon can tell cheaply whether the slot's font is loaded.
import fs from 'node:fs';
import path from 'node:path';
import { build } from './ttf.mjs';

export const POOL = 1024;
export const MAX_PAYLOAD = 4096;
const HEAD = 11; // "DB" ver flags slot(4) part parts idLen

export function crc16(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function envelope(payload) {
  const body = Buffer.concat([Buffer.from('WF'), Buffer.from([payload.length >> 8, payload.length & 0xFF]), payload]);
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c >> 8, c & 0xFF])]);
}

export function payload(slot, part, parts, id, text) {
  const idb = Buffer.from(id, 'utf8');
  const head = Buffer.alloc(HEAD);
  head.write('DB', 0, 'latin1');
  head[2] = 1;
  head[3] = 0;
  head.writeUInt32BE(slot, 4);
  head[8] = part;
  head[9] = parts;
  head[10] = idb.length;
  const p = Buffer.concat([head, idb, Buffer.from(text, 'utf8')]);
  if (p.length > MAX_PAYLOAD) throw new Error(`payload of ${p.length} bytes, a slot takes ${MAX_PAYLOAD}`);
  return p;
}

// Splits text into parts that each fit one slot, cutting only between UTF-8 characters.
export function splitText(id, text) {
  const room = MAX_PAYLOAD - HEAD - Buffer.byteLength(id, 'utf8');
  const out = [];
  let data = Buffer.from(text, 'utf8');
  while (data.length) {
    let cut = Math.min(data.length, room);
    while (cut < data.length && cut > 0 && (data[cut] & 0xC0) === 0x80) cut--;
    out.push(data.subarray(0, cut).toString('utf8'));
    data = data.subarray(cut);
  }
  return out.length ? out : [''];
}

export const mailDir = (addonDir) => path.join(addonDir, 'mail');
export const slotPath = (addonDir, slot) => path.join(mailDir(addonDir), `${String(slot).padStart(5, '0')}.ttf`);
export const procPath = (addonDir) => path.join(mailDir(addonDir), 'proc.ttf');

// Replaces the file in one step; the game may hold it open for a moment, so retry for about 1 s.
export async function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  fs.renameSync(tmp, file);
}

// Placeholders that are missing (the client only finds files that exist when it starts).
export function installPlaceholders(addonDir, pool = POOL) {
  const dir = mailDir(addonDir);
  fs.mkdirSync(dir, { recursive: true });
  const have = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
  let made = 0;
  for (let i = 1; i <= pool; i++) {
    const name = `${String(i).padStart(5, '0')}.ttf`;
    if (!have.has(name)) { fs.writeFileSync(path.join(dir, name), Buffer.alloc(0)); made++; }
  }
  if (!have.has('proc.ttf')) fs.writeFileSync(procPath(addonDir), Buffer.alloc(0));
  return made;
}

export function countPlaceholders(addonDir) {
  try { return fs.readdirSync(mailDir(addonDir)).filter((n) => /^\d{5}\.ttf$/i.test(n)).length; } catch { return 0; }
}

// Empties every slot that holds a packet; returns how many.
export async function resetSlots(addonDir) {
  let n = 0;
  for (const name of fs.readdirSync(mailDir(addonDir))) {
    if (!/^\d{5}\.ttf$/i.test(name)) continue;
    const p = path.join(mailDir(addonDir), name);
    try {
      if (fs.statSync(p).size) { await atomicWrite(p, Buffer.alloc(0)); n++; }
    } catch { /* held open: left as it is */ }
  }
  return n;
}

// The highest slot that holds a packet (0: none).
export function lastWritten(addonDir) {
  let top = 0;
  for (const name of fs.readdirSync(mailDir(addonDir))) {
    const m = /^(\d{5})\.ttf$/i.exec(name);
    if (!m) continue;
    try { if (fs.statSync(path.join(mailDir(addonDir), name)).size && +m[1] > top) top = +m[1]; } catch { /* gone */ }
  }
  return top;
}

const STAMP_GLYPHS = 64;
export async function writeProc(addonDir, stamp) {
  const p = envelope(Buffer.from(stamp, 'utf8'));
  if (p.length > STAMP_GLYPHS) throw new Error('stamp too long');
  await atomicWrite(procPath(addonDir), build(Buffer.concat([p, Buffer.alloc(STAMP_GLYPHS - p.length)]), 'DSHProc'));
}

export async function writeSlot(addonDir, slot, part, parts, id, text) {
  const font = build(envelope(payload(slot, part, parts, id, text)), `DSHMail${slot}`);
  await atomicWrite(slotPath(addonDir, slot), font);
}
