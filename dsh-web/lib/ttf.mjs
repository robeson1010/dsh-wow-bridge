// Zero-dependency TrueType writer for the font return channel.
// Port of Wuxian Workshop's src/wuxianworkshop/core/ttf.py (MIT, Copyright (c) 2026 kk8o).
//
// The font carries bytes in glyph advance widths: 1024 units per em, glyph order `.notdef`, `space`, `d0` .. `dN`,
// with d_i advancing (16 + v_i) * 16 units for the value sequence [0, 255] + data (the first two calibrate).
// U+0020 maps to `space`, U+E000 + i to d_i. Every d_i and `.notdef` is the same 64 x 512 box, so the ink is constant
// and only the advance differs; the addon (Font.lua) measures it back. Output is byte-reproducible.

export const UPEM = 1024;
export const BASE = 0xE000;
const ASCENT = 896, DESCENT = -128;
const BOX = [[0, 0], [64, 0], [64, 512], [0, 512]];
export const MAX_DATA = 0xFFFF - BASE - 2;
const TIMESTAMP = 3850070400n; // 2026-01-01T00:00:00Z since 1904-01-01
const VENDOR = Buffer.from('DSHB');
const LAYOUT = ['head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'loca', 'glyf', 'name', 'post'];
const ON_CURVE = 0x01, X_SHORT = 0x02, Y_SHORT = 0x04, X_SAME = 0x10, Y_SAME = 0x20;

export const advance = (v) => (16 + v) * 16;

// Big-endian writer helpers.
function pack(spec, ...vals) {
  // spec letters: B u8, H u16, h i16, I u32, i i32, q i64 (BigInt)
  const size = { B: 1, H: 2, h: 2, I: 4, i: 4, q: 8 };
  let len = 0;
  for (const c of spec) len += size[c];
  const b = Buffer.alloc(len);
  let o = 0;
  [...spec].forEach((c, k) => {
    const v = vals[k];
    switch (c) {
      case 'B': b.writeUInt8(v & 0xFF, o); break;
      case 'H': b.writeUInt16BE(v & 0xFFFF, o); break;
      case 'h': b.writeInt16BE(v, o); break;
      case 'I': b.writeUInt32BE(v >>> 0, o); break;
      case 'i': b.writeInt32BE(v, o); break;
      case 'q': b.writeBigInt64BE(BigInt(v), o); break;
    }
    o += size[c];
  });
  return b;
}

export function checksum(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const d = pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum = (sum + d.readUInt32BE(i)) >>> 0;
  return sum >>> 0;
}

function bbox(contours) {
  const xs = contours.flat().map((p) => p[0]);
  const ys = contours.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function delta(d, shortBit, sameBit, out) {
  if (d === 0) return sameBit;
  if (d >= -255 && d <= 255) {
    out.push(Math.abs(d));
    return shortBit | (d > 0 ? sameBit : 0);
  }
  const b = Buffer.alloc(2);
  b.writeInt16BE(d);
  out.push(b[0], b[1]);
  return 0;
}

function simpleGlyph(contours) {
  const ends = [];
  let count = 0;
  for (const c of contours) { count += c.length; ends.push(count - 1); }
  const flags = [], xs = [], ys = [];
  let px = 0, py = 0;
  for (const [x, y] of contours.flat()) {
    let f = ON_CURVE;
    f |= delta(x - px, X_SHORT, X_SAME, xs);
    f |= delta(y - py, Y_SHORT, Y_SAME, ys);
    flags.push(f);
    px = x; py = y;
  }
  const [x0, y0, x1, y1] = bbox(contours);
  return Buffer.concat([
    pack('hhhhh', contours.length, x0, y0, x1, y1),
    Buffer.concat(ends.map((e) => pack('H', e))), pack('H', 0),
    Buffer.from(flags), Buffer.from(xs), Buffer.from(ys),
  ]);
}

function glyfLoca(glyphs) {
  const offsets = [];
  const parts = [];
  let len = 0;
  for (const g of glyphs) {
    offsets.push(len);
    parts.push(g);
    len += g.length;
    if (len & 1) { parts.push(Buffer.alloc(1)); len += 1; }
  }
  offsets.push(len);
  const glyf = Buffer.concat(parts);
  if (offsets[offsets.length - 1] <= 2 * 0xFFFF) {
    return [glyf, Buffer.concat(offsets.map((o) => pack('H', o / 2))), 0];
  }
  return [glyf, Buffer.concat(offsets.map((o) => pack('I', o))), 1];
}

function head(locaFormat, bb) {
  const b = Buffer.concat([
    pack('IIIIHH', 0x00010000, 0x00010000, 0, 0x5F0F3CF5, 0x0003, UPEM),
    pack('qq', TIMESTAMP, TIMESTAMP),
    pack('hhhh', ...bb),
    pack('HHhhh', 0, 3, 2, locaFormat, 0),
  ]);
  if (b.length !== 54) throw new Error('head size');
  return b;
}

function hhea(advances, bboxes) {
  const inked = advances.map((a, i) => [a, bboxes[i]]).filter(([, b]) => b);
  const b = pack('Ihhh' + 'H' + 'hhh' + 'hhh' + 'hhhh' + 'h' + 'H',
    0x00010000, ASCENT, DESCENT, 0,
    Math.max(...advances),
    Math.min(...inked.map(([, bb]) => bb[0])),
    Math.min(...inked.map(([a, bb]) => a - bb[2])),
    Math.max(...inked.map(([, bb]) => bb[2])),
    1, 0, 0,
    0, 0, 0, 0,
    0,
    advances.length);
  if (b.length !== 36) throw new Error('hhea size');
  return b;
}

function maxp(numGlyphs) {
  const b = pack('I' + 'H'.repeat(14), 0x00010000, numGlyphs, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0);
  if (b.length !== 32) throw new Error('maxp size');
  return b;
}

function os2(advances, lastChar) {
  const widths = advances.filter((a) => a);
  const sum = widths.reduce((s, a) => s + a, 0);
  const avg = Math.floor((2 * sum + widths.length) / (2 * widths.length));
  const b = Buffer.concat([
    pack('HhHHH', 4, avg, 400, 5, 0),
    pack('hhhhhhhhhh', 665, 716, 0, 143, 665, 716, 0, 491, 51, 266),
    pack('h', 0),
    Buffer.alloc(10),
    pack('IIII', 1, 1 << 28, 0, 0),
    VENDOR,
    pack('H', 0x0040),
    pack('HH', 0x20, lastChar),
    pack('hhh', ASCENT, DESCENT, 0),
    pack('HH', ASCENT, -DESCENT),
    pack('II', 0, 0),
    pack('hh', 0, 0),
    pack('HHH', 0, 0x20, 0),
  ]);
  if (b.length !== 96) throw new Error('OS/2 size');
  return b;
}

const hmtx = (advances) => Buffer.concat(advances.map((a) => pack('Hh', a, 0)));

function cmap(ranges) {
  const segs = ranges.map(([start, end, gid]) => [start, end, (gid - start) & 0xFFFF]).concat([[0xFFFF, 0xFFFF, 1]]);
  const n = segs.length;
  const entrySelector = 31 - Math.clz32(n);
  const searchRange = 2 << entrySelector;
  const sub = Buffer.concat([
    pack('HHHHHHH', 4, 16 + 8 * n, 0, 2 * n, searchRange, entrySelector, 2 * n - searchRange),
    Buffer.concat(segs.map(([, end]) => pack('H', end))), pack('H', 0),
    Buffer.concat(segs.map(([start]) => pack('H', start))),
    Buffer.concat(segs.map(([, , d]) => pack('H', d))),
    Buffer.concat(segs.map(() => pack('H', 0))),
  ]);
  return Buffer.concat([pack('HHHHI', 0, 1, 3, 1, 12), sub]);
}

function name(fontName) {
  const strings = { 1: fontName, 2: 'Regular', 3: fontName, 4: fontName, 5: 'Version 1.0', 6: fontName };
  const pool = [];
  let poolLen = 0;
  const where = new Map();
  const records = [];
  for (const nid of Object.keys(strings).map(Number).sort((a, b) => a - b)) {
    const text = Buffer.from(strings[nid], 'utf16le').swap16();
    const key = text.toString('hex');
    if (!where.has(key)) { where.set(key, poolLen); pool.push(text); poolLen += text.length; }
    records.push(pack('HHHHHH', 3, 1, 0x0409, nid, text.length, where.get(key)));
  }
  return Buffer.concat([pack('HHH', 0, records.length, 6 + 12 * records.length), ...records, ...pool]);
}

const post = () => pack('IIhhIIIII', 0x00030000, 0, 0, 0, 0, 0, 0, 0, 0);

function sfnt(tables) {
  const tags = Object.keys(tables).sort();
  const order = LAYOUT.filter((t) => t in tables).concat(tags.filter((t) => !LAYOUT.includes(t)));
  const n = tags.length;
  const entrySelector = 31 - Math.clz32(n);
  const searchRange = 16 << entrySelector;
  const header = pack('IHHHH', 0x00010000, n, searchRange, entrySelector, 16 * n - searchRange);
  const offsets = {};
  const body = [];
  let offset = 12 + 16 * n;
  for (const tag of order) {
    offsets[tag] = offset;
    const t = tables[tag];
    const padded = Buffer.concat([t, Buffer.alloc((4 - (t.length % 4)) % 4)]);
    body.push(padded);
    offset += padded.length;
  }
  const dir = Buffer.concat(tags.map((tag) => Buffer.concat([
    Buffer.from(tag.padEnd(4, ' '), 'latin1'), pack('III', checksum(tables[tag]), offsets[tag], tables[tag].length),
  ])));
  const font = Buffer.concat([header, dir, ...body]);
  font.writeUInt32BE((0xB1B0AFBA - checksum(font)) >>> 0, offsets.head + 8);
  return font;
}

// TTF bytes with the two calibration glyphs and one glyph per byte of `data`.
export function build(data, fontName) {
  const values = [0, 255, ...data];
  if (values.length - 2 > MAX_DATA) throw new Error(`${values.length - 2} data bytes need code points past U+FFFE`);
  const box = simpleGlyph([BOX]);
  const bb = bbox([BOX]);
  const glyphs = [box, Buffer.alloc(0), ...values.map(() => box)];
  const bboxes = [bb, null, ...values.map(() => bb)];
  const advances = [512, 256, ...values.map(advance)];
  const [glyf, loca, locaFormat] = glyfLoca(glyphs);
  const lastChar = BASE + values.length - 1;
  return sfnt({
    head: head(locaFormat, bb),
    hhea: hhea(advances, bboxes),
    maxp: maxp(glyphs.length),
    'OS/2': os2(advances, lastChar),
    hmtx: hmtx(advances),
    cmap: cmap([[0x20, 0x20, 1], [BASE, lastChar, 2]]),
    loca,
    glyf,
    name: name(fontName),
    post: post(),
  });
}

// Reads the advance widths of glyphs U+E000.. back from a font built here (tests): [advance units...].
export function readAdvances(font) {
  const n = font.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tables[font.toString('latin1', o, o + 4)] = { offset: font.readUInt32BE(o + 8), length: font.readUInt32BE(o + 12) };
  }
  const numH = font.readUInt16BE(tables.hhea.offset + 34);
  const adv = [];
  for (let g = 0; g < numH; g++) adv.push(font.readUInt16BE(tables.hmtx.offset + 4 * g));
  return adv.slice(2); // glyphs 2.. are U+E000..
}
