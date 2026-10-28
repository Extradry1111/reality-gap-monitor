import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

/**
 * Per-pool time series of [t, poolPrice, refPrice, gapBps], kept in memory for `retentionHours`
 * and appended to a JSONL file so a restart doesn't wipe the charts.
 */
export class History {
  constructor({ dir, retentionHours = 24 } = {}) {
    this.retentionMs = retentionHours * 3600_000;
    this.series = new Map();
    this.file = dir ? path.join(dir, 'history.jsonl') : null;
    if (this.file) this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    const cutoff = Date.now() - this.retentionMs;
    let kept = 0;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { p, s } = JSON.parse(line);
        if (s[0] >= cutoff) {
          this.list(p).push(s);
          kept++;
        }
      } catch {}
    }
    this.compact();
    log.info(`history: restored ${kept} samples`);
  }

  /** Rewrite the file with only in-window samples so it can't grow forever. */
  compact() {
    if (!this.file) return;
    const lines = [];
    for (const [p, arr] of this.series) for (const s of arr) lines.push(JSON.stringify({ p, s }));
    fs.writeFileSync(this.file, lines.length ? lines.join('\n') + '\n' : '');
  }

  list(poolId) {
    if (!this.series.has(poolId)) this.series.set(poolId, []);
    return this.series.get(poolId);
  }

  add(poolId, sample) {
    const arr = this.list(poolId);
    arr.push(sample);
    const cutoff = sample[0] - this.retentionMs;
    let drop = 0;
    while (drop < arr.length && arr[drop][0] < cutoff) drop++;
    if (drop) arr.splice(0, drop);
    if (this.file) fs.appendFile(this.file, JSON.stringify({ p: poolId, s: sample }) + '\n', () => {});
  }

  /** Samples from the last `minutes`, thinned to at most `maxPoints` while keeping each bucket's widest gap. */
  query(poolId, minutes = 60, maxPoints = 600) {
    const since = Date.now() - minutes * 60_000;
    const arr = (this.series.get(poolId) ?? []).filter((s) => s[0] >= since);
    if (arr.length <= maxPoints) return arr;
    const size = arr.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      let best = null;
      for (let j = Math.floor(i * size); j < Math.floor((i + 1) * size); j++) {
        const s = arr[j];
        if (!best || (s[3] != null && Math.abs(s[3]) > Math.abs(best[3] ?? 0))) best = s;
      }
      if (best) out.push(best);
    }
    return out;
  }
}
