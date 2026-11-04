# Guide

The top bar follows the workflow: **Data → Prepare → Explore → Analyse → Model → Report**. Explore and Analyse have tabs.

## Data

Add files, a folder of runs, or drop them on the window. Each file keeps its own time base and shows its signals with a small trend line.

**Time from** sets where a file's time comes from: one of its columns, or **Fixed step per row** (seconds per row). A time column is read in **seconds, minutes, hours or days**; choose the unit it is given in. The ruler below shows rows against time at five points; the ⇄ button opens **Row** and **Time** fields that convert one into the other. Files with clock timestamps show the time of day.

With several files, **Line up files** combines them **By time**, **By clock time** or **By index**. **Shift** moves one file in time. **Resample to** sets the common time step (0 keeps the finest step; a coarser step averages instead of aliasing). The common grid has at most 1,000,000 rows.

**Click a signal** to open its values as a table: row, time, value and (where it differs) the original value. Click a cell; Shift+click or Shift+arrows select a range, Ctrl+click adds single cells, Ctrl+A selects all. **Delete** removes the selected values (they become missing). Type a number, press Enter or double-click to change a cell; Ctrl+Enter sets every selected cell to the typed value; an empty entry removes it. Paste a column of numbers from a spreadsheet at the current row. Ctrl+C copies time and value. The footer shows count, mean, min and max of the selection; **Go to row** jumps. Changed cells are tinted. Each change is a **Remove points** or **Set values** step in Prepare, so Undo (also in the table) and Reset work. Time axes are read only.

Each signal shows its **unit** next to its name, read from the header ("Force [N]", "Force (N)"). Click it, or **Units** in the toolbar for every signal at once, to set, fix or convert it. Type a unit or pick one of the suggestions; when the old and new unit measure the same quantity (mm and µm, °C and °F, bar and psi, rpm and Hz), **Convert** is ticked and the values are converted as Gain/Offset steps (Undo works). Untick it to change only the label, e.g. when the header was wrong. **Suggest** fills missing units from the names (Temperature → °C). Tick several rows to set them together. Units are saved in projects and recipes and appear on every axis, table, result and report.

A signal's menu has **Prepare**, **Rename**, **Duplicate**, **Reset to original** and **Remove**. **Formula** adds a signal computed from others. **Project** saves and opens projects and recipes (reusable processing).

## Cursor, selection and notes

**Click** any time chart (Plot, Prepare, Peaks & limits, Cycles) to place the **linked cursor**: a dotted line with each signal's value at that moment. It stays when you switch pages, and the values table opens at its row. The chip in the top bar shows its time; × removes it.

**Shift+drag** across a time chart (or use the select tool in the chart toolbar) to **select** a time range; **Select** in the top bar selects every time where a signal lies in a range ("Speed between 1500 and 2100 rpm", optionally joining short gaps). The selection is shaded on every time chart and used by Distribution (statistics and charts of the selected rows), Peaks & limits (extremes and violations inside it), Cycles (cycles that start inside it), Frequency response and Spectrogram (from its first to its last moment) and Results (**Selection** sets From and To). × in the chip clears it.

**Notes** are comments on a time range or a moment. Add one from the selection chip, or with **Notes** › **Add note**. They show as amber spans on every time chart, travel with the project, and are listed in both reports. In **Notes**, edit a text in place, click a time to select that range, or delete.

## Prepare

Prepare processes one signal as a row of blocks: **Source → steps → Output**. The arrows beside the signal picker (or Alt+↑ / Alt+↓) step to the previous or next signal, so a whole file can be cleaned one signal after another.

- **Add step** offers **Clean** (spikes, gaps, range), **Filter** (low-pass, high-pass, band-pass, band-stop, notch, moving average, median, Savitzky–Golay, exponential average), **Adjust** (offset, gain, downsample, remove mean, normalize, z-score, invert) and **Suggest filters**.
- A new step is previewed on the chart before it is added.
- Click a block to see its input (gray) and output on the chart, change its settings, move it or delete it. Each block shows what it did: samples removed, filled or moved.
- **Undo** removes the last step. **Reset** returns to the imported values.

**Offset** adds a typed value or subtracts the first data point. **Downsample** divides the rows by a factor, or by whatever matches the length of another signal. The rows are split into equal blocks and each block becomes one row holding its average, with the time of the block's middle. The signal gets its own, shorter rows: Row mode and the list on the Data page show the new length, and later steps (filters, ranges) work at the new sample rate. The imported values keep the original rows. Undo, Reset and saved projects bring the rows back or keep them. Formula signals cannot be downsampled.

Removed values become missing. Rows are never deleted, so every signal stays aligned. Deleting or editing a step re-runs the steps after it. A step that finds nothing to do passes the values through.

## Explore

- **Plot**: tick signals to plot them, stacked or overlaid. **All** and **None** tick or clear the list; with more than six signals, **Find a signal** filters it. Choose the X axis: row, time or another signal. **Show original** draws the imported values behind processed ones.
- **Distribution**: scatter, values by index, histogram and quartiles for one signal, with a summary table. Datasets over 100,000 rows are thinned by a fixed stride for display.
- **Compare files**: overlays the files of the workspace. Signals are matched by name; **Mapping** overrides a match. Line files up by typing a shift, clicking the same event on each trace, or aligning on a trigger. With two or more files it shows the difference and RMSE, maximum deviation, R² and mean error against the first file.

## Analyse

- **Spectrum**: FFT and power density (Welch). Drag the cutoff line and press **Add low-pass** to add a filter step at that frequency.
- **Spectrogram**: how the frequency content changes over time (short-time power density in dB). **Window** trades frequency for time resolution; **Overlap**, **Up to** and **Range** set the frames, the top frequency and the colour range. **Order analysis** takes a speed signal (rpm or rev/s), resamples the signal at equal steps of shaft angle and shows the **order map** (orders against speed, or time when the speed goes up and down) and the **order spectrum**. **Add to results** keeps the three strongest orders and their amplitudes.
- **Frequency response**: pick an **Input** and an **Output**. The Bode plot shows gain (dB) and phase (H1 estimate, Welch averages with a Hann window and 50 % overlap) and the coherence (near 1 where the output is explained by the input). **Segment** trades frequency resolution for a smoother estimate. **Add to results** keeps the peak frequency and gain, the −3 dB bandwidth, the gain at the lowest frequency and the mean coherence.
- **Peaks & limits**:
  - **Peaks**: find **Peaks**, **Valleys** (minima, e.g. negative peaks below zero) or **Both**. **Value ≥ / ≤** keeps extremes in a value range; **Prominence** (how far an extreme stands out; the wand sets 10 % of the range) is the main knob against noise; **Min gap** keeps the more prominent of two close extremes; **Min width** drops narrow spikes. **More** has **Max width**, **Width at** (the share of the prominence where the width is measured, 50 % = half height), **Min step** to the neighbour samples and **Keep top** N. ↑/↓ in a field nudges its value (Shift: ×10). **Guides** draws each width (green) and prominence (dashed).
  - **Limits**: an **Upper** and/or **Lower** limit; **Hysteresis** keeps noise at a limit from splitting a violation; **Min duration** ignores short ones. The badge shows **PASS** or **FAIL** with the time outside.
  - **From / To** restrict either search to a time window. **CSV** saves every extracted row (time, value, prominence, width and bases, or start, end, duration and extreme); **Results** sends counts, means and extremes to the Results page.
- **Cycles**: finds events on a **Trigger** signal: **Rising**, **Falling** or **Both** crossings of a **Level** (with **Hysteresis**, so noise at the level does not count twice), a **Step** in a state signal, or a change in a text column. **Hold-off** ignores events too close to the previous one. Cycles run **Event to event**, or a **Window around event** (time before and after). Every cycle is overlaid with the mean and ±1σ; the table has the chosen **Values** (mean, min, max, peak-to-peak, RMS, std dev, first and final value, integral, time of max and min, rise time, settling time, overshoot) of the chosen **Signals** per cycle, with their mean and std dev. Untick a cycle to leave it out. **CSV** saves the table, one row per cycle. Click a column heading to see its trend over the cycles. **Add to results** sends the mean and std dev, or every cycle.
- **Correlations**: Pearson or Spearman matrix. Choose which signals are included. Click a cell to see the scatter and lag for that pair. Signals from files at different rates are put on one time grid (slower ones interpolated); **Same length** uses the slowest file's step instead, so every signal has the same number of real samples. The Data page has the same button.
- **Curve fit**: pick X and Y, a model and **Fit**. Click a point to leave it out. **Advanced** has X range, coefficient start values, bounds, fixed coefficients, centering and robust (Huber) fitting. The list button next to the result sends the coefficients, R² and RMSE to Results. Confidence bands are approximate (normal 1.96 multiplier), not prediction intervals. Built-in models: linear, quadratic, cubic, exponential, exponential decay, power, logarithmic, Gaussian, Lorentzian, sigmoid, sine, or a custom equation in `x` with up to eight coefficients.

## Model

State-space models in four tabs: **Identify**, **Library**, **Simulate**, **Validate**. Results stay when the data is edited. Without a model, Library, Simulate and Validate offer **Identify** or **Load** (a saved library); while identification runs, **Identify** turns into **Stop**.

## Results

One table of scalar results, grouped by where they came from. **Measure** takes a value of a signal between **From** and **To**: max, min, mean, peak-to-peak, RMS, std dev, first and final value, integral, time of max or min, rise time (10–90 %), settling time (within a **Band** of the step) or overshoot. Times count from the start of the window; the step runs from the first to the final value (each the mean of the first and last 5 % of the samples). Cycles, Frequency response, Order analysis and Curve fit add their results here. A result with the same group, name and signal replaces the older one.

Tick rows to **Delete** them. **Copy** puts the table on the clipboard for a spreadsheet; **CSV** saves it. The chart shows the bars of one group (**Chart** on its heading row), one unit at a time. The results stay when the app is closed and go into the report as the **Results** section.

## Report

Choose what to include, choose **HTML**, **Interactive** or **PDF**, press **Create report**, then choose a name and place. **Interactive** writes one HTML file that opens in any browser without internet: the signals as zoomable stacked charts with the notes marked, and statistics, results, notes, processing and files as tables you can filter and sort. The report is one file with one embedded font. It contains headings, tables and charts, and the processing of each signal as the same block diagram.

## Charts

Drag to zoom, scroll to zoom, double-click to reset. The toolbar has Zoom, Pan, Select (time charts), Previous view, Reset, a data table with CSV export, **Copy** and PNG export. **Copy** puts the current view on the clipboard for PowerPoint at a fixed 16:9 size with matching fonts; Shift+click copies it at document width for Word, so pasted charts all match. Stacked charts share the X axis. Long signals are thinned per pixel column (minimum and maximum kept) and again after each zoom, so peaks stay visible. Summary charts (matrix, histogram, quartiles, bars) do not zoom.

## Verify

```text
npm run build
node --test tools/*.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```
