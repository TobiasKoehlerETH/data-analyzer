// Generates a deterministic test dataset for Data Analyzer.
//
//   node tools/make-test-dataset.mjs            feature suite  -> samples/test-suite/   (small, committed)
//   node tools/make-test-dataset.mjs --stress   stress set     -> samples/stress/       (large, git-ignored)
//   node tools/make-test-dataset.mjs --stress --rows 3000000   longer main log
//
// Every signal is built from known pieces (spikes, gaps, drift, sinusoids, coefficients), and
// manifest.json records them, so a result can be checked against the truth.
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stress = args.includes("--stress");
const rowsArg = args.indexOf("--rows");
const MAIN_ROWS = rowsArg >= 0 ? Number(args[rowsArg + 1]) : 1_000_000;
const root = new URL("../samples/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = join(root, stress ? "stress" : "test-suite");
mkdirSync(out, { recursive: true });

// ---- seeded randomness -------------------------------------------------------------------
let seed = 20260302;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const TAU = 2 * Math.PI;
const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "");

const manifest = { generator: "tools/make-test-dataset.mjs", seed: 20260302, files: {} };

/** Writes rows (arrays of strings) in chunks, so millions of rows never sit in memory twice. */
async function writeCsv(name, header, nRows, rowFn, { sep = ",", prelude = "" } = {}) {
  const ws = createWriteStream(join(out, name));
  const write = (s) => new Promise((res) => (ws.write(s) ? res() : ws.once("drain", res)));
  await write(prelude + header.join(sep) + "\n");
  let buf = [];
  for (let i = 0; i < nRows; i++) {
    buf.push(rowFn(i).join(sep));
    if (buf.length >= 20000) {
      await write(buf.join("\n") + "\n");
      buf = [];
    }
  }
  if (buf.length) await write(buf.join("\n") + "\n");
  await new Promise((res) => ws.end(res));
}

function pearson(a, b) {
  const idx = a.map((_, i) => i).filter((i) => Number.isFinite(a[i]) && Number.isFinite(b[i]));
  const n = idx.length;
  const ma = idx.reduce((s, i) => s + a[i], 0) / n;
  const mb = idx.reduce((s, i) => s + b[i], 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (const i of idx) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
const ranks = (v) => {
  const order = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(v.length);
  order.forEach(([, i], k) => (r[i] = k + 1));
  return r;
};

// ============================================================================================
// Feature suite
// ============================================================================================
async function suite() {
  // ---- A. force_100hz.csv: time in MINUTES, spikes, a gap, drift, interference, text phase ----
  {
    const fs = 100, n = 30000, cycle = 50; // 6 loading cycles of 50 s
    const spikeRows = Array.from({ length: 8 }, (_, k) => 2500 + k * 3300);
    const gap = [15000, 15299];
    const forceAt = (t) => {
      const c = t % cycle;
      return c < 20 ? (200 * c) / 20 : c < 40 ? 200 * (1 - (c - 20) / 20) : 0;
    };
    const phase = (t) => {
      const c = t % cycle;
      return c < 20 ? "ramp" : c < 40 ? "release" : "rest";
    };
    await writeCsv("force_100hz.csv", ["Time (min)", "Force (N)", "Distance (mm)", "Phase"], n, (i) => {
      const t = i / fs;
      let f = forceAt(t) + 0.25 * gauss() + 0.4 * Math.sin(TAU * 12 * t) + 0.004 * t;
      const sp = spikeRows.indexOf(i);
      if (sp >= 0) f += (sp % 2 ? -1 : 1) * (35 + 5 * sp);
      const inGap = i >= gap[0] && i <= gap[1];
      return [fmt(t / 60, 6), inGap ? "" : fmt(f, 3), inGap ? "" : fmt(0.002 * forceAt(t) + 0.0005 * gauss(), 5), phase(t)];
    });
    manifest.files["force_100hz.csv"] = {
      tests: ["time column in minutes (set unit: minutes)", "despike", "fill gaps", "low-pass / notch (12 Hz)", "text column group-by", "downsample", "high-pass (drift)"],
      rows: n, rate_hz: fs, time_unit: "minutes", duration_s: n / fs, cycles: 6, peak_force_N: 200,
      spike_rows_zero_based: spikeRows, spike_sizes_N: spikeRows.map((_, k) => (k % 2 ? -1 : 1) * (35 + 5 * k)),
      gap_rows_zero_based: gap, interference_hz: 12, interference_amp_N: 0.4, drift_N_per_s: 0.004, noise_sigma_N: 0.25,
    };
  }

  // ---- B. sensor_10hz.csv: slower sensor, lags force by 0.5 s ----
  {
    const fs = 10, n = 3000, cycle = 50, lag = 0.5;
    const forceAt = (t) => {
      const c = ((t % cycle) + cycle) % cycle;
      return c < 20 ? (200 * c) / 20 : c < 40 ? 200 * (1 - (c - 20) / 20) : 0;
    };
    await writeCsv("sensor_10hz.csv", ["Time (s)", "Counts", "Temperature (C)", "Status"], n, (i) => {
      const t = i / fs;
      const temp = 24 + 0.002 * t + 0.3 * Math.sin((TAU * t) / 90);
      return [fmt(t, 2), fmt(3500 + 60 * forceAt(t - lag) + 6 * gauss(), 1), fmt(temp, 3), temp > 24.25 ? "WARN" : "OK"];
    });
    manifest.files["sensor_10hz.csv"] = {
      tests: ["different rate than force_100hz (same length / downsample to match)", "lag correlation with force", "calibration scatter", "time in seconds"],
      rows: n, rate_hz: fs, counts_per_N: 60, counts_offset: 3500, lag_s: lag, noise_sigma_counts: 6,
    };
  }

  // ---- C. three runs of one test with known start delays ----
  {
    const delays = { a: 0, b: 2.5, c: 5 };
    for (const [k, d] of Object.entries(delays)) {
      const fs = 20, n = 1200;
      await writeCsv(`run_${k}.csv`, ["Time (s)", "Pressure (bar)", "Flow (L/min)"], n, (i) => {
        const t = i / fs, t0 = 10 + d;
        const u = t > t0 ? 1 : 0;
        return [fmt(t, 3), fmt(1 + 4 * u * (1 - Math.exp(-(t - t0) / 3)) + 0.02 * gauss(), 4), fmt(12 * u * (1 - Math.exp(-(t - t0) / 5)) + 0.05 * gauss(), 4)];
      });
    }
    manifest.files["run_a.csv, run_b.csv, run_c.csv"] = {
      tests: ["compare files", "align by shift / click / trigger", "signal mapping", "RMSE against the reference"],
      rows: 1200, rate_hz: 20, step_at_s: { run_a: 10, run_b: 12.5, run_c: 15 }, pressure_from_to_bar: [1, 5], time_constant_s: 3,
      trigger: "Pressure crosses 3 bar rising: run_b is 2.5 s and run_c 5 s later than run_a",
    };
  }

  // ---- D. clock_log.csv: ISO timestamps ----
  {
    const n = 3600, start = Date.UTC(2026, 2, 2, 8, 0, 0);
    const a = [];
    await writeCsv("clock_log.csv", ["Timestamp", "Temp A (C)", "Temp B (C)", "Humidity (%)"], n, (i) => {
      const ta = 21 + 2 * Math.sin((TAU * i) / 1800) + 0.05 * gauss();
      a.push(ta);
      const tb = 21 + 2 * Math.sin((TAU * (i - 120)) / 1800) + 0.5 + 0.05 * gauss();
      const ts = new Date(start + i * 1000).toISOString().replace("T", " ").replace("Z", "");
      return [ts, fmt(ta, 3), fmt(tb, 3), fmt(55 - 3 * (ta - 21) + 0.2 * gauss(), 2)];
    });
    manifest.files["clock_log.csv"] = {
      tests: ["timestamp column (date axis)", "align by clock time", "row <-> time map shows time of day"],
      rows: n, rate_hz: 1, starts: "2026-03-02 08:00:00.000", temp_b_lags_temp_a_s: 120, period_s: 1800,
    };
  }

  // ---- E. vibration_no_time.txt: whitespace, comment header, NO time column ----
  {
    const n = 20000;
    const prelude = "# vibration log, 50 Hz, no time column: use 'Fixed step per row' = 0.02 s\n# exported from bench logger\n";
    const rows = [];
    const ws = createWriteStream(join(out, "vibration_no_time.txt"));
    ws.write(prelude + "       AccX       AccY\n");
    for (let i = 0; i < n; i++) {
      const t = i * 0.02;
      const x = 1.0 * Math.sin(TAU * 3 * t) + 0.5 * Math.sin(TAU * 7.5 * t + 1) + 0.25 * Math.sin(TAU * 12 * t + 2) + 0.1 * gauss();
      const y = 1.0 * Math.sin(TAU * 7.5 * t) + 0.4 * Math.sin(TAU * 18 * t + 0.5) + 0.1 * gauss();
      rows.push(`${fmt(x, 5).padStart(11)}${fmt(y, 5).padStart(11)}`);
    }
    ws.write(rows.join("\n") + "\n");
    await new Promise((res) => ws.end(res));
    manifest.files["vibration_no_time.txt"] = {
      tests: ["whitespace-delimited text with comment lines", "no time column: fixed step per row", "spectrum peaks", "notch / band-pass", "Welch PSD"],
      rows: n, rate_hz: 50, step_s: 0.02,
      accx_peaks_hz: { 3: 1.0, 7.5: 0.5, 12: 0.25 }, accy_peaks_hz: { 7.5: 1.0, 18: 0.4 }, noise_sigma: 0.1,
    };
  }

  // ---- F. european_hours.csv: ; delimiter, decimal comma, time in HOURS ----
  {
    const n = 121;
    const ws = createWriteStream(join(out, "european_hours.csv"));
    const rows = ["Zeit [h];Temperatur [°C];Druck [bar]"];
    for (let i = 0; i < n; i++) {
      const t = i / 60;
      rows.push([t.toFixed(5), (20 + 5 * (1 - Math.exp(-t / 0.5))).toFixed(3), (1 + 0.1 * t).toFixed(4)].map((s) => s.replace(".", ",")).join(";"));
    }
    ws.write(rows.join("\n") + "\n");
    await new Promise((res) => ws.end(res));
    manifest.files["european_hours.csv"] = {
      tests: ["semicolon delimiter and decimal comma", "time column in hours (set unit: hours)", "non-ASCII header (°C)"],
      rows: n, step_h: 1 / 60, duration_s: 7200, temp_from_to_C: [20, 25],
    };
  }

  // ---- G. system_id.csv: 2 inputs, 2 outputs, known discrete dynamics ----
  {
    const n = 12000, fs = 10;
    let u1 = 1, u2 = 1, h1 = 0, h2 = 0, y1 = 0, y2 = 0;
    await writeCsv("system_id.csv", ["Time (s)", "u1", "u2", "y1", "y2"], n, (i) => {
      if (i >= h1) { u1 = rand() < 0.5 ? -1 : 1; h1 = i + 2 + Math.floor(rand() * 7); }
      if (i >= h2) { u2 = rand() < 0.5 ? -1 : 1; h2 = i + 2 + Math.floor(rand() * 7); }
      const row = [fmt(i / fs, 1), fmt(u1, 0), fmt(u2, 0), fmt(y1 + 0.01 * gauss(), 5), fmt(y2 + 0.01 * gauss(), 5)];
      const ny1 = 0.9 * y1 + 0.1 * u1 + 0.02 * u2;
      const ny2 = 0.85 * y2 + 0.05 * y1 + 0.15 * u2;
      y1 = ny1; y2 = ny2;
      return row;
    });
    manifest.files["system_id.csv"] = {
      tests: ["state-space identification (MIMO)", "simulate", "validate (residuals, ACF)", "model library", "report: Models/Simulation/Validation"],
      rows: n, rate_hz: fs,
      model: "y1[k+1] = 0.9 y1[k] + 0.1 u1[k] + 0.02 u2[k];  y2[k+1] = 0.85 y2[k] + 0.05 y1[k] + 0.15 u2[k]",
      order: 2, expected_vaf_percent_at_least: 90, measurement_noise_sigma: 0.01,
    };
  }

  // ---- H. fit_targets.csv ----
  {
    const n = 1000;
    await writeCsv("fit_targets.csv", ["x", "linear", "exp_decay", "gaussian", "sine"], n, (i) => {
      const x = (i / (n - 1)) * 10;
      return [
        fmt(x, 5),
        fmt(2.5 * x + 1 + 0.02 * gauss(), 5),
        fmt(5 * Math.exp(-x / 2) + 0.5 + 0.02 * gauss(), 5),
        fmt(3 * Math.exp(-(((x - 5) / 1.2) ** 2)) + 0.2 + 0.02 * gauss(), 5),
        fmt(1.5 * Math.sin(TAU * 0.4 * x + 0.5) + 2 + 0.02 * gauss(), 5),
      ];
    });
    manifest.files["fit_targets.csv"] = {
      tests: ["curve fit: linear, exponential decay, Gaussian, sine", "fit statistics and bands", "exclude points"],
      rows: n, x_from_to: [0, 10], noise_sigma: 0.02,
      linear: { a: 2.5, b: 1 }, exp_decay: { a: 5, b: 2, c: 0.5, equation: "a*exp(-x/b)+c" },
      gaussian: { a: 3, b: 5, c: 1.2, d: 0.2, equation: "a*exp(-((x-b)/c)^2)+d" },
      sine: { amplitude: 1.5, frequency_hz: 0.4, phase: 0.5, offset: 2 },
    };
  }

  // ---- I. correlations.csv: known relationships ----
  {
    const n = 2000;
    const base = [];
    let walk = 0;
    for (let i = 0; i < n; i++) {
      walk += 0.05 * gauss();
      base.push(Math.sin((TAU * i) / 400) + 0.5 * Math.sin((TAU * i) / 97) + walk);
    }
    const col = {
      base,
      linear: base.map((b) => 2 * b + 1 + 0.1 * gauss()),
      lagged: base.map((_, i) => base[Math.max(0, i - 30)]),
      monotonic: base.map((b) => Math.exp(1.5 * b)),
      anti: base.map((b) => -b),
      noise: base.map(() => gauss()),
      flat: base.map(() => 7),
      gappy: base.map((b, i) => (Math.floor(i / 100) % 4 === 3 ? NaN : b)),
    };
    await writeCsv("correlations.csv", ["Time (s)", ...Object.keys(col)], n, (i) => [String(i), ...Object.values(col).map((v) => (Number.isFinite(v[i]) ? fmt(v[i], 5) : ""))]);
    const r = (k) => Number(pearson(col.base, col[k]).toFixed(4));
    manifest.files["correlations.csv"] = {
      tests: ["correlation matrix (Pearson / Spearman)", "choose signals", "pair scatter and lag (30 s)", "constant column -> no correlation", "partly missing column (pairwise)"],
      rows: n, rate_hz: 1, lag_samples: 30,
      pearson_with_base: { linear: r("linear"), lagged: r("lagged"), monotonic: r("monotonic"), anti: r("anti"), noise: r("noise"), gappy: r("gappy") },
      spearman_with_base: { monotonic: Number(pearson(ranks(base), ranks(col.monotonic)).toFixed(4)) },
      note: "flat is constant: its correlation is undefined; gappy has 25% of its rows missing",
    };
  }

  // ---- J. many_columns.csv: 40 signals, named by group ----
  {
    const groups = ["Motor", "Temperature", "Pressure", "Flow"], units = { Motor: "rpm", Temperature: "degC", Pressure: "bar", Flow: "L/min" };
    const cols = [];
    for (const g of groups) for (let k = 1; k <= 10; k++) cols.push({ name: `${g}_${k} [${units[g]}]`, f: 0.01 * k + 0.003 * groups.indexOf(g), a: 5 + k, ph: k });
    const n = 5000;
    await writeCsv("many_columns.csv", ["Time (s)", ...cols.map((c) => c.name)], n, (i) => [fmt(i / 10, 1), ...cols.map((c) => fmt(c.a * Math.sin(TAU * c.f * (i / 10) + c.ph) + 0.1 * gauss(), 3))]);
    manifest.files["many_columns.csv"] = { tests: ["40 signals", "grouping by name and unit", "signal lists, search, plotting many signals"], rows: n, rate_hz: 10, signals: cols.length };
  }

  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// ============================================================================================
// Stress set
// ============================================================================================
async function stressSet() {
  // ---- S1. a long, 16-signal 1 kHz log ----
  {
    const n = MAIN_ROWS, fs = 1000;
    const names = ["Force (N)", "Displacement (mm)", "Temp 1 (C)", "Temp 2 (C)", "Temp 3 (C)", "Temp 4 (C)", "Acc X (g)", "Acc Y (g)", "Acc Z (g)", "Pressure (bar)", "Flow (L/min)", "Voltage (V)", "Current (A)", "Speed (rpm)", "Torque (Nm)", "Power (W)"];
    let drift = 0;
    await writeCsv("stress_1khz.csv", ["Time (s)", ...names], n, (i) => {
      const t = i / fs;
      drift += 0.0005 * gauss();
      const spike = i % 20011 === 7 ? 25 * (rand() < 0.5 ? -1 : 1) : 0;
      const gap = Math.floor(t / 60) % 7 === 3 && t % 60 < 2;
      const row = [fmt(t, 3)];
      for (let c = 0; c < names.length; c++) {
        const v = (c + 1) * Math.sin(TAU * (0.05 + 0.013 * c) * t + c) + 0.3 * Math.sin(TAU * (7 + c) * t) + 0.2 * gauss() + drift * (c % 3) + (c === 0 ? spike : 0);
        row.push(gap && c % 4 === 1 ? "" : fmt(v, 4));
      }
      return row;
    });
    manifest.files["stress_1khz.csv"] = { rows: n, signals: names.length, rate_hz: fs, spikes_every_rows: 20011, gaps: "2 s every 7th minute in every 4th signal" };
  }
  // ---- S2. a slower file with time in minutes (a different rate, mixed workspace) ----
  {
    const n = 100000, fs = 100;
    await writeCsv("stress_100hz_minutes.csv", ["Time (min)", "Reference Force (N)", "Reference Distance (mm)", "Strain 1", "Strain 2", "Strain 3"], n, (i) => {
      const t = i / fs;
      return [fmt(t / 60, 6), fmt(100 + 100 * Math.sin(TAU * 0.02 * t) + 0.3 * gauss(), 3), fmt(0.2 * Math.sin(TAU * 0.02 * t) + 0.001 * gauss(), 5), ...[1, 2, 3].map((k) => fmt(k * 100 * Math.sin(TAU * 0.02 * t + k) + 2 * gauss(), 2))];
    });
    manifest.files["stress_100hz_minutes.csv"] = { rows: n, rate_hz: fs, time_unit: "minutes" };
  }
  // ---- S3. 40 run files (batch / folder import) ----
  {
    mkdirSync(join(out, "runs"), { recursive: true });
    const saved = out;
    for (let k = 1; k <= 40; k++) {
      const ws = createWriteStream(join(out, "runs", `run_${String(k).padStart(2, "0")}.csv`));
      const rows = ["Time (s),Pressure (bar),Flow (L/min),Temperature (C),Vibration (g)"];
      for (let i = 0; i < 20000; i++) {
        const t = i / 100, t0 = 10 + 0.4 * k;
        const u = t > t0 ? 1 : 0;
        rows.push([fmt(t, 2), fmt(1 + 4 * u * (1 - Math.exp(-(t - t0) / 3)) + 0.02 * gauss(), 4), fmt(12 * u * (1 - Math.exp(-(t - t0) / 5)) + 0.05 * gauss(), 4), fmt(24 + 0.01 * t + 0.1 * gauss(), 3), fmt(0.3 * Math.sin(TAU * 25 * t) + 0.05 * gauss(), 4)].join(","));
      }
      ws.write(rows.join("\n") + "\n");
      await new Promise((res) => ws.end(res));
    }
    void saved;
    manifest.files["runs/run_01.csv ... run_40.csv"] = { files: 40, rows_each: 20000, rate_hz: 100, step_delay_s_per_run: 0.4 };
  }
  // ---- S4. a wide file: 200 signals ----
  {
    const n = 20000, cols = 200;
    await writeCsv("stress_wide.csv", ["Time (s)", ...Array.from({ length: cols }, (_, c) => `Ch${String(c + 1).padStart(3, "0")} [V]`)], n, (i) => {
      const t = i / 100;
      return [fmt(t, 2), ...Array.from({ length: cols }, (_, c) => fmt(Math.sin(TAU * (0.02 + 0.003 * c) * t + c) * (1 + (c % 5)) + 0.1 * gauss(), 3))];
    });
    manifest.files["stress_wide.csv"] = { rows: n, signals: cols, rate_hz: 100 };
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
}

const t0 = Date.now();
await (stress ? stressSet() : suite());
console.log(`${stress ? "stress set" : "feature suite"} written to ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
