import type { FilterStep, FilterType } from "./api";

export const FILTER_TYPES: FilterType[] = [
  "lowpass",
  "highpass",
  "bandpass",
  "bandstop",
  "savgol",
  "moving_average",
  "exp_moving_average",
  "median",
  "notch",
];

export function filterTitle(t: FilterType): string {
  return t
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  integer?: boolean;
  freq?: boolean;
}

export function paramDefs(t: FilterType): ParamDef[] {
  switch (t) {
    case "lowpass":
    case "highpass":
      return [
        { key: "cutoff", label: "Cutoff [Hz]", min: 0.0001, max: 10, def: 0.05, freq: true },
        { key: "order", label: "Order", min: 1, max: 10, def: 4, integer: true },
      ];
    case "bandpass":
    case "bandstop":
      return [
        { key: "low", label: "Low [Hz]", min: 0.0001, max: 10, def: 0.01, freq: true },
        { key: "high", label: "High [Hz]", min: 0.0001, max: 10, def: 0.1, freq: true },
        { key: "order", label: "Order", min: 1, max: 10, def: 4, integer: true },
      ];
    case "savgol":
      return [
        { key: "window", label: "Window", min: 3, max: 1001, def: 51, integer: true },
        { key: "polyorder", label: "Poly Order", min: 1, max: 10, def: 3, integer: true },
      ];
    case "moving_average":
    case "median":
      return [{ key: "window", label: "Window", min: 3, max: 1001, def: 21, integer: true }];
    case "exp_moving_average":
      return [{ key: "alpha", label: "Alpha", min: 0.001, max: 1, def: 0.1 }];
    case "notch":
      return [
        { key: "freq", label: "Frequency [Hz]", min: 0.0001, max: 10, def: 0.05, freq: true },
        { key: "Q", label: "Q Factor", min: 1, max: 200, def: 30 },
      ];
  }
}

export function defaultStep(t: FilterType): FilterStep {
  return { filter_type: t, params: Object.fromEntries(paramDefs(t).map((p) => [p.key, p.def])), enabled: true };
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v);
}

/** Mirrors FilterStep.describe() of the original application. */
export function describeStep(s: FilterStep): string {
  const parts = [filterTitle(s.filter_type)];
  const p = s.params;
  if (p.cutoff !== undefined) parts.push(`fc=${p.cutoff.toFixed(4)} Hz`);
  if (p.order !== undefined) parts.push(`order=${num(p.order)}`);
  if (p.window !== undefined) parts.push(`win=${num(p.window)}`);
  if (p.freq !== undefined) parts.push(`f0=${p.freq.toFixed(4)} Hz`);
  if (p.low !== undefined && p.high !== undefined) parts.push(`${p.low.toFixed(4)}–${p.high.toFixed(4)} Hz`);
  if (p.alpha !== undefined) parts.push(`α=${p.alpha}`);
  return parts.join(", ");
}
