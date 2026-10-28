const stamp = () => new Date().toISOString();

export const log = {
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), 'WARN', ...a),
  error: (...a) => console.error(stamp(), 'ERROR', ...a),
};

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function combine(prices, mode = 'median') {
  const xs = prices.filter(Number.isFinite);
  if (!xs.length) return null;
  if (mode === 'first') return xs[0];
  if (mode === 'mean') return xs.reduce((a, b) => a + b, 0) / xs.length;
  return median(xs);
}

/** Signed gap of pool vs reference in basis points. Positive = pool trades above reality. */
export function gapBps(poolPrice, refPrice) {
  if (!Number.isFinite(poolPrice) || !Number.isFinite(refPrice) || refPrice <= 0) return null;
  return ((poolPrice - refPrice) / refPrice) * 1e4;
}

/** Read "a.b[0].c" style paths out of parsed JSON. */
export function getPath(obj, path) {
  if (!path) return obj;
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Replace ${ENV_VAR} placeholders in every string of a JSON-like value. */
export function interpolateEnv(value, env = process.env) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '');
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)]));
  }
  return value;
}

/** Optional post-processing shared by every price adapter. */
export function applyTransform(x, { multiply, divideBy, invert } = {}) {
  let v = Number(x);
  if (multiply != null) v *= Number(multiply);
  if (divideBy != null) v /= Number(divideBy);
  if (invert) v = 1 / v;
  return v;
}

export async function fetchJson(url, { timeoutMs = 8000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export const fmtBps = (b) => (b == null ? '—' : `${b >= 0 ? '+' : ''}${b.toFixed(1)} bps`);

export function fmtPrice(p) {
  if (p == null) return '—';
  const digits = p >= 1000 ? 2 : p >= 1 ? 4 : 6;
  return p.toLocaleString('en-US', { maximumFractionDigits: digits });
}
