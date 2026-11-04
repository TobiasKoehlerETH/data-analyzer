/**
 * Peak, valley and limit detection on a time series. The peak rules follow the usual
 * `find_peaks` definitions (height, threshold, distance, prominence, width at a relative height).
 * Pure, no imports, so it runs under `node --test`.
 */

export type Num = number | null | undefined;
const ok = (v: Num): v is number => v !== null && v !== undefined && Number.isFinite(v);

export interface PeakOptions {
  /** "max": peaks, "min": valleys (negative peaks), "both". */
  kind: "max" | "min" | "both";
  /** Keep only extremes whose value lies in this range (either end may be null). */
  minValue?: number | null;
  maxValue?: number | null;
  /** Smallest prominence: how far the extreme stands out from the higher of its two bases. */
  prominence?: number;
  /** Smallest step to both direct neighbours (in signal units). */
  threshold?: number;
  /** Smallest time between two kept extremes of one kind [s]; the more prominent one wins. */
  distance?: number;
  /** Width at `relHeight` of the prominence: keep extremes at least / at most this wide [s]. */
  minWidth?: number;
  maxWidth?: number | null;
  /** 0.5 = width at half prominence (FWHM-style). */
  relHeight?: number;
  /** Only search between these times. */
  from?: number | null;
  to?: number | null;
  /** Keep only the N most prominent (0 = all). */
  maxCount?: number;
}

export interface Peak {
  kind: "max" | "min";
  index: number;
  time: number;
  value: number;
  prominence: number;
  /** Time of the lowest point between the peak and a higher one, on each side (the bases). */
  leftBase: number;
  rightBase: number;
  /** Width at relHeight [s], with its two crossing times. */
  width: number;
  left: number;
  right: number;
  /** The level the width was measured at. */
  widthLevel: number;
}

/** Peaks of `y` (or of −y for valleys). Values are returned in the signal's own sign. */
function findMax(t: number[], y: number[], o: PeakOptions, sign: 1 | -1): Peak[] {
  const n = y.length;
  const v = sign === 1 ? y : y.map((x) => -x);
  const candidates: number[] = [];
  // Local maxima, with flat tops reported at their middle.
  for (let i = 1; i < n - 1; i++) {
    if (!(v[i] > v[i - 1])) continue;
    let j = i;
    while (j + 1 < n && v[j + 1] === v[i]) j++;
    if (j + 1 < n && v[j + 1] < v[i]) candidates.push(Math.floor((i + j) / 2));
    i = j;
  }
  const lo = o.minValue ?? null;
  const hi = o.maxValue ?? null;
  let peaks = candidates.filter((i) => (lo === null || y[i] >= lo) && (hi === null || y[i] <= hi));
  if (o.threshold && o.threshold > 0) peaks = peaks.filter((i) => Math.min(v[i] - v[i - 1], v[i] - v[i + 1]) >= o.threshold!);

  const info = peaks.map((i) => {
    // Bases: walk out until a higher sample (or the end); the lowest point on the way is the base.
    let lMin = v[i];
    let lIdx = i;
    for (let k = i - 1; k >= 0 && v[k] <= v[i]; k--) if (v[k] < lMin) (lMin = v[k]), (lIdx = k);
    let rMin = v[i];
    let rIdx = i;
    for (let k = i + 1; k < n && v[k] <= v[i]; k++) if (v[k] < rMin) (rMin = v[k]), (rIdx = k);
    const prominence = v[i] - Math.max(lMin, rMin);
    const level = v[i] - prominence * (o.relHeight ?? 0.5);
    const cross = (from: number, step: -1 | 1, stop: number) => {
      let k = from;
      while (k !== stop && v[k] > level) k += step;
      const a = k - step;
      // Interpolate between the last sample above and the first at or below the level.
      if (v[k] === v[a]) return t[k];
      return t[a] + ((t[k] - t[a]) * (v[a] - level)) / (v[a] - v[k]);
    };
    const left = cross(i, -1, lIdx);
    const right = cross(i, 1, rIdx);
    return { i, prominence, lIdx, rIdx, left, right, level };
  });

  let kept = info.filter((p) => p.prominence >= (o.prominence ?? 0));
  kept = kept.filter((p) => p.right - p.left >= (o.minWidth ?? 0) && (o.maxWidth == null || p.right - p.left <= o.maxWidth));
  if (o.distance && o.distance > 0) {
    // Most prominent first; drop any extreme closer than `distance` to one already kept.
    const byProm = [...kept].sort((a, b) => b.prominence - a.prominence || v[b.i] - v[a.i]);
    const taken: number[] = [];
    const keep = new Set<number>();
    for (const p of byProm) {
      if (taken.some((ti) => Math.abs(ti - t[p.i]) < o.distance!)) continue;
      taken.push(t[p.i]);
      keep.add(p.i);
    }
    kept = kept.filter((p) => keep.has(p.i));
  }
  return kept.map((p) => ({
    kind: sign === 1 ? "max" : "min",
    index: p.i,
    time: t[p.i],
    value: y[p.i],
    prominence: p.prominence,
    leftBase: t[p.lIdx],
    rightBase: t[p.rIdx],
    width: p.right - p.left,
    left: p.left,
    right: p.right,
    widthLevel: sign * p.level,
  }));
}

/** Peaks and/or valleys, in time order. Missing samples are skipped. */
export function findPeaks(time: Num[], values: Num[], o: PeakOptions): Peak[] {
  const t: number[] = [];
  const y: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const ti = time[i];
    const v = values[i];
    if (!ok(ti) || !ok(v)) continue;
    if (o.from != null && ti < o.from) continue;
    if (o.to != null && ti > o.to) continue;
    t.push(ti);
    y.push(v);
    idx.push(i);
  }
  if (y.length < 3) return [];
  let out = [...(o.kind !== "min" ? findMax(t, y, o, 1) : []), ...(o.kind !== "max" ? findMax(t, y, o, -1) : [])];
  if (o.maxCount && o.maxCount > 0 && out.length > o.maxCount) {
    const top = new Set([...out].sort((a, b) => b.prominence - a.prominence).slice(0, o.maxCount));
    out = out.filter((p) => top.has(p));
  }
  return out.map((p) => ({ ...p, index: idx[p.index] })).sort((a, b) => a.time - b.time);
}

export interface LimitOptions {
  upper?: number | null;
  lower?: number | null;
  /** A violation ends only once the signal is back inside by this much. */
  hysteresis?: number;
  /** Shorter violations are ignored [s]. */
  minDuration?: number;
  from?: number | null;
  to?: number | null;
}

export interface Violation {
  kind: "upper" | "lower";
  start: number;
  end: number;
  duration: number;
  /** The furthest value outside the limit, and when. */
  extreme: number;
  extremeTime: number;
  /** How far the extreme lies beyond the limit. */
  excess: number;
}

/** Stretches where the signal is above `upper` or below `lower` (crossings interpolated). */
export function findViolations(time: Num[], values: Num[], o: LimitOptions): Violation[] {
  const out: Violation[] = [];
  const h = Math.max(0, o.hysteresis ?? 0);
  for (const kind of ["upper", "lower"] as const) {
    const limit = kind === "upper" ? o.upper : o.lower;
    if (limit == null || !Number.isFinite(limit)) continue;
    const s = kind === "upper" ? 1 : -1;
    // Work on s·(y − limit): positive = outside.
    let cur: Violation | null = null;
    let back: number | null = null;
    let pt: number | null = null;
    let pd: number | null = null;
    for (let i = 0; i < values.length; i++) {
      const ti = time[i];
      const v = values[i];
      if (!ok(ti) || !ok(v) || (o.from != null && ti < o.from) || (o.to != null && ti > o.to)) {
        pt = null;
        pd = null;
        continue;
      }
      const d = s * (v - limit);
      // Where the signal last crossed back inside: the end, once it is confirmed by the hysteresis.
      const crossing = () => (pt !== null && pd !== null && pd !== d ? pt + ((ti - pt) * pd) / (pd - d) : ti);
      if (!cur && d > 0) {
        const start = pt !== null && pd !== null && pd <= 0 ? crossing() : ti;
        cur = { kind, start, end: ti, duration: 0, extreme: v, extremeTime: ti, excess: d };
        back = null;
      } else if (cur) {
        if (d > cur.excess) Object.assign(cur, { extreme: v, extremeTime: ti, excess: d });
        if (d > 0) back = null;
        else if (back === null && pd !== null && pd > 0) back = crossing();
        if (d < -h || (h === 0 && d <= 0)) {
          cur.end = back ?? ti;
          cur.duration = cur.end - cur.start;
          out.push(cur);
          cur = null;
          back = null;
        } else if (d > 0) cur.end = ti;
      }
      pt = ti;
      pd = d;
    }
    if (cur) {
      cur.duration = cur.end - cur.start;
      out.push(cur);
    }
  }
  return out.filter((v) => v.duration >= (o.minDuration ?? 0)).sort((a, b) => a.start - b.start);
}

/** Rows as CSV: a header line, then one line per row; text with commas or quotes is quoted. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (c: string | number | null | undefined) => {
    if (c === null || c === undefined || (typeof c === "number" && !Number.isFinite(c))) return "";
    const s = typeof c === "number" ? String(c) : c;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
