import { test } from "node:test";
import assert from "node:assert/strict";
import { findPeaks, findViolations, toCsv } from "../src/lib/peaks.ts";
import { canonical, conversion, guessUnit, lookup } from "../src/lib/units.ts";

const near = (a: number | null | undefined, b: number, tol: number, what = "") => assert.ok(a != null && Math.abs(a - b) <= tol, `${what} ${a} ≉ ${b} (±${tol})`);

test("unit conversions within a quantity", () => {
  near(conversion("mm", "m")?.scale, 1e-3, 1e-15);
  const c = conversion("°C", "°F")!;
  near(100 * c.scale + c.offset, 212, 1e-9, "100 °C");
  const k = conversion("degC", "K")!;
  near(0 * k.scale + k.offset, 273.15, 1e-9);
  near(conversion("rpm", "Hz")?.scale, 1 / 60, 1e-15);
  near(conversion("bar", "psi")?.scale, 14.5037738, 1e-6);
  near(conversion("g", "m/s²")?.scale, 9.80665, 1e-12, "g as acceleration");
  near(conversion("g", "kg")?.scale, 1e-3, 1e-15, "g as mass");
  assert.equal(conversion("N", "m"), null);
  assert.equal(conversion("furlong", "m"), null);
  assert.equal(canonical("Nm"), "N·m");
  assert.equal(canonical("C"), "°C");
  assert.equal(lookup("Hz").length, 2);
  assert.equal(guessUnit("Temperature A"), "°C");
  assert.equal(guessUnit("Status"), null);
});

test("peaks with prominence, distance and width", () => {
  const t = Array.from({ length: 1001 }, (_, i) => i / 100);
  // Gaussian peaks of height 1 at 2 s and 0.5 at 6 s (σ = 0.2 s) plus a tiny ripple.
  const y = t.map((x) => Math.exp(-(((x - 2) / 0.2) ** 2) / 2) + 0.5 * Math.exp(-(((x - 6) / 0.2) ** 2) / 2) + 0.001 * Math.sin(40 * x));
  const all = findPeaks(t, y, { kind: "max" });
  assert.ok(all.length > 2, "the ripple makes small peaks");
  const big = findPeaks(t, y, { kind: "max", prominence: 0.1 });
  assert.deepEqual(big.map((p) => Math.round(p.time * 10) / 10), [2, 6]);
  // Full width at half maximum of a Gaussian = 2.3548 σ.
  near(big[0].width, 2.3548 * 0.2, 0.02, "FWHM");
  near(big[1].prominence, 0.5, 0.01);
  assert.equal(findPeaks(t, y, { kind: "max", prominence: 0.1, minValue: 0.8 }).length, 1);
  assert.equal(findPeaks(t, y, { kind: "max", prominence: 0.1, distance: 5 }).length, 1);
  assert.equal(findPeaks(t, y, { kind: "max", prominence: 0.1, maxCount: 1 })[0].time, 2);
  assert.equal(findPeaks(t, y, { kind: "max", prominence: 0.1, from: 4 }).length, 1);
});

test("valleys below zero and flat tops", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const y = [0, -2, 0, 1, 0, -0.5, 0, 3, 0];
  const v = findPeaks(t, y, { kind: "min", maxValue: -1 });
  assert.deepEqual(v.map((p) => [p.time, p.value]), [[1, -2]]);
  assert.equal(v[0].kind, "min");
  near(v[0].prominence, 2, 1e-12);
  const both = findPeaks(t, y, { kind: "both" });
  assert.deepEqual(both.map((p) => p.kind), ["min", "max", "min", "max"]);
  const flat = findPeaks([0, 1, 2, 3, 4], [0, 1, 1, 1, 0], { kind: "max" });
  assert.deepEqual(flat.map((p) => p.time), [2]);
});

test("limit violations with hysteresis and minimum duration", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const y = [0, 2, 4, 2, 0.9, 1.5, 0, -3, 0, 0];
  const v = findViolations(t, y, { upper: 1, lower: -1 });
  // Crossings are interpolated: 0→2 crosses 1 at 0.5; 2→0.9 at 3 + 1/1.1; 0.9→1.5 at 4 + 0.1/0.6 …
  const r = (x: number) => Number(x.toFixed(3));
  assert.deepEqual(v.map((x) => [x.kind, r(x.start), r(x.end)]), [["upper", 0.5, 3.909], ["upper", 4.167, 5.333], ["lower", 6.333, 7.667]]);
  assert.equal(v[0].extreme, 4);
  near(v[2].start, 6 + 1 / 3, 1e-9);
  // With hysteresis 0.5 the dip to 0.9 does not end the first violation.
  const h = findViolations(t, y, { upper: 1, hysteresis: 0.5 });
  assert.equal(h.length, 1);
  near(h[0].end, 5 + 0.5 / 1.5, 1e-9);
  assert.equal(findViolations(t, y, { upper: 1, minDuration: 3 }).length, 1);
});

test("csv quoting", () => {
  assert.equal(toCsv(["a", "b"], [["x,y", 1.5], ['say "hi"', null]]), 'a,b\n"x,y",1.5\n"say ""hi""",\n');
});

test("names lose the unit written in them", async () => {
  const { bareName } = await import("../src/lib/units.ts");
  assert.equal(bareName("Force (N) · run_a", "N"), "Force · run_a");
  assert.equal(bareName("Gap [mm]", "mm"), "Gap");
  assert.equal(bareName("Flow (L/min) · b", "L/min"), "Flow · b");
  assert.equal(bareName("Counts", ""), "Counts");
});
