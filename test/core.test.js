import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform, combine, gapBps, getPath, interpolateEnv, median } from '../src/util.js';
import { parseBinance, parseCoinbase, parseFinnhub, parseYahoo } from '../src/feeds/exchanges.js';
import { isUsEquityOpen } from '../src/marketHours.js';
import { History } from '../src/history.js';
import { redact } from '../src/server.js';
import { validate } from '../src/config.js';

test('gapBps is signed relative to the reference', () => {
  assert.equal(gapBps(101, 100), 100);
  assert.ok(Math.abs(gapBps(99.5, 100) + 50) < 1e-9);
  assert.equal(gapBps(null, 100), null);
  assert.equal(gapBps(100, 0), null);
});

test('median and combine', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(combine([1, 2, 9], 'mean'), 4);
  assert.equal(combine([5, 1], 'first'), 5);
  assert.equal(combine([NaN, 7]), 7);
});

test('getPath, interpolateEnv, applyTransform', () => {
  assert.equal(getPath({ a: { b: [{ c: 5 }] } }, 'a.b[0].c'), 5);
  assert.equal(getPath({ a: 1 }, 'x.y'), undefined);
  assert.deepEqual(interpolateEnv({ rpc: '${RPC}/v1', n: 3, arr: ['${X}'] }, { RPC: 'https://r', X: 'x' }), { rpc: 'https://r/v1', n: 3, arr: ['x'] });
  assert.equal(interpolateEnv('${MISSING}', {}), '');
  assert.equal(applyTransform('2', { multiply: 3 }), 6);
  assert.equal(applyTransform(4, { divideBy: 2, invert: true }), 0.5);
});

test('exchange message parsers', () => {
  assert.deepEqual(parseBinance({ stream: 'ethusdt@bookTicker', data: { s: 'ETHUSDT', b: '3000.0', a: '3001.0' } }), { symbol: 'ETHUSDT', price: 3000.5 });
  assert.equal(parseBinance({ result: null, id: 1 }), null);
  assert.deepEqual(parseCoinbase({ type: 'ticker', product_id: 'ETH-USD', best_bid: '10', best_ask: '12', price: '11.5' }), { symbol: 'ETH-USD', price: 11 });
  assert.deepEqual(parseCoinbase({ type: 'ticker', product_id: 'ETH-USD', price: '11.5' }), { symbol: 'ETH-USD', price: 11.5 });
  assert.equal(parseCoinbase({ type: 'subscriptions' }), null);
  assert.deepEqual(parseFinnhub({ type: 'trade', data: [{ s: 'AAPL', p: 1 }, { s: 'AAPL', p: 2 }, { s: 'TSLA', p: 3 }] }), [
    { symbol: 'AAPL', price: 2 },
    { symbol: 'TSLA', price: 3 },
  ]);
  assert.deepEqual(parseFinnhub({ type: 'ping' }), []);
  assert.equal(parseYahoo({ chart: { result: [{ meta: { regularMarketPrice: 189.5 } }] } }), 189.5);
});

test('US equity market hours', () => {
  assert.equal(isUsEquityOpen(new Date('2026-10-28T14:00:00Z')), true); // Wed 10:00 ET
  assert.equal(isUsEquityOpen(new Date('2026-10-28T13:29:00Z')), false); // 9:29 ET
  assert.equal(isUsEquityOpen(new Date('2026-10-28T20:00:00Z')), false); // 16:00 ET
  assert.equal(isUsEquityOpen(new Date('2026-10-31T15:00:00Z')), false); // Saturday
  assert.equal(isUsEquityOpen(new Date('2026-11-26T15:00:00Z')), false); // Thanksgiving
  assert.equal(isUsEquityOpen(new Date('2026-11-27T18:30:00Z')), false); // early close, 13:30 ET
  assert.equal(isUsEquityOpen(new Date('2026-07-01T13:45:00Z')), true); // summer time, 9:45 EDT
});

test('history keeps the window and thins while preserving the widest gap', () => {
  const h = new History({ retentionHours: 1 });
  const now = Date.now();
  h.add('p', [now - 2 * 3600_000, 1, 1, 0]);
  for (let i = 0; i < 1000; i++) h.add('p', [now - (1000 - i) * 1000, 1, 1, i === 500 ? 99 : 1]);
  assert.equal(h.list('p').length, 1000);
  const q = h.query('p', 60, 100);
  assert.equal(q.length, 100);
  assert.ok(q.some((s) => s[3] === 99));
});

test('redact strips urls (which can hold RPC keys) from public payloads', () => {
  const out = redact({ e: 'request failed (url="https://eth.example/v2/SECRETKEY") retry', n: 1, a: ['wss://x/y?token=abc'] });
  assert.ok(!JSON.stringify(out).includes('SECRETKEY'));
  assert.ok(!JSON.stringify(out).includes('abc'));
  assert.equal(out.n, 1);
});

test('config validation explains what is missing', () => {
  const cfg = {
    chains: {},
    pools: [
      {
        id: 'x',
        label: 'X',
        chain: 'robinhood',
        pool: { type: 'evm-call', address: '0xYOUR_POOL', method: 'price' },
        reference: { sources: [{ type: 'binance' }] },
      },
    ],
  };
  assert.throws(() => validate(cfg), (err) => {
    assert.match(err.message, /address/);
    assert.match(err.message, /abi/);
    assert.match(err.message, /rpc/);
    assert.match(err.message, /symbol/);
    return true;
  });
});
