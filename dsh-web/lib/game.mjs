// Follows the game process (Wow.exe): the font mailbox starts over for every new game process, because the client
// caches every font it read until it exits.
import { execFile } from 'node:child_process';

export function wowPid(image = 'Wow.exe') {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /^"[^"]+","(\d+)"/m.exec(String(out));
      resolve(m ? +m[1] : null);
    });
  });
}

export class GameWatch {
  constructor({ onStart, onExit, log, everyMs = 2000 }) {
    Object.assign(this, { onStart, onExit, log, everyMs });
    this.pid = undefined; // undefined: not looked yet; null: not running
  }

  async tick() {
    const pid = await wowPid();
    if (pid === this.pid) return;
    const before = this.pid;
    this.pid = pid;
    if (pid) await this.onStart(pid, before === undefined);
    else if (before) await this.onExit(before);
    else if (before === undefined) this.log('the game is not running');
  }

  start() {
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log(`game watch error: ${e.message}`); }
      this.timer = setTimeout(loop, this.everyMs);
    };
    return loop();
  }

  stop() { clearTimeout(this.timer); }
}
