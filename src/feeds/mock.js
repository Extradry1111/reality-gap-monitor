import { Feed } from './feed.js';

/**
 * Simulated market for --demo: a reference random walk plus a "Metric pool" that tracks it with
 * small noise, and now and then a dislocation (pool drifts off) or a freeze (pool stops updating),
 * so every dashboard state and alert can be seen without any network access.
 */
export class MockMarket {
  constructor({ id, start, volBps = 4, tickMs = 1000, eventEverySec = 90 }) {
    Object.assign(this, { id, volBps, tickMs, eventEverySec });
    this.ref = start;
    this.pool = start;
    this.offsetBps = 0;
    this.targetOffsetBps = 0;
    this.frozenUntil = 0;
    this.eventEndsAt = 0;
    this.refFeed = new Feed(`mock-ref:${id}`, 'Simulated CEX');
    this.poolFeed = new Feed(`mock-pool:${id}`, 'Simulated Metric pool');
  }

  step(now = Date.now()) {
    const shock = (Math.random() - 0.5) * 2 * this.volBps * 1e-4;
    this.ref *= 1 + shock;

    if (now > this.eventEndsAt && this.targetOffsetBps !== 0) this.targetOffsetBps = 0;
    if (now > this.eventEndsAt && Math.random() < this.tickMs / 1000 / this.eventEverySec) {
      const dur = 20_000 + Math.random() * 40_000;
      this.eventEndsAt = now + dur;
      if (Math.random() < 0.5) this.frozenUntil = now + dur + 30_000;
      else this.targetOffsetBps = (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 60);
    }
    this.offsetBps += (this.targetOffsetBps - this.offsetBps) * 0.15;

    if (now >= this.frozenUntil) {
      const noise = (Math.random() - 0.5) * 3;
      this.pool = this.ref * (1 + (this.offsetBps + noise) * 1e-4);
    }
    this.refFeed.set(this.ref, now);
    this.poolFeed.set(this.pool, now);
  }

  start() {
    this.step();
    this.timer = setInterval(() => this.step(), this.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }
}

export function demoConfig() {
  const pool = (id, label, chain, kind, start, extra = {}) => ({
    id,
    label,
    chain,
    kind,
    feeBps: 5,
    pool: { type: 'mock', start },
    reference: { sources: [{ type: 'mock' }] },
    ...extra,
  });
  return {
    demo: true,
    server: { host: '0.0.0.0', port: Number(process.env.PORT) || 8787 },
    alerts: { defaultThresholdBps: 25, staleAfterSec: 30, staleRefMoveBps: 8 },
    chains: {},
    pools: [
      pool('eth-usdc-eth', 'ETH / USDC', 'ethereum', 'crypto', 3000),
      pool('btc-usdc-eth', 'WBTC / USDC', 'ethereum', 'crypto', 95000),
      pool('bnb-usdt-bsc', 'BNB / USDT', 'bnb', 'crypto', 650),
      pool('tsla-usd-rh', 'TSLA / USD', 'robinhood', 'stock', 250, { marketHours: 'always' }),
      pool('nvda-usd-rh', 'NVDA / USD', 'robinhood', 'stock', 180),
    ],
  };
}
