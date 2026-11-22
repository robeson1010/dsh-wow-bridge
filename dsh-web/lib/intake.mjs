// Game -> bridge intake. The silent voice (voice/DSHBridgeTts.cs) pushes each spoken message over the named pipe
// \\.\pipe\DSHBridge; when the bridge was not running it wrote the message to %APPDATA%\DSHBridge\tts-inbox\*.txt
// instead, which is read here on start and watched afterwards.
// Messages: "DSHB:<id>:<part>/<parts>:<base64 of the request JSON>" (the game may prefix a "Start" bookmark).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const PIPE = '\\\\.\\pipe\\DSHBridge';
const FRAME = /^\s*(?:Start)?\s*DSHB:([A-Za-z0-9_-]{1,64}):(\d{1,4})\/(\d{1,4}):([A-Za-z0-9+/=\s]*)$/;
const VOICE_TEST = /^\s*(?:Start)?\s*DSHB-VOICE-TEST /;
const MAX_MESSAGE = 200000;
const PART_TTL_MS = 60000;

export class Intake {
  constructor({ inboxDir, onRequest, log }) {
    this.inboxDir = inboxDir;
    this.onRequest = onRequest;
    this.log = log;
    this.parts = new Map(); // id -> { n, got: Map(i -> b64), t }
    this.seen = new Set();
  }

  // one spoken message
  accept(text, via) {
    if (!text.trim()) return; // an empty connection (something probing the pipe)
    if (text.length > MAX_MESSAGE) return this.log(`dropped an oversized message (${text.length} chars)`);
    if (VOICE_TEST.test(text)) return this.log(`voice test received via ${via}`);
    const m = FRAME.exec(text);
    if (!m) return this.log(`dropped a message that is not a DSHB frame (via ${via})`);
    const [, id, i, n, b64] = m;
    const part = +i, parts = +n;
    if (part < 1 || part > parts) return;
    const now = Date.now();
    for (const [k, v] of this.parts) if (now - v.t > PART_TTL_MS) this.parts.delete(k);
    let e = this.parts.get(id);
    if (!e) { e = { n: parts, got: new Map(), t: now }; this.parts.set(id, e); }
    e.got.set(part, b64.replace(/\s+/g, ''));
    if (e.got.size < e.n) return;
    this.parts.delete(id);
    if (this.seen.has(id)) return this.log(`request ${id} already handled (resent)`);
    this.seen.add(id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    const b64all = [...Array(e.n).keys()].map((k) => e.got.get(k + 1)).join('');
    let req;
    try {
      req = JSON.parse(Buffer.from(b64all, 'base64').toString('utf8'));
    } catch (err) {
      return this.log(`request ${id}: bad JSON (${err.message})`);
    }
    if (!req || typeof req !== 'object' || String(req.id) !== id) return this.log(`request ${id}: id mismatch`);
    this.onRequest(req, via);
  }

  startPipe(name = PIPE) {
    this.server = net.createServer((sock) => {
      const chunks = [];
      let size = 0;
      sock.on('data', (d) => {
        size += d.length;
        if (size > MAX_MESSAGE * 4) { sock.destroy(); return; }
        chunks.push(d);
      });
      sock.on('end', () => {
        try { this.accept(Buffer.concat(chunks).toString('utf8'), 'pipe'); } catch (e) { this.log(`pipe message error: ${e.message}`); }
      });
      sock.on('error', () => {});
    });
    this.server.on('error', (e) => {
      this.log(`pipe error: ${e.message}${e.code === 'EADDRINUSE' ? ' (is another bridge running?)' : ''}`);
      if (e.code === 'EADDRINUSE') process.exit(2);
    });
    this.server.listen(name, () => this.log(`listening on ${name}`));
  }

  // fallback folder: what arrived while no bridge ran, then anything new
  startInbox() {
    fs.mkdirSync(this.inboxDir, { recursive: true });
    const take = (name) => {
      if (!name.endsWith('.txt')) return;
      const p = path.join(this.inboxDir, name);
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
      try { fs.rmSync(p, { force: true }); } catch { /* next time */ }
      try { this.accept(text, 'file'); } catch (e) { this.log(`inbox message error: ${e.message}`); }
    };
    for (const name of fs.readdirSync(this.inboxDir).sort()) take(name);
    this.watcher = fs.watch(this.inboxDir, (ev, name) => { if (name) setTimeout(() => take(String(name)), 20); });
    this.watcher.on('error', (e) => this.log(`inbox watch error: ${e.message}`));
  }

  close() {
    this.server?.close();
    this.watcher?.close();
  }
}
