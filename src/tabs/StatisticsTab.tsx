import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import { Plot } from "@/components/Plot";
import { EmptyState, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import {
  analysisVectors,
  summarize,
  histogram,
  downloadText,
  categoryVector,
  type Categories,
  matchingRows,
  type PlotSelection,
  type Vectors,
} from "@/lib/analysis";
import { INK, MARKER_SIZE, PALETTE, axis, baseLayout, esc, fmtG, seriesColor, wash } from "@/lib/chart";

type Selection = PlotSelection | null;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const fields = [
  "count",
  "missing",
  "mean",
  "std",
  "min",
  "q1",
  "median",
  "q3",
  "max",
  "iqr",
] as const;
const labels = [
  "n",
  "Missing",
  "Mean",
  "Std dev",
  "Min",
  "Q1",
  "Median",
  "Q3",
  "Max",
  "IQR",
];

export function StatisticsTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const loadedRequest = useRef("");
  const [xColumn, setXColumn] = useState("__row");
  const [yColumn, setYColumn] = useState("");
  const [data, setData] = useState<Vectors | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState("");
  const [bins, setBins] = useState(30);
  const [loading, setLoading] = useState(false);
  /** Bumping a chart's epoch clears its drawn selection box (another chart now owns the selection). */
  const [epoch, setEpoch] = useState({ scatter: 0, row: 0, histogram: 0 });
  /** Text variable the views are split by ("" = none). */
  const [groupBy, setGroupBy] = useState("");
  const [cats, setCats] = useState<Categories | null>(null);
  useEffect(() => {
    // Default to a signal-vs-signal scatter; "by row" already shows the row view.
    setXColumn(dataset?.signals[1]?.column ?? "__row");
    setYColumn(dataset?.signals[0]?.column ?? "");
    setSelection(null);
    setData(null);
    setGroupBy("");
  }, [dataset?.path, dataset?.sheet]);
  useEffect(() => {
    if (!groupBy || activeTab !== "statistics") {
      if (!groupBy) setCats(null);
      return;
    }
    let cancelled = false;
    categoryVector(groupBy)
      .then((c) => !cancelled && setCats(c))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [groupBy, dataVersion, activeTab]);
  useEffect(() => {
    if (!dataset || !yColumn || activeTab !== "statistics") return;
    const requestKey = JSON.stringify([dataset.path, dataset.sheet, dataVersion, yColumn, xColumn]);
    if (loadedRequest.current === requestKey && data) return;
    let cancelled = false;
    setError("");
    setLoading(true);
    setSelection(null);
    analysisVectors([
      ...new Set([yColumn, ...(xColumn === "__row" ? [] : [xColumn])]),
    ])
      .then((v) => {
        if (!cancelled) { loadedRequest.current = requestKey; setData(v); }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, dataset, yColumn, xColumn, activeTab]);
  const x = useMemo(
    () =>
      !data
        ? []
        : xColumn === "__row"
          ? data.time.map((_, i) => i + 1)
          : (data.columns[xColumn] ?? []),
    [data, xColumn],
  );
  const y = data?.columns[yColumn] ?? [];
  const xLabel =
    xColumn === "__row"
      ? "Row position"
      : (dataset?.signals.find((s) => s.column === xColumn)?.label ?? "X");
  const yLabel =
    dataset?.signals.find((s) => s.column === yColumn)?.label ?? "Y";
  const selectedRows = useMemo(() => {
    if (!selection) return null;
    return matchingRows(x, y, selection);
  }, [selection, x, y]);
  const selectedY = useMemo(
    () => (selectedRows ? [...selectedRows].map((i) => y[i]) : y),
    [y, selectedRows],
  );
  const selectedX = useMemo(
    () => (selectedRows ? [...selectedRows].map((i) => x[i]) : x),
    [x, selectedRows],
  );
  /** Groups by size: the largest get palette slots, the rest share "Other" (gray). */
  const groups = useMemo(() => {
    if (!cats || cats.codes.length !== y.length) return null;
    const counts = cats.levels.map(() => 0);
    for (const c of cats.codes) if (c >= 0) counts[c]++;
    const order = cats.levels.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);
    const keep = order.length > PALETTE.length ? order.slice(0, PALETTE.length - 1) : order;
    const slot = new Map(keep.map((lvl, k) => [lvl, k]));
    const other = order.length > keep.length ? keep.length : -1;
    const names = [...keep.map((l) => cats.levels[l]), ...(other >= 0 ? ["Other"] : [])];
    const colors = names.map((_, k) => (k === other ? INK.muted : seriesColor(k)));
    const of = (i: number) => {
      const c = cats.codes[i];
      return c < 0 ? -1 : (slot.get(c) ?? other);
    };
    return { names, colors, of };
  }, [cats, y.length]);
  const summary = useMemo(() => {
    const rows = [{ name: yLabel, scope: "All", ...summarize(y) }];
    if (groups)
      groups.names.forEach((g, k) => rows.push({ name: yLabel, scope: g, ...summarize(y.filter((_, i) => groups.of(i) === k)) }));
    if (xColumn !== "__row" && xColumn !== yColumn)
      rows.push({ name: xLabel, scope: "All", ...summarize(x) });
    if (selectedRows) {
      rows.push({ name: yLabel, scope: "Selected", ...summarize(selectedY) });
      if (xColumn !== "__row" && xColumn !== yColumn)
        rows.push({ name: xLabel, scope: "Selected", ...summarize(selectedX) });
    }
    return rows;
  }, [
    y,
    x,
    selectedY,
    selectedX,
    xColumn,
    yColumn,
    xLabel,
    yLabel,
    selectedRows,
    groups,
  ]);
  const charts = useMemo(() => {
    const accent = seriesColor(0);
    const step = Math.max(1, Math.ceil(y.length / 8000));
    const sx: number[] = [], sy: number[] = [], sc: string[] = [];
    const rx: number[] = [], ry: number[] = [], rc: string[] = [];
    for (let i = 0; i < y.length; i += step) {
      const color = selectedRows && !selectedRows.has(i) ? INK.faded : accent;
      if (!finite(y[i])) continue;
      rx.push(i + 1); ry.push(y[i] as number); rc.push(color);
      if (finite(x[i])) { sx.push(x[i] as number); sy.push(y[i] as number); sc.push(color); }
    }
    const dense = (n: number) => (n > 3000 ? 0.45 : n > 800 ? 0.7 : 0.9);
    const marker = (colors: string[]) => ({
      color: colors,
      size: MARKER_SIZE,
      opacity: dense(colors.length),
      line: { color: INK.surface, width: 1 },
    });
    const keep = { selected: { marker: { opacity: 1 } }, unselected: { marker: { opacity: 1 } } } as const;
    const points = (xs: number[], ys: number[], colors: string[], xName: string) => ({
      type: "scattergl",
      mode: "markers",
      name: esc(yLabel),
      x: xs,
      y: ys,
      marker: marker(colors),
      ...keep,
      hovertemplate: `<b>%{y:.6~g}</b>  ${esc(yLabel)}<br><span style="color:${INK.muted}">${esc(xName)} %{x:.6~g}</span><extra></extra>`,
    });
    const allBins = histogram(y, bins);
    const yStats = summarize(y);
    // Grouped views (no selection): one coloured trace per group.
    const grouped = groups && !selectedRows;
    const byGroup = (xs: (i: number) => number | null) =>
      groups!.names.map((g, k) => {
        const gx: number[] = [], gy: number[] = [];
        for (let i = 0; i < y.length; i += step) {
          const xi = xs(i);
          if (groups!.of(i) === k && finite(y[i]) && finite(xi)) { gx.push(xi); gy.push(y[i] as number); }
        }
        const t = points(gx, gy, gx.map(() => groups!.colors[k]), xLabel);
        return { ...t, name: esc(g), marker: { ...t.marker, color: groups!.colors[k] } };
      });
    const selectedBins = selectedRows && yStats.min !== null ? histogram(selectedY, bins, [yStats.min, yStats.max!]) : [];
    const binWidth = allBins.length > 1 ? allBins[1][0] - allBins[0][0] : 1;
    const bar = (name: string, bins: [number, number][], color: string) => ({
      type: "bar",
      name,
      x: bins.map((b) => b[0]),
      y: bins.map((b) => b[1]),
      width: binWidth,
      marker: { color, cornerradius: 3, line: { color: INK.surface, width: 1 } },
      ...keep,
      hovertemplate: `<b>%{y}</b>  ${name.toLowerCase()} rows<br><span style="color:${INK.muted}">${esc(yLabel)} ≈ %{x:.4~g}</span><extra></extra>`,
    });
    const boxRows = (
      grouped
        ? groups!.names.map((g, k) => ({ name: g, stats: summarize(y.filter((_, i) => groups!.of(i) === k)), color: groups!.colors[k] }))
        : [
            { name: "All", stats: yStats, color: selectedRows ? INK.muted : accent },
            ...(selectedRows ? [{ name: "Selected", stats: summarize(selectedY), color: accent }] : []),
          ]
    ).filter((r) => r.stats.count > 0);
    const selectLayout = (xTitle: string, yTitle: string | undefined, direction: "any" | "h") =>
      baseLayout({
        dragmode: "select",
        selectdirection: direction,
        hovermode: "closest",
        newselection: { line: { color: INK.secondary, width: 1, dash: "solid" } },
        activeselection: { fillcolor: accent, opacity: 0.08 },
        margin: { l: 56, r: 12, t: 12, b: 44 },
        xaxis: axis(xTitle),
        yaxis: axis(yTitle),
      });
    const legend = { showlegend: true };
    return {
      scatter: grouped
        ? { data: byGroup((i) => x[i]), layout: { ...selectLayout(xLabel, yLabel, "any"), ...legend } }
        : { data: [points(sx, sy, sc, xLabel)], layout: selectLayout(xLabel, yLabel, "any") },
      row: grouped
        ? { data: byGroup((i) => i + 1), layout: { ...selectLayout("Row position", yLabel, "h"), ...legend } }
        : { data: [points(rx, ry, rc, "Row")], layout: selectLayout("Row position", yLabel, "h") },
      histogram: grouped
        ? {
            // Stacked by group on shared bins.
            data: groups!.names.map((g, k) =>
              bar(g, yStats.min !== null ? histogram(y.filter((_, i) => groups!.of(i) === k), bins, [yStats.min, yStats.max!]) : [], groups!.colors[k]),
            ),
            layout: { ...selectLayout(yLabel, "Count", "h"), barmode: "stack", bargap: 0, ...legend },
          }
        : {
            data: [bar("All", allBins, selectedRows ? INK.faded : accent), ...(selectedRows ? [bar("Selected", selectedBins, accent)] : [])],
            layout: { ...selectLayout(yLabel, "Count", "h"), barmode: "overlay", bargap: 0, showlegend: !!selectedRows },
          },
      box: {
        data: boxRows.map((r) => ({
          type: "box",
          name: r.name,
          x: [r.name],
          q1: [r.stats.q1],
          median: [r.stats.median],
          q3: [r.stats.q3],
          lowerfence: [r.stats.min],
          upperfence: [r.stats.max],
          width: 0.18,
          line: { color: r.color, width: 2 },
          fillcolor: wash(r.color),
          hoverinfo: "y",
        })),
        layout: baseLayout({
          hovermode: "closest",
          margin: { l: 56, r: 12, t: 12, b: 32 },
          xaxis: axis(undefined, { type: "category", showgrid: false, range: [-0.9, boxRows.length - 0.1], tickfont: { size: 12, color: INK.secondary } }),
          yaxis: axis(yLabel),
        }),
      },
    };
  }, [x, y, xLabel, yLabel, bins, selectedRows, selectedY, groups]);
  const select = (kind: NonNullable<Selection>["kind"]) => ({
    selected: (event: { range?: { x?: number[]; y?: number[] } } | undefined) => {
      const range = event?.range;
      if (!range?.x) return;
      const sorted = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];
      setEpoch((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, k === kind ? v : v + 1])) as typeof e);
      setSelection({ kind, x: sorted(range.x), ...(kind === "scatter" && range.y ? { y: sorted(range.y) } : {}) });
    },
    deselect: () => setSelection((s) => (s?.kind === kind ? null : s)),
  });
  const clear = () => {
    setSelection(null);
    setEpoch((e) => ({ scatter: e.scatter + 1, row: e.row + 1, histogram: e.histogram + 1 }));
  };
  const revision = `${dataset?.path}|${xColumn}|${yColumn}|${dataVersion}`;
  if (!dataset)
    return (
      <EmptyState title="No data loaded">
        Open a data file to explore it.
      </EmptyState>
    );
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto">
      <div className="flex shrink-0 items-end gap-3">
        <label className="analysis-field w-[240px]">
          X
          <select value={xColumn} onChange={(e) => setXColumn(e.target.value)}>
            <option value="__row">Row position</option>
            {dataset.signals.map((s) => (
              <option key={s.column} value={s.column}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="analysis-field w-[240px]">
          Y
          <select value={yColumn} onChange={(e) => setYColumn(e.target.value)}>
            {dataset.signals.map((s) => (
              <option key={s.column} value={s.column}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {dataset.texts.length > 0 && (
          <label className="analysis-field w-[200px]">
            Group by
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">None</option>
              {dataset.texts.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!selection}
          onClick={clear}
          title="Clear the linked selection"
        >
          <RotateCcw className="size-3.5" />
          Clear selection
        </Button>
        <span className="pb-2 text-xs text-muted-foreground">
          {selectedRows
            ? `${selectedRows.size.toLocaleString()} selected`
            : `${y.length.toLocaleString()} rows`}
        </span>
        <span
          className="ml-auto pb-2 text-xs text-muted-foreground"
          title="Brush any plot to select matching rows in every view. Statistics use full data; scatter previews show up to 8,000 points."
        >
          Drag to select
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : !data ? (
        <EmptyState title="Loading…" />
      ) : (
        <>
          <div className={`grid min-h-[480px] flex-1 grid-cols-2 grid-rows-2 gap-3 transition-opacity ${loading ? "opacity-50" : ""}`}>
            <Panel title={`${yLabel} vs ${xLabel}`} bodyClassName="p-1">
              <Plot {...charts.scatter} select uirevision={`${revision}|${epoch.scatter}`} events={select("scatter")} />
            </Panel>
            <Panel title={`${yLabel} by row`} bodyClassName="p-1">
              <Plot {...charts.row} select uirevision={`${revision}|${epoch.row}`} events={select("row")} />
            </Panel>
            <Panel
              title="Distribution"
              actions={
                <label className="flex items-center gap-1 text-xs">
                  Bins
                  <input
                    aria-label="Histogram bins"
                    className="analysis-input w-14"
                    type="number"
                    min={5}
                    max={100}
                    value={bins}
                    onChange={(e) =>
                      setBins(
                        Math.max(5, Math.min(100, Number(e.target.value) || 5)),
                      )
                    }
                  />
                </label>
              }
              bodyClassName="p-1"
            >
              <Plot {...charts.histogram} select uirevision={`${revision}|${epoch.histogram}`} events={select("histogram")} />
            </Panel>
            <Panel
              title="Quartiles"
              actions={
                <span className="text-[11px] text-muted-foreground">
                  Whiskers: min–max
                </span>
              }
              bodyClassName="p-1"
            >
              <Plot
                {...charts.box}
                uirevision={revision}
                table={() => ({ columns: ["Scope", ...labels], rows: summary.filter((r) => r.name === yLabel).map((r) => [r.scope, ...fields.map((f) => r[f])]) })}
              />
            </Panel>
          </div>
          <Panel
            title="Summary"
            className="max-h-[210px] shrink-0"
            actions={
              <Button
                size="sm"
                variant="ghost"
                title="Export summary CSV"
                onClick={() =>
                  downloadText(
                    "statistics.csv",
                    [
                      ["Signal", "Scope", ...labels],
                      ...summary.map((r) => [
                        r.name,
                        r.scope,
                        ...fields.map((f) => r[f] ?? ""),
                      ]),
                    ]
                      .map((row) =>
                        row
                          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
                          .join(","),
                      )
                      .join("\r\n"),
                    "text/csv",
                  )
                }
              >
                <Download className="size-3.5" />
              </Button>
            }
            bodyClassName="overflow-auto p-0"
          >
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="p-2 text-left">Signal</th>
                  <th className="p-2 text-left">Scope</th>
                  {labels.map((l) => (
                    <th key={l} className="px-2">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-t ${r.scope === "Selected" ? "text-ap-red" : ""}`}
                  >
                    <td
                      className="max-w-[200px] truncate p-2 text-left"
                      title={r.name}
                    >
                      {r.name}
                    </td>
                    <td className="p-2 text-left">{r.scope}</td>
                    {fields.map((f) => (
                      <td key={f} className="px-2 tabular-nums">
                        {r[f] === null ? "—" : fmtG(r[f]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
