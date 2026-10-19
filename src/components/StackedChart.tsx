import Plotly from "plotly.js-dist-min";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceActive } from "@/lib/workspace";
import { Plot, type PlotElement, type PlotTable } from "./Plot";
import { INK, LINE_WIDTH, MARKER_SIZE, axis, baseLayout, decimate, esc, hoverValue, type Figure } from "@/lib/chart";

export interface ChartSeries {
  name: string;
  color: string;
  data: [number | null, number | null][];
  dashed?: boolean;
  type?: "line" | "scatter" | "bar";
}

/** Decades per tick on a log axis, so a wide range still shows about six labels. */
function logStep(p: ChartPanel): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of p.series)
    for (const [, y] of s.data)
      if (y != null && y > 0) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
  if (!(hi > lo)) return 1;
  return Math.max(1, Math.ceil(Math.log10(hi / lo) / 6));
}

export interface ChartPanel {
  id: string;
  yLabel?: string;
  title?: string;
  series: ChartSeries[];
  /** Defaults to on for two or more series; a single series is named by the panel instead. */
  legend?: boolean;
  /** Horizontal reference lines (zero lines, confidence bounds). */
  hLines?: { y: number; label?: string }[];
  /** Vertical marker lines; at most one may be draggable. */
  vLines?: { x: number; label?: string; draggable?: boolean }[];
  /** Highlighted points (e.g. peaks), most important first; labels are thinned so they never collide. */
  points?: { x: number; y: number; label: string }[];
  yLog?: boolean;
}

export interface StackedChartProps {
  panels: ChartPanel[];
  /** Columns per row; panels fill row-major (side-by-side layouts). */
  columns?: number;
  xLabel?: string;
  /** X values are Unix milliseconds: show a date/time axis. */
  xDate?: boolean;
  xRange?: [number, number] | null;
  /** Called (debounced) with the visible x range after zoom/pan; null = full range. */
  onZoom?: (range: [number, number] | null) => void;
  onCursor?: (x: number) => void;
  onClick?: (panelIndex: number, x: number, y: number) => void;
  /** Called while the draggable vertical line moves. */
  onDragLine?: (x: number) => void;
  /** Enables box selection (drag) and reports the box in data coordinates; null when cleared. */
  onSelect?: (box: { panel: number; x: [number, number]; y: [number, number] } | null) => void;
  /** Changing this key removes the drawn selection box without touching the zoom. */
  selectionKey?: string | number;
  /** Changing this key resets the zoom. */
  resetKey?: string | number;
  tooltip?: boolean;
  className?: string;
}

const GAP = 26;
const HEADER = 20;
const MAX_POINTS = 4000;

const axisId = (i: number) => (i === 0 ? "" : String(i + 1));

export function StackedChart({
  panels,
  columns = 1,
  xLabel,
  xDate = false,
  xRange,
  onZoom,
  onCursor,
  onClick,
  onDragLine,
  onSelect,
  selectionKey,
  resetKey,
  tooltip = true,
  className,
}: StackedChartProps) {
  const active = useContext(WorkspaceActive);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const [view, setView] = useState<[number, number] | null>(null);
  const zoomTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cbs = useRef({ onZoom, onCursor, onClick, onDragLine, onSelect });
  cbs.current = { onZoom, onCursor, onClick, onDragLine, onSelect };
  const gdRef = useRef<PlotElement | null>(null);
  const selectable = !!onSelect;

  useEffect(() => setView(null), [resetKey]);
  useEffect(() => {
    const gd = gdRef.current;
    if (gd && selectionKey !== undefined) Plotly.relayout(gd, { selections: [] } as any).catch(() => {});
  }, [selectionKey]);

  useEffect(() => {
    if (!host.current || !active) return;
    const ro = new ResizeObserver(() => {
      if (host.current) setSize({ w: host.current.clientWidth, h: host.current.clientHeight });
    });
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [active]);

  const n = panels.length;
  const rows = Math.max(1, Math.ceil(n / columns));
  const scatterOnly = panels.some((p) => p.series.some((s) => s.type === "scatter"));
  const draggable = panels.some((p) => p.vLines?.some((v) => v.draggable));
  const target = Math.max(600, Math.round((size.w / columns) * 2));
  const config = useMemo(() => (draggable ? { edits: { shapePosition: true } } : undefined), [draggable]);

  const figure = useMemo(() => {
    const data: Figure[] = [];
    const shapes: Figure[] = [];
    const annotations: Figure[] = [];
    const layout: Figure = {};
    const legends: Figure = {};
    const top = 8;
    const bottom = 44;
    const usable = Math.max(60, size.h - top - bottom);
    const rowHeaders: number[] = Array.from({ length: rows }, (_, r) =>
      panels.slice(r * columns, r * columns + columns).some((p) => p.title || legendOn(p)) ? HEADER : 0,
    );
    const plotH = (usable - GAP * (rows - 1) - rowHeaders.reduce((a, b) => a + b, 0)) / rows;
    const colGap = columns > 1 ? 0.04 : 0;
    const colW = (1 - colGap * (columns - 1)) / columns;

    panels.forEach((p, i) => {
      const row = Math.floor(i / columns);
      const col = i % columns;
      const id = axisId(i);
      const above = rowHeaders.slice(0, row + 1).reduce((a, b) => a + b, 0) + row * (plotH + GAP);
      const y1 = 1 - above / usable;
      const y0 = Math.max(0, y1 - plotH / usable);
      const x0 = col * (colW + colGap);
      const lastRow = row === rows - 1 || i + columns >= n;
      layout[`xaxis${id}`] = axis(lastRow ? xLabel : undefined, {
        type: xDate ? "date" : undefined,
        domain: [x0, x0 + colW],
        anchor: `y${id}`,
        matches: i === 0 ? undefined : "x",
        showticklabels: lastRow,
        range: xRange ?? undefined,
        autorange: xRange ? undefined : true,
        showspikes: tooltip && !scatterOnly,
        spikemode: "across",
        spikesnap: "cursor",
        spikecolor: INK.muted,
        spikethickness: 1,
        spikedash: "solid",
      });
      const yl = p.yLabel ? (p.yLabel.length > 32 ? p.yLabel.slice(0, 31) + "…" : p.yLabel) : undefined;
      layout[`yaxis${id}`] = axis(yl, {
        domain: [y0, y1],
        anchor: `x${id}`,
        type: p.yLog ? "log" : "linear",
        exponentformat: p.yLog ? "power" : undefined,
        dtick: p.yLog ? logStep(p) : undefined,
      });
      if (p.title) {
        annotations.push({
          text: esc(p.title),
          xref: "paper",
          yref: "paper",
          x: x0 + colW,
          y: y1,
          xanchor: "right",
          yanchor: "bottom",
          showarrow: false,
          font: { size: 12, color: INK.secondary },
        });
      }
      const legendKey = i === 0 ? "legend" : `legend${i + 1}`;
      if (legendOn(p)) {
        legends[legendKey] = {
          ...baseLayout().legend,
          x: x0,
          y: y1,
          yanchor: "bottom",
          xref: "paper",
          yref: "paper",
        };
      }
      for (const h of p.hLines ?? []) {
        shapes.push({ type: "line", xref: `x${id} domain`, x0: 0, x1: 1, yref: `y${id}`, y0: h.y, y1: h.y, line: { color: INK.axis, width: 1 }, layer: "below" });
        if (h.label) annotations.push({ text: esc(h.label), xref: `x${id} domain`, yref: `y${id}`, x: 1, y: h.y, xanchor: "right", yanchor: "bottom", showarrow: false, font: { size: 11, color: INK.secondary } });
      }
      for (const v of p.vLines ?? []) {
        shapes.push({
          type: "line",
          xref: `x${id}`,
          x0: v.x,
          x1: v.x,
          yref: `y${id} domain`,
          y0: 0,
          y1: 1,
          line: { color: v.draggable ? INK.primary : INK.muted, width: v.draggable ? 2 : 1 },
          layer: v.draggable ? "above" : "below",
        });
        if (v.label)
          annotations.push({
            text: esc(v.label),
            xref: `x${id}`,
            yref: `y${id} domain`,
            x: v.x,
            y: 1,
            xanchor: "left",
            yanchor: "top",
            xshift: 3,
            showarrow: false,
            bgcolor: "rgba(255,255,255,0.85)",
            font: { size: 11, color: INK.secondary },
          });
      }
      if (p.points?.length) {
        const xs = p.series.flatMap((s) => s.data.map((d) => d[0])).filter((v): v is number => v !== null);
        const span = xs.length ? Math.max(...xs) - Math.min(...xs) || 1 : 1;
        const labelled: number[] = [];
        for (const pt of p.points) {
          if (labelled.length >= 5 || labelled.some((x) => Math.abs(x - pt.x) < span * 0.06)) continue;
          labelled.push(pt.x);
          annotations.push({
            text: esc(pt.label),
            xref: `x${id}`,
            yref: `y${id}`,
            x: pt.x,
            y: p.yLog ? Math.log10(pt.y) : pt.y,
            yanchor: "bottom",
            yshift: 6,
            showarrow: false,
            font: { size: 11, color: INK.secondary },
          });
        }
        data.push({
          type: "scatter",
          mode: "markers",
          name: "Peaks",
          xaxis: `x${id}`,
          yaxis: `y${id}`,
          x: p.points.map((pt) => pt.x),
          y: p.points.map((pt) => pt.y),
          showlegend: false,
          marker: { color: INK.primary, size: MARKER_SIZE, line: { color: INK.surface, width: 2 } },
          hovertemplate: tooltip ? `<b>%{x:.4~g}</b>  peak<extra></extra>` : undefined,
        });
      }
      p.series.forEach((s) => {
        const type = s.type ?? "line";
        const xs = s.data.map((d) => d[0]);
        const ys = s.data.map((d) => d[1]);
        const common = {
          name: esc(s.name),
          xaxis: `x${id}`,
          yaxis: `y${id}`,
          legend: legendKey,
          showlegend: legendOn(p),
          hovertemplate: tooltip ? hoverValue(s.name, xLabel) : undefined,
          hoverinfo: tooltip ? undefined : "skip",
        };
        if (type === "bar") {
          data.push({ ...common, type: "bar", x: xs, y: ys, marker: { color: s.color, cornerradius: 4, line: { color: INK.surface, width: 1 } } });
        } else if (type === "scatter") {
          data.push({
            ...common,
            type: "scattergl",
            mode: "markers",
            x: xs,
            y: ys,
            marker: { color: s.color, size: MARKER_SIZE, opacity: xs.length > 1500 ? 0.55 : 0.9, line: { color: INK.surface, width: 1 } },
          });
        } else {
          const d = decimate(xs, ys, Math.max(MAX_POINTS, target), view);
          data.push({
            ...common,
            type: "scatter",
            mode: "lines",
            x: d.x,
            y: d.y,
            connectgaps: false,
            line: { color: s.color, width: LINE_WIDTH, dash: s.dashed ? "dash" : "solid", shape: "linear" },
          });
        }
      });
    });
    const full: Figure = {
      ...layout,
      ...legends,
      showlegend: Object.keys(legends).length > 0,
      shapes,
      annotations,
      margin: { l: 64, r: 16, t: top, b: bottom, pad: 0 },
      hovermode: !tooltip ? false : scatterOnly ? "closest" : "x unified",
      bargap: 0.08,
      ...(selectable
        ? {
            dragmode: "select",
            selectdirection: "any",
            newselection: { line: { color: INK.secondary, width: 1, dash: "solid" } },
            activeselection: { fillcolor: INK.primary, opacity: 0.06 },
          }
        : {}),
    };
    return { data, layout: full };
  }, [panels, columns, rows, n, size, xLabel, xDate, xRange, tooltip, scatterOnly, view, target, selectable]);

  const table = (): PlotTable => {
    const out: PlotTable = { columns: ["Panel", "Series", xLabel ?? "X", "Y"], rows: [] };
    for (const p of panels) for (const s of p.series) for (const [x, y] of s.data) if (y !== null) out.rows.push([p.yLabel ?? p.title ?? "", s.name, x, y]);
    return out;
  };

  const events = {
    relayout: (e: Record<string, any>) => {
      const shapeKey = Object.keys(e).find((k) => /^shapes\[\d+\]\.x0$/.test(k));
      if (shapeKey) {
        cbs.current.onDragLine?.(Number(e[shapeKey]));
        return;
      }
      let range: [number, number] | null | undefined;
      for (const [k, v] of Object.entries(e)) {
        if (/^xaxis\d*\.autorange$/.test(k) && v) range = null;
        else if (/^xaxis\d*\.range\[0\]$/.test(k)) range = [toNum(v), toNum(e[k.replace("[0]", "[1]")])];
        else if (/^xaxis\d*\.range$/.test(k) && Array.isArray(v)) range = [toNum(v[0]), toNum(v[1])];
      }
      if (range === undefined) return;
      clearTimeout(zoomTimer.current);
      zoomTimer.current = setTimeout(() => {
        setView(range);
        cbs.current.onZoom?.(range);
      }, 140);
    },
    selected: (e: { range?: Record<string, number[]> } | undefined) => {
      const range = e?.range;
      const xKey = range && Object.keys(range).find((k) => /^x\d*$/.test(k));
      if (!range || !xKey) return;
      const id = xKey.slice(1);
      const xr = range[xKey];
      const yr = range[`y${id}`];
      if (!xr || !yr) return;
      const sorted = (v: (number | string)[]): [number, number] => {
        const [a, b] = [toNum(v[0]), toNum(v[1])];
        return [Math.min(a, b), Math.max(a, b)];
      };
      cbs.current.onSelect?.({ panel: id ? Number(id) - 1 : 0, x: sorted(xr), y: sorted(yr) });
    },
    deselect: () => cbs.current.onSelect?.(null),
    hover: (e: { points?: { x: number | string }[] }) => {
      const x = e.points?.[0]?.x;
      if (x !== undefined && Number.isFinite(toNum(x))) cbs.current.onCursor?.(toNum(x));
    },
    click: (e: { event?: MouseEvent }, gd: PlotElement) => {
      if (!e.event || (!cbs.current.onClick && !cbs.current.onDragLine)) return;
      const rect = gd.getBoundingClientRect();
      const px = e.event.clientX - rect.left;
      const py = e.event.clientY - rect.top;
      for (let i = 0; i < n; i++) {
        const xa = gd._fullLayout[`xaxis${axisId(i)}`];
        const ya = gd._fullLayout[`yaxis${axisId(i)}`];
        if (!xa || !ya) continue;
        if (px < xa._offset || px > xa._offset + xa._length || py < ya._offset || py > ya._offset + ya._length) continue;
        const x = xa.p2l(px - xa._offset);
        const y = ya.p2l(py - ya._offset);
        cbs.current.onClick?.(i, x, y);
        if (panels[i].vLines?.some((v) => v.draggable)) cbs.current.onDragLine?.(x);
        return;
      }
    },
  };

  return (
    <div ref={host} className={className ?? "h-full w-full min-h-0"}>
      {n > 0 && (
        <Plot
          data={figure.data}
          layout={figure.layout}
          uirevision={String(resetKey ?? "")}
          table={table}
          events={events}
          config={config}
          select={selectable}
          onInit={(gd) => (gdRef.current = gd)}
        />
      )}
    </div>
  );
}

/** Axis values as numbers; date axes report "2026-10-01 09:00:12.5" strings (UTC). */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v);
  const n = Number(s);
  return Number.isFinite(n) ? n : Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
}

function legendOn(p: ChartPanel) {
  return p.legend ?? p.series.length > 1;
}
