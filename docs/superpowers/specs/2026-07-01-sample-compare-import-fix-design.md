# Sample Compare Import Fix Design

## Problem

`sample_compare/251_D40Buffer_TM1_200N_1mmpmin_calibration_force.csv`
contains a normal header followed by a units row and a `Sample 1` label row.
The generic table parser currently requires every non-empty value in a column
to be numeric before coercing that column. As a result, `Force`, `Distance`,
and `Time` remain text and are excluded from the dataset. Only `Event` is
available as a signal, so comparison with the capacitance CSV fails.

Both sample files also contain numeric time columns. The dataset builder
currently recognizes datetime columns only and otherwise generates a row
index. A successful overlay therefore also requires numeric time-column
detection and unit normalization.

## Parser Behavior

For each text column, numeric coercion will be accepted when at least 90% of
its non-empty values parse as finite numbers and at least one numeric value is
present. Non-numeric cells in an accepted numeric column become `NaN`.

After column coercion, leading rows will be removed only while all recovered
numeric measurement columns are empty in that row. Rows after the first
numeric data row remain untouched, including later gaps and missing values.
Columns that do not meet the numeric threshold remain text.

This behavior is format-neutral and does not special-case filenames or vendors.

## Dataset Time Axis

The dataset builder will select a numeric column whose normalized name is
`time`, `timestamp`, or `elapsed time`, including names with units in
parentheses or square brackets. The selected time column will not appear as a
signal.

Time values will be converted to elapsed seconds:

- seconds (`s`, `sec`, `second`, `seconds`) use factor 1;
- minutes (`min`, `minute`, `minutes`) use factor 60;
- milliseconds (`ms`, `millisecond`, `milliseconds`) use factor 0.001;
- an unlabelled numeric time column uses factor 1.

The first finite time value becomes zero. If no suitable numeric time column
exists, the current row-index fallback remains unchanged.

## Comparison Behavior

The force CSV will expose `Force`, `Distance`, and `Event` as signals and use
its `Time` column, converted from minutes to seconds. The capacitance CSV will
use `Time (s)` and expose `Force (N)`.

The existing fuzzy matching threshold will match requested `Force` to
`Force (N)`. The existing interpolation and statistics code remains unchanged.

## Testing

Implementation follows red-green-refactor.

- A parser regression test uses a compact header/units/sample fixture and
  verifies numeric recovery plus leading-row removal.
- Dataset tests verify numeric time selection, minute-to-second conversion,
  and removal of the time column from signals.
- An integration regression test imports both real files under
  `sample_compare`, registers both datasets, calls the compare overlay, and
  requires two overlaid files plus one statistics row.
- The complete backend and frontend suites run after the fix.

