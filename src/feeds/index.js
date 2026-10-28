import { BinanceHub, CoinbaseHub, FinnhubHub, YahooHub } from './exchanges.js';
import { evmCallFeed, httpJsonFeed, makeProvider } from './onchain.js';
import { MockMarket } from './mock.js';

/** Builds and de-duplicates every feed the configured pools need, sharing connections. */
export class FeedRegistry {
  constructor(config) {
    const refs = config.references ?? {};
    this.config = config;
    this.hubs = {
      binance: new BinanceHub(refs.binance),
      coinbase: new CoinbaseHub(refs.coinbase),
      finnhub: new FinnhubHub(refs.finnhub),
      yahoo: new YahooHub(refs.yahoo),
    };
    this.providers = new Map();
    this.feeds = new Map();
    this.mocks = new Map();
  }

  provider(chain) {
    if (!this.providers.has(chain)) this.providers.set(chain, makeProvider(chain, this.config.chains?.[chain]));
    return this.providers.get(chain);
  }

  own(feed) {
    if (!this.feeds.has(feed.key)) this.feeds.set(feed.key, feed);
    return this.feeds.get(feed.key);
  }

  mock(poolCfg) {
    if (!this.mocks.has(poolCfg.id)) {
      this.mocks.set(poolCfg.id, new MockMarket({ id: poolCfg.id, start: poolCfg.pool.start ?? 100 }));
    }
    return this.mocks.get(poolCfg.id);
  }

  /** spec.type: binance | coinbase | finnhub | yahoo | evm-call | http-json | mock */
  create(spec, poolCfg, role) {
    switch (spec.type) {
      case 'binance':
      case 'coinbase':
      case 'finnhub':
      case 'yahoo':
        return this.hubs[spec.type].feed(spec.symbol);
      case 'evm-call': {
        const chain = spec.chain ?? poolCfg.chain;
        return this.own(evmCallFeed({ ...spec, chain }, this.provider(chain)));
      }
      case 'http-json':
        return this.own(httpJsonFeed(spec));
      case 'mock': {
        const m = this.mock(poolCfg);
        return role === 'pool' ? m.poolFeed : m.refFeed;
      }
      default:
        throw new Error(`pool "${poolCfg.id}": unknown ${role} source type "${spec.type}"`);
    }
  }

  start() {
    for (const h of Object.values(this.hubs)) h.start();
    for (const f of this.feeds.values()) f.start();
    for (const m of this.mocks.values()) m.start();
  }

  stop() {
    for (const h of Object.values(this.hubs)) h.stop();
    for (const f of this.feeds.values()) f.stop();
    for (const m of this.mocks.values()) m.stop();
    for (const p of this.providers.values()) p.destroy();
  }
}
