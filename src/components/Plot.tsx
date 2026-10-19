import Plotly from "plotly.js-cartesian-dist-min";
import type { Config, PlotlyHTMLElement } from "plotly.js";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadText } from "@/lib/analysis";
import { baseLayout, fmtG, plotConfig, type Figure } from "@/lib/chart";
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
  /** Zoom and selection survive data updates until this changes. */
  uirevision?: string | number;
  /** Table view; derived from the x/y traces when omitted. */
  table?: PlotTable | (() => PlotTable);
  events?: Partial<Record<"click" | "hover" | "unhover" | "selected" | "deselect" | "relayout", Handler>>;
  className?: string;
  /** Adds the box-select tool for linked selections. */
  select?: boolean;
  onInit?: (gd: PlotElement) => void;
}

const TABLE_LIMIT = 2000;
const MAX_BAR_PX = 24;
const ICONS = {
  back: { width: 24, height: 24, path: "M10 5 3 12l7 7v-4.5c5 0 8.5 1.5 11 5-1-5-4-10-11-11V5z" },
  table: { width: 24, height: 24, path: "M3 4h18v16H3zM5 6v3h6V6zm8 0v3h6V6zM5 11v3h6v-3zm8 0v3h6v-3zM5 16v2h6v-2zm8 0v2h6v-2z" },
};

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
export function Plot({ data, layout, config, uirevision, table, events, className, select, onInit }: Props) {
  const active = useContext(WorkspaceActive);
  const el = useRef<HTMLDivElement>(null);
  const gdRef = useRef<PlotElement | null>(null);
  const handlers = useRef(events);
  handlers.current = events;
  const history = useRef<Record<string, unknown>[]>([]);
  const last = useRef<Record<string, unknown>>({});
  const restoring = useRef(false);
  const [showTable, setShowTable] = useState(false);
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
    const navigation: any[] = [...(select ? ["select2d"] : []), "zoom2d", "pan2d", back, "resetScale2d"];
    return { ...plotConfig, ...config, modeBarButtons: [navigation, [tableButton, "toImage"]] as any };
  }, [config, select]);

  useEffect(() => {
    history.current = [];
  }, [uirevision]);

  useEffect(() => {
    if (!active || !el.current) return;
    const node = el.current;
    const fullLayout = { ...baseLayout(), ...layout, uirevision: uirevision ?? "static" };
    let cancelled = false;
    Plotly.react(node, data as any, fullLayout as any, fullConfig).then((gd) => {
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
      on("plotly_selected", (e) => handlers.current?.selected?.(e, plot));
      on("plotly_deselect", (e) => handlers.current?.deselect?.(e, plot));
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
  }, [data, layout, fullConfig, uirevision, active]);

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
    <div className={cn("relative h-full w-full min-h-0", className)}>
      <div ref={el} className="h-full w-full" />
      {showTable && <TableView table={typeof table === "function" ? table() : (table ?? tableFrom(data))} onClose={() => setShowTable(false)} />}
    </div>
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
