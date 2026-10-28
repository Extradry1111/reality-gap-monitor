import { EventEmitter } from 'node:events';
import { log } from '../util.js';

/**
 * A single live price. `latest.ts` is when we last observed the price (even if unchanged),
 * so a quiet-but-healthy feed stays fresh and a dead one ages out.
 */
export class Feed extends EventEmitter {
  constructor(key, label) {
    super();
    this.key = key;
    this.label = label;
    this.latest = null;
    this.error = null;
  }

  set(price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return this.fail(new Error(`invalid price ${price}`));
    this.latest = { price, ts };
    this.error = null;
    this.emit('price', this.latest);
  }

  fail(err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (msg !== this.error) log.warn(`[${this.label}] ${msg}`);
    this.error = msg;
  }

  start() {}
  stop() {}
}

/** Feed that calls `read()` every `pollMs`, never overlapping two reads. */
export class PollingFeed extends Feed {
  constructor(key, label, pollMs, read) {
    super(key, label);
    this.pollMs = pollMs;
    this.read = read;
    this.timer = null;
  }

  start() {
    const loop = async () => {
      try {
        this.set(await this.read());
      } catch (err) {
        this.fail(err);
      }
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    this.running = true;
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}

/** WebSocket with exponential-backoff reconnects and an idle watchdog. */
export class ReconnectingSocket {
  constructor(name, url, { onOpen, onMessage, idleMs = 30_000 }) {
    Object.assign(this, { name, url, onOpen, onMessage, idleMs });
    this.attempt = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    this.detach()?.close();
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(typeof this.url === 'function' ? this.url() : this.url);
    } catch (err) {
      log.warn(`[${this.name}] ${err.message}`);
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      log.info(`[${this.name}] connected`);
      this.touch();
      this.onOpen?.(ws);
    };
    ws.onmessage = (ev) => {
      this.touch();
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      } catch {
        return;
      }
      this.onMessage(msg, ws);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      log.warn(`[${this.name}] disconnected (${ev.code})`);
      this.detach();
      this.retry();
    };
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.warn(`[${this.name}] no data for ${this.idleMs / 1000}s, reconnecting`);
      try {
        this.detach()?.close();
      } catch {}
      this.retry();
    }, this.idleMs);
  }

  detach() {
    const ws = this.ws;
    if (ws) ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.ws = null;
    return ws;
  }

  retry() {
    clearTimeout(this.idleTimer);
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) + Math.random() * 500;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
