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
}

export type Preview = { columns: string[]; rows: (string | number)[][] }

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
