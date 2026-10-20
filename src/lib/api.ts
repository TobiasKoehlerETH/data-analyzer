import { invoke } from "@/lib/platform";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface SignalInfo {
  column: string;
  name: string;
  unit: string;
  group: string;
  index: number;
  label: string;
}

export interface DatasetInfo {
  path: string;
  n_samples: number;
  n_signals: number;
  sample_rate: number;
  duration: number;
  signals: SignalInfo[];
  metadata: Record<string, Json>;
  encoding: string;
  delimiter: string;
  header_row: number;
  is_raser_format: boolean;
  file_type: string;
  sheet: string | null;
  /** Signals with processing steps (Prepare edits or filters). */
  edited: string[];
  /** Unix seconds at t = 0 when the time axis comes from timestamps (enables date axes). */
  time_origin: number | null;
  /** Text variables available for grouping. */
  texts: string[];
}

export interface PreviewResult {
  encoding: string;
  delimiter: string;
  header_row: number;
  is_raser_format: boolean;
  metadata: Record<string, Json>;
  headers: string[];
  rows: string[][];
  file_type: string;
  sheets: string[];
  sheet: string | null;
  raw: string[][];
  n_lines: number;
  data_start: number;
  no_header: boolean;
  time_column_index: number | null;
  time_column: string | null;
  skipped_columns: number[];
  numeric_columns: number[];
  /** Columns holding text (imported as categories). */
  text_columns: number[];
}

/** Manual overrides of the automatic format detection (0-based lines / columns). */
export interface ImportOptions {
  delimiter?: string | null;
  header_row?: number | null;
  no_header?: boolean;
  data_start?: number | null;
  skip_rows?: number[];
  skip_columns?: number[];
  /** null/undefined = auto, -1 = none (sample index), k = column k */
  time_column?: number | null;
}

export interface VariableInfo {
  name: string;
  len: number;
  source: string;
  source_id: number | null;
  kind: "imported" | "derived" | "text";
  formula: string | null;
  min: number | null;
  max: number | null;
  is_time: boolean;
  edits: string[];
  can_undo: boolean;
  error: string | null;
}

export interface SourceInfo {
  id: number;
  name: string;
  path: string;
  rows: number;
  time_var: string | null;
  origin: number | null;
  /** Shift added to this file's time when aligning (seconds). */
  offset: number;
  /** Seconds per row when the time comes from a conversion factor instead of a time column. */
  row_step: number | null;
  start: number | null;
  duration: number;
  sample_rate: number;
}

export type Align = "time" | "clock" | "row";

/** Where one row of a file sits in time. */
export interface TimeMap {
  /** 1-based row in the file. */
  row: number;
  rows: number;
  /** Seconds on the aligned axis. */
  time: number;
  /** Clock time (UTC) when the file has timestamps. */
  clock: string | null;
}

/** Reusable processing: steps per column name plus derived variables. */
export interface Recipe {
  name: string;
  columns: { column: string; steps: VariableEdit[] }[];
  derived: { name: string; formula: string; steps: VariableEdit[] }[];
}

export type VariableEdit =
  | { op: "offset"; value: number }
  | { op: "scale"; value: number }
  | { op: "despike"; value: number }
  /** Time ranges on the aligned axis (inclusive). */
  | { op: "clear_range" | "keep_range"; value: [number, number] }
  /** Sample times on the aligned axis. */
  | { op: "clear_points"; value: number[] }
  | { op: "filter"; value: FilterStep }
  | { op: "normalize" | "zscore" | "demean" | "zero_start" | "invert" | "fill_gaps" };

/** What one pipeline block did to the values it received. */
export interface StageInfo {
  label: string;
  /** The step itself (times on the aligned axis). */
  step: VariableEdit;
  /** Missing samples after this block. */
  missing: number;
  removed: number;
  filled: number;
  changed: number;
  rms_change: number | null;
}

export interface Pipeline {
  /** "file.csv · column" or "= formula". */
  source: string;
  kind: "imported" | "derived";
  rows: number;
  /** Missing samples in the imported values. */
  missing: number;
  stages: StageInfo[];
}

/** One variable at its own samples (no interpolation), times on the aligned axis. */
export interface VariableSamples {
  time: number[];
  original: (number | null)[];
  edited: (number | null)[];
  edits: string[];
  can_undo: boolean;
  time_origin: number | null;
}

/** Imported values of variables on the common grid, windowed and decimated (x = time or row). */
export interface WorkspaceVectors {
  variables: Record<string, { x: number[]; original: (number | null)[]; edits: string[] }>;
}

export interface WorkspaceView {
  variables: VariableInfo[];
  sources: SourceInfo[];
  align: Align;
  grid_step: number | null;
  /** Recipe applied to every new import. */
  auto_recipe: string | null;
  dataset: DatasetInfo | null;
  added: string[];
  /** Steps or files that could not be applied. */
  warnings: string[];
}

export interface StatRow {
  signal: string;
  count: number;
  mean: number;
  std: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  skew: number;
  kurtosis: number;
}

export interface Xy {
  x: (number | null)[];
  y: (number | null)[];
}

export interface SeriesResponse {
  t_min: number;
  t_max: number;
  series: { column: string; x: (number | null)[]; y: (number | null)[] }[];
}

export type FilterType =
  | "lowpass"
  | "highpass"
  | "bandpass"
  | "bandstop"
  | "savgol"
  | "moving_average"
  | "exp_moving_average"
  | "median"
  | "notch";

export interface FilterStep {
  filter_type: FilterType;
  params: Record<string, number>;
  enabled: boolean;
}

export interface Suggestion {
  step: FilterStep;
  reason: string;
  estimated_improvement: number;
  description: string;
}

export interface PeakInfo {
  frequency: number;
  amplitude: number;
  prominence: number;
}

export interface SpectrumView {
  fft: Xy;
  psd: Xy;
  /** PSD of the imported values when the signal has processing steps. */
  psd_original: Xy | null;
  peaks: PeakInfo[];
  n_peaks: number;
  nyquist: number;
  nperseg_used: number;
}

export interface PairDto {
  signal_a: string;
  signal_b: string;
  name_a: string;
  name_b: string;
  pearson_r: number;
  spearman_r: number;
  lag_samples: number;
  lag_seconds: number;
}

export interface CorrelationView {
  columns: string[];
  names: string[];
  pearson: (number | null)[][];
  spearman: (number | null)[][];
  top_pairs: PairDto[];
}

export interface PairAnalysis {
  label_a: string;
  label_b: string;
  scatter: Xy;
  lags: number[];
  corr: number[];
  pearson_r: number;
}

export interface OutputMetrics {
  name: string;
  rmse: number;
  nrmse: number;
  mae: number;
  r_squared: number;
  vaf: number;
}

export interface SysIdRow {
  index: number;
  name: string;
  order: number;
  mean_vaf: number;
  best_vaf: number;
  metrics: OutputMetrics[];
}

export interface ModelSummary {
  name: string;
  method: string;
  order: number;
  n_inputs: number;
  n_outputs: number;
  decimation_factor: number;
  mean_vaf: number;
  best_vaf: number;
  timestamp: string;
}

export interface StateSpaceModel {
  name: string;
  A: number[][];
  B: number[][];
  C: number[][];
  D: number[][];
  input_names: string[];
  output_names: string[];
  method: string;
  order: number;
  decimation_factor: number;
  dt: number;
  metrics: OutputMetrics[];
  timestamp: string;
}

export interface SimulationView {
  models: string[];
  plots: {
    output: string;
    label: string;
    measured: Xy;
    simulated: { model: string; x: (number | null)[]; y: (number | null)[] }[];
  }[];
}

export interface ValidationOutput {
  name: string;
  label: string;
  residuals: Xy;
  hist_centers: number[];
  hist_density: number[];
  hist_width: number;
  normal: Xy;
  shapiro_stat: number;
  shapiro_p: number;
  acf_lags: number[];
  acf: (number | null)[];
  acf_confidence: number;
  xcorr: { input: string; label: string; lags: number[]; values: (number | null)[] }[];
  metrics: OutputMetrics;
}

export interface ValidationView {
  model: string;
  outputs: ValidationOutput[];
}

export interface CompareFile {
  id: string;
  path: string;
  short_name: string;
  color: string;
  offset: number;
  columns: string[];
  n_samples: number;
  t_start: number;
  t_end: number;
}

export interface CompareState {
  files: CompareFile[];
  mapped_signals: string[];
  mappings: { canonical: string; file_columns: Record<string, string> }[];
  /** Rebuilt dataset when the call changed the workspace (time shifts). */
  dataset: DatasetInfo | null;
}

export interface CompareTrace {
  file_id: string;
  name: string;
  color: string;
  x: (number | null)[];
  y: (number | null)[];
}

export interface CompareSignalSeries {
  signal: string;
  traces: CompareTrace[];
}

export interface CompareStatistics {
  signal: string;
  file_name: string;
  rmse: number;
  max_deviation: number;
  r_squared: number;
  mean_error: number;
}

export interface ProgressEvent {
  task: string;
  value: number;
  message: string;
}

export const api = {
  previewFile: (path: string, sheet?: string | null, options?: ImportOptions | null) =>
    invoke<PreviewResult>("preview_file", { path, sheet: sheet ?? null, options: options ?? null }),
  workspaceImport: (path: string, sheet: string | null, options: ImportOptions, columns: string[]) =>
    invoke<WorkspaceView>("workspace_import", { path, sheet, options, columns }),
  workspaceView: () => invoke<WorkspaceView>("workspace_view"),
  workspaceRemove: (names: string[]) => invoke<WorkspaceView>("workspace_remove", { names }),
  workspaceRename: (old: string, newName: string) => invoke<WorkspaceView>("workspace_rename", { old, new: newName }),
  workspaceSetTime: (name: string, time: boolean) => invoke<WorkspaceView>("workspace_set_time", { name, time }),
  workspaceImportBatch: (paths: string[], folder: string | null, columns: string[] | null) =>
    invoke<WorkspaceView>("workspace_import_batch", { paths, folder, columns }),
  workspaceRemoveSource: (id: number) => invoke<WorkspaceView>("workspace_remove_source", { id }),
  workspaceSetRowStep: (id: number, step: number | null) => invoke<WorkspaceView>("workspace_set_row_step", { id, step }),
  /** A row of a file → its time, or a time → the nearest row. */
  sourceTimeMap: (id: number, at: { row?: number; time?: number }) => invoke<TimeMap>("source_time_map", { id, row: at.row ?? null, time: at.time ?? null }),
  workspaceSetOffset: (id: number, offset: number) => invoke<WorkspaceView>("workspace_set_offset", { id, offset }),
  workspaceSetAlign: (align: Align, gridStep: number | null) => invoke<WorkspaceView>("workspace_set_align", { align, gridStep }),
  workspaceAddDerived: (name: string, formula: string) => invoke<WorkspaceView>("workspace_add_derived", { name, formula }),
  workspaceSetFormula: (name: string, formula: string) => invoke<WorkspaceView>("workspace_set_formula", { name, formula }),
  workspaceVariable: (name: string) => invoke<VariableSamples>("workspace_variable", { name }),
  /** Values a step would produce, without adding it (times on the aligned axis). */
  workspacePreview: (name: string, edit: VariableEdit) => invoke<number[]>("workspace_preview", { name, edit }),
  workspacePipeline: (name: string) => invoke<Pipeline>("workspace_pipeline", { name }),
  /** Values entering and leaving block `index` of the pipeline. */
  workspaceStage: (name: string, index: number) => invoke<{ input: (number | null)[]; output: (number | null)[] }>("workspace_stage", { name, index }),
  workspaceStep: (name: string, action: "remove" | "move" | "replace", index: number, opts: { to?: number; edit?: VariableEdit } = {}) =>
    invoke<WorkspaceView>("workspace_step", { name, action, index, to: opts.to ?? null, edit: opts.edit ?? null }),
  recipeSave: (path: string, name: string, names: string[] | null) => invoke<Recipe>("recipe_save", { path, name, names }),
  recipeLoad: (path: string) => invoke<Recipe>("recipe_load", { path }),
  recipeApply: (recipe: Recipe, source: number | null) => invoke<WorkspaceView>("recipe_apply", { recipe, source }),
  recipeSetAuto: (recipe: Recipe | null) => invoke<WorkspaceView>("recipe_set_auto", { recipe }),
  projectSave: (path: string) => invoke<void>("project_save", { path }),
  projectOpen: (path: string) => invoke<WorkspaceView>("project_open", { path }),
  workspaceClear: () => invoke<WorkspaceView>("workspace_clear"),
  workspaceEdit: (name: string, action: "edit" | "undo" | "reset" | "remove_filters" | "duplicate", edit?: VariableEdit) =>
    invoke<WorkspaceView>("workspace_edit", { name, action, edit: edit ?? null }),
  workspaceVectors: (names: string[], range: [number, number] | null, maxPoints: number, row: boolean) =>
    invoke<WorkspaceVectors>("workspace_vectors", { names, range, maxPoints, row }),
  exportDataset: (path: string) => invoke<number>("export_dataset", { path }),
  datasetInfo: () => invoke<DatasetInfo | null>("dataset_info"),
  descriptiveStats: () => invoke<StatRow[]>("descriptive_stats"),
  /** Visible window, peak-preserving decimated; `row` = x is the 1-based row number. */
  getSeries: (columns: string[], range: [number, number] | null, maxPoints: number, row = false) =>
    invoke<SeriesResponse>("get_series", { columns, range, maxPoints, row }),
  valuesAt: (columns: string[], t: number) => invoke<{ t: number; values: (number | null)[] }>("values_at", { columns, t }),

  filterSuggest: (column: string) => invoke<Suggestion[]>("filter_suggest", { column }),

  spectrum: (column: string, nperseg: number) => invoke<SpectrumView>("spectrum", { column, nperseg }),

  correlationCompute: () => invoke<CorrelationView>("correlation_compute"),
  correlationPair: (a: string, b: string) => invoke<PairAnalysis>("correlation_pair", { a, b }),
  correlationLags: () => invoke<PairDto[]>("correlation_lags"),

  sysidAutoDecimation: (columns: string[]) => invoke<number>("sysid_auto_decimation", { columns }),
  sysidEstimateTime: (nSamples: number, nInputs: number, nOutputs: number, orderMin: number, orderMax: number) =>
    invoke<number>("sysid_estimate_time", { nSamples, nInputs, nOutputs, orderMin, orderMax }),
  sysidIdentify: (req: {
    inputs: string[];
    outputs: string[];
    name: string;
    method: string;
    order_min: number;
    order_max: number;
    decimation: number;
    start: number;
    end: number;
  }) => invoke<SysIdRow[]>("sysid_identify", { req }),
  sysidCancel: () => invoke<void>("sysid_cancel"),
  sysidSaveResult: (index: number) => invoke<string>("sysid_save_result", { index }),

  modelsList: () => invoke<ModelSummary[]>("models_list"),
  modelDetail: (name: string) => invoke<StateSpaceModel>("model_detail", { name }),
  modelRename: (old: string, newName: string) => invoke<void>("model_rename", { old, new: newName }),
  modelDuplicate: (names: string[]) => invoke<string[]>("model_duplicate", { names }),
  modelDelete: (names: string[]) => invoke<void>("model_delete", { names }),
  modelsCompare: (names: string[]) => invoke<[string, string][][]>("models_compare", { names }),
  modelUpdateMatrices: (name: string, a: number[][], b: number[][], c: number[][], d: number[][]) =>
    invoke<void>("model_update_matrices", { name, a, b, c, d }),
  modelsSave: (path: string) => invoke<void>("models_save", { path }),
  modelsLoad: (path: string) => invoke<number>("models_load", { path }),

  simulationRun: (model: string, start: number, end: number, autoX0: boolean, append: boolean) =>
    invoke<SimulationView>("simulation_run", { model, start, end, autoX0, append }),
  simulationClear: () => invoke<void>("simulation_clear"),

  validationRun: (model: string) => invoke<ValidationView>("validation_run", { model }),

  compareState: () => invoke<CompareState>("compare_state"),
  compareSetOffset: (id: string, offset: number) => invoke<CompareState>("compare_set_offset", { id, offset }),
  compareAlignTrigger: (signal: string, threshold: number, rising: boolean) =>
    invoke<CompareState>("compare_align_trigger", { signal, threshold, rising }),
  compareAlignClicks: (clicks: [string, number][]) => invoke<CompareState>("compare_align_clicks", { clicks }),
  compareNearestFile: (signal: string, t: number, y: number) => invoke<string | null>("compare_nearest_file", { signal, t, y }),
  compareSetMapping: (canonical: string, id: string, column: string | null) =>
    invoke<CompareState>("compare_set_mapping", { canonical, id, column }),
  compareSeries: (signals: string[], range: [number, number] | null, maxPoints: number) =>
    invoke<CompareSignalSeries[]>("compare_series", { signals, range, maxPoints }),
  compareDifferences: (signals: string[], maxPoints: number) =>
    invoke<CompareSignalSeries[]>("compare_differences", { signals, maxPoints }),
  compareStats: (signals: string[]) => invoke<CompareStatistics[]>("compare_stats", { signals }),

  reportGenerate: (sections: string[], format: string, path: string) =>
    invoke<{ path: string; note: string | null }>("report_generate", { sections, format, path }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

export const BINARY_FILE_EXTENSIONS = ["parquet", "mat", "h5", "hdf5", "tdms"];
export const DATA_FILE_EXTENSIONS = ["csv", "txt", "tsv", "tab", "dat", "log", "asc", "xlsx", "xlsm", "xlsb", "xls", "ods", ...BINARY_FILE_EXTENSIONS];

export const DATA_FILE_FILTERS = [
  { name: "Data files (CSV, TXT, Excel, Parquet, MAT, HDF5, TDMS)", extensions: DATA_FILE_EXTENSIONS },
  { name: "CSV / text", extensions: ["csv", "txt", "tsv", "tab", "dat", "log", "asc"] },
  { name: "Excel workbooks", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"] },
  { name: "Parquet, MATLAB, HDF5, TDMS", extensions: BINARY_FILE_EXTENSIONS },
  { name: "All files", extensions: ["*"] },
];

export const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];
