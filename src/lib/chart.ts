/** A+P chart styling for ECharts: red first, then dark blue, blue/gray, grays and tints. */
export const PALETTE = [
  "#ff2400",
  "#274259",
  "#6b7b84",
  "#5c5c5c",
  "#ff7a59",
  "#4f7fa3",
  "#a6b0b5",
  "#b31a00",
  "#8fa9bf",
  "#2b2b2b",
  "#ffb199",
  "#1b2e3e",
  "#c4cacd",
  "#7a2e1e",
  "#a5a5a5",
];

export const FONT = '"Futura LT Book","Futura LT","Futura PT",Futura,"Century Gothic","Avenir Next",Arial,sans-serif';

export const AXIS_COLOR = "#000000";
export const GRID_COLOR = "#e3e5e7";
export const MUTED = "#5c5c5c";

export function zip(x: (number | null)[], y: (number | null)[]): [number | null, number | null][] {
  const n = Math.min(x.length, y.length);
  const out: [number | null, number | null][] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [x[i], y[i]];
  return out;
}

export function valueAxis(extra: Record<string, unknown> = {}) {
  return {
    type: "value",
    scale: true,
    axisLine: { show: true, lineStyle: { color: AXIS_COLOR, width: 0.8 } },
    axisTick: { show: true, lineStyle: { color: AXIS_COLOR, width: 0.8 } },
    axisLabel: { color: MUTED, fontSize: 10.5, fontFamily: FONT, hideOverlap: true },
    splitLine: { show: true, lineStyle: { color: GRID_COLOR, width: 0.8 } },
    nameTextStyle: { color: "#000", fontFamily: FONT, fontSize: 11 },
    ...extra,
  };
}

export const baseTextStyle = { fontFamily: FONT, color: "#000" };

export const tooltipStyle = {
  backgroundColor: "rgba(255,255,255,0.96)",
  borderColor: "#d9dcde",
  borderWidth: 1,
  textStyle: { fontFamily: FONT, fontSize: 11, color: "#000" },
  extraCssText: "box-shadow: 2px 2px 6px rgb(0 0 0 / 25%); border-radius: 0;",
};

export function fmt(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(digits);
}

/** Python-like "%g" formatting with 6 significant digits. */
export function fmtG(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp < -4 || exp >= 6) {
    return v.toExponential(5).replace(/\.?0+e/, "e").replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(Number(v.toPrecision(6)));
}

/** Divergent colour scale for correlations: dark blue → white → A+P red. */
export const DIVERGING = ["#274259", "#8fa9bf", "#ffffff", "#ff9b80", "#ff2400"];
