import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../src/feeds/feed.js';
import { Engine } from '../src/engine.js';
import { Alerts } from '../src/alerts.js';
import { History } from '../src/history.js';

function setup(poolExtra = {}, alertOpts = {}) {
  const feeds = { pool: new Feed('pool', 'Metric pool'), ref: new Feed('ref', 'CEX') };
  const registry = { create: (_spec, _cfg, role) => (role === 'pool' ? feeds.pool : feeds.ref) };
  const alerts = new Alerts({ defaultThresholdBps: 20, confirmSec: 2, staleAfterSec: 10, staleRefMoveBps: 10, feedDownSec: 5, ...alertOpts });
  const events = [];
  alerts.on('alert', (e) => events.push(e));
  const cfg = { id: 'p', label: 'ETH/USDC', chain: 'ethereum', kind: 'crypto', feeBps: 5, pool: {}, reference: { sources: [{}] }, ...poolExtra };
  const engine = new Engine({ pools: [cfg], registry, history: new History(), alerts, opts: { sampleMs: 0 } });
  const at = (t, pool, ref) => {
    if (pool != null) feeds.pool.set(pool, t);
    if (ref != null) feeds.ref.set(ref, t);
    engine.tick(t);
    return engine.snapshot()[0];
  };
  return { engine, events, at, feeds };
}

test('gap alert needs confirmSec, re-notifies on widening, clears with hysteresis', () => {
  const { events, at } = setup();
  const t0 = 1_000_000;
  assert.equal(at(t0, 100, 100).status, 'ok');
  assert.equal(at(t0 + 1000, 100.3, 100).status, 'watch'); // 30 bps, not confirmed yet
  assert.equal(events.length, 0);
  let s = at(t0 + 3000, 100.3, 100);
  assert.equal(s.status, 'alert');
  assert.deepEqual(events.map((e) => e.type), ['gap_open']);
  assert.match(events[0].message, /ABOVE reality/);
  assert.ok(Math.abs(s.netEdgeBps - 25) < 1e-6);

  at(t0 + 4000, 100.65, 100); // 65 bps >= 2x 30
  assert.equal(events.at(-1).type, 'gap_widen');

  at(t0 + 5000, 100.18, 100); // 18 bps: below 20 but above 16 (hysteresis) -> still open
  assert.equal(events.at(-1).type, 'gap_widen');
  at(t0 + 6000, 100.1, 100);
  assert.equal(events.at(-1).type, 'gap_close');
});

test('one-tick blips do not alert', () => {
  const { events, at } = setup();
  at(1000, 100, 100);
  at(2000, 101, 100);
  at(3000, 100, 100);
  at(6000, 100, 100);
  assert.equal(events.length, 0);
});

test('stale price: pool frozen while reference moves', () => {
  const { events, at } = setup();
  const t0 = 1_000_000;
  at(t0, 100, 100);
  for (let i = 1; i <= 12; i++) at(t0 + i * 1000, 100, 100 + i * 0.01); // ref +12 bps over 12s
  const s = at(t0 + 13_000, 100, 100.13);
  assert.equal(s.stale, true);
  assert.ok(events.some((e) => e.type === 'stale_open'));
  at(t0 + 14_000, 100.13, 100.13);
  assert.equal(events.at(-1).type, 'stale_close');
});

test('a frozen pool with a flat reference is not stale', () => {
  const { at } = setup();
  for (let i = 0; i < 30; i++) at(1_000_000 + i * 1000, 100, 100);
  assert.equal(at(1_031_000, 100, 100).stale, false);
});

test('dead pool feed turns into feed_down then recovers', () => {
  const { events, at, feeds } = setup();
  const t0 = 1_000_000;
  at(t0, 100, 100);
  feeds.pool.fail(new Error('rpc timeout'));
  let s;
  for (let i = 1; i <= 40; i++) s = at(t0 + i * 1000, null, 100);
  assert.equal(s.status, 'feed_down');
  assert.match(s.feedProblem, /pool price is \d+s old/);
  assert.ok(events.some((e) => e.type === 'feed_down'));
  s = at(t0 + 41_000, 100, 100);
  assert.equal(s.status, 'ok');
  assert.equal(events.at(-1).type, 'feed_up');
});

test('stocks: closed market suppresses gap alerts and does not age out the reference', () => {
  const { events, at } = setup({ kind: 'stock' });
  const sat = Date.parse('2026-10-31T15:00:00Z');
  at(sat - 60_000, null, 250); // last trade a minute ago
  let s;
  for (let i = 0; i < 10; i++) s = at(sat + i * 1000, 260, null);
  assert.equal(s.marketOpen, false);
  assert.equal(s.status, 'market_closed');
  assert.ok(s.gapBps > 300);
  assert.equal(events.filter((e) => e.type.startsWith('gap')).length, 0);
});

test('per-pool threshold overrides the default', () => {
  const { events, at } = setup({ thresholdBps: 50 });
  for (let i = 0; i < 5; i++) at(1000 + i * 1000, 100.3, 100);
  assert.equal(events.length, 0);
});
