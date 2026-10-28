// Reality Gap dashboard. Live data arrives over Server-Sent Events from /api/stream.
// Personal settings (alert thresholds, notification toggle) live only in this browser.

const $ = (sel, el = document) => el.querySelector(sel);
const LIVE_KEEP_MS = 30 * 60_000;
const STATUS_TEXT = {
  ok: 'In line', watch: 'Above threshold', alert: 'Gap alert', stale: 'Stale price',
  market_closed: 'Market closed', feed_down: 'Feed down', warming: 'Connecting',
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(`rgm:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`rgm:${k}`, JSON.stringify(v)); } catch {} },
};

const state = {
  meta: {},
  pools: new Map(),          // id -> latest server state
  live: new Map(),           // id -> [[t, pool, ref, gap]]
  rows: new Map(),           // id -> row elements
  selected: store.get('selected', null),
  minutes: store.get('minutes', 60),
  hist: [],                  // samples for selected pool + range
  myTh: store.get('thresholds', {}),
  notify: store.get('notify', false),
  myOpen: new Map(),
  hover: { gap: null, price: null },
};

// ---------- formatting ----------

const fmtPrice = (p) => p == null ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 2 : p >= 1 ? 4 : 6 });
const fmtBps = (b, dp = 1) => b == null ? '—' : `${b > 0 ? '+' : b < 0 ? '−' : ''}${Math.abs(b).toFixed(dp)}`;
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtTimeS = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const myThreshold = (s) => Number(state.myTh[s.id]) > 0 ? Number(state.myTh[s.id]) : s.thresholdBps;

// ---------- live connection ----------

async function boot() {
  try {
    const snap = await (await fetch('api/snapshot')).json();
    state.meta = snap.meta ?? {};
    applyMeta();
    renderAlerts(snap.alerts ?? []);
    onTick(snap.pools ?? []);
  } catch {}
  connect();
}

function connect() {
  const es = new EventSource('api/stream');
  const live = $('#live');
  es.onopen = () => { live.className = 'live up'; live.lastChild.textContent = 'live'; };
  es.onerror = () => { live.className = 'live down'; live.lastChild.textContent = 'reconnecting'; };
  es.addEventListener('tick', (e) => onTick(JSON.parse(e.data)));
  es.addEventListener('alert', (e) => prependAlert(JSON.parse(e.data)));
}

function onTick(pools) {
  const now = Date.now();
  for (const s of pools) {
    state.pools.set(s.id, s);
    const buf = state.live.get(s.id) ?? [];
    if (s.gapBps != null) buf.push([now, s.poolPrice, s.refPrice, s.gapBps]);
    while (buf.length && buf[0][0] < now - LIVE_KEEP_MS) buf.shift();
    state.live.set(s.id, buf);
    checkMyAlert(s);
  }
  if (!state.selected || !state.pools.has(state.selected)) select(pools[0]?.id, false);
  renderStats();
  renderTable();
  renderDetail();
}

// ---------- summary + table ----------

function renderStats() {
  const list = [...state.pools.values()];
  const live = list.filter((s) => s.gapBps != null && s.marketOpen);
  const widest = live.reduce((a, s) => (!a || Math.abs(s.gapBps) > Math.abs(a.gapBps) ? s : a), null);
  const abs = live.map((s) => Math.abs(s.gapBps)).sort((a, b) => a - b);
  const med = abs.length ? (abs.length % 2 ? abs[abs.length >> 1] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2) : null;
  $('#s-pools').textContent = list.length;
  $('#s-max').textContent = widest ? `${fmtBps(widest.gapBps)} bps` : '—';
  $('#s-max-pool').textContent = widest ? `${widest.label} · ${widest.chain}` : '';
  $('#s-med').textContent = med == null ? '—' : `${med.toFixed(1)} bps`;
  $('#s-alert').textContent = `${list.filter((s) => s.alerts?.gap).length} / ${list.filter((s) => s.stale).length}`;
}

function renderTable() {
  const tbody = $('#pools tbody');
  for (const s of state.pools.values()) {
    let r = state.rows.get(s.id);
    if (!r) {
      r = buildRow(s);
      state.rows.set(s.id, r);
      tbody.append(r.tr);
    }
    r.tr.classList.toggle('sel', s.id === state.selected);
    r.pool.textContent = fmtPrice(s.poolPrice);
    r.ref.textContent = fmtPrice(s.refPrice);
    r.gapVal.textContent = s.gapBps == null ? '—' : `${fmtBps(s.gapBps)} bps`;
    r.gap.className = `num gap ${s.gapBps > 0 ? 'pos' : s.gapBps < 0 ? 'neg' : ''}`;
    r.dir.textContent = s.gapBps == null ? '' : s.gapBps > 0 ? 'Metric above' : 'Metric below';
    r.edge.textContent = s.netEdgeBps == null ? '—' : `${s.netEdgeBps.toFixed(1)} bps`;
    r.status.className = `status st-${s.status}`;
    r.status.textContent = STATUS_TEXT[s.status] ?? s.status;
    r.status.title = s.feedProblem ?? (s.stale ? `Unchanged for ${Math.round(s.staleSec)}s while reference moved ${s.refMoveBps.toFixed(1)} bps` : '');
    if (document.activeElement !== r.th) r.th.placeholder = String(s.thresholdBps);
    drawSpark(r.spark, (state.live.get(s.id) ?? []).filter((x) => x[0] >= Date.now() - 5 * 60_000), myThreshold(s));
  }
}

function buildRow(s) {
  const tr = el('tr');
  const name = el('td');
  name.append(el('span', 'pool-name', s.label), el('span', 'chip', s.chain));
  if (s.kind === 'stock') name.append(el('span', 'chip', 'stock'));
  const pool = el('td', 'num opt');
  const ref = el('td', 'num opt');
  const gap = el('td', 'num gap');
  const gapVal = el('span');
  const dir = el('span', 'dir');
  gap.append(gapVal, dir);
  const edge = el('td', 'num opt');
  const stTd = el('td');
  const status = el('span', 'status');
  stTd.append(status);
  const spTd = el('td', 'spark-col opt');
  const spark = el('canvas', 'spark');
  spTd.append(spark);
  const thTd = el('td', 'num');
  const th = el('input', 'th');
  Object.assign(th, { type: 'number', min: '1', step: '1', inputMode: 'decimal', value: state.myTh[s.id] ?? '' });
  th.setAttribute('aria-label', `My alert threshold for ${s.label} in bps`);
  th.addEventListener('click', (e) => e.stopPropagation());
  th.addEventListener('change', () => {
    const v = Number(th.value);
    if (v > 0) state.myTh[s.id] = v; else { delete state.myTh[s.id]; th.value = ''; }
    store.set('thresholds', state.myTh);
    state.myOpen.delete(s.id);
    renderDetail(true);
  });
  thTd.append(th);
  tr.append(name, pool, ref, gap, edge, stTd, spTd, thTd);
  tr.addEventListener('click', () => select(s.id));
  return { tr, pool, ref, gap, gapVal, dir, edge, status, spark, th };
}

// ---------- detail panel ----------

async function select(id, scroll = true) {
  if (!id) return;
  state.selected = id;
  store.set('selected', id);
  for (const [pid, r] of state.rows) r.tr.classList.toggle('sel', pid === id);
  await loadHistory();
  if (scroll && window.innerWidth < 900) $('#detail').scrollIntoView({ behavior: 'smooth' });
}

async function loadHistory() {
  const id = state.selected;
  try {
    const res = await fetch(`api/history?pool=${encodeURIComponent(id)}&minutes=${state.minutes}&points=800`);
    const { samples } = await res.json();
    if (id === state.selected) state.hist = samples ?? [];
  } catch {
    state.hist = [];
  }
  renderDetail(true);
}

let lastDetail = 0;
function renderDetail(force = false) {
  const s = state.pools.get(state.selected);
  if (!s) return;
  const now = Date.now();
  if (!force && now - lastDetail < 900) return;
  lastDetail = now;

  $('#d-title').textContent = `${s.label} · ${s.chain}`;
  const from = now - state.minutes * 60_000;
  const lastHist = state.hist.at(-1)?.[0] ?? 0;
  const pts = state.hist.filter((x) => x[0] >= from).concat((state.live.get(s.id) ?? []).filter((x) => x[0] > lastHist && x[0] >= from));
  const th = myThreshold(s);
  // don't squash a short history against the right edge of a long range
  const range = [Math.max(from, (pts[0]?.[0] ?? from) - 5_000), now];

  drawChart($('#c-gap'), {
    range,
    series: [{ pts: pts.map((x) => [x[0], x[3]]), color: cssVar('--text'), width: 1.6 }],
    band: th, zero: true, fmt: (v) => fmtBps(v, Math.abs(v) < 10 ? 1 : 0), unit: 'bps', key: 'gap',
  });
  drawChart($('#c-price'), {
    range,
    series: [
      { pts: pts.map((x) => [x[0], x[2]]), color: cssVar('--ref'), width: 1.4, name: 'reference' },
      { pts: pts.map((x) => [x[0], x[1]]), color: cssVar('--pool'), width: 1.6, name: 'Metric' },
    ],
    fmt: fmtPrice, key: 'price',
  });
  renderFacts(s, th);
}

function renderFacts(s, th) {
  const box = $('#d-facts');
  box.replaceChildren();
  const dl = el('dl');
  const row = (k, v) => dl.append(el('dt', null, k), el('dd', null, v));
  row('Metric price', fmtPrice(s.poolPrice));
  row('Reference', fmtPrice(s.refPrice));
  row('Gap', s.gapBps == null ? '—' : `${fmtBps(s.gapBps, 2)} bps`);
  row('Pool fee', `${s.feeBps} bps`);
  row('Edge after fee', s.netEdgeBps == null ? '—' : `${s.netEdgeBps.toFixed(1)} bps`);
  row('My alert at', `±${th} bps`);
  row('Pool price unchanged', `${Math.round(s.staleSec)}s`);
  row('Reality moved since', `${(s.refMoveBps ?? 0).toFixed(1)} bps`);
  if (s.refSpreadBps != null) row('Reference spread', `${s.refSpreadBps.toFixed(1)} bps`);
  row('Market', s.marketMode === 'us-equity' ? (s.marketOpen ? 'US market open' : 'US market closed') : '24/7');
  box.append(dl);

  const src = el('dl');
  for (const r of s.refs ?? []) {
    src.append(el('dt', null, r.label), el('dd', null, r.price == null ? '—' : `${fmtPrice(r.price)}${r.ageMs != null ? ` · ${Math.round(r.ageMs / 1000)}s` : ''}`));
  }
  const srcBox = el('div', 'note');
  srcBox.append(el('div', null, `Pool read from: ${s.venue}`), src);
  box.append(srcBox);

  let note = null;
  if (s.feedProblem) note = el('div', 'err', s.feedProblem);
  else if (s.gapBps != null && Math.abs(s.gapBps) >= th) {
    note = el('div', 'note', s.gapBps > 0
      ? 'Metric is pricing above the reference: sell on Metric, buy on the reference venue (before gas and slippage).'
      : 'Metric is pricing below the reference: buy on Metric, sell on the reference venue (before gas and slippage).');
  } else if (s.stale) note = el('div', 'note', 'Pool price is frozen while the reference moves. LPs are exposed to stale-price arbitrage.');
  else if (!s.marketOpen) note = el('div', 'note', 'The stock market is closed, so the reference price is frozen and gaps are informational only.');
  if (note) box.append(note);
}

// ---------- charts (canvas, no dependencies) ----------

function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = c.getBoundingClientRect();
  if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, w: width, h: height };
}

function niceTicks(min, max, n = 4) {
  const span = max - min || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function pathSeries(ctx, pts, X, Y, maxGapMs) {
  ctx.beginPath();
  let prev = null;
  for (const [t, v] of pts) {
    if (v == null) { prev = null; continue; }
    if (prev == null || t - prev > maxGapMs) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v));
    prev = t;
  }
  ctx.stroke();
}

function drawChart(canvas, opts) {
  canvas._opts = opts;
  if (!canvas._wired) wireHover(canvas);
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 58, r: 10, t: 8, b: 22 };
  const [t0, t1] = opts.range;
  const vals = opts.series.flatMap((s) => s.pts.map((p) => p[1])).filter((v) => v != null);
  if (opts.band) vals.push(opts.band * 1.15, -opts.band * 1.15);
  if (opts.zero) vals.push(0);
  const muted = cssVar('--muted');
  const line = cssVar('--line');
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';

  if (!vals.length || !opts.series.some((s) => s.pts.length)) {
    ctx.fillStyle = muted;
    ctx.fillText('Waiting for data…', pad.l + 8, h / 2);
    canvas._geom = null;
    return;
  }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padY = (hi - lo || Math.abs(hi) || 1) * 0.08;
  lo -= padY; hi += padY;
  const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  canvas._geom = { X, Y, pad, w, h, t0, t1 };

  // threshold zones
  if (opts.band) {
    ctx.fillStyle = cssVar('--band');
    ctx.fillRect(pad.l, pad.t, w - pad.l - pad.r, Y(opts.band) - pad.t);
    ctx.fillRect(pad.l, Y(-opts.band), w - pad.l - pad.r, h - pad.b - Y(-opts.band));
    ctx.strokeStyle = cssVar('--bad');
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    for (const b of [opts.band, -opts.band]) { ctx.beginPath(); ctx.moveTo(pad.l, Y(b)); ctx.lineTo(w - pad.r, Y(b)); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // grid + y labels
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(lo, hi, Math.max(2, Math.floor(h / 45)))) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(opts.fmt(v), pad.l - 6, Y(v));
  }
  if (opts.zero) {
    ctx.strokeStyle = muted;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
  }

  // x labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const n = Math.max(2, Math.floor((w - pad.l) / 110));
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    ctx.fillText(fmtTime(t), Math.min(Math.max(X(t), pad.l + 16), w - pad.r - 16), h - pad.b + 6);
  }

  // series
  const maxGapMs = Math.max(30_000, (t1 - t0) / 200);
  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b); ctx.clip();
  ctx.lineJoin = 'round';
  for (const s of opts.series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.5;
    pathSeries(ctx, s.pts, X, Y, maxGapMs);
  }
  ctx.restore();

  // hover crosshair
  const ht = state.hover[opts.key];
  if (ht != null) {
    const p0 = nearest(opts.series.at(-1).pts, ht);
    if (p0) {
      ctx.strokeStyle = muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(p0[0]), pad.t); ctx.lineTo(X(p0[0]), h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      for (const s of opts.series) {
        const p = nearest(s.pts, ht);
        if (p?.[1] == null) continue;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

function nearest(pts, t) {
  let best = null;
  for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  return best;
}

function wireHover(canvas) {
  canvas._wired = true;
  const tip = el('div', 'tip');
  tip.hidden = true;
  canvas.parentElement.append(tip);
  const move = (e) => {
    const g = canvas._geom;
    const o = canvas._opts;
    if (!g) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < g.pad.l || x > g.w - g.pad.r) return leave();
    const t = g.t0 + ((x - g.pad.l) / (g.w - g.pad.l - g.pad.r)) * (g.t1 - g.t0);
    state.hover[o.key] = t;
    drawChart(canvas, o);
    const lines = o.series.map((s) => {
      const p = nearest(s.pts, t);
      return p ? `${s.name ? `${s.name} ` : ''}${o.fmt(p[1])}${o.unit ? ` ${o.unit}` : ''}` : '';
    });
    const p = nearest(o.series.at(-1).pts, t);
    if (!p) return leave();
    tip.textContent = `${fmtTimeS(p[0])} · ${lines.filter(Boolean).join(' · ')}`;
    tip.style.left = `${Math.min(Math.max(g.X(p[0]), 90), g.w - 90)}px`;
    tip.style.top = `${g.pad.t + 30}px`;
    tip.hidden = false;
  };
  const leave = () => { state.hover[canvas._opts.key] = null; tip.hidden = true; drawChart(canvas, canvas._opts); };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
}

function drawSpark(canvas, pts, th) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (pts.length < 2) return;
  const vals = pts.map((p) => p[3]);
  const m = Math.max(th * 1.1, ...vals.map(Math.abs));
  const X = (t) => ((t - pts[0][0]) / (pts.at(-1)[0] - pts[0][0] || 1)) * (w - 2) + 1;
  const Y = (v) => h / 2 - (v / m) * (h / 2 - 2);
  ctx.fillStyle = cssVar('--band');
  ctx.fillRect(0, 0, w, Y(th));
  ctx.fillRect(0, Y(-th), w, h - Y(-th));
  ctx.strokeStyle = cssVar('--line');
  ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
  const last = vals.at(-1);
  ctx.strokeStyle = Math.abs(last) >= th ? cssVar('--bad') : last >= 0 ? cssVar('--pos') : cssVar('--neg');
  ctx.lineWidth = 1.4;
  pathSeries(ctx, pts.map((p) => [p[0], p[3]]), X, Y, 30_000);
}

// ---------- alerts ----------

function renderAlerts(list) {
  const ol = $('#alerts');
  ol.replaceChildren();
  if (!list.length) ol.append(el('li', 'empty', 'No alerts yet.'));
  for (const a of list) ol.append(alertItem(a));
}

function alertItem(a) {
  const li = el('li');
  const t = el('time', null, fmtTimeS(a.ts));
  t.dateTime = new Date(a.ts).toISOString();
  li.append(t, el('span', null, a.message));
  return li;
}

function prependAlert(a) {
  const ol = $('#alerts');
  $('.empty', ol)?.remove();
  ol.prepend(alertItem(a));
  while (ol.children.length > 100) ol.lastChild.remove();
}

/** Personal alerts: evaluated in the browser against this visitor's own thresholds. */
function checkMyAlert(s) {
  if (!state.notify || s.gapBps == null || s.feedProblem || !s.marketOpen) return;
  const th = myThreshold(s);
  const abs = Math.abs(s.gapBps);
  const open = state.myOpen.get(s.id);
  if (!open && abs >= th) {
    state.myOpen.set(s.id, true);
    notify(`${s.label} (${s.chain}): ${fmtBps(s.gapBps)} bps`, s.gapBps > 0
      ? `Metric ${fmtPrice(s.poolPrice)} is above reality ${fmtPrice(s.refPrice)}`
      : `Metric ${fmtPrice(s.poolPrice)} is below reality ${fmtPrice(s.refPrice)}`);
  } else if (open && abs < th * 0.8) {
    state.myOpen.delete(s.id);
  }
}

let audio;
function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: title.split(':')[0] });
  } catch {}
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.35);
  } catch {}
  const prev = document.title;
  document.title = `⚠ ${title}`;
  setTimeout(() => (document.title = prev), 6000);
}

function renderNotifyBtn() {
  const b = $('#notify');
  b.textContent = state.notify ? '🔔 Alerts on' : '🔕 Alerts off';
  b.classList.toggle('on', state.notify);
}

$('#notify').addEventListener('click', async () => {
  if (!state.notify && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  state.notify = !state.notify;
  state.myOpen.clear();
  store.set('notify', state.notify);
  renderNotifyBtn();
});

// ---------- share + meta ----------

$('#share').addEventListener('click', () => {
  const list = [...state.pools.values()].filter((s) => s.gapBps != null && s.marketOpen);
  const w = list.reduce((a, s) => (!a || Math.abs(s.gapBps) > Math.abs(a.gapBps) ? s : a), null);
  const who = state.meta.xHandle ? `@${state.meta.xHandle.replace(/^@/, '')}` : 'Metric';
  const text = w
    ? `Live check on ${who}: does it price to reality?\n\nWidest gap right now: ${w.label} on ${w.chain} at ${fmtBps(w.gapBps)} bps (${w.gapBps > 0 ? 'above' : 'below'} the reference).\n\nWatch every pool live 👇`
    : 'Live gap between Metric pool prices and reality 👇';
  const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin + location.pathname)}`;
  window.open(url, '_blank', 'noopener');
});

function applyMeta() {
  const m = state.meta;
  if (m.title) { $('#title').textContent = m.title; document.title = m.title; }
  $('#demo').hidden = !m.demo;
  const links = $('#links');
  links.replaceChildren();
  for (const [name, href] of Object.entries(m.links ?? {})) {
    if (!/^https?:\/\//.test(href)) continue;
    const a = el('a', null, name);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    if (links.childNodes.length) links.append(' · ');
    links.append(a);
  }
}

for (const b of $('#ranges').children) {
  b.classList.toggle('on', Number(b.dataset.m) === state.minutes);
  b.addEventListener('click', () => {
    state.minutes = Number(b.dataset.m);
    store.set('minutes', state.minutes);
    for (const x of $('#ranges').children) x.classList.toggle('on', x === b);
    loadHistory();
  });
}

window.addEventListener('resize', () => renderDetail(true));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => renderDetail(true));
renderNotifyBtn();
boot();
