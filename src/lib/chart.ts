/**
 * Chart theme for Plotly, following the dataviz visual guide: validated categorical order,
 * one-hue sequential and blue↔red diverging scales, hairline chrome, 2px lines, ≥8px ringed
 * markers and text that always wears ink tokens rather than series colours.
 */
import type { Config } from "plotly.js";

/** Plotly figure parts. The bundled typings lag Plotly 3, so figures are plain records. */
export type Figure = Record<string, any>;

/**
 * Categorical slots in fixed order, A+P red first (validated on white: adjacent CVD ΔE ≥ 16.3,
 * normal-vision ΔE ≥ 19.6; the first three also pass all-pairs for scatter). Never cycle past
 * seven — fold into small multiples instead.
 */
export const PALETTE = ["#ff2400", "#2a78d6", "#1baf7a", "#6250d6", "#eda100", "#e87ba4", "#008300"];

/** Colour for a series by its stable position (entity), never by its current rank. */
export const seriesColor = (i: number) => PALETTE[Math.min(i, PALETTE.length - 1)];

export const INK = {
  surface: "#ffffff",
  primary: "#0f1216",
  secondary: "#4a525c",
  muted: "#6b7380",
  grid: "#eceef2",
  axis: "#c5cbd3",
  /** De-emphasis for marks outside the current selection or fit range. */
  faded: "#d6dae0",
  /** The imported values behind a processed signal. */
  original: "#b4bac3",
};

export const FONT = '"Inter Variable",Inter,"Segoe UI",system-ui,-apple-system,sans-serif';

/** Sequential blue ramp (light → dark) for magnitude. */
export const SEQUENTIAL: [number, string][] = [
  [0, "#cde2fb"],
  [0.25, "#86b6ef"],
  [0.5, "#3987e5"],
  [0.75, "#1c5cab"],
  [1, "#0d366b"],
];

/** Diverging blue ↔ red with a neutral gray midpoint and equal steps per arm. */
export const DIVERGING: [number, string][] = [
  [0, "#1c5cab"],
  [0.25, "#86b6ef"],
  [0.5, "#f0efec"],
  [0.75, "#f0a09f"],
  [1, "#b8312f"],
];

/** A series hue as a translucent wash (area fills, bands, box bodies). */
export function wash(hex: string, alpha = 0.1): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export const LINE_WIDTH = 2;
export const MARKER_SIZE = 8;

/**
 * Marker look by point count. A few points get full, outlined dots; thousands of points get small,
 * soft, outline-free ones, so a dense cloud still shows its shape instead of a solid blob.
 */
export function markerStyle(n: number, color: string | string[]) {
  const size = n > 20000 ? 2.5 : n > 8000 ? 3 : n > 3000 ? 4 : n > 1000 ? 5 : n > 300 ? 6 : MARKER_SIZE;
  const opacity = n > 8000 ? 0.45 : n > 3000 ? 0.55 : n > 1000 ? 0.7 : 0.9;
  return { color, size, opacity, line: n > 1000 ? { width: 0 } : { color: INK.surface, width: 1 } };
}

export function zip(x: (number | null)[], y: (number | null)[]): [number | null, number | null][] {
  const n = Math.min(x.length, y.length);
  const out: [number | null, number | null][] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [x[i], y[i]];
  return out;
}

/** Labels come from file headers: escape them before Plotly renders its pseudo-HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function axis(title?: string, extra: Figure = {}): Figure {
  return {
    title: title ? { text: esc(title), standoff: 10, font: { size: 12.5, color: INK.secondary } } : undefined,
    showgrid: true,
    gridcolor: INK.grid,
    gridwidth: 1,
    griddash: "solid",
    zeroline: false,
    showline: true,
    linecolor: INK.axis,
    linewidth: 1,
    mirror: false,
    ticks: "outside",
    ticklen: 4,
    tickcolor: INK.axis,
    tickfont: { size: 12, color: INK.muted },
    automargin: true,
    hoverformat: ".6~g",
    ...extra,
  };
}

export function baseLayout(extra: Figure = {}): Figure {
  return {
    font: { family: FONT, size: 12, color: INK.primary },
    paper_bgcolor: INK.surface,
    plot_bgcolor: INK.surface,
    margin: { l: 56, r: 16, t: 28, b: 44, pad: 0 },
    colorway: PALETTE,
    showlegend: false,
    legend: {
      orientation: "h",
      x: 0,
      xanchor: "left",
      y: 1.02,
      yanchor: "bottom",
      bgcolor: "rgba(0,0,0,0)",
      font: { size: 11, color: INK.secondary },
      itemwidth: 30,
    },
    hoverlabel: {
      bgcolor: "rgba(255,255,255,0.97)",
      bordercolor: INK.axis,
      font: { family: FONT, size: 12, color: INK.primary },
      align: "left",
    },
    hoverdistance: 24,
    uniformtext: { mode: false },
    spikedistance: -1,
    dragmode: "zoom",
    xaxis: axis(),
    yaxis: axis(),
    ...extra,
  };
}

/** Simple navigation: drag to zoom, scroll to zoom, double-click to reset; a short, always-visible toolbar. */
export const plotConfig: Partial<Config> = {
  responsive: false,
  displaylogo: false,
  scrollZoom: true,
  doubleClick: "reset",
  displayModeBar: true,
  toImageButtonOptions: { format: "png", scale: 2, filename: "plot" },
};

/** Hover template that leads with the value and keeps the series name secondary. */
export function hoverValue(name: string, xLabel = "x"): string {
  return `<b>%{y:.6~g}</b>  ${esc(name)}<br><span style="color:${INK.muted}">${esc(xLabel)} %{x:.6~g}</span><extra></extra>`;
}

/** Min/max decimation that keeps peaks visible while bounding the number of plotted points. */
export function decimate(x: (number | null)[], y: (number | null)[], target: number, range?: [number, number] | null) {
  let lo = 0;
  let hi = x.length;
  if (range) {
    // Data are row-ordered; X is usually monotone. Fall back to the full span otherwise.
    const first = x.findIndex((v) => v != null && v >= range[0]);
    let last = -1;
    for (let i = x.length - 1; i >= 0; i--) if (x[i] != null && (x[i] as number) <= range[1]) { last = i; break; }
    if (first >= 0 && last >= first) {
      lo = Math.max(0, first - 1);
      hi = Math.min(x.length, last + 2);
    }
  }
  const n = hi - lo;
  if (n <= target) return { x: x.slice(lo, hi), y: y.slice(lo, hi) };
  const buckets = Math.max(1, Math.floor(target / 2));
  const size = n / buckets;
  const ox: (number | null)[] = [];
  const oy: (number | null)[] = [];
  for (let b = 0; b < buckets; b++) {
    const s = lo + Math.floor(b * size);
    const e = Math.min(hi, lo + Math.floor((b + 1) * size));
    let iMin = -1;
    let iMax = -1;
    let gap = false;
    for (let i = s; i < e; i++) {
      const v = y[i];
      if (v == null || !Number.isFinite(v)) { gap = true; continue; }
      if (iMin < 0 || v < (y[iMin] as number)) iMin = i;
      if (iMax < 0 || v > (y[iMax] as number)) iMax = i;
    }
    if (iMin < 0) { ox.push(x[s]); oy.push(null); continue; }
    const [a, c] = iMin < iMax ? [iMin, iMax] : [iMax, iMin];
    ox.push(x[a]); oy.push(y[a]);
    if (c !== a) { ox.push(x[c]); oy.push(y[c]); }
    if (gap) { ox.push(x[c]); oy.push(null); }
  }
  return { x: ox, y: oy };
}

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
