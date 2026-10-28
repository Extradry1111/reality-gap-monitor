import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fmtBps, fmtPrice, log } from './util.js';

export const ALERT_DEFAULTS = {
  defaultThresholdBps: 30,
  confirmSec: 3, // gap must hold this long before alerting (filters one-tick blips)
  hysteresis: 0.8, // alert clears once |gap| < threshold * hysteresis
  renotifyFactor: 2, // re-notify while open if the gap widens by this factor
  staleAfterSec: 60,
  staleRefMoveBps: 15,
  feedDownSec: 30,
  alertWhenMarketClosed: false,
};

export function describe(ev) {
  const { label, chain } = ev.pool;
  const name = `${label} (${chain})`;
  switch (ev.type) {
    case 'gap_open':
    case 'gap_widen': {
      const above = ev.gapBps > 0;
      const verb = ev.type === 'gap_widen' ? 'gap widened' : 'gap opened';
      return (
        `${above ? '🔺' : '🔻'} ${name}: ${verb} — Metric is ${Math.abs(ev.gapBps).toFixed(1)} bps ${above ? 'ABOVE' : 'BELOW'} reality ` +
        `(pool ${fmtPrice(ev.poolPrice)} vs ref ${fmtPrice(ev.refPrice)}). ` +
        `Signal: ${above ? 'sell on Metric / buy reference' : 'buy on Metric / sell reference'}` +
        (ev.feeBps ? `, edge after ${ev.feeBps} bps fee ≈ ${Math.max(0, Math.abs(ev.gapBps) - ev.feeBps).toFixed(1)} bps.` : '.')
      );
    }
    case 'gap_close':
      return `✅ ${name}: gap closed, back to ${fmtBps(ev.gapBps)}.`;
    case 'stale_open':
      return `⏸ ${name}: pool price unchanged for ${ev.staleSec}s while reality moved ${ev.refMoveBps.toFixed(1)} bps — stale-price risk for LPs.`;
    case 'stale_close':
      return `▶️ ${name}: pool price is updating again.`;
    case 'feed_down':
      return `⚠️ ${name}: ${ev.detail}`;
    case 'feed_up':
      return `🔌 ${name}: feeds recovered.`;
    default:
      return `${name}: ${ev.type}`;
  }
}

/** Turns per-tick pool state into open/close alert events, with debounce, hysteresis and re-notify. */
export class Alerts extends EventEmitter {
  constructor(opts = {}, { dir, notifiers = [] } = {}) {
    super();
    this.opts = { ...ALERT_DEFAULTS, ...opts };
    this.notifiers = notifiers;
    this.state = new Map();
    this.log = [];
    this.file = dir ? path.join(dir, 'alerts.jsonl') : null;
    if (this.file) this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-500);
    for (const l of lines) {
      try {
        this.log.push(JSON.parse(l));
      } catch {}
    }
    fs.writeFileSync(this.file, this.log.map((e) => JSON.stringify(e)).join('\n') + (this.log.length ? '\n' : ''));
  }

  recent(limit = 100) {
    return this.log.slice(-limit).reverse();
  }

  thresholdFor(poolCfg) {
    return poolCfg.thresholdBps ?? this.opts.defaultThresholdBps;
  }

  st(id) {
    if (!this.state.has(id)) {
      this.state.set(id, { gapOpen: false, gapSince: null, notifiedAbs: 0, staleOpen: false, downOpen: false, downSince: null });
    }
    return this.state.get(id);
  }

  isOpen(id) {
    const s = this.st(id);
    return { gap: s.gapOpen, stale: s.staleOpen, down: s.downOpen };
  }

  evaluate(poolCfg, s, now = Date.now()) {
    const o = this.opts;
    const st = this.st(poolCfg.id);
    const base = { pool: { id: poolCfg.id, label: poolCfg.label, chain: poolCfg.chain }, poolPrice: s.poolPrice, refPrice: s.refPrice, gapBps: s.gapBps, feeBps: poolCfg.feeBps ?? 0 };

    // feed health
    if (s.feedProblem) {
      st.downSince ??= now;
      if (!st.downOpen && now - st.downSince >= o.feedDownSec * 1000) {
        st.downOpen = true;
        this.fire({ ...base, type: 'feed_down', severity: 'warn', detail: s.feedProblem }, now);
      }
    } else {
      st.downSince = null;
      if (st.downOpen) {
        st.downOpen = false;
        this.fire({ ...base, type: 'feed_up', severity: 'info' }, now);
      }
    }

    // price gap
    const threshold = this.thresholdFor(poolCfg);
    const allowed = s.gapBps != null && !s.feedProblem && (s.marketOpen || o.alertWhenMarketClosed);
    const abs = allowed ? Math.abs(s.gapBps) : 0;
    if (allowed && abs >= threshold) {
      st.gapSince ??= now;
      if (!st.gapOpen && now - st.gapSince >= o.confirmSec * 1000) {
        st.gapOpen = true;
        st.notifiedAbs = abs;
        this.fire({ ...base, type: 'gap_open', severity: 'alert', thresholdBps: threshold }, now);
      } else if (st.gapOpen && abs >= st.notifiedAbs * o.renotifyFactor) {
        st.notifiedAbs = abs;
        this.fire({ ...base, type: 'gap_widen', severity: 'alert', thresholdBps: threshold }, now);
      }
    } else {
      st.gapSince = null;
      if (st.gapOpen && (!allowed || abs < threshold * o.hysteresis)) {
        st.gapOpen = false;
        this.fire({ ...base, type: 'gap_close', severity: 'info', thresholdBps: threshold }, now);
      }
    }

    // stale pool price
    if (s.stale && !st.staleOpen) {
      st.staleOpen = true;
      this.fire({ ...base, type: 'stale_open', severity: 'warn', staleSec: Math.round(s.staleSec), refMoveBps: s.refMoveBps }, now);
    } else if (!s.stale && st.staleOpen && !s.feedProblem) {
      st.staleOpen = false;
      this.fire({ ...base, type: 'stale_close', severity: 'info' }, now);
    }
  }

  fire(ev, now) {
    ev.id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    ev.ts = now;
    ev.message = describe(ev);
    this.log.push(ev);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    if (this.file) fs.appendFile(this.file, JSON.stringify(ev) + '\n', () => {});
    log.info(`ALERT ${ev.message}`);
    this.emit('alert', ev);
    for (const n of this.notifiers) n(ev).catch((err) => log.warn(`notifier: ${err.message}`));
  }
}
