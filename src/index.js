import path from 'node:path';
import { loadConfig, publicConfig } from './config.js';
import { FeedRegistry } from './feeds/index.js';
import { History } from './history.js';
import { Alerts } from './alerts.js';
import { buildNotifiers } from './notifiers.js';
import { Engine } from './engine.js';
import { startServer } from './server.js';
import { fmtBps, fmtPrice, log } from './util.js';

const argv = process.argv.slice(2);
const checkMode = argv.includes('--check');

let config;
try {
  config = loadConfig(argv);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const dataDir = config.demo || checkMode ? null : path.resolve(config.dataDir ?? process.env.DATA_DIR ?? 'data');
const registry = new FeedRegistry(config);
const history = new History({ dir: dataDir, retentionHours: config.engine?.retentionHours ?? 24 });
const alerts = new Alerts(config.alerts, { dir: dataDir, notifiers: checkMode ? [] : buildNotifiers(config.alerts, config.server.publicUrl) });

let engine;
try {
  engine = new Engine({ pools: config.pools, registry, history, alerts, opts: config.engine });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

registry.start();

if (checkMode) {
  // One-shot sanity check of every configured source, for use while wiring up a new pool.
  const waitSec = Number(argv[argv.indexOf('--check') + 1]) || 15;
  log.info(`checking ${config.pools.length} pool(s) for ${waitSec}s…`);
  setTimeout(() => {
    engine.tick();
    let ok = true;
    for (const s of engine.snapshot()) {
      console.log(`\n${s.label} [${s.chain}] (${s.id})`);
      console.log(`  pool      ${fmtPrice(s.poolPrice)}  via ${s.venue}`);
      for (const r of s.refs) console.log(`  reference ${fmtPrice(r.price)}  via ${r.label}${r.error ? `  ERROR: ${r.error}` : ''}`);
      console.log(`  gap       ${fmtBps(s.gapBps)}${s.feedProblem ? `  PROBLEM: ${s.feedProblem}` : ''}${s.marketOpen ? '' : '  (market closed)'}`);
      if (s.feedProblem) ok = false;
    }
    registry.stop();
    process.exit(ok ? 0 : 2);
  }, waitSec * 1000);
} else {
  engine.start();
  const server = startServer(config.server, { engine, history, alerts, meta: publicConfig(config) });
  const compactTimer = setInterval(() => history.compact(), 3600_000);
  const shutdown = () => {
    log.info('shutting down');
    clearInterval(compactTimer);
    engine.stop();
    registry.stop();
    history.compact();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log.info(`monitoring ${config.pools.length} pool(s)${config.demo ? ' with SIMULATED data (--demo)' : ''}`);
}
