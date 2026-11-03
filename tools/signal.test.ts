import { test } from "node:test";
import assert from "node:assert/strict";
import { angleResample, fft, fillMissing, frequencyResponse, orderMap, orderSpectrum, resonance, spectrogram } from "../src/lib/dsp.ts";
import { cut, detectEvents, makeSegments, meanCurve, measure } from "../src/lib/events.ts";

const near = (a: number | null, b: number, tol: number, what = "") => assert.ok(a !== null && Math.abs(a - b) <= tol, `${what} ${a} ≉ ${b} (±${tol})`);

test("fft of a cosine puts its energy in one bin", () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  near(Math.hypot(re[5], im[5]), n / 2, 1e-9);
  near(Math.hypot(re[6], im[6]), 0, 1e-9);
});

test("missing values are interpolated and the ends held", () => {
  assert.deepEqual([...fillMissing([null, 1, null, 3, null])], [1, 1, 2, 3, 3]);
});

test("spectrogram follows a frequency step", () => {
  const fs = 1000;
  const y = Float64Array.from({ length: 4000 }, (_, i) => Math.sin(2 * Math.PI * (i < 2000 ? 50 : 200) * (i / fs)));
  const s = spectrogram(y, fs, { nfft: 256, overlap: 0.5, maxBins: 1000 });
  const peak = (frame: number) => {
    let k = 0;
    for (let i = 1; i < s.freqs.length; i++) if (s.power[i][frame] > s.power[k][frame]) k = i;
    return s.freqs[k];
  };
  near(peak(1), 50, fs / 256);
  near(peak(s.times.length - 2), 200, fs / 256);
});

test("frequency response of a gain and a delay", () => {
  const fs = 100;
  const n = 20000;
  // White-ish input; output = 3 × input delayed by 2 samples.
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const x = Float64Array.from({ length: n }, rnd);
  const y = Float64Array.from({ length: n }, (_, i) => 3 * (x[i - 2] ?? 0));
  const h = frequencyResponse(x, y, fs, 512);
  const k = h.f.findIndex((f) => f >= 10);
  near(h.mag[k], 3, 0.05, "gain");
  // Phase of a 2-sample delay at f: −360·f·2/fs degrees.
  near(h.phase[k], (-360 * h.f[k] * 2) / fs, 2, "phase");
  assert.ok(h.coherence[k] > 0.99);
  const r = resonance(h);
  assert.ok(r && Math.abs(r.gainDb - 20 * Math.log10(3)) < 0.5);
});

test("order analysis finds the 2nd order during a run-up", () => {
  const fs = 2000;
  const n = 40000;
  const t = Float64Array.from({ length: n }, (_, i) => i / fs);
  // Speed ramps 5 → 25 rev/s; the signal turns at twice the shaft angle.
  const speed = Float64Array.from(t, (ti) => 5 + ti);
  const angle = Float64Array.from(t, (ti) => 5 * ti + ti * ti / 2);
  const y = Float64Array.from(angle, (a) => 1.5 * Math.sin(2 * Math.PI * 2 * a));
  const a = angleResample(t, y, speed, 32);
  near(a.revs.length / 32, 5 * 20 + 200, 1, "revolutions");
  const s = orderSpectrum(a, 32, 16);
  let k = 0;
  for (let i = 1; i < s.amplitude.length; i++) if (s.amplitude[i] > s.amplitude[k]) k = i;
  near(s.orders[k], 2, 1 / 16, "order");
  near(s.amplitude[k], 1.5, 0.1, "amplitude");
  const m = orderMap(a, 32, 8, 8);
  assert.ok(m.rpm[0] < m.rpm[m.rpm.length - 1], "rpm rises");
  assert.equal(m.amplitude.length, m.orders.length);
});

test("rising crossings with hysteresis ignore noise around the level", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const y = [0, 2, 0.9, 1.1, 0, 0, 2, 2, 0, 0];
  const e = detectEvents(t, y, { mode: "rising", level: 1, hysteresis: 0.5, holdoff: 0, tolerance: 0 });
  assert.deepEqual(e, [0.5, 5.5]);
  const both = detectEvents(t, y, { mode: "both", level: 1, hysteresis: 0.5, holdoff: 0, tolerance: 0 });
  assert.equal(both.length, 4);
  const held = detectEvents(t, y, { mode: "rising", level: 1, hysteresis: 0, holdoff: 10, tolerance: 0 });
  assert.deepEqual(held, [0.5]);
});

test("state changes and segments", () => {
  const t = [0, 1, 2, 3, 4, 5];
  const e = detectEvents(t, [1, 1, 2, 2, 1, 1], { mode: "change", level: 0, hysteresis: 0, holdoff: 0, tolerance: 0 });
  assert.deepEqual(e, [2, 4]);
  assert.deepEqual(makeSegments([1, 3, 3.1, 6], [0, 10], { mode: "between", pre: 0, post: 0, minDuration: 0.5 }).map((s) => [s.start, s.end]), [[1, 3], [3.1, 6]]);
  assert.deepEqual(makeSegments([1, 9.5], [0, 10], { mode: "window", pre: 2, post: 1, minDuration: 0 }).map((s) => [s.start, s.end]), [[0, 2], [7.5, 10]]);
});

test("measurements on a first-order step", () => {
  const tau = 1;
  const t = Array.from({ length: 1001 }, (_, i) => i / 100);
  const y = t.map((ti) => 1 - Math.exp(-ti / tau));
  const m = measure(t, y, 0, 10);
  near(m.max, 1 - Math.exp(-10), 1e-9);
  near(m.tmax, 10, 1e-9);
  near(m.integral, 10 - (1 - Math.exp(-10)), 1e-3);
  // Rise 10–90 % of a first-order lag is ln(9)·τ; the step is measured from the averaged ends.
  near(m.rise, Math.log(9) * tau, 0.15, "rise");
  near(m.settle, 3.9, 0.3, "settle");
  near(m.overshoot, 0, 0.01, "overshoot");
  const sq = measure([0, 1, 2, 3], [1, -1, 1, -1], 0, 3);
  near(sq.rms, 1, 1e-12);
  near(sq.p2p, 2, 1e-12);
});

test("cycles cut and averaged on a common grid", () => {
  const t = Array.from({ length: 41 }, (_, i) => i * 0.25);
  const y = t.map((ti) => ti % 5);
  const a = cut(t, y, 0, 4, 0);
  const b = cut(t, y, 5, 9, 5);
  assert.deepEqual(a.x, b.x);
  const m = meanCurve([a, b], 5);
  assert.deepEqual(m.mean, [0, 1, 2, 3, 4]);
});
