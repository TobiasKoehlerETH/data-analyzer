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
}

const TABLE_LIMIT = 2000;
const MAX_BAR_PX = 24;
const ICONS = {
  back: { width: 24, height: 24, path: "M10 5 3 12l7 7v-4.5c5 0 8.5 1.5 11 5-1-5-4-10-11-11V5z" },
  table: { width: 24, height: 24, path: "M3 4h18v16H3zM5 6v3h6V6zm8 0v3h6V6zM5 11v3h6v-3zm8 0v3h6v-3zM5 16v2h6v-2zm8 0v2h6v-2z" },
  expand: { width: 24, height: 24, path: "M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z" },
  collapse: { width: 24, height: 24, path: "M8 3h2v7H3V8h5zm6 0h2v5h5v2h-7zM3 14h7v7H8v-5H3zm11 0h7v2h-5v5h-2z" },
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
export function Plot({ data, layout, config, uirevision, table, events, className, zoom = true, onInit }: Props) {
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
    const png = { name: "png", title: "Export current view as PNG", icon: (Plotly as any).Icons.camera, click: () => gdRef.current && exportPng(gdRef.current) };
    const fullButton = { name: "full", title: full ? "Back to panel (Esc)" : "Open in full window", icon: full ? ICONS.collapse : ICONS.expand, click: () => setFull((v) => !v) };
    const navigation: any[] = ["zoom2d", "pan2d", back, "resetScale2d"];
    return {
      ...plotConfig,
      ...(zoom ? {} : { scrollZoom: false, doubleClick: false as const }),
      ...config,
      modeBarButtons: [...(zoom ? [navigation] : []), [tableButton, png, fullButton]] as any,
    };
  }, [config, zoom, full]);

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
    const axesAt = (gd: PlotElement, px: number, py: number) => {
      const fl = gd._fullLayout ?? {};
      for (const key of Object.keys(fl).filter((k) => /^xaxis\d*$/.test(k))) {
        const xa = fl[key];
        const ya = fl[`yaxis${key.slice(5)}`] ?? fl[xa?.anchor?.replace("y", "yaxis")];
        if (!xa?._length || !ya?._length) continue;
        if (px >= xa._offset && px <= xa._offset + xa._length && py >= ya._offset && py <= ya._offset + ya._length) return { xa, ya };
      }
      return null;
    };
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
        <div ref={el} className={full ? "min-h-0 w-full flex-1 p-2" : "h-full w-full"} />
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
