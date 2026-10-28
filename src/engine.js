import { EventEmitter } from 'node:events';
import { combine, gapBps } from './util.js';
import { isMarketOpen } from './marketHours.js';

export const ENGINE_DEFAULTS = {
  tickMs: 1000,
  sampleMs: 2000,
  maxRefAgeMs: 15_000,
  maxPoolAgeMs: 30_000,
};

/**
 * Once per tick, for every pool: take the pool's price and the combined reference price, compute
 * the gap, track how long the pool price has been frozen, feed the alert state machine, and
 * record a history sample.
 */
export class Engine extends EventEmitter {
  constructor({ pools, registry, history, alerts, opts = {} }) {
    super();
    this.opts = { ...ENGINE_DEFAULTS, ...opts };
    this.history = history;
    this.alerts = alerts;
    this.pools = pools.map((cfg) => ({
      cfg,
      poolFeed: registry.create(cfg.pool, cfg, 'pool'),
      refFeeds: cfg.reference.sources.map((s) => registry.create(s, cfg, 'reference')),
      lastPoolPrice: null,
      lastChangeTs: null,
      refAtChange: null,
      lastSampleTs: 0,
      state: null,
    }));
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(now = Date.now()) {
    for (const p of this.pools) {
      p.state = this.compute(p, now);
      this.alerts.evaluate(p.cfg, p.state, now);
      p.state.alerts = this.alerts.isOpen(p.cfg.id);
      p.state.status = statusOf(p.state);
      if (p.state.gapBps != null && now - p.lastSampleTs >= this.opts.sampleMs) {
        p.lastSampleTs = now;
        this.history.add(p.cfg.id, [now, round(p.state.poolPrice), round(p.state.refPrice), round(p.state.gapBps, 2)]);
      }
    }
    this.emit('tick', this.snapshot(), now);
  }

  compute(p, now) {
    const { cfg } = p;
    const o = this.opts;
    const marketMode = cfg.marketHours ?? (cfg.kind === 'stock' ? 'us-equity' : 'always');
    const marketOpen = isMarketOpen(marketMode, new Date(now));

    const pool = p.poolFeed.latest;
    const poolFresh = pool && now - pool.ts <= o.maxPoolAgeMs;

    // off-hours stock quotes legitimately stop updating, so don't age them out while closed
    const refs = p.refFeeds.map((f) => ({
      key: f.key,
      label: f.label,
      price: f.latest?.price ?? null,
      ageMs: f.latest ? now - f.latest.ts : null,
      error: f.error,
    }));
    const usable = refs.filter((r) => r.price != null && (!marketOpen || r.ageMs <= o.maxRefAgeMs));
    const refPrice = combine(usable.map((r) => r.price), cfg.reference.combine);
    const poolPrice = poolFresh ? pool.price : null;
    const gap = gapBps(poolPrice, refPrice);

    let feedProblem = null;
    if (!pool) feedProblem = p.poolFeed.error ? `pool feed error: ${p.poolFeed.error}` : 'waiting for pool price';
    else if (!poolFresh) feedProblem = `pool price is ${Math.round((now - pool.ts) / 1000)}s old${p.poolFeed.error ? ` (${p.poolFeed.error})` : ''}`;
    else if (refPrice == null) feedProblem = `no fresh reference price${refs.find((r) => r.error) ? ` (${refs.find((r) => r.error).error})` : ''}`;

    // staleness: pool price frozen while the real world kept moving
    if (poolPrice != null && poolPrice !== p.lastPoolPrice) {
      p.lastPoolPrice = poolPrice;
      p.lastChangeTs = now;
      p.refAtChange = refPrice;
    }
    if (p.refAtChange == null && refPrice != null) p.refAtChange = refPrice;
    const staleSec = p.lastChangeTs ? (now - p.lastChangeTs) / 1000 : 0;
    const refMoveBps = refPrice != null && p.refAtChange ? Math.abs(gapBps(refPrice, p.refAtChange)) : 0;
    const a = this.alerts.opts;
    const stale = !feedProblem && marketOpen && staleSec >= a.staleAfterSec && refMoveBps >= a.staleRefMoveBps;

    const refPrices = usable.map((r) => r.price);
    const refSpreadBps = refPrices.length > 1 ? gapBps(Math.max(...refPrices), Math.min(...refPrices)) : null;
    const feeBps = cfg.feeBps ?? 0;

    return {
      id: cfg.id,
      label: cfg.label,
      chain: cfg.chain,
      kind: cfg.kind ?? 'crypto',
      venue: p.poolFeed.label,
      poolPrice,
      refPrice,
      refs,
      refSpreadBps,
      gapBps: gap,
      feeBps,
      netEdgeBps: gap == null ? null : Math.max(0, Math.abs(gap) - feeBps),
      thresholdBps: this.alerts.thresholdFor(cfg),
      marketOpen,
      marketMode,
      staleSec,
      refMoveBps,
      stale,
      feedProblem,
    };
  }

  snapshot() {
    return this.pools.map((p) => p.state).filter(Boolean);
  }
}

function statusOf(s) {
  if (s.feedProblem) return s.alerts.down ? 'feed_down' : 'warming';
  if (!s.marketOpen) return 'market_closed';
  if (s.alerts.gap) return 'alert';
  if (s.stale) return 'stale';
  if (Math.abs(s.gapBps ?? 0) >= s.thresholdBps) return 'watch';
  return 'ok';
}

function round(x, decimals) {
  if (x == null) return null;
  return decimals == null ? Number(x.toPrecision(10)) : Number(x.toFixed(decimals));
}
