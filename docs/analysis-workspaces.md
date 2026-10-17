# Data plots and analysis

Data Plots opens with the first three numeric columns plotted against row positions **1…N**. Select more columns on the left. Choose **Time** or another column in **X axis** for time plots or XY scatter plots. Missing values keep their original row positions.

## Curve fitting

Choose **Fit curve** on a numeric line, scatter or bar chart. Select the data and model, then **Fit**. **Fit options** contains range limits, starting coefficients, bounds, fixed coefficients, normalization and robust fitting. Click a preview point to exclude it. For large datasets, the preview is sampled; the fit uses all included observations.

Built-in models include linear, quadratic, cubic, exponential, exponential decay, power, logarithmic, Gaussian, Lorentzian, sigmoid and sine. Custom equations use `x` and up to eight named coefficients, `^` for powers, and functions such as `exp`, `ln`, `sqrt`, `sin` and `cos`.

Data Plots and Statistics supply complete vectors to the fitter. Other charts supply their plotted observations, which can already be downsampled; the data count and source tooltip identify this scope. Heatmaps, boxplots and categorical charts do not represent numeric XY observations and therefore do not offer curve fitting.

Results include residuals, RMSE, SSE, R², adjusted R² and coefficient estimates. Confidence intervals and mean-response bands use a local linear approximation with a normal 1.96 multiplier. They are not prediction intervals. Uncertainty is withheld for robust fits, active bounds, nonconvergence and rank-deficient models. Robust fitting uses Huber loss; displayed error metrics remain unweighted. Constant Y has undefined R².

With **Center and scale X**, the equation uses `(X − center) / scale`; results and exported files include both values. Coefficients therefore refer to that transformed variable. Power and logarithmic models need a valid domain: avoid nonpositive X when the equation requires positive X.

Fits remain available for comparison while the toolbox is open. **Add to plot** overlays the chosen result; changing the source chart clears that overlay. **Export** saves the equation, included observations, options and results as JSON. This implementation provides 1D curve fitting, not MATLAB surface fitting or every MATLAB model family.

## Statistics

Choose X and Y, then drag a rectangle in Scatter or an X interval in By row or Distribution. All views highlight matching rows; the summary compares the selection with the full data. **Reset** clears it. Scatter previews are limited to approximately 8,000 points; selection and statistics use complete vectors, including rows that are not rendered.

Summary statistics include count, missing values, mean, sample standard deviation, minimum, quartiles, maximum and IQR. Quartiles use linear interpolation. Boxplot whiskers show the actual minimum and maximum. Use the download button to export the summary as CSV.

## Verification

```text
npm run build
node --test tools/analysis.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```
