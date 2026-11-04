import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Download, ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, NumberInput, Panel, Segmented, StatusText } from "@/components/common";
import { MultiPick } from "@/components/MultiPick";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import { analysisVectors, categoryVector, type Vectors } from "@/lib/analysis";
import { errorText } from "@/lib/api";
import { INK, seriesColor, wash } from "@/lib/chart";
import { cut, detectEvents, makeSegments, meanCurve, measure, METRICS, metricUnit, type EventMode, type Metric } from "@/lib/events";
import { fileStem, saveCsv } from "@/lib/csv";
import { inside, SECONDS } from "@/lib/brush";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const TEXT = "text:";
const MAX_LINES = 150;
const MAX_OVERLAY = 80;
const sig = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(4))));
const STAT_METRICS: Metric[] = ["mean", "min", "max", "p2p", "rms", "std", "first", "last", "integral", "tmax", "tmin", "rise", "settle", "overshoot"];

/** Cut the data into cycles at events on a trigger signal, then compare the cycles. */
export function CyclesTab() {
  const { dataset, dataVersion, activeTab, addResults, brush } = useApp();
  const [trigger, setTrigger] = useState<string>("");
  const [mode, setMode] = useState<EventMode>("rising");
  const [level, setLevel] = useState(0);
  const [hysteresis, setHysteresis] = useState(0);
  const [holdoff, setHoldoff] = useState(0);
  const [segMode, setSegMode] = useState<"between" | "window">("between");
  const [pre, setPre] = useState(0);
  const [post, setPost] = useState(1);
  const [minDuration, setMinDuration] = useState(0);
  const [signals, setSignals] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>(["max", "mean", "min"]);
  const [overlay, setOverlay] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [data, setData] = useState<Vectors | null>(null);
  const [codes, setCodes] = useState<(number | null)[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const textTrigger = trigger.startsWith(TEXT) ? trigger.slice(TEXT.length) : null;
  const signalInfo = (c: string) => dataset?.signals.find((s) => s.column === c);

  // Defaults when a dataset arrives: trigger on the first signal, statistics of every signal.
  useEffect(() => {
    if (!dataset) return;
    const cols = dataset.signals.map((s) => s.column);
    setTrigger((t) => (t && (cols.includes(t) || dataset.texts.includes(t.slice(TEXT.length))) ? t : (cols[0] ?? "")));
    setSignals((s) => {
      const kept = s.filter((c) => cols.includes(c));
      return kept.length ? kept : cols.slice(0, 3);
    });
    setOverlay((o) => (o && cols.includes(o) ? o : (cols[0] ?? null)));
  }, [dataset]);

  const needed = useMemo(() => [...new Set([...(textTrigger || !trigger ? [] : [trigger]), ...signals, ...(overlay ? [overlay] : [])])], [trigger, textTrigger, signals, overlay]);

  useEffect(() => {
    if (activeTab !== "cycles" || !dataset || !needed.length) return;
    let cancelled = false;
    setLoading(true);
    analysisVectors(needed)
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setError("");
      })
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [needed.join("|"), dataVersion, activeTab, !!dataset]);

  useEffect(() => {
    if (!textTrigger) return setCodes(null);
    let cancelled = false;
    categoryVector(textTrigger)
      .then((c) => !cancelled && setCodes(c.codes.map((k) => (k < 0 ? null : k))))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [textTrigger, dataVersion]);

  const time = data?.time ?? [];
  const triggerValues = textTrigger ? codes : data?.columns[trigger];

  // A new trigger signal starts at its midpoint with 5 % hysteresis.
  useEffect(() => {
    if (textTrigger) {
      setMode("change");
      return;
    }
    const v = data?.columns[trigger];
    if (!v) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) if (x !== null && Number.isFinite(x)) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    if (hi >= lo) {
      setLevel(Number(((lo + hi) / 2).toPrecision(4)));
      setHysteresis(Number(((hi - lo) * 0.05).toPrecision(2)));
    }
    if (mode === "change") setMode("rising");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, !!data?.columns[trigger], textTrigger]);

  const range: [number, number] = useMemo(() => {
    const ts = time.filter((t): t is number => t !== null);
    return ts.length ? [ts[0], ts[ts.length - 1]] : [0, 0];
  }, [time]);

  // Typing a level stays smooth: detection follows a moment later.
  const p = useDeferredValue({ level, hysteresis, holdoff });
  const events = useMemo(
    () => (triggerValues ? detectEvents(time, triggerValues, { mode, level: p.level, hysteresis: p.hysteresis, holdoff: p.holdoff, tolerance: textTrigger ? 0 : p.hysteresis }) : []),
    [time, triggerValues, mode, p, textTrigger],
  );
  // With a selection, only cycles that start inside it.
  const segments = useMemo(
    () => makeSegments(events, range, { mode: segMode, pre, post, minDuration }).filter((s) => inside(s.start, brush)).map((s, i) => ({ ...s, index: i + 1 })),
    [events, range, segMode, pre, post, minDuration, brush],
  );
  useEffect(() => {
    setExcluded([]);
    setSelected(null);
  }, [segments.length, trigger, mode, segMode]);

  const stats = useMemo(() => {
    if (!data) return [];
    return segments.map((s) => ({
      seg: s,
      values: Object.fromEntries(signals.map((c) => [c, data.columns[c] ? measure(time, data.columns[c], s.start, s.end) : null])),
    }));
  }, [segments, signals, data, time]);

  const included = stats.filter((r) => !excluded.includes(r.seg.index));
  const columns = signals.flatMap((c) => metrics.map((m) => ({ key: `${c}|${m}`, signal: c, metric: m })));
  const summary = (key: string) => {
    const [c, m] = key.split("|") as [string, Metric];
    const v = included.map((r) => r.values[c]?.[m]).filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
    if (!v.length) return { mean: null, std: null, n: 0 };
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return { mean, std: v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : null, n: v.length };
  };
  const trendKey = trend && columns.some((c) => c.key === trend) ? trend : (columns[0]?.key ?? null);

  const triggerLabel = textTrigger ?? signalInfo(trigger)?.label ?? trigger;

  const triggerPanels: ChartPanel[] = useMemo(() => {
    if (!triggerValues || !time.length) return [];
    const lines = events.length <= MAX_LINES ? events.map((e) => ({ x: e })) : [];
    return [
      {
        id: "trigger",
        yLabel: triggerLabel,
        hLines: textTrigger ? [] : [{ y: level, label: `level ${sig(level)}` }],
        vLines: lines,
        series: [{ name: triggerLabel, color: seriesColor(0), data: time.map((t, i) => [t, triggerValues[i] ?? null] as [number | null, number | null]) }],
      },
    ];
  }, [time, triggerValues, events, level, triggerLabel, textTrigger]);

  const overlayPanels: ChartPanel[] = useMemo(() => {
    if (!data || !overlay || !data.columns[overlay]) return [];
    const y = data.columns[overlay];
    const shown = included.slice(0, MAX_OVERLAY);
    const curves = shown.map((r) => ({ index: r.seg.index, ...cut(time, y, r.seg.start, r.seg.end, segMode === "window" ? r.seg.event : r.seg.start) }));
    const m = meanCurve(curves);
    const series: ChartSeries[] = curves.map((c) => ({
      name: `Cycle ${c.index}`,
      color: c.index === selected ? seriesColor(0) : INK.original,
      width: c.index === selected ? 2.2 : 1,
      data: c.x.map((x, i) => [x, c.y[i]] as [number, number | null]),
    }));
    // The selected cycle on top.
    series.sort((a, b) => (a.color === seriesColor(0) ? 1 : 0) - (b.color === seriesColor(0) ? 1 : 0));
    if (curves.length > 1) {
      series.push({ name: "+1σ", color: wash(seriesColor(1), 0.6), width: 1, dashed: true, data: m.x.map((x, i) => [x, m.hi[i]] as [number, number | null]) });
      series.push({ name: "−1σ", color: wash(seriesColor(1), 0.6), width: 1, dashed: true, data: m.x.map((x, i) => [x, m.lo[i]] as [number, number | null]) });
      series.push({ name: "Mean", color: seriesColor(1), width: 2.4, data: m.x.map((x, i) => [x, m.mean[i]] as [number, number | null]) });
    }
    return [{ id: "overlay", yLabel: signalInfo(overlay)?.label ?? overlay, legend: false, series, vLines: segMode === "window" ? [{ x: 0, label: "event" }] : [] }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, overlay, included, time, segMode, selected]);

  const trendPanels: ChartPanel[] = useMemo(() => {
    if (!trendKey) return [];
    const [c, m] = trendKey.split("|") as [string, Metric];
    const s = summary(trendKey);
    return [
      {
        id: "trend",
        yLabel: `${METRICS[m].label}${metricUnit(m, signalInfo(c)?.unit ?? "") ? ` [${metricUnit(m, signalInfo(c)?.unit ?? "")}]` : ""}`,
        hLines: s.mean !== null ? [{ y: s.mean, label: "mean" }] : [],
        series: [{ name: METRICS[m].label, color: seriesColor(0), type: "scatter", data: included.map((r) => [r.seg.index, r.values[c]?.[m] ?? null] as [number, number | null]) }],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendKey, included]);

  const addToResults = (perCycle: boolean) => {
    const group = `Cycles of ${triggerLabel}`;
    const rows = columns.flatMap(({ signal, metric }) => {
      const info = signalInfo(signal);
      const unit = metricUnit(metric, info?.unit ?? "");
      const base = { group, signal: info?.label ?? signal, unit, source: "Cycles" };
      if (perCycle)
        return included.flatMap((r) => {
          const v = r.values[signal]?.[metric];
          return v === null || v === undefined ? [] : [{ ...base, name: `Cycle ${r.seg.index} · ${METRICS[metric].label}`, value: v }];
        });
      const s = summary(`${signal}|${metric}`);
      return [
        ...(s.mean !== null ? [{ ...base, name: `${METRICS[metric].label} · mean of ${s.n}`, value: s.mean }] : []),
        ...(s.std !== null ? [{ ...base, name: `${METRICS[metric].label} · std dev of ${s.n}`, value: s.std }] : []),
      ];
    });
    addResults(rows);
    toast.success(`${rows.length} result${rows.length === 1 ? "" : "s"} added`);
  };

  if (!dataset) return <EmptyState title="No data loaded" />;

  const triggerSignals = dataset.signals;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Field label="Trigger" className="w-[300px]">
          <Select value={trigger || undefined} onValueChange={setTrigger}>
            <SelectTrigger className="h-8 w-full" title="The signal whose crossings or state changes start a cycle">
              <SelectValue placeholder="Signal" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {triggerSignals.map((s) => (
                <SelectItem key={s.column} value={s.column}>
                  {s.label}
                </SelectItem>
              ))}
              {dataset.texts.length > 0 && <SelectSeparator />}
              {dataset.texts.map((t) => (
                <SelectItem key={t} value={`${TEXT}${t}`}>
                  {t} (text states)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Segmented
          value={mode}
          onChange={setMode}
          options={
            textTrigger
              ? [{ value: "change", label: "State change" }]
              : [
                  { value: "rising", label: "Rising", hint: "Upward crossings of the level" },
                  { value: "falling", label: "Falling", hint: "Downward crossings of the level" },
                  { value: "both", label: "Both" },
                  { value: "change", label: "Step", hint: "A jump larger than the hysteresis (state signals)" },
                ]
          }
        />
        {!textTrigger && mode !== "change" && (
          <Field label="Level" className="w-40">
            <NumberInput value={level} step={0.1} onChange={setLevel} />
          </Field>
        )}
        {!textTrigger && (
          <Field label={mode === "change" ? "Min step" : "Hysteresis"} className="w-40" hint={mode === "change" ? "The smallest jump that counts as a new state" : "After a crossing, the signal must go back past the level by this much before the next one counts"}>
            <NumberInput value={hysteresis} min={0} step={0.01} onChange={setHysteresis} />
          </Field>
        )}
        <Field label="Hold-off" className="w-36" hint="Events closer than this to the previous one are ignored">
          <NumberInput value={holdoff} min={0} step={0.1} suffix="s" onChange={setHoldoff} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented
          value={segMode}
          onChange={setSegMode}
          options={[
            { value: "between", label: "Event → event", hint: "Each cycle runs from one event to the next" },
            { value: "window", label: "Window", hint: "A fixed window before and after each event" },
          ]}
        />
        {segMode === "window" && (
          <>
            <Field label="Before" className="w-32">
              <NumberInput value={pre} min={0} step={0.1} suffix="s" onChange={setPre} />
            </Field>
            <Field label="After" className="w-32">
              <NumberInput value={post} min={0} step={0.1} suffix="s" onChange={setPost} />
            </Field>
          </>
        )}
        <Field label="Min length" className="w-36" hint="Shorter cycles are dropped">
          <NumberInput value={minDuration} min={0} step={0.1} suffix="s" onChange={setMinDuration} />
        </Field>
        <p className="text-[13px] text-muted-foreground tabular-nums">
          <span className="font-semibold text-foreground">{events.length}</span> event{events.length === 1 ? "" : "s"} ·{" "}
          <span className="font-semibold text-foreground">{segments.length}</span> cycle{segments.length === 1 ? "" : "s"}
          {excluded.length > 0 && <> · {excluded.length} left out</>}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className={cn("flex min-w-0 flex-[3] flex-col gap-3 transition-opacity", loading && "opacity-60")}>
          <Panel title="Trigger and events" className="min-h-0 flex-[2]" bodyClassName="p-1">
            {triggerPanels.length ? <StackedChart panels={triggerPanels} xLabel="Time [s]" resetKey={trigger} time={SECONDS} /> : <EmptyState title="Loading…" />}
          </Panel>
          <Panel
            title={segMode === "window" ? "Cycles overlaid on the event" : "Cycles overlaid from their start"}
            actions={
              <div className="w-56">
                <SignalSelect signals={dataset.signals} value={overlay} onChange={setOverlay} />
              </div>
            }
            className="min-h-0 flex-[3]"
            bodyClassName="p-1"
          >
            {overlayPanels.length && included.length ? (
              <StackedChart panels={overlayPanels} xLabel={segMode === "window" ? "Time from event [s]" : "Time in cycle [s]"} resetKey={`${overlay}|${segMode}`} />
            ) : (
              <EmptyState title="No cycles" />
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-[2] flex-col gap-3">
          <Panel
            title="Per cycle"
            className="min-h-0 flex-[3]"
            bodyClassName="flex min-h-0 flex-col gap-2 pt-1"
            actions={
              <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!stats.length}
                title="Every cycle with its start, length and values as a CSV file"
                onClick={() =>
                  saveCsv(
                    `${fileStem(triggerLabel)}-cycles.csv`,
                    [
                      "Cycle",
                      "Included",
                      "Start [s]",
                      "End [s]",
                      "Length [s]",
                      ...columns.map((c) => {
                        const i = signalInfo(c.signal);
                        const un = metricUnit(c.metric, i?.unit ?? "");
                        return `${i?.label ?? c.signal} ${METRICS[c.metric].label}${un ? ` [${un}]` : ""}`;
                      }),
                    ],
                    stats.map((r) => [r.seg.index, excluded.includes(r.seg.index) ? "no" : "yes", r.seg.start, r.seg.end, r.seg.end - r.seg.start, ...columns.map((c) => r.values[c.signal]?.[c.metric] ?? null)]),
                  )
                }
              >
                <Download /> CSV
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={!included.length || !columns.length}>
                    <ListPlus /> Add to results
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => addToResults(false)}>Mean and std dev over the cycles</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addToResults(true)}>Every cycle</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </>
            }
          >
            <div className="flex flex-wrap gap-2">
              <MultiPick label="Signals" noun="signals" options={dataset.signals.map((s) => ({ value: s.column, label: s.label }))} value={signals} onChange={setSignals} />
              <MultiPick label="Values" noun="values" options={STAT_METRICS.map((m) => ({ value: m, label: METRICS[m].label }))} value={metrics} onChange={setMetrics} />
            </div>
            <div className="selectable min-h-0 flex-1 overflow-auto rounded-lg border border-ap-line">
              <table className="w-full border-collapse text-[12.5px] tabular-nums">
                <thead className="sticky top-0 z-10 bg-[#fafbfc] shadow-[0_1px_0_var(--ap-line)]">
                  <tr className="text-left">
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 text-right font-medium">Start [s]</th>
                    <th className="px-2 py-1.5 text-right font-medium">Length [s]</th>
                    {columns.map((c) => {
                      const info = signalInfo(c.signal);
                      const unit = metricUnit(c.metric, info?.unit ?? "");
                      return (
                        <th
                          key={c.key}
                          onClick={() => setTrend(c.key)}
                          title={`${info?.label ?? c.signal}: ${METRICS[c.metric].label}. Click to show its trend over the cycles.`}
                          className={cn("cursor-pointer px-2 py-1.5 text-right font-medium whitespace-nowrap hover:text-ap-red", trendKey === c.key && "text-ap-red")}
                        >
                          <span className="block max-w-32 truncate text-[11px] font-normal text-muted-foreground">{info?.name ?? c.signal}</span>
                          {METRICS[c.metric].label}
                          {unit && <span className="font-normal text-muted-foreground"> [{unit}]</span>}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {stats.map((r) => {
                    const out = excluded.includes(r.seg.index);
                    return (
                      <tr
                        key={r.seg.index}
                        onClick={() => setSelected(selected === r.seg.index ? null : r.seg.index)}
                        className={cn("cursor-pointer border-b border-ap-line/60 hover:bg-[#f7f8fa]", selected === r.seg.index && "bg-ap-red-soft", out && "text-muted-foreground/60")}
                      >
                        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={!out}
                            title="Include this cycle in the mean and the results"
                            onCheckedChange={(v) => setExcluded(v ? excluded.filter((i) => i !== r.seg.index) : [...excluded, r.seg.index])}
                          />
                        </td>
                        <td className="px-2 py-1">{r.seg.index}</td>
                        <td className="px-2 py-1 text-right">{sig(r.seg.start)}</td>
                        <td className="px-2 py-1 text-right">{sig(r.seg.end - r.seg.start)}</td>
                        {columns.map((c) => (
                          <td key={c.key} className="px-2 py-1 text-right">
                            {sig(r.values[c.signal]?.[c.metric])}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                {included.length > 1 && (
                  <tfoot className="sticky bottom-0 bg-white shadow-[0_-1px_0_var(--ap-line)]">
                    {(["mean", "std"] as const).map((k) => (
                      <tr key={k} className="font-medium">
                        <td />
                        <td className="px-2 py-1" colSpan={3}>
                          {k === "mean" ? `Mean of ${included.length}` : "Std dev"}
                        </td>
                        {columns.map((c) => (
                          <td key={c.key} className="px-2 py-1 text-right">
                            {sig(summary(c.key)[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tfoot>
                )}
              </table>
              {!stats.length && <p className="p-6 text-center text-[13px] text-muted-foreground">No cycles found.</p>}
            </div>
          </Panel>
          <Panel title="Trend over the cycles" className="min-h-0 flex-[2]" bodyClassName="p-1">
            {trendPanels.length && included.length ? <StackedChart panels={trendPanels} xLabel="Cycle" zoom={false} /> : <EmptyState title="No cycles" />}
          </Panel>
        </div>
      </div>
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}
