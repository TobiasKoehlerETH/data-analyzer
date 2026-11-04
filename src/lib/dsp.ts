/**
 * Frequency analysis in the browser: FFT, spectrogram (STFT), Welch cross-spectra, frequency
 * response (H1) with coherence, and order analysis by resampling to the shaft angle.
 * Pure functions, no imports, so they run under `node --test`.
 */

export type Num = number | null | undefined;

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** In-place iterative radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Periodic Hann window. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Missing values replaced by linear interpolation; the ends hold the nearest valid value. */
export function fillMissing(y: Num[]): Float64Array {
  const out = new Float64Array(y.length);
  let last = -1;
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (last < 0) for (let k = 0; k < i; k++) out[k] = v;
    else for (let k = last + 1; k < i; k++) out[k] = (y[last] as number) + ((v - (y[last] as number)) * (k - last)) / (i - last);
    out[i] = v;
    last = i;
  }
  if (last >= 0) for (let k = last + 1; k < y.length; k++) out[k] = y[last] as number;
  return out;
}

/** Median spacing of a time axis (robust to gaps). */
export function medianStep(t: Num[]): number {
  const d: number[] = [];
  for (let i = 1; i < t.length && d.length < 4000; i++) {
    const a = t[i - 1];
    const b = t[i];
    if (a != null && b != null && b > a) d.push(b - a);
  }
  if (!d.length) return 1;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** Collapses `power[f][frame]` rows into at most `max` rows, keeping the largest value (peaks stay visible). */
function collapseRows(freqs: number[], power: number[][], max: number) {
  if (freqs.length <= max) return { freqs, power };
  const g = Math.ceil(freqs.length / max);
  const f: number[] = [];
  const p: number[][] = [];
  for (let i = 0; i < freqs.length; i += g) {
    f.push(freqs[Math.min(freqs.length - 1, i + Math.floor(g / 2))]);
    const row = power[i].slice();
    for (let k = i + 1; k < Math.min(freqs.length, i + g); k++) for (let j = 0; j < row.length; j++) row[j] = Math.max(row[j], power[k][j]);
    p.push(row);
  }
  return { freqs: f, power: p };
}

export interface Spectrogram {
  /** Centre time of each frame [s]. */
  times: number[];
  freqs: number[];
  /** Power density in dB, `power[frequency][frame]`. */
  power: number[][];
  nfft: number;
  hop: number;
}

/**
 * Short-time power density in dB (Hann window, one-sided). Frames are spread so there are at most
 * `maxFrames`; frequency rows above `fmax` are dropped and the rest collapsed to `maxBins`.
 */
export function spectrogram(
  y: Float64Array,
  fs: number,
  opts: { nfft: number; overlap: number; t0?: number; fmax?: number; maxFrames?: number; maxBins?: number },
): Spectrogram {
  // A power-of-two window no longer than the signal.
  const n = Math.max(8, Math.min(nextPow2(opts.nfft), 2 ** Math.floor(Math.log2(Math.max(8, y.length)))));
  const maxFrames = opts.maxFrames ?? 600;
  let hop = Math.max(1, Math.round(n * (1 - Math.min(0.95, Math.max(0, opts.overlap)))));
  const frames0 = Math.floor((y.length - n) / hop) + 1;
  if (frames0 > maxFrames) hop = Math.ceil((y.length - n) / (maxFrames - 1));
  const frames = Math.max(1, Math.floor((y.length - n) / hop) + 1);
  const w = hann(n);
  let s2 = 0;
  for (const v of w) s2 += v * v;
  const half = n / 2;
  const df = fs / n;
  const top = Math.min(half, opts.fmax ? Math.floor(opts.fmax / df) : half);
  const power: number[][] = Array.from({ length: top + 1 }, () => new Array(frames));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const times: number[] = [];
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[start + i] ?? 0;
    mean /= n;
    for (let i = 0; i < n; i++) {
      re[i] = ((y[start + i] ?? mean) - mean) * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= top; k++) {
      let p = (re[k] * re[k] + im[k] * im[k]) / (fs * s2);
      if (k > 0 && k < half) p *= 2;
      power[k][f] = 10 * Math.log10(p + 1e-300);
    }
    times.push((opts.t0 ?? 0) + (start + n / 2) / fs);
  }
  const freqs = Array.from({ length: top + 1 }, (_, k) => k * df);
  const c = collapseRows(freqs, power, opts.maxBins ?? 512);
  return { times, freqs: c.freqs, power: c.power, nfft: n, hop };
}

export interface CrossSpectra {
  f: number[];
  gxx: Float64Array;
  gyy: Float64Array;
  gxyRe: Float64Array;
  gxyIm: Float64Array;
  segments: number;
}

/** Welch auto- and cross-spectra of two equally sampled signals (Hann, 50 % overlap by default). */
export function welchCross(x: Float64Array, y: Float64Array, fs: number, nperseg: number, overlap = 0.5): CrossSpectra {
  const len = Math.min(x.length, y.length);
  const n = Math.min(nextPow2(nperseg), 2 ** Math.floor(Math.log2(Math.max(8, len))));
  const hop = Math.max(1, Math.round(n * (1 - overlap)));
  const w = hann(n);
  const half = n / 2;
  const gxx = new Float64Array(half + 1);
  const gyy = new Float64Array(half + 1);
  const gxyRe = new Float64Array(half + 1);
  const gxyIm = new Float64Array(half + 1);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  let segments = 0;
  for (let start = 0; start + n <= len; start += hop) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += x[start + i];
      my += y[start + i];
    }
    mx /= n;
    my /= n;
    for (let i = 0; i < n; i++) {
      xr[i] = (x[start + i] - mx) * w[i];
      yr[i] = (y[start + i] - my) * w[i];
      xi[i] = 0;
      yi[i] = 0;
    }
    fft(xr, xi);
    fft(yr, yi);
    for (let k = 0; k <= half; k++) {
      gxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
      gyy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      // conj(X) · Y
      gxyRe[k] += xr[k] * yr[k] + xi[k] * yi[k];
      gxyIm[k] += xr[k] * yi[k] - xi[k] * yr[k];
    }
    segments++;
  }
  return { f: Array.from({ length: half + 1 }, (_, k) => (k * fs) / n), gxx, gyy, gxyRe, gxyIm, segments };
}

export interface FrequencyResponse {
  f: number[];
  /** |H| (output units per input unit). */
  mag: number[];
  magDb: number[];
  /** Unwrapped phase in degrees. */
  phase: number[];
  /** Magnitude-squared coherence, 0…1. */
  coherence: number[];
  segments: number;
}

/** H1 estimate H = Gxy / Gxx with coherence, from input `x` to output `y`. DC is left out. */
export function frequencyResponse(x: Float64Array, y: Float64Array, fs: number, nperseg: number, overlap = 0.5): FrequencyResponse {
  const s = welchCross(x, y, fs, nperseg, overlap);
  const out: FrequencyResponse = { f: [], mag: [], magDb: [], phase: [], coherence: [], segments: s.segments };
  let prev = 0;
  let offset = 0;
  for (let k = 1; k < s.f.length; k++) {
    const gxx = s.gxx[k];
    if (!(gxx > 0)) continue;
    const hr = s.gxyRe[k] / gxx;
    const hi = s.gxyIm[k] / gxx;
    const mag = Math.hypot(hr, hi);
    let ph = (Math.atan2(hi, hr) * 180) / Math.PI;
    if (out.phase.length) {
      while (ph + offset - prev > 180) offset -= 360;
      while (ph + offset - prev < -180) offset += 360;
    }
    ph += offset;
    prev = ph;
    const coh = s.gyy[k] > 0 ? (s.gxyRe[k] ** 2 + s.gxyIm[k] ** 2) / (gxx * s.gyy[k]) : 0;
    out.f.push(s.f[k]);
    out.mag.push(mag);
    out.magDb.push(20 * Math.log10(mag + 1e-300));
    out.phase.push(ph);
    out.coherence.push(Math.min(1, Math.max(0, coh)));
  }
  return out;
}

/** The frequency of the largest magnitude, and the −3 dB band around it. */
export function resonance(h: FrequencyResponse): { f: number; gainDb: number; low: number | null; high: number | null } | null {
  if (!h.f.length) return null;
  let k = 0;
  for (let i = 1; i < h.magDb.length; i++) if (h.magDb[i] > h.magDb[k]) k = i;
  const edge = h.magDb[k] - 3;
  let lo = k;
  while (lo > 0 && h.magDb[lo] > edge) lo--;
  let hi = k;
  while (hi < h.magDb.length - 1 && h.magDb[hi] > edge) hi++;
  return { f: h.f[k], gainDb: h.magDb[k], low: h.magDb[lo] <= edge ? h.f[lo] : null, high: h.magDb[hi] <= edge ? h.f[hi] : null };
}

export interface AngleSignal {
  /** Uniform shaft angle in revolutions. */
  revs: Float64Array;
  y: Float64Array;
  /** Time [s] at each angle step. */
  time: Float64Array;
  /** Speed [rev/s] at each angle step. */
  speed: Float64Array;
}

/**
 * Resamples `y(t)` at equal steps of shaft angle. The angle is the running integral of the speed
 * (rev/s); stretches where the shaft stands still or turns backwards add no angle.
 */
export function angleResample(t: Float64Array, y: Float64Array, speed: Float64Array, samplesPerRev: number): AngleSignal {
  const n = Math.min(t.length, y.length, speed.length);
  const phi = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const s = Math.max(0, (speed[i] + speed[i - 1]) / 2);
    phi[i] = phi[i - 1] + s * (t[i] - t[i - 1]);
  }
  const total = n ? phi[n - 1] : 0;
  const m = Math.max(0, Math.floor(total * samplesPerRev));
  const revs = new Float64Array(m);
  const out = new Float64Array(m);
  const time = new Float64Array(m);
  const spd = new Float64Array(m);
  let j = 0;
  for (let k = 0; k < m; k++) {
    const r = k / samplesPerRev;
    while (j < n - 2 && phi[j + 1] <= r) j++;
    const span = phi[j + 1] - phi[j];
    const a = span > 0 ? Math.min(1, Math.max(0, (r - phi[j]) / span)) : 0;
    revs[k] = r;
    out[k] = y[j] + (y[j + 1] - y[j]) * a;
    time[k] = t[j] + (t[j + 1] - t[j]) * a;
    spd[k] = speed[j] + (speed[j + 1] - speed[j]) * a;
  }
  return { revs, y: out, time, speed: spd };
}

/** Peak amplitude per order: Welch in the angle domain (Hann, amplitude-corrected). */
export function orderSpectrum(a: AngleSignal, samplesPerRev: number, revsPerSegment: number): { orders: number[]; amplitude: number[] } {
  const n = Math.min(nextPow2(revsPerSegment * samplesPerRev), 2 ** Math.floor(Math.log2(Math.max(8, a.y.length))));
  const s = welchCross(a.y, a.y, samplesPerRev, n);
  const w = hann(n);
  let sw = 0;
  for (const v of w) sw += v;
  const orders: number[] = [];
  const amplitude: number[] = [];
  for (let k = 1; k < s.f.length; k++) {
    orders.push(s.f[k]);
    // Mean |X|² over segments → peak amplitude of a sinusoid at that order.
    amplitude.push((2 * Math.sqrt(s.gxx[k] / Math.max(1, s.segments))) / sw);
  }
  return { orders, amplitude };
}

export interface OrderMap {
  orders: number[];
  /** Mean speed of each frame [rpm]. */
  rpm: number[];
  /** Centre time of each frame [s]. */
  time: number[];
  /** Peak amplitude, `amplitude[order][frame]`. */
  amplitude: number[][];
}

/** Order amplitudes frame by frame (each frame `revsPerFrame` revolutions long). */
export function orderMap(a: AngleSignal, samplesPerRev: number, revsPerFrame: number, maxOrder: number, maxFrames = 400): OrderMap {
  const n = Math.min(nextPow2(revsPerFrame * samplesPerRev), 2 ** Math.floor(Math.log2(Math.max(8, a.y.length))));
  const frames0 = Math.max(1, Math.floor((a.y.length - n) / (n / 2)) + 1);
  const hop = frames0 > maxFrames ? Math.ceil((a.y.length - n) / (maxFrames - 1)) : n / 2;
  const w = hann(n);
  let sw = 0;
  for (const v of w) sw += v;
  const dOrder = samplesPerRev / n;
  const top = Math.min(n / 2, Math.floor(maxOrder / dOrder));
  const amplitude: number[][] = Array.from({ length: top }, () => []);
  const rpm: number[] = [];
  const time: number[] = [];
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let start = 0; start + n <= a.y.length; start += hop) {
    let mean = 0;
    let sp = 0;
    for (let i = 0; i < n; i++) {
      mean += a.y[start + i];
      sp += a.speed[start + i];
    }
    mean /= n;
    for (let i = 0; i < n; i++) {
      re[i] = (a.y[start + i] - mean) * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k <= top; k++) amplitude[k - 1].push((2 * Math.hypot(re[k], im[k])) / sw);
    rpm.push((sp / n) * 60);
    time.push(a.time[start + Math.floor(n / 2)]);
  }
  return { orders: Array.from({ length: top }, (_, k) => (k + 1) * dOrder), rpm, time, amplitude };
}

/** Rows of `v` whose time lies in `range` (all rows when range is null). */
export function clip<T extends { time: Num[]; columns: Record<string, Num[]> }>(v: T | null, range: [number, number] | null): T | null {
  if (!v || !range) return v;
  const keep: number[] = [];
  v.time.forEach((t, i) => t != null && t >= range[0] && t <= range[1] && keep.push(i));
  if (keep.length === v.time.length) return v;
  const pick = <U,>(a: U[]) => keep.map((i) => a[i]);
  return { ...v, time: pick(v.time), columns: Object.fromEntries(Object.entries(v.columns).map(([k, c]) => [k, pick(c)])) };
}
