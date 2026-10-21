# Test suite

Synthetic files with known contents. `manifest.json` lists the truth for each one
(spike rows, gap rows, tone frequencies, model coefficients, …).

| File | Tests |
| --- | --- |
| `force_100hz.csv` | Time in **minutes**, spikes, a dropout, drift, 12 Hz interference, text column. |
| `sensor_10hz.csv` | A slower file for the same test: downsample to the same length, lag, correlation. |
| `run_a/b/c.csv` | Three runs of one test, started 0 / 2.5 / 5 s apart: compare, align, trigger. |
| `clock_log.csv` | ISO timestamps: date axis, clock alignment. |
| `vibration_no_time.txt` | Whitespace text, comment lines, **no time column**: set 0.02 s per row; tones at 3, 7.5, 12 Hz. |
| `european_hours.csv` | `;` and decimal commas, time in **hours**, `°C` in a header. |
| `system_id.csv` | Two inputs, two outputs, known state-space model: identify, simulate, validate. |
| `fit_targets.csv` | Linear, exponential, Gaussian and sine curves with known coefficients. |
| `correlations.csv` | Linear, lagged, monotonic, inverse, noise, constant and gappy columns. |
| `many_columns.csv` | 40 signals in four groups. |

Generate again: `node tools/make-test-dataset.mjs`

Check them: `cargo test --test test_suite` (in `src-tauri`)

## Stress test

```
node tools/make-test-dataset.mjs --stress            # 1 M rows x 16 signals, 40 run files, 200 signals wide
node tools/make-test-dataset.mjs --stress --rows 3000000
cargo test --release --test test_suite -- --ignored --nocapture
```

The stress files go to `samples/stress/` and are not committed. The test prints the time of
each step: imports, edits, downsample, grid alignment, statistics, correlation, spectrum, report.
