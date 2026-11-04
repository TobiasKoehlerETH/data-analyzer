import Plotly from "plotly.js-dist-min";
import type { Config, PlotlyHTMLElement } from "plotly.js";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { downloadText } from "@/lib/analysis";
import { baseLayout, fmtG, plotConfig, type Figure } from "@/lib/chart";
import { invoke, isTauri, save } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { WorkspaceActive } from "@/lib/workspace";

export type PlotElement = PlotlyHTMLElement & {
  layout: Figure;
  _fullLayout: Record<string, any>;
};

/** Long-format twin of a chart, shown by the table-view button. */
export interface PlotTable {
  columns: string[];
  rows: (string | number | null)[][];
}

type Handler = (event: any, gd: PlotElement) => void;

interface Props {
  data: Figure[];
  layout?: Figure;
  config?: Partial<Config>;
  /** Zoom survives data updates until this changes. */
  uirevision?: string | number;
  /** Table view; derived from the x/y traces when omitted. */
  table?: PlotTable | (() => PlotTable);
  events?: Partial<Record<"click" | "hover" | "unhover" | "relayout", Handler>>;
  className?: string;
  /** False for summary charts (heatmaps, bars, box plots): no zoom, pan or wheel zoom. */
  zoom?: boolean;
  onInit?: (gd: PlotElement) => void;
  /** A click (no drag) on the plot area, with the x value under the pointer. */
  onPickX?: (x: number) => void;
  /** A Shift+drag (or a drag with the select tool) across x, from left to right. */
  onBrushX?: (x0: number, x1: number) => void;
}

/** The x and y axes under a point of the plot area, if any. */
function axesAt(gd: PlotElement, px: number, py: number): { xa: any; ya: any } | null {
  const fl = gd._fullLayout ?? {};
  for (const key of Object.keys(fl).filter((k) => /^xaxis\d*$/.test(k))) {
    const xa = fl[key];
    const ya = fl[`yaxis${key.slice(5)}`] ?? fl[xa?.anchor?.replace("y", "yaxis")];
    if (!xa?._length || !ya?._length) continue;
    if (px >= xa._offset && px <= xa._offset + xa._length && py >= ya._offset && py <= ya._offset + ya._length) return { xa, ya };
  }
  return null;
}

const TABLE_LIMIT = 2000;
const MAX_BAR_PX = 24;
const ICONS = {
  back: { width: 24, height: 24, path: "M10 5 3 12l7 7v-4.5c5 0 8.5 1.5 11 5-1-5-4-10-11-11V5z" },
  table: { width: 24, height: 24, path: "M3 4h18v16H3zM5 6v3h6V6zm8 0v3h6V6zM5 11v3h6v-3zm8 0v3h6v-3zM5 16v2h6v-2zm8 0v2h6v-2z" },
  expand: { width: 24, height: 24, path: "M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z" },
  collapse: { width: 24, height: 24, path: "M8 3h2v7H3V8h5zm6 0h2v5h5v2h-7zM3 14h7v7H8v-5H3zm11 0h7v2h-5v5h-2z" },
  copy: { width: 24, height: 24, path: "M8 3h9l4 4v11h-3v3H5V6h3zm2 2v11h9V8h-3V5zM7 8v11h9v-1h-6V8z" },
  select: { width: 24, height: 24, path: "M4 4h3v2H6v12h1v2H4zm13 0h3v16h-3v-2h1V6h-1zM9 9h6v6H9z" },
};

/** Saves the chart as it is shown (current zoom, current size) as a PNG at twice the screen resolution. */
async function exportPng(gd: PlotElement) {
  try {
    const url = await Plotly.toImage(gd, { format: "png", width: gd.clientWidth, height: gd.clientHeight, scale: 2 });
    if (!isTauri) {
      const a = document.createElement("a");
      a.href = url;
      a.download = "chart.png";
      a.click();
      return;
    }
    const path = await save({ filters: [{ name: "PNG image", extensions: ["png"] }], defaultPath: "chart.png", title: "Export chart as PNG" });
    if (!path) return;
    await invoke("save_image", { path, dataUrl: url });
    toast.success(`Saved ${path.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast.error(`PNG export failed: ${e}`);
  }
}

/** Every font size in a figure layout times k (titles, ticks, legends, annotations). */
function scaleFonts(o: any, k: number): any {
  if (Array.isArray(o)) return o.map((x) => scaleFonts(x, k));
  if (!o || typeof o !== "object") return o;
  const out: any = {};
  for (const [key, v] of Object.entries(o)) {
    if ((key === "font" || key === "tickfont") && v && typeof v === "object") out[key] = { ...(v as object), size: ((v as any).size ?? 12) * k };
    else out[key] = scaleFonts(v, k);
  }
  return out;
}

/** Fixed sizes so every copied chart lands in a slide or a page the same way. */
const COPY = {
  slide: { width: 1600, height: 900, font: 1.5, label: "slide (16:9)" },
  doc: { width: 1300, height: 760, font: 1.25, label: "document" },
};

/**
 * Copies the current view as a PNG for PowerPoint or Word: a fixed size and fonts scaled to it,
 * so charts pasted from different pages match. Falls back to saving a file.
 */
async function copyChart(gd: PlotElement, kind: keyof typeof COPY) {
  const c = COPY[kind];
  const layout = scaleFonts(JSON.parse(JSON.stringify(gd.layout)), c.font);
  const m = layout.margin ?? {};
  layout.margin = { ...m, l: (m.l ?? 64) * c.font, r: (m.r ?? 16) * c.font, t: (m.t ?? 8) * c.font + 8, b: (m.b ?? 44) * c.font };
  Object.assign(layout, { width: c.width, height: c.height, paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff", font: { ...(layout.font ?? {}), size: (layout.font?.size ?? 12) * c.font } });
  try {
    const url = await Plotly.toImage({ data: gd.data, layout } as any, { format: "png", width: c.width, height: c.height, scale: 2 });
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success(`Chart copied for a ${c.label}: paste it into PowerPoint or Word`);
    } catch {
      // No image clipboard here: save the same picture instead.
      const path = isTauri ? await save({ filters: [{ name: "PNG image", extensions: ["png"] }], defaultPath: `chart-${kind}.png`, title: "Save chart" }) : null;
      if (path) {
        await invoke("save_image", { path, dataUrl: url });
        toast.success(`Saved ${path.split(/[\\/]/).pop()}`);
      } else if (!isTauri) {
        const a = document.createElement("a");
        a.href = url;
        a.download = `chart-${kind}.png`;
        a.click();
      }
    }
  } catch (e) {
    toast.error(`Copy failed: ${e}`);
  }
}

function tableFrom(data: Figure[]): PlotTable {
  const rows: (string | number | null)[][] = [];
  for (const t of data as any[]) {
    if (!Array.isArray(t.x) || !Array.isArray(t.y) || t.showlegend === false && t.hoverinfo === "skip") continue;
    const name = String(t.name ?? "");
    for (let i = 0; i < Math.min(t.x.length, t.y.length); i++) if (t.y[i] != null) rows.push([name, t.x[i], t.y[i]]);
  }
  return { columns: ["Series", "X", "Y"], rows };
}

/** Category bars stay ≤ 24px thick so the band's leftover reads as air. */
function capBars(gd: PlotElement) {
  const fullData = (gd as any)._fullData as any[] | undefined;
  if (!fullData) return;
  const idx: number[] = [];
  const widths: number[] = [];
  fullData.forEach((t, i) => {
    if (t.type !== "bar" || t.orientation === "h") return;
    const xa = gd._fullLayout[t.xaxis === "x" ? "xaxis" : `xaxis${t.xaxis.slice(1)}`];
    if (!xa || xa.type !== "category" || !xa._length) return;
    const unitPx = xa._length / Math.abs(xa.range[1] - xa.range[0]);
    const width = Math.min(0.8, MAX_BAR_PX / unitPx);
    const current = (gd.data[i] as any)?.width;
    if (typeof current !== "number" || Math.abs(current - width) > 1e-3) {
      idx.push(i);
      widths.push(width);
    }
  });
  if (idx.length) Plotly.restyle(gd, { width: widths } as any, idx);
}

function ranges(gd: PlotElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ax] of Object.entries(gd._fullLayout ?? {})) {
    if (/^[xy]axis\d*$/.test(key) && ax?.range) out[`${key}.range`] = [...ax.range];
  }
  return out;
}

/** Plotly wrapper: renders with the shared theme, resizes with its box and adds Back and Table view. */
export function Plot({ data, layout, config, uirevision, table, events, className, zoom = true, onInit, onPickX, onBrushX }: Props) {
  const picks = useRef({ onPickX, onBrushX });
  picks.current = { onPickX, onBrushX };
  /** The select tool: a plain drag marks a range instead of zooming. */
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  selectingRef.current = selecting;
  const [band, setBand] = useState<{ left: number; width: number; top: number; height: number } | null>(null);
  const active = useContext(WorkspaceActive);
  const el = useRef<HTMLDivElement>(null);
  const gdRef = useRef<PlotElement | null>(null);
  const handlers = useRef(events);
  handlers.current = events;
  const history = useRef<Record<string, unknown>[]>([]);
  const last = useRef<Record<string, unknown>>({});
  const restoring = useRef(false);
  const [showTable, setShowTable] = useState(false);
  /** The chart fills the window (Esc or the toolbar button returns it to its panel). */
  const [full, setFull] = useState(false);
  const initialised = useRef(false);

  const fullConfig = useMemo<Partial<Config>>(() => {
    const back = {
      name: "back",
      title: "Previous view",
      icon: ICONS.back,
      click: () => {
        const gd = gdRef.current;
        const prev = history.current.pop();
        if (!gd || !prev) return;
        restoring.current = true;
        Plotly.relayout(gd, prev).finally(() => {
          restoring.current = false;
          last.current = ranges(gd);
        });
      },
    };
    const tableButton = { name: "table", title: "Show data as table", icon: ICONS.table, click: () => setShowTable((v) => !v) };
    const copy = {
      name: "copy",
      title: "Copy for PowerPoint (Shift+click: for Word)",
      icon: ICONS.copy,
      click: (_gd: unknown, ev: MouseEvent) => gdRef.current && copyChart(gdRef.current, ev?.shiftKey ? "doc" : "slide"),
    };
    const png = { name: "png", title: "Export current view as PNG", icon: (Plotly as any).Icons.camera, click: () => gdRef.current && exportPng(gdRef.current) };
    const selectButton = {
      name: "select",
      title: selecting ? "Select tool on: drag marks a range (click to go back to zoom)" : "Select a time range (or Shift+drag)",
      icon: ICONS.select,
      click: () => setSelecting((v) => !v),
    };
    const fullButton = { name: "full", title: full ? "Back to panel (Esc)" : "Open in full window", icon: full ? ICONS.collapse : ICONS.expand, click: () => setFull((v) => !v) };
    const navigation: any[] = ["zoom2d", "pan2d", ...(onBrushX ? [selectButton] : []), back, "resetScale2d"];
    return {
      ...plotConfig,
      ...(zoom ? {} : { scrollZoom: false, doubleClick: false as const }),
      ...config,
      modeBarButtons: [...(zoom ? [navigation] : []), [tableButton, copy, png, fullButton]] as any,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, zoom, full, selecting, !!onBrushX]);

  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [full]);

  useEffect(() => {
    history.current = [];
  }, [uirevision]);

  // Middle-button drag always pans, whatever tool the toolbar has selected.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let drag: { x: number; y: number; xa: any; ya: any; x0: number[]; y0: number[] } | null = null;
    let frame = 0;
    let pending: MouseEvent | null = null;
    const apply = () => {
      frame = 0;
      const gd = gdRef.current;
      const e = pending;
      if (!gd || !drag || !e) return;
      const { xa, ya } = drag;
      const dx = ((e.clientX - drag.x) / xa._length) * (drag.x0[1] - drag.x0[0]);
      const dy = ((e.clientY - drag.y) / ya._length) * (drag.y0[1] - drag.y0[0]);
      const update: Record<string, unknown> = {};
      if (xa.fixedrange !== true) update[`${xa._name}.range`] = drag.x0.map((v) => xa.l2r(v - dx));
      if (ya.fixedrange !== true) update[`${ya._name}.range`] = drag.y0.map((v) => ya.l2r(v + dy));
      Plotly.relayout(gd, update);
    };
    const move = (e: MouseEvent) => {
      pending = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      cancelAnimationFrame(frame);
      frame = 0;
      if (drag) {
        restoring.current = false;
        drag = null;
      }
    };
    const down = (e: MouseEvent) => {
      const gd = gdRef.current;
      if (e.button !== 1 || !gd) return;
      const rect = gd.getBoundingClientRect();
      const hit = axesAt(gd, e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      // One history entry per pan, not one per mouse move.
      history.current.push(ranges(gd));
      restoring.current = true;
      drag = { x: e.clientX, y: e.clientY, xa: hit.xa, ya: hit.ya, x0: hit.xa.range.map(hit.xa.r2l), y0: hit.ya.range.map(hit.ya.r2l) };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
    // Stops the browser's middle-click autoscroll.
    const aux = (e: MouseEvent) => e.button === 1 && e.preventDefault();
    node.addEventListener("mousedown", down, true);
    node.addEventListener("auxclick", aux);
    return () => {
      node.removeEventListener("mousedown", down, true);
      node.removeEventListener("auxclick", aux);
      up();
    };
  }, []);

  // Click = pick a moment (linked cursor); Shift+drag or the select tool = mark a range.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let start: { x: number; y: number; xa: any; top: number; height: number; brush: boolean } | null = null;
    const local = (e: MouseEvent) => {
      const r = gdRef.current!.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    const move = (e: MouseEvent) => {
      if (!start?.brush) return;
      const { px } = local(e);
      const lo = Math.max(start.xa._offset, Math.min(start.x, px));
      const hi = Math.min(start.xa._offset + start.xa._length, Math.max(start.x, px));
      setBand({ left: lo, width: hi - lo, top: start.top, height: start.height });
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      const s0 = start;
      start = null;
      setBand(null);
      if (!s0 || !gdRef.current) return;
      const { px, py } = local(e);
      const xa = s0.xa;
      if (s0.brush) {
        const a = Math.max(xa._offset, Math.min(s0.x, px)) - xa._offset;
        const b = Math.min(xa._offset + xa._length, Math.max(s0.x, px)) - xa._offset;
        if (b - a > 3) picks.current.onBrushX?.(xa.p2l(a), xa.p2l(b));
        return;
      }
      if (Math.hypot(px - s0.x, py - s0.y) < 4) picks.current.onPickX?.(xa.p2l(px - xa._offset));
    };
    const down = (e: MouseEvent) => {
      const gd = gdRef.current;
      if (e.button !== 0 || !gd || (e.target as HTMLElement).closest(".modebar")) return;
      if (!picks.current.onPickX && !picks.current.onBrushX) return;
      const { px, py } = local(e);
      const hit = axesAt(gd, px, py);
      if (!hit) return;
      const brush = !!picks.current.onBrushX && (e.shiftKey || selectingRef.current);
      if (brush) {
        // The range replaces Plotly's own drag (zoom) for this gesture.
        e.preventDefault();
        e.stopPropagation();
      }
      const ys = Object.keys(gd._fullLayout).filter((k) => /^yaxis\d*$/.test(k)).map((k) => gd._fullLayout[k]);
      const top = Math.min(...ys.map((a) => a._offset ?? Infinity));
      const bottom = Math.max(...ys.map((a) => (a._offset ?? 0) + (a._length ?? 0)));
      start = { x: px, y: py, xa: hit.xa, top, height: bottom - top, brush };
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
    };
    node.addEventListener("mousedown", down, true);
    return () => {
      node.removeEventListener("mousedown", down, true);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  useEffect(() => {
    if (!active || !el.current) return;
    const node = el.current;
    const fullLayout: Record<string, any> = { ...baseLayout(), ...layout, uirevision: uirevision ?? "static" };
    if (!zoom) {
      fullLayout.dragmode = false;
      for (const k of ["xaxis", "yaxis", ...Object.keys(fullLayout).filter((key) => /^[xy]axis\d+$/.test(key))]) {
        fullLayout[k] = { ...(fullLayout[k] ?? {}), fixedrange: true };
      }
    }
    let cancelled = false;
    // No hover tooltips: hover events still fire (cursor readouts, click-to-exclude), but nothing pops up.
    const quiet = data.map((t) => ({ ...t, hoverinfo: "none", hovertemplate: undefined }));
    Plotly.react(node, quiet as any, fullLayout as any, fullConfig).then((gd) => {
      if (cancelled) return;
      const plot = gd as PlotElement;
      gdRef.current = plot;
      last.current = ranges(plot);
      capBars(plot);
      if (initialised.current) return;
      initialised.current = true;
      const on = (name: string, fn: (e: any) => void) => (plot as any).on(name, fn);
      on("plotly_click", (e) => handlers.current?.click?.(e, plot));
      on("plotly_hover", (e) => handlers.current?.hover?.(e, plot));
      on("plotly_unhover", (e) => handlers.current?.unhover?.(e, plot));
      on("plotly_relayout", (e: Record<string, unknown>) => {
        const zoomed = Object.keys(e).some((k) => /^[xy]axis\d*\.(range|autorange)/.test(k));
        if (zoomed && !restoring.current) {
          history.current.push(last.current);
          if (history.current.length > 50) history.current.shift();
        }
        last.current = ranges(plot);
        handlers.current?.relayout?.(e, plot);
      });
      onInit?.(plot);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, fullConfig, uirevision, active, zoom]);

  useEffect(() => {
    if (!active || !el.current) return;
    const node = el.current;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const gd = gdRef.current;
        if (gd && node.clientWidth > 0 && node.clientHeight > 0) Promise.resolve(Plotly.Plots.resize(node) as unknown).then(() => capBars(gd));
      });
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active]);

  const mounted = useRef(false);
  useEffect(() => {
    const node = el.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Deferred so Plotly's pending auto-margin redraw never runs against a purged graph;
      // skipped when React remounts the same node (StrictMode).
      setTimeout(() => {
        if (mounted.current || !node) return;
        Plotly.purge(node);
        gdRef.current = null;
        initialised.current = false;
      }, 1000);
    };
  }, []);

  return (
    <>
      {full && <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setFull(false)} title="Click to close" aria-hidden />}
      <div
        className={cn(
          full ? "fixed inset-6 z-50 flex flex-col rounded-lg border border-ap-line bg-white shadow-2xl" : "relative h-full w-full min-h-0",
          !full && className,
        )}
        role={full ? "dialog" : undefined}
        aria-label={full ? "Chart in full window" : undefined}
      >
        {/* The plot node stays the same element in both modes, so the chart keeps its zoom. */}
        {full && (
          <div className="flex shrink-0 items-center gap-2 border-b border-ap-line px-3 py-2">
            <span className="text-[12.5px] text-muted-foreground">Esc or click outside to close</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => gdRef.current && exportPng(gdRef.current)} title="Export current view as PNG">
              <Download /> PNG
            </Button>
            <Button size="sm" onClick={() => setFull(false)} title="Close full window (Esc)" autoFocus>
              <X /> Close
            </Button>
          </div>
        )}
        <div className={cn("relative", full ? "min-h-0 w-full flex-1" : "h-full w-full", selecting && "[&_.nsewdrag]:!cursor-crosshair")}>
          <div ref={el} className={full ? "h-full w-full p-2" : "h-full w-full"} />
          {band && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 border-x-2 border-ap-darkblue/60 bg-ap-darkblue/10"
              style={{ left: band.left, width: band.width, top: band.top, height: band.height }}
            />
          )}
        </div>
        {showTable && <TableView table={typeof table === "function" ? table() : (table ?? tableFrom(data))} onClose={() => setShowTable(false)} />}
      </div>
    </>
  );
}

function cell(v: string | number | null) {
  return typeof v === "number" ? fmtG(v) : (v ?? "—");
}

function TableView({ table, onClose }: { table: PlotTable; onClose: () => void }) {
  const csv = () =>
    downloadText(
      "plot-data.csv",
      [table.columns, ...table.rows].map((r) => r.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n"),
      "text/csv",
    );
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-white" role="region" aria-label="Plot data table">
      <div className="flex items-center gap-2 border-b border-ap-line px-2 py-1 text-xs text-muted-foreground">
        <span>
          {table.rows.length > TABLE_LIMIT
            ? `First ${TABLE_LIMIT.toLocaleString()} of ${table.rows.length.toLocaleString()} rows`
            : `${table.rows.length.toLocaleString()} rows`}
        </span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={csv} title="Download all rows as CSV">
          <Download className="size-3.5" /> CSV
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={onClose} title="Back to chart" aria-label="Close table">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto">
        <table className="w-full text-right text-xs tabular-nums">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {table.columns.map((c, i) => (
                <th key={i} className={cn("px-2 py-1.5 font-normal", i === 0 && "text-left")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, TABLE_LIMIT).map((r, i) => (
              <tr key={i} className="border-t border-ap-line">
                {r.map((v, j) => (
                  <td key={j} className={cn("px-2 py-1", j === 0 && "max-w-[240px] truncate text-left")}>
                    {cell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
