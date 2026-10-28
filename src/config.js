import fs from 'node:fs';
import { interpolateEnv } from './util.js';
import { demoConfig } from './feeds/mock.js';

const SOURCE_TYPES = ['binance', 'coinbase', 'finnhub', 'yahoo', 'evm-call', 'http-json', 'mock'];

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--demo') || env.DEMO === '1') return finalize(demoConfig(), env);
  const i = argv.indexOf('--config');
  const file = i >= 0 ? argv[i + 1] : env.CONFIG ?? 'config.json';
  if (!fs.existsSync(file)) {
    throw new Error(`config file "${file}" not found. Copy config.example.json to config.json and fill it in, or run with --demo.`);
  }
  return finalize(JSON.parse(fs.readFileSync(file, 'utf8')), env);
}

function finalize(raw, env) {
  const cfg = interpolateEnv(raw, env);
  cfg.server ??= {};
  cfg.server.host ??= env.HOST ?? '127.0.0.1';
  cfg.server.port = Number(env.PORT ?? cfg.server.port ?? 8787);
  cfg.pools = (cfg.pools ?? []).filter((p) => p.enabled !== false);
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errors = [];
  if (!cfg.pools.length) errors.push('no enabled pools in "pools"');
  const ids = new Set();
  for (const [i, p] of cfg.pools.entries()) {
    const where = `pools[${i}]${p.id ? ` (${p.id})` : ''}`;
    if (!p.id) errors.push(`${where}: missing "id"`);
    else if (ids.has(p.id)) errors.push(`${where}: duplicate id`);
    ids.add(p.id);
    if (!p.label) errors.push(`${where}: missing "label"`);
    if (!p.chain) errors.push(`${where}: missing "chain"`);
    checkSource(p.pool, `${where}.pool`, p, cfg, errors);
    const sources = p.reference?.sources;
    if (!Array.isArray(sources) || !sources.length) errors.push(`${where}.reference.sources: need at least one reference source`);
    else sources.forEach((s, j) => checkSource(s, `${where}.reference.sources[${j}]`, p, cfg, errors));
  }
  if (errors.length) throw new Error(`invalid config:\n  - ${errors.join('\n  - ')}`);
}

function checkSource(s, where, pool, cfg, errors) {
  if (!s || !SOURCE_TYPES.includes(s.type)) {
    errors.push(`${where}: "type" must be one of ${SOURCE_TYPES.join(', ')}`);
    return;
  }
  if (['binance', 'coinbase', 'finnhub', 'yahoo'].includes(s.type) && !s.symbol) errors.push(`${where}: missing "symbol"`);
  if (s.type === 'http-json' && !s.url) errors.push(`${where}: missing "url"`);
  if (s.type === 'evm-call') {
    const chain = s.chain ?? pool.chain;
    if (!/^0x[0-9a-fA-F]{40}$/.test(s.address ?? '')) errors.push(`${where}: "address" must be a 0x… contract address (got "${s.address}")`);
    if (!s.abi) errors.push(`${where}: missing "abi" (e.g. "function getPrice() view returns (uint256)")`);
    if (!s.method) errors.push(`${where}: missing "method"`);
    if (!cfg.chains?.[chain]?.rpc) errors.push(`${where}: chain "${chain}" needs an "rpc" url in "chains"`);
  }
}

/** The subset of config that is safe to show to public visitors. */
export function publicConfig(cfg) {
  return {
    demo: !!cfg.demo,
    title: cfg.server.title ?? 'Metric Reality Gap',
    links: cfg.server.links ?? {},
    xHandle: cfg.server.xHandle ?? null,
  };
}
