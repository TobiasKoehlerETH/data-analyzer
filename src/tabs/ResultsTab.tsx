import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, Download, ListPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, NumberInput, Panel } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { Plot } from "@/components/Plot";
import { api, errorText, type VariableSamples } from "@/lib/api";
import { axis, baseLayout, esc, INK, seriesColor, wash } from "@/lib/chart";
import { measure, METRICS, metricUnit, type Metric } from "@/lib/events";
import { save } from "@/lib/platform";
import { useApp, type ResultRow } from "@/lib/store";
import { cn } from "@/lib/utils";

const MEASURE: Metric[] = ["max", "min", "mean", "p2p", "rms", "std", "first", "last", "integral", "tmax", "tmin", "rise", "settle", "overshoot"];
const sig = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(6))));
const round = (v: number) => Number(v.toPrecision(6));

/** Rows as CSV (comma, quoted where needed). */
export function resultsCsv(rows: ResultRow[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["Group,Result,Signal,Value,Unit,Source", ...rows.map((r) => [r.group, r.name, r.signal, String(r.value), r.unit, r.source].map(q).join(","))].join("\n") + "\n";
}

/** Every scalar result in one table: measured here, or sent from Cycles, Frequency response and Curve fit. */
export function ResultsTab() {
  const { dataset, dataVersion, results, addResults, removeResults, showStatus } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("max");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [band, setBand] = useState(2);
  const [vec, setVec] = useState<VariableSamples | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [chartGroup, setChartGroup] = useState<string | null>(null);
  const [chartUnit, setChartUnit] = useState<string | null>(null);

  useEffect(() => {
    if (dataset && (!column || !dataset.signals.some((s) => s.column === column))) setColumn(dataset.signals[0]?.column ?? null);
  }, [dataset, column]);

  useEffect(() => {
    if (!column) return setVec(null);
    let cancelled = false;
    api
      .workspaceVariable(column)
      .then((v) => {
        if (cancelled) return;
        setVec(v);
        const t = v.edited_time;
        if (t.length) {
          setFrom(round(t[0]));
          setTo(round(t[t.length - 1]));
        }
      })
      .catch((e) => !cancelled && toast.error(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [column, dataVersion]);

  const info = dataset?.signals.find((s) => s.column === column);
  const values = useMemo(() => (vec ? measure(vec.edited_time, vec.edited, Math.min(from, to), Math.max(from, to), { band: band / 100 }) : null), [vec, from, to, band]);
  const value = values?.[metric] ?? null;
  const full = vec && vec.edited_time.length ? [vec.edited_time[0], vec.edited_time[vec.edited_time.length - 1]] : null;
  const whole = full ? Math.abs(from - full[0]) < 1e-9 && Math.abs(to - full[1]) < 1e-9 : true;

  const add = () => {
    if (value === null || !info) return;
    const name = `${METRICS[metric].label}${metric === "settle" ? ` (±${band} %)` : ""}${whole ? "" : ` · ${sig(Math.min(from, to))}–${sig(Math.max(from, to))} s`}`;
    addResults([{ group: "Measurements", name, signal: info.label, value, unit: metricUnit(metric, info.unit), source: "Results" }]);
  };

  const groups = useMemo(() => [...new Set(results.map((r) => r.group))], [results]);
  const shownGroup = chartGroup && groups.includes(chartGroup) ? chartGroup : (groups[0] ?? null);
  const groupRows = results.filter((r) => r.group === shownGroup && (!picked.some((id) => results.find((x) => x.id === id)?.group === shownGroup) || picked.includes(r.id)));
  // Bars share one scale, so the chart shows one unit at a time (the most common one by default).
  const units = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of groupRows) count.set(r.unit, (count.get(r.unit) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  }, [groupRows]);
  const unit = chartUnit !== null && units.includes(chartUnit) ? chartUnit : (units[0] ?? "");
  const chart = useMemo(() => {
    const rows = groupRows.filter((r) => r.unit === unit).slice(0, 40);
    if (!rows.length) return null;
    // Horizontal bars, first result on top; the signal joins the label only when names repeat.
    const repeated = new Set(rows.map((r) => r.name)).size < rows.length;
    const short = (s: string) => (s.length > 34 ? s.slice(0, 33) + "…" : s);
    const labels = rows.map((r) => esc(short(repeated ? `${r.name} · ${r.signal.split(" · ")[0]}` : r.name)));
    // Repeated labels would merge bars, so bars sit at their index.
    const index = rows.map((_, i) => i);
    return {
      data: [
        {
          type: "bar",
          orientation: "h",
          x: rows.map((r) => r.value),
          y: index,
          marker: { color: seriesColor(1), cornerradius: 3 },
          customdata: rows.map((r) => esc(`${r.name} · ${r.signal}`)),
          hovertemplate: "%{customdata}<br><b>%{x:.6~g}</b><extra></extra>",
        },
      ],
      layout: baseLayout({
        hovermode: "closest",
        dragmode: false,
        bargap: 0.25,
        margin: { l: 8, r: 16, t: 8, b: 44 },
        xaxis: axis(unit || "Value", { zeroline: true, zerolinecolor: INK.axis }),
        yaxis: axis(undefined, { tickmode: "array", tickvals: index, ticktext: labels, autorange: "reversed", automargin: true, showgrid: false, tickfont: { size: 11, color: INK.secondary } }),
      }),
    };
  }, [groupRows, unit]);

  const exportCsv = async () => {
    const p = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], title: "Save results", defaultPath: "results.csv" });
    if (!p) return;
    try {
      await api.saveText(p, resultsCsv(results));
      showStatus(`Saved ${results.length} results to ${p}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(resultsCsv(results).replace(/,/g, "\t"));
      toast.success("Results copied; paste them into a spreadsheet");
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const allPicked = results.length > 0 && picked.length === results.length;

  return (
    <div className="flex h-full flex-col gap-3">
      {dataset && (
        <Panel title="Measure" bodyClassName="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
          <Field label="Signal" className="w-[300px]">
            <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} />
          </Field>
          <Field label="Value" className="w-56">
            <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEASURE.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METRICS[m].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="From" className="w-36">
            <NumberInput value={from} step={0.1} suffix="s" onChange={setFrom} />
          </Field>
          <Field label="To" className="w-36">
            <NumberInput value={to} step={0.1} suffix="s" onChange={setTo} />
          </Field>
          {!whole && full && (
            <Button size="sm" variant="ghost" onClick={() => (setFrom(round(full[0])), setTo(round(full[1])))}>
              Whole signal
            </Button>
          )}
          {metric === "settle" && (
            <Field label="Band" className="w-28" hint="Settled once the signal stays within this share of the step">
              <NumberInput value={band} min={0.1} max={50} step={0.5} suffix="%" onChange={setBand} />
            </Field>
          )}
          <p className="min-w-28 text-[15px] font-semibold tabular-nums" title="Times are measured from the start of the window; the step for rise, settling and overshoot runs from the first to the final value">
            {sig(value)} <span className="text-[12.5px] font-normal text-muted-foreground">{info ? metricUnit(metric, info.unit) : ""}</span>
          </p>
          <Button size="sm" onClick={add} disabled={value === null}>
            <ListPlus /> Add
          </Button>
        </Panel>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel
          title={`Results${results.length ? ` (${results.length})` : ""}`}
          className="min-h-0 min-w-0 flex-[3]"
          bodyClassName="flex min-h-0 flex-col pt-1"
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={!picked.length} onClick={() => (removeResults(picked), setPicked([]))} title="Delete the ticked results">
                <Trash2 /> Delete
              </Button>
              <Button size="sm" variant="ghost" disabled={!results.length} onClick={copy} title="Copy as a table for Excel">
                <ClipboardCopy /> Copy
              </Button>
              <Button size="sm" variant="outline" disabled={!results.length} onClick={exportCsv}>
                <Download /> CSV
              </Button>
            </>
          }
        >
          {results.length === 0 ? (
            <EmptyState title="No results yet">
              Measure a value above, or press <b>Add to results</b> on the Cycles, Frequency response or Curve fit page. Results go into the report.
            </EmptyState>
          ) : (
            <div className="selectable min-h-0 flex-1 overflow-auto rounded-lg border border-ap-line">
              <table className="w-full border-collapse text-[12.5px] tabular-nums">
                <thead className="sticky top-0 z-10 bg-[#fafbfc] shadow-[0_1px_0_var(--ap-line)]">
                  <tr className="text-left">
                    <th className="w-8 px-2 py-1.5">
                      <Checkbox checked={allPicked} onCheckedChange={(v) => setPicked(v ? results.map((r) => r.id) : [])} aria-label="Tick all" />
                    </th>
                    <th className="px-2 py-1.5 font-medium">Result</th>
                    <th className="px-2 py-1.5 font-medium">Signal</th>
                    <th className="px-2 py-1.5 text-right font-medium">Value</th>
                    <th className="px-2 py-1.5 font-medium">Unit</th>
                    <th className="px-2 py-1.5 font-medium">From</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows
                      key={g}
                      group={g}
                      rows={results.filter((r) => r.group === g)}
                      picked={picked}
                      setPicked={setPicked}
                      charted={g === shownGroup}
                      onChart={() => setChartGroup(g)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel
          title={shownGroup ?? "Chart"}
          className="min-h-0 min-w-0 flex-[2]"
          bodyClassName="p-1"
          actions={
            units.length > 1 ? (
              <Select value={unit || "__none"} onValueChange={(v) => setChartUnit(v === "__none" ? "" : v)}>
                <SelectTrigger className="h-7 w-32 text-[12.5px]" title="The unit to chart">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((u) => (
                    <SelectItem key={u || "__none"} value={u || "__none"}>
                      {u || "no unit"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : undefined
          }
        >
          {chart ? (
            <Plot zoom={false} data={chart.data} layout={chart.layout} uirevision={`${shownGroup}|${unit}`} table={() => ({ columns: ["Result", "Signal", "Value", "Unit"], rows: groupRows.map((r) => [r.name, r.signal, r.value, r.unit]) })} />
          ) : (
            <EmptyState title="Nothing to chart" />
          )}
        </Panel>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  rows,
  picked,
  setPicked,
  charted,
  onChart,
}: {
  group: string;
  rows: ResultRow[];
  picked: string[];
  setPicked: (v: string[]) => void;
  charted: boolean;
  onChart: () => void;
}) {
  const ids = rows.map((r) => r.id);
  const all = ids.every((id) => picked.includes(id));
  return (
    <>
      <tr className={cn("border-b border-ap-line", charted ? "bg-ap-red-soft/60" : "bg-[#f7f8fa]")}>
        <td className="px-2 py-1.5">
          <Checkbox checked={all} onCheckedChange={(v) => setPicked(v ? [...new Set([...picked, ...ids])] : picked.filter((p) => !ids.includes(p)))} aria-label={`Tick ${group}`} />
        </td>
        <td colSpan={4} className="px-2 py-1.5 font-semibold">
          {group} <span className="font-normal text-muted-foreground">· {rows.length}</span>
        </td>
        <td className="px-2 py-1 text-right">
          <button className={cn("rounded px-1.5 text-[12px]", charted ? "font-medium text-ap-red" : "text-muted-foreground hover:text-foreground")} onClick={onChart}>
            {charted ? "Charted" : "Chart"}
          </button>
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.id} className={cn("border-b border-ap-line/60 hover:bg-[#f7f8fa]", picked.includes(r.id) && "bg-[color:var(--hl)]")} style={{ ["--hl" as string]: wash(seriesColor(1), 0.08) }}>
          <td className="px-2 py-1">
            <Checkbox checked={picked.includes(r.id)} onCheckedChange={(v) => setPicked(v ? [...picked, r.id] : picked.filter((p) => p !== r.id))} />
          </td>
          <td className="px-2 py-1">{r.name}</td>
          <td className="max-w-48 truncate px-2 py-1 text-muted-foreground" title={r.signal}>
            {r.signal}
          </td>
          <td className="px-2 py-1 text-right font-medium">{sig(r.value)}</td>
          <td className="px-2 py-1 text-muted-foreground">{r.unit}</td>
          <td className="px-2 py-1 text-muted-foreground">{r.source}</td>
        </tr>
      ))}
    </>
  );
}
