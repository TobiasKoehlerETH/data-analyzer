/**
 * The app-wide selection ("brush"): a set of time intervals on the aligned time axis.
 * Pure helpers, no imports, so they run under `node --test`.
 */

export type Interval = [number, number];
type Num = number | null | undefined;

/** Sorted, non-overlapping intervals (touching ones merge). */
export function normalize(intervals: Interval[]): Interval[] {
  const s = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as Interval)
    .sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** True when `t` lies in one of the (normalized) intervals; no selection means everything is in. */
export function inside(t: number, brush: Interval[] | null | undefined): boolean {
  if (!brush || !brush.length) return true;
  let lo = 0;
  let hi = brush.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < brush[mid][0]) hi = mid - 1;
    else if (t > brush[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Values outside the selection become missing (rows keep their place). */
export function mask<T extends Num>(time: Num[], values: T[], brush: Interval[] | null | undefined): (T | null)[] {
  if (!brush || !brush.length) return values;
  return values.map((v, i) => {
    const t = time[i];
    return t !== null && t !== undefined && inside(t, brush) ? v : null;
  });
}

/** From the first selected time to the last (for analyses that need one contiguous stretch). */
export function span(brush: Interval[] | null | undefined): Interval | null {
  return brush && brush.length ? [brush[0][0], brush[brush.length - 1][1]] : null;
}

export const total = (brush: Interval[]) => brush.reduce((s, [a, b]) => s + (b - a), 0);

/**
 * Where `values` lie in [lo, hi] (either end may be null): one interval per run of rows, from
 * the first to the last row of the run. Runs closer than `gap` seconds are joined.
 */
export function where(time: Num[], values: Num[], lo: number | null, hi: number | null, gap = 0): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const t = time[i];
    const v = values[i];
    if (t === null || t === undefined || !Number.isFinite(t)) continue;
    const ok = v !== null && v !== undefined && Number.isFinite(v) && (lo === null || v >= lo) && (hi === null || v <= hi);
    if (ok) {
      if (start === null) start = t;
      last = t;
    } else if (start !== null) {
      out.push([start, last!]);
      start = null;
    }
  }
  if (start !== null) out.push([start, last!]);
  if (gap <= 0) return out;
  const joined: Interval[] = [];
  for (const iv of out) {
    const prev = joined[joined.length - 1];
    if (prev && iv[0] - prev[1] <= gap) prev[1] = iv[1];
    else joined.push([iv[0], iv[1]]);
  }
  return joined;
}

/** "12.3 – 20 s" or "3 ranges · 34.5 s". */
export function describe(brush: Interval[]): string {
  const n = (v: number) => String(Number(v.toPrecision(4)));
  if (!brush.length) return "";
  if (brush.length === 1) return `${n(brush[0][0])} – ${n(brush[0][1])} s`;
  return `${brush.length} ranges · ${n(total(brush))} s`;
}

/** How a chart's x axis maps to the aligned time axis (seconds), for the linked cursor and the selection. */
export interface TimeAxis {
  toTime: (x: number) => number;
  toX: (t: number) => number;
}

export const SECONDS: TimeAxis = { toTime: (x) => x, toX: (t) => t };

/** A date axis in Unix milliseconds, with t = 0 at `origin` (Unix seconds). */
export const dateAxis = (origin: number): TimeAxis => ({ toTime: (x) => x / 1000 - origin, toX: (t) => (origin + t) * 1000 });

/** A 1-based row axis whose rows sit at `times` (increasing). */
export function rowAxis(times: ArrayLike<number>): TimeAxis {
  const n = times.length;
  return {
    toTime: (x) => (n ? times[Math.min(n - 1, Math.max(0, Math.round(x) - 1))] : x),
    toX: (t) => {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      // A time between two rows maps to a fractional row, so lines sit exactly.
      if (lo > 0 && times[lo] !== times[lo - 1]) {
        const f = (t - times[lo - 1]) / (times[lo] - times[lo - 1]);
        if (f >= 0 && f <= 1) return lo + f;
      }
      return lo + 1;
    },
  };
}
