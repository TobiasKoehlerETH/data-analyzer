export type SignalInfo = {
  name: string
  unit: string
  min: number
  max: number
  mean: number
  std: number
}

export type DatasetMeta = {
  id: string
  filename: string
  rows: number
  signalCount: number
  duration: number // seconds
  sampleRate: number // Hz
  raser: boolean
  info: Record<string, string> // parsed header metadata (key: value)
  columns: ColumnDescriptor[]
  warnings: string[]
  sheet: string | null
}

export type TableCell = string | number | boolean | null
export type Preview = { columns: string[]; rows: TableCell[][] }

export type HeaderMode = "auto" | "first_row" | "none" | "row"

export type ImportOptions = {
  sheet?: string
  headerMode: HeaderMode
  headerRow?: number
}

export type ColumnDescriptor = {
  name: string
  type: "numeric" | "text" | "datetime" | "mixed" | "empty"
}

export type SheetInfo = { name: string; empty: boolean }

export type TableInspection = {
  token: string
  filename: string
  format: "delimited" | "xlsx"
  sheets: SheetInfo[]
  suggestedSheet: string | null
  suggestedHeaderRow: number | null
  delimiter: string | null
  encoding: string | null
  columns: ColumnDescriptor[]
  preview: Preview
  warnings: string[]
  raser: boolean
}

export type ImportPreview = {
  columns: ColumnDescriptor[]
  preview: Preview
  warnings: string[]
}

export type LoadResponse = {
  dataset: DatasetMeta
  signals: SignalInfo[]
  preview: Preview
}

/** time + each requested signal as a Float32 array (read-only views over one buffer). */
export type SignalData = { time: Float32Array; series: Record<string, Float32Array> }

// --- Signal processing -------------------------------------------------------
export type FilterStep = {
  filter_type: string
  params: Record<string, number>
  enabled: boolean
}
export type FilterChain = { steps: FilterStep[] }

export type FilterSuggestion = {
  filterType: string
  params: Record<string, number>
  reason: string
  improvement: number
}

export type Spectrum = {
  fft: { freqs: number[]; magnitude: number[] }
  psd: { freqs: number[]; psd: number[] }
  peaks: { frequency: number; amplitude: number; prominence: number }[]
}

export type CorrelationMatrix = {
  columns: string[]
  pearson: number[][]
  topPairs: { a: string; b: string; pearson: number; spearman: number }[]
}

// --- Modelling ---------------------------------------------------------------
export type OutputMetrics = {
  name: string
  rmse: number
  nrmse: number
  mae: number
  r_squared: number
  vaf: number
}

export type ModelSummary = {
  name: string
  order: number
  method: string
  nInputs: number
  nOutputs: number
  inputNames: string[]
  outputNames: string[]
  decimation: number
  meanVaf: number
  bestVaf: number
  metrics: OutputMetrics[]
}

export type SysIdPlan = { decimation: number; samples: number; estimatedSeconds: number }

export type Job<T> = {
  status: "running" | "done" | "error"
  progress: number
  message: string
  result: T | null
  error: string | null
}

export type SysIdResult = { sweep: ModelSummary[]; bestName: string | null }

export type SimResult = {
  time: number[]
  outputs: { name: string; measured: number[] }[]
  sims: { model: string; byOutput: Record<string, number[]> }[]
}

export type ValOutput = {
  name: string
  residuals: number[]
  acf: { lags: number[]; acf: number[]; confidence: number }
  shapiro: { stat: number; p: number }
  hist: { counts: number[]; edges: number[] }
  metrics: OutputMetrics
}

export type ValResult = {
  time: number[]
  outputs: ValOutput[]
  inputXcorr: Record<string, Record<string, number[]>>
}

// --- Compare -----------------------------------------------------------------
export type CompareOverlay = {
  time: number[]
  files: { id: string; name: string; values: number[] }[]
  stats: { file: string; rmse: number; maxDev: number; r2: number; meanError: number }[]
  matchedColumn: string
}
