import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './util.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const MAX_STREAMS = Number(process.env.MAX_STREAMS ?? 1000);

/** Error text can echo RPC URLs, which often embed API keys. Never send those to visitors. */
export function redact(value) {
  if (typeof value === 'string') return value.replace(/(wss?|https?):\/\/[^\s"')]+/g, '[url]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}

/** Read-only public API + dashboard. Visitors can't change anything on the server. */
export function startServer({ host, port }, { engine, history, alerts, meta }) {
  const streams = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  engine.on('tick', (snap) => {
    const data = redact(snap);
    for (const res of streams) send(res, 'tick', data);
  });
  alerts.on('alert', (ev) => {
    const data = redact(ev);
    for (const res of streams) send(res, 'alert', data);
  });
  setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 15_000).unref();

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only' });

    switch (url.pathname) {
      case '/api/snapshot':
        return json(res, 200, { meta, now: Date.now(), pools: redact(engine.snapshot()), alerts: redact(alerts.recent(50)) });
      case '/api/history': {
        const pool = url.searchParams.get('pool');
        const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 60, 1), 24 * 60);
        const points = Math.min(Math.max(Number(url.searchParams.get('points')) || 600, 10), 2000);
        if (!engine.pools.some((p) => p.cfg.id === pool)) return json(res, 404, { error: 'unknown pool' });
        return json(res, 200, { pool, minutes, samples: history.query(pool, minutes, points) });
      }
      case '/api/alerts':
        return json(res, 200, { alerts: redact(alerts.recent(Math.min(Number(url.searchParams.get('limit')) || 100, 500))) });
      case '/api/stream': {
        if (streams.size >= MAX_STREAMS) return json(res, 503, { error: 'too many live viewers, retry shortly' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 3000\n\n');
        send(res, 'tick', redact(engine.snapshot()));
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      case '/healthz':
        return json(res, 200, { ok: true, pools: engine.pools.length, viewers: streams.size });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, host, () => log.info(`dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}
