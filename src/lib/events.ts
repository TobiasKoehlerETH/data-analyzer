/**
 * Events, segments and scalar measurements on a time series. Pure functions, no imports,
 * so they run under `node --test`.
 */

export type Num = number | null | undefined;
const ok = (v: Num): v is number => v !== null && v !== undefined && Number.isFinite(v);

export type EventMode = "rising" | "falling" | "both" | "change";

export interface EventOptions {
  mode: EventMode;
  /** Threshold for crossings. */
  level: number;
  /** A crossing counts again only after the signal went back past the level by this much. */
  hysteresis: number;
  /** Events closer than this [s] to the previous one are dropped. */
  holdoff: number;
  /** For "change": the smallest step that counts as a new state (0 = any change). */
  tolerance: number;
}

/** Event times (crossings are interpolated between samples). `t` must increase. */
export function detectEvents(t: Num[], y: Num[], o: EventOptions): number[] {
  const raw: number[] = [];
  const h = Math.max(0, o.hysteresis);
  if (o.mode === "change") {
    let last: number | null = null;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const ti = t[i];
      if (!ok(v) || !ok(ti)) continue;
      if (last !== null && Math.abs(v - last) > o.tolerance) raw.push(ti);
      if (last === null || Math.abs(v - last) > o.tolerance) last = v;
    }
  } else {
    const wantUp = o.mode === "rising" || o.mode === "both";
    const wantDown = o.mode === "falling" || o.mode === "both";
    // Armed once the signal has been clearly on the far side of the level.
    let upArmed = false;
    let downArmed = false;
    let pv: number | null = null;
    let pt: number | null = null;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const ti = t[i];
      if (!ok(v) || !ok(ti)) {
        pv = null;
        continue;
      }
      if (v <= o.level - h) upArmed = true;
      if (v >= o.level + h) downArmed = true;
      if (wantUp && upArmed && v >= o.level && pv !== null && pv < o.level) {
        raw.push(pt! + ((o.level - pv) / (v - pv)) * (ti - pt!));
        upArmed = false;
      }
      if (wantDown && downArmed && v <= o.level && pv !== null && pv > o.level) {
        raw.push(pt! + ((pv - o.level) / (pv - v)) * (ti - pt!));
        downArmed = false;
      }
      pv = v;
      pt = ti;
    }
  }
  raw.sort((a, b) => a - b);
  const out: number[] = [];
  for (const e of raw) if (!out.length || e - out[out.length - 1] >= o.holdoff) out.push(e);
  return out;
}

export interface Segment {
  /** 1-based number in the order found. */
  index: number;
  start: number;
  end: number;
  /** The event the segment belongs to (its start for "between", its trigger for "window"). */
  event: number;
}

export interface SegmentOptions {
  /** "between": from one event to the next. "window": a fixed window around each event. */
  mode: "between" | "window";
  pre: number;
  post: number;
  /** Segments shorter than this [s] are dropped. */
  minDuration: number;
}

export function makeSegments(events: number[], range: [number, number], o: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  if (o.mode === "between") {
    for (let i = 0; i + 1 < events.length; i++) {
      if (events[i + 1] - events[i] >= o.minDuration) out.push({ index: out.length + 1, start: events[i], end: events[i + 1], event: events[i] });
    }
  } else {
    for (const e of events) {
      const start = Math.max(range[0], e - Math.max(0, o.pre));
      const end = Math.min(range[1], e + Math.max(0, o.post));
      if (end - start >= Math.max(o.minDuration, 1e-12)) out.push({ index: out.length + 1, start, end, event: e });
    }
  }
  return out;
}

/** First index with t[i] >= x (t increasing, missing times skipped as +∞ is not assumed). */
export function lowerBound(t: Num[], x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = t[mid];
    if (ok(v) && v < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const METRICS = {
  mean: { label: "Mean", time: false },
  min: { label: "Min", time: false },
  max: { label: "Max", time: false },
  p2p: { label: "Peak-to-peak", time: false },
  rms: { label: "RMS", time: false },
  std: { label: "Std dev", time: false },
  first: { label: "First value", time: false },
  last: { label: "Final value", time: false },
  integral: { label: "Integral", time: false },
  tmax: { label: "Time of max", time: true },
  tmin: { label: "Time of min", time: true },
  rise: { label: "Rise time 10–90 %", time: true },
  settle: { label: "Settling time", time: true },
  overshoot: { label: "Overshoot", time: false },
  duration: { label: "Duration", time: true },
} as const;
export type Metric = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as Metric[];

/** The unit of a metric of a signal in `unit` ("·s" for integrals, "s" for times, "%" for overshoot). */
export function metricUnit(m: Metric, unit: string): string {
  if (METRICS[m].time) return "s";
  if (m === "overshoot") return "%";
  if (m === "integral") return unit ? `${unit}·s` : "s";
  return unit;
}

export interface MeasureOptions {
  /** Settling band as a fraction of the step (0.02 = ±2 %). */
  band?: number;
}

/**
 * Every metric of `y` on `start <= t <= end`. Times (tmax, tmin, settle) are measured from `start`.
 * The step for rise time, settling and overshoot runs from the first to the final value
 * (each the mean of the first / last 5 % of the samples).
 */
export function measure(t: Num[], y: Num[], start: number, end: number, opts: MeasureOptions = {}): Record<Metric, number | null> {
  const r = Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as Record<Metric, number | null>;
  r.duration = end - start;
  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = lowerBound(t, start); i < t.length; i++) {
    const ti = t[i];
    if (!ok(ti)) continue;
    if (ti > end) break;
    const v = y[i];
    if (ok(v)) {
      ts.push(ti);
      ys.push(v);
    }
  }
  const n = ys.length;
  if (!n) return r;
  let sum = 0;
  let sq = 0;
  let iMin = 0;
  let iMax = 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    sum += ys[i];
    sq += ys[i] * ys[i];
    if (ys[i] < ys[iMin]) iMin = i;
    if (ys[i] > ys[iMax]) iMax = i;
    if (i) area += ((ys[i] + ys[i - 1]) / 2) * (ts[i] - ts[i - 1]);
  }
  const mean = sum / n;
  let dev = 0;
  for (const v of ys) dev += (v - mean) ** 2;
  Object.assign(r, {
    mean,
    min: ys[iMin],
    max: ys[iMax],
    p2p: ys[iMax] - ys[iMin],
    rms: Math.sqrt(sq / n),
    std: n > 1 ? Math.sqrt(dev / (n - 1)) : null,
    first: ys[0],
    last: ys[n - 1],
    integral: area,
    tmax: ts[iMax] - start,
    tmin: ts[iMin] - start,
  });
  // Step response figures.
  const k = Math.max(1, Math.round(n * 0.05));
  const y0 = ys.slice(0, k).reduce((a, b) => a + b, 0) / k;
  const y1 = ys.slice(n - k).reduce((a, b) => a + b, 0) / k;
  const step = y1 - y0;
  if (n > 4 && Math.abs(step) > 1e-12 * Math.max(1, Math.abs(y0), Math.abs(y1))) {
    const at = (frac: number) => {
      const level = y0 + frac * step;
      for (let i = 1; i < n; i++) {
        const a = (ys[i - 1] - level) * Math.sign(step);
        const b = (ys[i] - level) * Math.sign(step);
        if (a < 0 && b >= 0) return ts[i - 1] + ((ts[i] - ts[i - 1]) * -a) / (b - a);
      }
      return null;
    };
    const t10 = at(0.1);
    const t90 = at(0.9);
    r.rise = t10 !== null && t90 !== null ? t90 - t10 : null;
    const band = Math.abs(step) * (opts.band ?? 0.02);
    let lastOut = -1;
    for (let i = 0; i < n; i++) if (Math.abs(ys[i] - y1) > band) lastOut = i;
    r.settle = lastOut < 0 ? 0 : lastOut + 1 < n ? ts[lastOut + 1] - start : null;
    const peak = step > 0 ? ys[iMax] : ys[iMin];
    r.overshoot = Math.max(0, ((peak - y1) / step) * 100);
  }
  return r;
}

/** The samples of a segment, with x measured from `origin` (the segment start or its trigger). */
export function cut(t: Num[], y: Num[], start: number, end: number, origin: number): { x: number[]; y: (number | null)[] } {
  const x: number[] = [];
  const v: (number | null)[] = [];
  for (let i = lowerBound(t, start); i < t.length; i++) {
    const ti = t[i];
    if (!ok(ti)) continue;
    if (ti > end) break;
    x.push(ti - origin);
    v.push(ok(y[i]) ? (y[i] as number) : null);
  }
  return { x, y: v };
}

/** Mean and ±1 standard deviation of several curves on a common grid (only where curves exist). */
export function meanCurve(curves: { x: number[]; y: (number | null)[] }[], points = 400): { x: number[]; mean: (number | null)[]; lo: (number | null)[]; hi: (number | null)[] } {
  const xs = curves.flatMap((c) => (c.x.length ? [c.x[0], c.x[c.x.length - 1]] : []));
  if (!xs.length) return { x: [], mean: [], lo: [], hi: [] };
  const a = Math.min(...xs);
  const b = Math.max(...xs);
  const grid = Array.from({ length: points }, (_, i) => a + ((b - a) * i) / Math.max(1, points - 1));
  const vals = curves.map((c) => {
    let j = 0;
    return grid.map((g) => {
      if (!c.x.length || g < c.x[0] || g > c.x[c.x.length - 1]) return null;
      while (j < c.x.length - 2 && c.x[j + 1] < g) j++;
      const y0 = c.y[j];
      const y1 = c.y[Math.min(c.x.length - 1, j + 1)];
      if (y0 === null || y1 === null) return y0 ?? y1;
      const span = c.x[j + 1] - c.x[j];
      return span > 0 ? y0 + ((y1 - y0) * (g - c.x[j])) / span : y0;
    });
  });
  const mean: (number | null)[] = [];
  const lo: (number | null)[] = [];
  const hi: (number | null)[] = [];
  grid.forEach((_, i) => {
    const col = vals.map((v) => v[i]).filter(ok);
    if (!col.length) {
      mean.push(null);
      lo.push(null);
      hi.push(null);
      return;
    }
    const m = col.reduce((s, v) => s + v, 0) / col.length;
    const sd = col.length > 1 ? Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / (col.length - 1)) : 0;
    mean.push(m);
    lo.push(m - sd);
    hi.push(m + sd);
  });
  return { x: grid, mean, lo, hi };
}
