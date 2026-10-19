# Data plots and analysis

Data Plots opens with the first numeric column plotted against row positions **1…N**. Choose **X** and **Y** above the plot before opening **Fit curve**. For example, choose Temperature for X and Pressure for Y to fit pressure as a function of temperature. Choosing two columns produces a scatter plot; row position and time remain available as X options. The swap button exchanges X and Y. Select additional Y columns on the left for multiple plots. Missing values keep their original row positions.

## Curve fitting

Choose **Fit curve** on a numeric line, scatter or bar chart. Select the data and model, then **Fit**. **Fit options** contains range limits, starting coefficients, bounds, fixed coefficients, normalization and robust fitting. Click a preview point to exclude it. For large datasets, the preview is sampled; the fit uses all included observations.

Built-in models include linear, quadratic, cubic, exponential, exponential decay, power, logarithmic, Gaussian, Lorentzian, sigmoid and sine. Custom equations use `x` and up to eight named coefficients, `^` for powers, and functions such as `exp`, `ln`, `sqrt`, `sin` and `cos`.

Data Plots and Statistics supply complete vectors to the fitter. Other charts supply their plotted observations, which can already be downsampled; the data count and source tooltip identify this scope. Heatmaps, boxplots and categorical charts do not represent numeric XY observations and therefore do not offer curve fitting.

Results include residuals, RMSE, SSE, R², adjusted R² and coefficient estimates. Confidence intervals and mean-response bands use a local linear approximation with a normal 1.96 multiplier. They are not prediction intervals. Uncertainty is withheld for robust fits, active bounds, nonconvergence and rank-deficient models. Robust fitting uses Huber loss; displayed error metrics remain unweighted. Constant Y has undefined R².

With **Center and scale X**, the equation uses `(X − center) / scale`; results and exported files include both values. Coefficients therefore refer to that transformed variable. Power and logarithmic models need a valid domain: avoid nonpositive X when the equation requires positive X.

Fits remain available for comparison while the toolbox is open. **Add to plot** overlays the chosen result; changing the source chart clears that overlay. **Export** saves the equation, included observations, options and results as JSON. This implementation provides 1D curve fitting, not MATLAB surface fitting or every MATLAB model family.

## Statistics

Choose X and Y, then drag a rectangle in the scatter plot or an X interval in By row or Distribution. All views highlight matching rows and fade the rest; the summary compares the selection with the full data. **Clear selection** removes it. Switch a chart's toolbar to Zoom or Pan to navigate instead of selecting. Scatter previews are limited to approximately 8,000 points; selection and statistics use complete vectors, including rows that are not rendered.

Summary statistics include count, missing values, mean, sample standard deviation, minimum, quartiles, maximum and IQR. Quartiles use linear interpolation. Boxplot whiskers show the actual minimum and maximum. Use the download button to export the summary as CSV.

## Navigation

Charts share one set of controls. Drag to zoom: a rectangle zooms both axes, while a mostly horizontal drag zooms X only. Scroll to zoom around the pointer and double-click to reset. The toolbar offers Zoom, Pan, **Previous view** (steps back through earlier zooms), Reset, **Show data as table** (with CSV download) and PNG export. Stacked panels keep a common X axis. Long signals are decimated per pixel column (minimum and maximum kept), and are re-decimated after each zoom, so peaks remain visible.

Charts follow one visual system: a validated categorical palette led by A+P red, a blue-to-red diverging scale with a neutral midpoint for correlations, 2px lines, ringed markers, hairline grids and a legend whenever a chart shows two or more series. Report figures use the same palette and styling.

Use **Ctrl+PageUp** and **Ctrl+PageDown** to switch workspaces. Workspaces load on first use and retain their controls and results. Hidden charts pause rendering; returning to Data Plots or Statistics reuses loaded vectors until the data or selected columns change. Transitions respect the system's reduced-motion preference.

## Verification

```text
npm run build
node --test tools/analysis.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```
