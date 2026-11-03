# Guide

The top bar follows the workflow: **Data → Prepare → Explore → Analyse → Model → Report**. Explore and Analyse have tabs.

## Data

Add files, a folder of runs, or drop them on the window. Each file keeps its own time base and shows its signals with a small trend line.

**Time from** sets where a file's time comes from: one of its columns, or **Fixed step per row** (seconds per row). A time column is read in **seconds, minutes, hours or days**; choose the unit it is given in. The ruler below shows rows against time at five points. **Row** and **Time** convert one into the other. Files with clock timestamps show the time of day.

With several files, **Line up files** combines them **By time**, **By clock time** or **By index**. **Shift** moves one file in time. **Resample to** sets the common time step (0 keeps the finest step; a coarser step averages instead of aliasing). The common grid has at most 1,000,000 rows.

A signal's menu has **Prepare**, **Rename**, **Duplicate**, **Reset to original** and **Remove**. **Formula** adds a signal computed from others. **Project** saves and opens projects and recipes (reusable processing).

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
- **Cycles**: finds events on a **Trigger** signal: **Rising**, **Falling** or **Both** crossings of a **Level** (with **Hysteresis**, so noise at the level does not count twice), a **Step** in a state signal, or a change in a text column. **Hold-off** ignores events too close to the previous one. Cycles run **Event to event**, or a **Window around event** (time before and after). Every cycle is overlaid with the mean and ±1σ; the table has the chosen **Values** (mean, min, max, peak-to-peak, RMS, std dev, first and final value, integral, time of max and min, rise time, settling time, overshoot) of the chosen **Signals** per cycle, with their mean and std dev. Untick a cycle to leave it out. Click a column heading to see its trend over the cycles. **Add to results** sends the mean and std dev, or every cycle.
- **Correlations**: Pearson or Spearman matrix. Choose which signals are included. Click a cell to see the scatter and lag for that pair. Signals from files at different rates are put on one time grid (slower ones interpolated); **Same length** uses the slowest file's step instead, so every signal has the same number of real samples. The Data page has the same button.
- **Curve fit**: pick X and Y, a model and **Fit**. Click a point to leave it out. **Advanced** has X range, coefficient start values, bounds, fixed coefficients, centering and robust (Huber) fitting. The list button next to the result sends the coefficients, R² and RMSE to Results. Confidence bands are approximate (normal 1.96 multiplier), not prediction intervals. Built-in models: linear, quadratic, cubic, exponential, exponential decay, power, logarithmic, Gaussian, Lorentzian, sigmoid, sine, or a custom equation in `x` with up to eight coefficients.

## Model

State-space models in four tabs: **Identify**, **Library**, **Simulate**, **Validate**. Results stay when the data is edited.

## Results

One table of scalar results, grouped by where they came from. **Measure** takes a value of a signal between **From** and **To**: max, min, mean, peak-to-peak, RMS, std dev, first and final value, integral, time of max or min, rise time (10–90 %), settling time (within a **Band** of the step) or overshoot. Times count from the start of the window; the step runs from the first to the final value (each the mean of the first and last 5 % of the samples). Cycles, Frequency response, Order analysis and Curve fit add their results here. A result with the same group, name and signal replaces the older one.

Tick rows to **Delete** them. **Copy** puts the table on the clipboard for a spreadsheet; **CSV** saves it. The chart shows the bars of one group (**Chart** on its heading row), one unit at a time. The results stay when the app is closed and go into the report as the **Results** section.

## Report

Choose what to include, choose **HTML** or **PDF**, press **Create report**, then choose a name and place. The report is one file with one embedded font. It contains headings, tables and charts, and the processing of each signal as the same block diagram.

## Charts

Drag to zoom, scroll to zoom, double-click to reset. The toolbar has Zoom, Pan, Previous view, Reset, a data table with CSV export, and PNG export. Stacked charts share the X axis. Long signals are thinned per pixel column (minimum and maximum kept) and again after each zoom, so peaks stay visible. Summary charts (matrix, histogram, quartiles, bars) do not zoom.

## Verify

```text
npm run build
node --test tools/*.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```
