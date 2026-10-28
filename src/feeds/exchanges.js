import { Feed, PollingFeed, ReconnectingSocket } from './feed.js';
import { fetchJson } from '../util.js';

/** Several pools can watch the same symbol; a hub shares one connection per venue. */
class Hub {
  constructor(venue) {
    this.venue = venue;
    this.feeds = new Map();
  }

  feed(symbol) {
    const s = this.normalize(symbol);
    if (!this.feeds.has(s)) this.feeds.set(s, new Feed(`${this.venue.toLowerCase()}:${s}`, `${this.venue} ${s}`));
    return this.feeds.get(s);
  }

  normalize(s) {
    return String(s).toUpperCase();
  }

  stop() {
    this.sock?.stop();
  }
}

// ---- Binance: best bid/ask stream, priced at the mid ----

export function parseBinance(msg) {
  const d = msg?.data ?? msg;
  if (!d?.s || d.b == null || d.a == null) return null;
  const bid = Number(d.b);
  const ask = Number(d.a);
  return { symbol: d.s.toUpperCase(), price: (bid + ask) / 2 };
}

export class BinanceHub extends Hub {
  constructor({ wsBase = 'wss://stream.binance.com:9443' } = {}) {
    super('Binance');
    this.wsBase = wsBase;
  }

  start() {
    if (!this.feeds.size) return;
    const streams = [...this.feeds.keys()].map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
    this.sock = new ReconnectingSocket('binance', `${this.wsBase}/stream?streams=${streams}`, {
      onMessage: (msg) => {
        const t = parseBinance(msg);
        if (t) this.feeds.get(t.symbol)?.set(t.price);
      },
    });
    this.sock.start();
  }
}

// ---- Coinbase Exchange: ticker channel, priced at the mid ----

export function parseCoinbase(msg) {
  if (msg?.type !== 'ticker' || !msg.product_id) return null;
  const bid = Number(msg.best_bid);
  const ask = Number(msg.best_ask);
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(msg.price);
  return { symbol: msg.product_id.toUpperCase(), price };
}

export class CoinbaseHub extends Hub {
  constructor({ wsUrl = 'wss://ws-feed.exchange.coinbase.com' } = {}) {
    super('Coinbase');
    this.wsUrl = wsUrl;
  }

  start() {
    if (!this.feeds.size) return;
    const product_ids = [...this.feeds.keys()];
    this.sock = new ReconnectingSocket('coinbase', this.wsUrl, {
      // heartbeat keeps quiet markets from tripping the idle watchdog
      onOpen: (ws) => ws.send(JSON.stringify({ type: 'subscribe', product_ids, channels: ['ticker', 'heartbeat'] })),
      onMessage: (msg) => {
        const t = parseCoinbase(msg);
        if (t) this.feeds.get(t.symbol)?.set(t.price);
        else if (msg.type === 'heartbeat') {
          // no trade, but the last price is still current
          const f = this.feeds.get(msg.product_id);
          if (f?.latest) f.set(f.latest.price);
        }
      },
    });
    this.sock.start();
  }
}

// ---- Finnhub: real-time US stock trades (free API key) ----

export function parseFinnhub(msg) {
  if (msg?.type !== 'trade' || !Array.isArray(msg.data)) return [];
  const last = new Map();
  for (const t of msg.data) last.set(t.s.toUpperCase(), Number(t.p));
  return [...last].map(([symbol, price]) => ({ symbol, price }));
}

export class FinnhubHub extends Hub {
  constructor({ token } = {}) {
    super('Finnhub');
    this.token = token;
  }

  start() {
    if (!this.feeds.size) return;
    if (!this.token) {
      for (const f of this.feeds.values()) f.fail(new Error('FINNHUB_TOKEN is not set'));
      return;
    }
    this.sock = new ReconnectingSocket('finnhub', `wss://ws.finnhub.io?token=${this.token}`, {
      idleMs: 90_000,
      onOpen: (ws) => {
        for (const symbol of this.feeds.keys()) ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      },
      onMessage: (msg) => {
        for (const t of parseFinnhub(msg)) this.feeds.get(t.symbol)?.set(t.price);
        if (msg.type === 'ping') {
          for (const f of this.feeds.values()) if (f.latest) f.set(f.latest.price);
        }
      },
    });
    this.sock.start();
  }
}

// ---- Yahoo Finance: keyless polling fallback for stocks ----

export function parseYahoo(json) {
  const meta = json?.chart?.result?.[0]?.meta;
  return meta ? Number(meta.regularMarketPrice) : null;
}

export class YahooHub extends Hub {
  constructor({ pollMs = 15_000 } = {}) {
    super('Yahoo');
    this.pollMs = pollMs;
    this.pollers = [];
  }

  feed(symbol) {
    const s = this.normalize(symbol);
    if (!this.feeds.has(s)) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&range=1d`;
      const read = async () => {
        const price = parseYahoo(await fetchJson(url, { headers: { 'user-agent': 'Mozilla/5.0 reality-gap-monitor' } }));
        if (!price) throw new Error(`no price for ${s}`);
        return price;
      };
      this.feeds.set(s, new PollingFeed(`yahoo:${s}`, `Yahoo ${s}`, this.pollMs, read));
    }
    return this.feeds.get(s);
  }

  start() {
    for (const f of this.feeds.values()) f.start();
  }

  stop() {
    for (const f of this.feeds.values()) f.stop();
  }
}
