import { invoke } from "@tauri-apps/api/core";

export type Point = [number, number];
export interface FitSource {
  name: string;
  points: Point[];
  xLabel?: string;
  scope?: string;
  seriesIndex?: number;
}
export interface Parameter {
  name: string;
  start: number;
  lower: number | null;
  upper: number | null;
  fixed: boolean;
}
export interface FitRequest {
  points: Point[];
  expression: string;
  parameters: Parameter[];
  normalize: boolean;
  robust: boolean;
}
export interface FitResult {
  coefficients: number[];
  standard_errors: (number | null)[];
  curve: Point[];
  lower: Point[];
  upper: Point[];
  residuals: Point[];
  sse: number;
  rmse: number;
  r_squared: number | null;
  adjusted_r_squared: number | null;
  count: number;
  iterations: number;
  converged: boolean;
  x_center: number;
  x_scale: number;
  warning: string | null;
}
export interface Vectors {
  time: (number | null)[];
  columns: Record<string, (number | null)[]>;
}
export const analysisVectors = (columns: string[]) =>
  invoke<Vectors>("analysis_vectors", { columns });
export const curveFit = (request: FitRequest) =>
  invoke<FitResult>("curve_fit", { request });

export const FIT_MODELS = [
  { name: "Linear", equation: "a*x+b", starts: [1, 0] },
  { name: "Quadratic", equation: "a*x^2+b*x+c", starts: [1, 1, 0] },
  { name: "Cubic", equation: "a*x^3+b*x^2+c*x+d", starts: [1, 1, 1, 0] },
  { name: "Exponential", equation: "a*exp(b*x)+c", starts: [1, -1, 0] },
  { name: "Exponential decay", equation: "a*exp(-x/b)+c", starts: [1, 1, 0] },
  { name: "Power", equation: "a*x^b+c", starts: [1, 1, 0] },
  { name: "Logarithmic", equation: "a*ln(x)+b", starts: [1, 0] },
  { name: "Gaussian", equation: "a*exp(-((x-b)/c)^2)+d", starts: [1, 0, 1, 0] },
  { name: "Lorentzian", equation: "a/(1+((x-b)/c)^2)+d", starts: [1, 0, 1, 0] },
  { name: "Sigmoid", equation: "a/(1+exp(-b*(x-c)))+d", starts: [1, 1, 0, 0] },
  { name: "Sine", equation: "a*sin(b*x+c)+d", starts: [1, 1, 0, 0] },
  { name: "Custom equation", equation: "a*x+b", starts: [1, 0] },
];

/** Only numeric Cartesian observations are eligible; matrices and categories are not curves. */
export function chartFitSources(option: Record<string, any>): FitSource[] {
  const series = Array.isArray(option.series)
    ? option.series
    : option.series
      ? [option.series]
      : [];
  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  const yAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
  return series.flatMap((s: any, seriesIndex: number) => {
    if (
      !["line", "scatter", "bar"].includes(s.type) ||
      (s.coordinateSystem && s.coordinateSystem !== "cartesian2d") ||
      s.id?.startsWith("curve-fit-")
    )
      return [];
    const axis = axes[s.xAxisIndex ?? 0];
    if (
      axis?.type === "category" ||
      yAxes[s.yAxisIndex ?? 0]?.type === "category"
    )
      return [];
    const points: Point[] = (s.data ?? []).flatMap((entry: any) => {
      const v = entry?.value ?? entry;
      return Array.isArray(v) &&
        typeof v[0] === "number" &&
        typeof v[1] === "number" &&
        Number.isFinite(v[0]) &&
        Number.isFinite(v[1])
        ? [[v[0], v[1]]]
        : [];
    });
    return points.length >= 3
      ? [
          {
            name: s.name || `Series ${seriesIndex + 1}`,
            points,
            seriesIndex,
            xLabel: axis?.name || "X",
            scope:
              "Chart observations (may be downsampled). Use Data Plots for full-vector fits.",
          },
        ]
      : [];
  });
}

export function finitePairs(
  x: (number | null)[],
  y: (number | null)[],
): Point[] {
  return y.flatMap((v, i) =>
    v !== null && x[i] != null && Number.isFinite(v) && Number.isFinite(x[i])
      ? [[x[i] as number, v] as Point]
      : [],
  );
}

export type PlotSelection = {
  kind: "scatter" | "row" | "histogram";
  x: [number, number];
  y?: [number, number];
};
export function matchingRows(
  x: (number | null)[],
  y: (number | null)[],
  selection: PlotSelection,
): Set<number> {
  const rows = new Set<number>();
  for (let i = 0; i < y.length; i++) {
    const a =
      selection.kind === "row"
        ? i + 1
        : selection.kind === "histogram"
          ? y[i]
          : x[i];
    if (
      a == null ||
      !Number.isFinite(a) ||
      a < selection.x[0] ||
      a > selection.x[1]
    )
      continue;
    const b = y[i];
    if (
      selection.kind === "scatter" &&
      (b == null ||
        !Number.isFinite(b) ||
        (selection.y && (b < selection.y[0] || b > selection.y[1])))
    )
      continue;
    rows.add(i);
  }
  return rows;
}

export function summarize(values: (number | null)[]) {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const n = sorted.length;
  if (!n)
    return {
      count: 0,
      missing: values.length,
      mean: null,
      std: null,
      min: null,
      q1: null,
      median: null,
      q3: null,
      max: null,
      iqr: null,
    };
  const quantile = (p: number) => {
    const i = (n - 1) * p;
    const k = Math.floor(i);
    return sorted[k] + (sorted[Math.ceil(i)] - sorted[k]) * (i - k);
  };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const q1 = quantile(0.25),
    q3 = quantile(0.75);
  return {
    count: n,
    missing: values.length - n,
    mean,
    std:
      n > 1
        ? Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
        : null,
    min: sorted[0],
    q1,
    median: quantile(0.5),
    q3,
    max: sorted[n - 1],
    iqr: q3 - q1,
  };
}

export function histogram(
  values: (number | null)[],
  bins = 30,
  extent?: [number, number],
): Point[] {
  const finite = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (!finite.length && !extent) return [];
  const min = extent?.[0] ?? finite.reduce((a, b) => Math.min(a, b), Infinity);
  const max = extent?.[1] ?? finite.reduce((a, b) => Math.max(a, b), -Infinity);
  const width = max === min ? 1 : (max - min) / bins;
  const counts = Array.from({ length: max === min ? 1 : bins }, () => 0);
  for (const v of finite)
    if (v >= min && v <= max)
      counts[Math.min(counts.length - 1, Math.floor((v - min) / width))]++;
  return counts.map((n, i) => [max === min ? min : min + (i + 0.5) * width, n]);
}

export function downloadText(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
