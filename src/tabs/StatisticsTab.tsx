import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Plot } from "@/components/Plot";
import { EmptyState, Field, Panel } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { analysisVectors, summarize, histogram, downloadText, categoryVector, type Categories, type Vectors } from "@/lib/analysis";
import { INK, PALETTE, axis, baseLayout, esc, fmtG, markerStyle, seriesColor, wash } from "@/lib/chart";

const BINS = 30;
/** Longer datasets are thinned to about this many rows, which keeps the page instant. */
const MAX_ROWS = 100_000;
const ROW = "__row";
const NONE = "__none";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fields = ["count", "missing", "mean", "std", "min", "q1", "median", "q3", "max", "iqr"] as const;
const labels = ["n", "Missing", "Mean", "Std dev", "Min", "Q1", "Median", "Q3", "Max", "IQR"];

/** One signal at a glance: how its values spread, how they move, and how they relate to a second signal. */
export function StatisticsTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const loadedRequest = useRef("");
  const [xColumn, setXColumn] = useState(ROW);
  const [yColumn, setYColumn] = useState("");
  const [data, setData] = useState<Vectors | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  /** Text variable the views are split by ("" = none). */
  const [groupBy, setGroupBy] = useState("");
  const [cats, setCats] = useState<Categories | null>(null);

  useEffect(() => {
    // Default to a signal-vs-signal scatter; "by row" already shows the row view.
    setXColumn(dataset?.signals[1]?.column ?? ROW);
    setYColumn(dataset?.signals[0]?.column ?? "");
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
    analysisVectors([...new Set([yColumn, ...(xColumn === ROW ? [] : [xColumn])])], MAX_ROWS)
      .then((v) => {
        if (!cancelled) {
          loadedRequest.current = requestKey;
          setData(v);
        }
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

  const x = useMemo(() => (!data ? [] : xColumn === ROW ? data.time.map((_, i) => i * data.step + 1) : (data.columns[xColumn] ?? [])), [data, xColumn]);
  const y = data?.columns[yColumn] ?? [];
  const xLabel = xColumn === ROW ? "Row position" : (dataset?.signals.find((s) => s.column === xColumn)?.label ?? "X");
  const yLabel = dataset?.signals.find((s) => s.column === yColumn)?.label ?? "Y";

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
    if (groups) groups.names.forEach((g, k) => rows.push({ name: yLabel, scope: g, ...summarize(y.filter((_, i) => groups.of(i) === k)) }));
    if (xColumn !== ROW && xColumn !== yColumn) rows.push({ name: xLabel, scope: "All", ...summarize(x) });
    return rows;
  }, [y, x, xColumn, yColumn, xLabel, yLabel, groups]);

  const charts = useMemo(() => {
    const accent = seriesColor(0);
    const step = Math.max(1, Math.ceil(y.length / 8000));
    const sx: number[] = [];
    const sy: number[] = [];
    const rx: number[] = [];
    const ry: number[] = [];
    for (let i = 0; i < y.length; i += step) {
      if (!finite(y[i])) continue;
      rx.push(i * (data?.step ?? 1) + 1);
      ry.push(y[i] as number);
      if (finite(x[i])) {
        sx.push(x[i] as number);
        sy.push(y[i] as number);
      }
    }
    const points = (xs: number[], ys: number[], xName: string) => ({
      type: "scattergl",
      mode: "markers",
      name: esc(yLabel),
      x: xs,
      y: ys,
      marker: markerStyle(xs.length, accent),
      hovertemplate: `<b>%{y:.6~g}</b>  ${esc(yLabel)}<br><span style="color:${INK.muted}">${esc(xName)} %{x:.6~g}</span><extra></extra>`,
    });
    const yStats = summarize(y);
    const byGroup = (xs: (i: number) => number | null, xName: string) =>
      groups!.names.map((g, k) => {
        const gx: number[] = [];
        const gy: number[] = [];
        for (let i = 0; i < y.length; i += step) {
          const xi = xs(i);
          if (groups!.of(i) === k && finite(y[i]) && finite(xi)) {
            gx.push(xi);
            gy.push(y[i] as number);
          }
        }
        const t = points(gx, gy, xName);
        return { ...t, name: esc(g), marker: { ...t.marker, color: groups!.colors[k] } };
      });
    const allBins = histogram(y, BINS);
    const binWidth = allBins.length > 1 ? allBins[1][0] - allBins[0][0] : 1;
    const bar = (name: string, bins: [number, number][], color: string) => ({
      type: "bar",
      name,
      x: bins.map((b) => b[0]),
      y: bins.map((b) => b[1]),
      width: binWidth,
      marker: { color, cornerradius: 3, line: { color: INK.surface, width: 1 } },
      hovertemplate: `<b>%{y}</b>  rows<br><span style="color:${INK.muted}">${esc(yLabel)} ≈ %{x:.4~g}</span><extra></extra>`,
    });
    const boxRows = (
      groups
        ? groups.names.map((g, k) => ({ name: g, stats: summarize(y.filter((_, i) => groups.of(i) === k)), color: groups.colors[k] }))
        : [{ name: "All", stats: yStats, color: accent }]
    ).filter((r) => r.stats.count > 0);
    const layout = (xTitle: string, yTitle: string | undefined) =>
      baseLayout({ hovermode: "closest", margin: { l: 56, r: 12, t: 12, b: 44 }, xaxis: axis(xTitle), yaxis: axis(yTitle) });
    const legend = { showlegend: true };
    return {
      scatter: groups
        ? { data: byGroup((i) => x[i], xLabel), layout: { ...layout(xLabel, yLabel), ...legend } }
        : { data: [points(sx, sy, xLabel)], layout: layout(xLabel, yLabel) },
      row: groups
        ? { data: byGroup((i) => i * (data?.step ?? 1) + 1, "Row"), layout: { ...layout("Row position", yLabel), ...legend } }
        : { data: [points(rx, ry, "Row")], layout: layout("Row position", yLabel) },
      histogram: groups
        ? {
            data: groups.names.map((g, k) =>
              bar(g, yStats.min !== null ? histogram(y.filter((_, i) => groups.of(i) === k), BINS, [yStats.min, yStats.max!]) : [], groups.colors[k]),
            ),
            layout: { ...layout(yLabel, "Count"), barmode: "stack", bargap: 0, ...legend },
          }
        : { data: [bar("All", allBins, accent)], layout: { ...layout(yLabel, "Count"), barmode: "overlay", bargap: 0, showlegend: false } },
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
  }, [x, y, xLabel, yLabel, groups, data?.step]);

  const revision = `${dataset?.path}|${xColumn}|${yColumn}|${dataVersion}`;
  if (!dataset) return <EmptyState title="No data loaded">Open a data file to explore it.</EmptyState>;

  const exportSummary = () =>
    downloadText(
      "statistics.csv",
      [["Signal", "Scope", ...labels], ...summary.map((r) => [r.name, r.scope, ...fields.map((f) => r[f] ?? "")])]
        .map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
        .join("\r\n"),
      "text/csv",
    );

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
        <Field label="Signal" className="w-[300px]">
          <SignalSelect signals={dataset.signals} value={yColumn} onChange={setYColumn} />
        </Field>
        <Field label="Compare with" className="w-[300px]">
          <Select value={xColumn} onValueChange={setXColumn}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value={ROW}>Row position</SelectItem>
              {dataset.signals.map((s) => (
                <SelectItem key={s.column} value={s.column}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {dataset.texts.length > 0 && (
          <Field label="Group by" className="w-[240px]">
            <Select value={groupBy || NONE} onValueChange={(v) => setGroupBy(v === NONE ? "" : v)}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {dataset.texts.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <span className="text-[12.5px] text-muted-foreground tabular-nums">{y.length.toLocaleString("en-US")} rows{data && data.step > 1 ? ` (every ${data.step}th)` : ""}</span>
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
              <Plot {...charts.scatter} uirevision={`${revision}|scatter`} />
            </Panel>
            <Panel title={`${yLabel} by row`} bodyClassName="p-1">
              <Plot {...charts.row} uirevision={`${revision}|row`} />
            </Panel>
            <Panel title="Histogram" bodyClassName="p-1">
              <Plot {...charts.histogram} zoom={false} uirevision={`${revision}|histogram`} />
            </Panel>
            <Panel title="Quartiles" actions={<span className="text-[12px] text-muted-foreground">Whiskers: min–max</span>} bodyClassName="p-1">
              <Plot
                {...charts.box}
                zoom={false}
                uirevision={revision}
                table={() => ({ columns: ["Scope", ...labels], rows: summary.filter((r) => r.name === yLabel).map((r) => [r.scope, ...fields.map((f) => r[f])]) })}
              />
            </Panel>
          </div>
          <Panel
            title="Summary"
            className="max-h-[220px] shrink-0"
            actions={
              <Button size="icon-xs" variant="ghost" title="Export summary as CSV" onClick={exportSummary}>
                <Download />
              </Button>
            }
            bodyClassName="overflow-auto p-0"
          >
            <table className="w-full text-right text-[12.5px]">
              <thead className="sticky top-0 bg-[#f6f7f9] text-muted-foreground">
                <tr>
                  <th className="p-2 text-left font-medium">Signal</th>
                  <th className="p-2 text-left font-medium">Scope</th>
                  {labels.map((l) => (
                    <th key={l} className="px-2 font-medium">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.map((r, i) => (
                  <tr key={i} className="border-t border-ap-line">
                    <td className="max-w-[200px] truncate p-2 text-left" title={r.name}>
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
