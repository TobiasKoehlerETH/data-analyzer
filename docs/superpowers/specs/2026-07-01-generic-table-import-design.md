# Generic CSV and XLSX Import Design

## Goal

Allow the Data Analyzer to import broadly structured CSV and XLSX files, including
files without headers, without silently discarding columns or cell data.

## Scope

The importer will support:

- Delimited text files using comma, semicolon, tab, or pipe separators.
- Common text encodings already handled by the application.
- CSV files with a header, without a header, or with metadata before the header.
- Explicit selection of the first row or another row as the header.
- XLSX workbooks containing one or more sheets.
- Blank, duplicate, numeric, and otherwise unsuitable column labels.
- Numeric, text, date/time, mixed, empty, and partially empty columns.
- Uneven CSV rows when they can be recovered without losing cell values.

Legacy Raser DataLog behavior remains supported.

## Architecture

The backend will expose one generic table-import service instead of making the
dataset layer depend directly on the CSV parser.

The service will have:

- A format-neutral `parse_table()` entry point.
- A delimited-text reader for CSV-like files.
- An XLSX reader for Excel workbooks.
- Shared header resolution, column naming, type inference, warnings, and result
  normalization.
- A compatibility `parse_csv()` wrapper for existing callers and template tests.

The existing dataset registry remains responsible for constructing an analyzable
dataset. It will retain the complete imported table for preview and future use,
while exposing compatible numeric columns to numeric analysis engines.

The frontend will add an import dialog to the existing Data workflow. No new
project-file format or persistent workspace model is introduced.

## Import Flow

1. The user chooses a CSV or XLSX file.
2. The frontend uploads the file for inspection.
3. The backend detects the format and returns:
   - Available sheets and the first non-empty suggested sheet for XLSX.
   - Detected encoding and delimiter for delimited text.
   - Suggested header mode and header row.
   - A preview with every column and cell preserved.
   - Inferred column types and recoverable-file warnings.
4. The dialog lets the user choose:
   - An XLSX sheet.
   - Automatic header detection.
   - The first row as the header.
   - No header.
   - A specific one-based header row.
5. The backend performs the confirmed import using those options.
6. The application shows all imported columns in the preview. Numeric analysis
   tools expose only columns whose values can safely be treated as numeric.

## Header Handling

Automatic detection will score candidate rows using field consistency, value
types, uniqueness, and neighboring data rows. It must not assume that the first
matching row is necessarily a header.

When no header is selected or detected, columns receive stable names:
`Column 1`, `Column 2`, and so on.

Blank and duplicate headers receive unique display names. For example, two
columns named `Force` become `Force` and `Force (2)`. Original cell values are
not changed.

Rows before an explicitly selected header are treated as preamble metadata when
they can be represented as key/value information. They are not inserted into
the numeric sample stream.

## Data Preservation and Analysis

The importer will not silently remove:

- Text columns.
- Mixed-type columns.
- Empty columns.
- Columns that cannot be analyzed numerically.
- Recoverable values from uneven rows.

Every column remains visible in the imported-table preview. Numeric operations
such as plotting, filtering, spectra, correlation, and modelling receive only
compatible numeric signals. The UI will label column types and explain why a
non-numeric column is unavailable to a numeric operation.

Date/time columns may provide the dataset time axis when parsing is reliable.
Otherwise, the dataset uses a generated sample index while retaining the
original date/time values.

## XLSX Behavior

The inspection response lists all workbook sheets and identifies empty sheets.
The first non-empty sheet is preselected, but the user must be able to choose any
sheet before import.

Only the selected sheet becomes the active dataset in one import operation.
Users can import another sheet as another dataset by repeating the operation.
Formula results are read as stored values; the importer does not execute Excel.

## Error Handling

Recoverable irregularities produce visible warnings, including:

- Uneven delimited rows.
- Duplicate or blank headers.
- Ambiguous header detection.
- Mixed-type columns.
- Empty selected sheets.
- Cells that cannot be converted for numeric analysis.

The import is rejected without creating a dataset when:

- The file format is unsupported or corrupt.
- The selected sheet does not exist.
- The selected header row is outside the table.
- No table cells can be read.

Error responses will refer to a generic table or workbook rather than claiming
every failure is a CSV parsing error.

## Testing

Backend tests will be written before implementation and will cover:

- Headered and headerless CSV files.
- Auto, first-row, no-header, and explicit-row header modes.
- Comma, semicolon, tab, and pipe delimiters.
- Existing encoding and Raser DataLog behavior.
- Metadata or preamble rows.
- Blank and duplicate headers.
- Mixed, text, date/time, empty, and partially empty columns.
- Recoverable uneven rows and emitted warnings.
- Single-sheet and multi-sheet XLSX workbooks.
- Empty-sheet detection and sheet selection.
- Invalid sheet and header selections.
- Compatibility of the existing `parse_csv()` API.

Frontend tests will cover the import dialog state and the request payload for
sheet and header selections. Existing backend and frontend test suites, type
checking, and production builds must remain green.

## Out of Scope

- Legacy binary `.xls` files.
- Excel macros and formula calculation.
- Importing every workbook sheet as one merged dataset.
- Automatic conversion of categorical text into numeric signals.
- Arbitrary malformed files where preserving every cell is impossible.
