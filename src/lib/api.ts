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
  filtered: string[];
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
  min: number | null;
  max: number | null;
  is_time: boolean;
  edits: string[];
  can_undo: boolean;
}

export type VariableEdit =
  | { op: "offset"; value: number }
  | { op: "scale"; value: number }
  | { op: "downsample"; value: number }
  | { op: "despike"; value: number }
  /** Half-open row ranges [start, end). */
  | { op: "clear_range" | "keep_range"; value: [number, number] }
  | { op: "clear_points"; value: number[] }
  | { op: "normalize" | "zscore" | "demean" | "zero_start" | "invert" | "fill_gaps" };

/** Imported and edited values of a workspace variable, row-aligned with the dataset time axis. */
export interface WorkspaceVectors {
  time: number[];
  variables: Record<string, { original: (number | null)[]; edited: (number | null)[]; edits: string[]; can_undo: boolean }>;
}

export interface WorkspaceView {
  variables: VariableInfo[];
  time_var: string | null;
  dataset: DatasetInfo | null;
  added: string[];
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

export interface FilterChain {
  steps: FilterStep[];
}

export interface Suggestion {
  step: FilterStep;
  reason: string;
  estimated_improvement: number;
  description: string;
}

export interface FilterPreview {
  x: (number | null)[];
  original: (number | null)[];
  filtered: (number | null)[] | null;
  draft: (number | null)[] | null;
  error: string | null;
}

export interface PeakInfo {
  frequency: number;
  amplitude: number;
  prominence: number;
}

export interface SpectrumView {
  fft: Xy;
  psd: Xy;
  psd_filtered: Xy | null;
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
  errors: string[];
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
  workspaceSetTime: (name: string | null) => invoke<WorkspaceView>("workspace_set_time", { name }),
  workspaceClear: () => invoke<WorkspaceView>("workspace_clear"),
  workspaceEdit: (name: string, action: "edit" | "undo" | "reset" | "duplicate", edit?: VariableEdit) =>
    invoke<WorkspaceView>("workspace_edit", { name, action, edit: edit ?? null }),
  workspaceVectors: (names: string[]) => invoke<WorkspaceVectors>("workspace_vectors", { names }),
  exportDataset: (path: string) => invoke<number>("export_dataset", { path }),
  datasetInfo: () => invoke<DatasetInfo | null>("dataset_info"),
  descriptiveStats: () => invoke<StatRow[]>("descriptive_stats"),
  getSeries: (columns: string[], range: [number, number] | null, maxPoints: number) =>
    invoke<SeriesResponse>("get_series", { columns, range, maxPoints }),
  valuesAt: (columns: string[], t: number) => invoke<{ t: number; values: (number | null)[] }>("values_at", { columns, t }),

  filterSuggest: (column: string) => invoke<Suggestion[]>("filter_suggest", { column }),
  filterPreview: (column: string, chain: FilterChain, draft: FilterStep | null) =>
    invoke<FilterPreview>("filter_preview", { column, chain, draft }),
  filterApply: (column: string, chain: FilterChain) => invoke<DatasetInfo>("filter_apply", { column, chain }),
  filterClear: (column: string) => invoke<DatasetInfo>("filter_clear", { column }),
  filterGetChain: (column: string) => invoke<FilterChain | null>("filter_get_chain", { column }),
  filterSaveChain: (path: string, chain: FilterChain) => invoke<void>("filter_save_chain", { path, chain }),
  filterLoadChain: (path: string) => invoke<FilterChain>("filter_load_chain", { path }),

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

  compareAddFiles: (paths: string[]) => invoke<CompareState>("compare_add_files", { paths }),
  compareState: () => invoke<CompareState>("compare_state"),
  compareRemoveFile: (id: string) => invoke<CompareState>("compare_remove_file", { id }),
  compareClear: () => invoke<CompareState>("compare_clear"),
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

export const DATA_FILE_EXTENSIONS = ["csv", "txt", "tsv", "tab", "dat", "log", "asc", "xlsx", "xlsm", "xlsb", "xls", "ods"];

export const DATA_FILE_FILTERS = [
  { name: "Data files (CSV, TXT, Excel)", extensions: DATA_FILE_EXTENSIONS },
  { name: "CSV / text", extensions: ["csv", "txt", "tsv", "tab", "dat", "log", "asc"] },
  { name: "Excel workbooks", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"] },
  { name: "All files", extensions: ["*"] },
];

export const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];
