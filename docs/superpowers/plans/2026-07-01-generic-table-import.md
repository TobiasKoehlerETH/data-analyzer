# Generic Table Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import CSV-like and XLSX tables through an inspect-and-confirm workflow that supports sheet selection, header overrides, and lossless previews.

**Architecture:** Add a format-neutral parser beside the retained `parse_csv()` compatibility API. The dataset router will cache uploaded files between inspection and confirmed loading, while the React Load route presents the available sheets, header controls, warnings, inferred types, and full-column preview.

**Tech Stack:** Python 3.12, pandas, openpyxl, FastAPI, pytest, React 19, TypeScript, Vitest.

## Global Constraints

- Preserve all readable columns and cells in the table preview.
- Expose only safely numeric columns to numeric analysis engines.
- Support CSV, TSV, semicolon/pipe-delimited text, and `.xlsx`.
- Support Auto, First row, No header, and explicit one-based header-row modes.
- Preselect the first non-empty XLSX sheet while allowing any sheet to be selected.
- Keep Raser DataLog behavior and the existing `parse_csv()` API compatible.
- Do not add `.xls`, macros, formula execution, categorical encoding, or workbook-sheet merging.

---

### Task 1: Format-Neutral Table Parser

**Files:**
- Create: `backend/core/table_parser.py`
- Create: `backend/tests/test_table_parser.py`
- Modify: `backend/core/csv_parser.py`
- Modify: `backend/requirements.txt`

**Interfaces:**
- Produces: `HeaderMode`, `ImportOptions`, `TableInspection`, `ParseResult`, `inspect_table(path)`, and `parse_table(path, options)`.
- Preserves: `core.csv_parser.parse_csv(path) -> ParseResult`.

- [ ] **Step 1: Write failing parser tests**

Add tests that create temporary headered/headerless delimited files and XLSX
workbooks, then assert generated column names, duplicate-name normalization,
sheet discovery, first-non-empty selection, mixed-column preservation, and
explicit header-row selection.

- [ ] **Step 2: Verify the tests fail**

Run: `backend\.venv\Scripts\python.exe -m pytest backend\tests\test_table_parser.py -q`

Expected: collection fails because `core.table_parser` does not exist.

- [ ] **Step 3: Implement the parser**

Implement:

```python
class HeaderMode(str, Enum):
    AUTO = "auto"
    FIRST_ROW = "first_row"
    NONE = "none"
    ROW = "row"

@dataclass
class ImportOptions:
    sheet: str | None = None
    header_mode: HeaderMode = HeaderMode.AUTO
    header_row: int | None = None

def inspect_table(path: str | Path) -> TableInspection: ...
def parse_table(path: str | Path, options: ImportOptions | None = None) -> ParseResult: ...
```

Delimited text inspection must detect encoding, delimiter, row width, header
confidence, and recoverable uneven rows. XLSX inspection must list every sheet,
mark empty sheets, and select the first non-empty sheet. Normalization must
assign `Column N` names and suffix duplicate labels with ` (N)`.

- [ ] **Step 4: Keep the compatibility API**

Make `backend/core/csv_parser.py` re-export the shared `ParseResult` and delegate
`parse_csv()` to `parse_table()` while retaining existing helper functions used
by template tests.

- [ ] **Step 5: Add Excel runtime support**

Add `openpyxl>=3.1` to `backend/requirements.txt`.

- [ ] **Step 6: Verify parser tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend\tests\test_table_parser.py template\trial2\data_analyzer\tests\test_csv_parser.py -q`

Expected: all tests pass.

### Task 2: Inspect and Confirm API

**Files:**
- Create: `backend/tests/test_dataset_import.py`
- Modify: `backend/dataset.py`
- Modify: `backend/routers/dataset.py`

**Interfaces:**
- Consumes: `inspect_table()` and `parse_table()`.
- Produces: `POST /dataset/inspect` and confirmed `POST /dataset/load` with `token`, `sheet`, `headerMode`, and `headerRow`.

- [ ] **Step 1: Write failing API and dataset tests**

Test that inspection returns a token, sheets, suggested options, columns, types,
warnings, and preview. Test that confirmed load respects sheet/header choices,
retains all preview columns, and exposes only numeric signals.

- [ ] **Step 2: Verify the tests fail**

Run: `backend\.venv\Scripts\python.exe -m pytest backend\tests\test_dataset_import.py -q`

Expected: failures because inspection and generic options are absent.

- [ ] **Step 3: Extend the dataset model**

Add column descriptors and warnings to `Dataset`, accept `ImportOptions` in
`build_dataset()`, retain the normalized DataFrame for preview, and leave
numeric arrays restricted to safely numeric columns.

- [ ] **Step 4: Implement upload inspection caching**

Store each temporary upload under an opaque token. Return inspection data from
`/dataset/inspect`; load the cached upload from `/dataset/load` using form
fields. Delete the cached file after successful load or a terminal parse error.

- [ ] **Step 5: Verify API tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend\tests\test_dataset_import.py -q`

Expected: all tests pass.

### Task 3: React Import Dialog

**Files:**
- Create: `frontend/src/routes/import-options.test.ts`
- Create: `frontend/src/routes/import-options.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/routes/Load.tsx`

**Interfaces:**
- Consumes: inspection and confirmed-load API responses.
- Produces: `optionsForMode(mode, row)` request normalization and the import dialog UI.

- [ ] **Step 1: Write failing option-normalization tests**

Test that Auto, First row, and No header omit `headerRow`, while explicit row
mode sends a positive one-based row number.

- [ ] **Step 2: Verify the tests fail**

Run: `npm --prefix frontend test -- --run src/routes/import-options.test.ts`

Expected: failure because `import-options.ts` does not exist.

- [ ] **Step 3: Implement API types and client calls**

Add `TableInspection`, `ColumnDescriptor`, and `ImportOptions` types. Replace
the one-step client load with:

```typescript
inspect(file: File): Promise<TableInspection>
load(token: string, options: ImportOptions): Promise<LoadResponse>
```

- [ ] **Step 4: Implement the import dialog**

Update file acceptance to `.csv,.tsv,.txt,.xlsx`. After inspection, show sheet
selection for workbooks, header mode controls, explicit row input, warnings,
column type badges, and the inspection preview. Confirming the dialog loads the
dataset and navigates to Plot.

- [ ] **Step 5: Verify frontend tests and type checking**

Run: `npm --prefix frontend test -- --run src/routes/import-options.test.ts`

Run: `npm --prefix frontend run build`

Expected: tests and build pass.

### Task 4: Full Regression Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed backend and frontend behavior.
- Produces: user-facing import documentation and final verification evidence.

- [ ] **Step 1: Update documentation**

Describe CSV/XLSX support, sheet selection, header modes, preserved mixed
columns, and numeric-only analysis compatibility.

- [ ] **Step 2: Run backend regression tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend\tests template\trial2\data_analyzer\tests -q`

Expected: all tests pass.

- [ ] **Step 3: Run frontend verification**

Run: `npm --prefix frontend test -- --run`

Run: `npm --prefix frontend run lint`

Run: `npm --prefix frontend run build`

Expected: all commands exit successfully.

- [ ] **Step 4: Review the diff**

Run: `git diff --check`

Run: `git status --short`

Confirm that unrelated existing changes remain preserved and unstaged.
