import type { FilterStep } from "@/lib/types"

/** Default params per filter type (mirrors core/filter_engine defaults). */
export const FILTER_DEFAULTS: Record<string, Record<string, number>> = {
  lowpass: { cutoff: 0.1, order: 4 },
  highpass: { cutoff: 0.01, order: 4 },
  bandpass: { low: 0.01, high: 0.1, order: 4 },
  bandstop: { low: 0.01, high: 0.1, order: 4 },
  savgol: { window: 51, polyorder: 3 },
  moving_average: { window: 21 },
  exp_moving_average: { alpha: 0.1 },
  median: { window: 5 },
  notch: { freq: 0.1, Q: 30 },
}

export const FILTER_LABELS: Record<string, string> = {
  lowpass: "Low-pass",
  highpass: "High-pass",
  bandpass: "Band-pass",
  bandstop: "Band-stop",
  savgol: "Savitzky-Golay",
  moving_average: "Moving average",
  exp_moving_average: "Exp. moving average",
  median: "Median",
  notch: "Notch",
}

export const FILTER_TYPES = Object.keys(FILTER_DEFAULTS)

export const newStep = (type: string): FilterStep => ({
  filter_type: type,
  params: { ...FILTER_DEFAULTS[type] },
  enabled: true,
})
