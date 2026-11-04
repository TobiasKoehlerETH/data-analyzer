import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, ListPlus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckField, EmptyState, Field, Panel, Segmented, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import { api, errorText, type VariableSamples } from "@/lib/api";
import { INK, seriesColor, wash } from "@/lib/chart";
import { fileStem, saveCsv } from "@/lib/csv";
import { findPeaks, findViolations, type Peak, type Violation } from "@/lib/peaks";
import { inside, SECONDS } from "@/lib/brush";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const sig = (v: number | null | undefined, d = 5) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(d))));
const MAX_ROWS = 2000;
const PEAK = seriesColor(0);
const VALLEY = seriesColor(1);

/** A number field that may be left empty (no limit). */
function OptNumber({
  value,
  onChange,
  suffix,
  placeholder = "off",
  className,
  title,
  step,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  placeholder?: string;
  className?: string;
  title?: string;
  /** ↑/↓ change the value by this much (Shift: ×10). */
  step?: number;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    if ((text.trim() === "" ? null : Number(text.replace(",", "."))) !== value) setText(value === null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cn("relative", className)}>
      <Input
        className={cn("h-8 tabular-nums", suffix && "pr-7")}
        value={text}
        placeholder={placeholder}
        title={title}
        inputMode="decimal"
        onKeyDown={(e) => {
          if (!step || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          const next = Number(((value ?? 0) + d).toPrecision(6));
          setText(String(next));
          onChange(next);
        }}
        onChange={(e) => {
          setText(e.target.value);
          const raw = e.target.value.trim().replace(",", ".");
          if (raw === "") onChange(null);
          else if (Number.isFinite(Number(raw)) && raw !== "-" && raw !== ".") onChange(Number(raw));
        }}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** Find peaks and valleys with every parameter exposed, or the stretches outside limits. */
export function PeaksTab() {
  const { dataset, dataVersion, activeTab, addResults, brush } = useApp();
  const [mode, setMode] = useState<"peaks" | "limits">("peaks");
  const [column, setColumn] = useState<string | null>(null);
  const [vec, setVec] = useState<VariableSamples | null>(null);
  /** The signal `vec` belongs to (it arrives after the column changes). */
  const [vecFor, setVecFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  // Peak parameters.
  const [kind, setKind] = useState<"max" | "min" | "both">("max");
  const [minValue, setMinValue] = useState<number | null>(null);
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [prominence, setProminence] = useState<number | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [minWidth, setMinWidth] = useState<number | null>(null);
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  const [relHeight, setRelHeight] = useState<number | null>(50);
  const [maxCount, setMaxCount] = useState<number | null>(null);
  const [guides, setGuides] = useState(true);
  const [more, setMore] = useState(false);
  // Limit parameters.
  const [upper, setUpper] = useState<number | null>(null);
  const [lower, setLower] = useState<number | null>(null);
  const [hysteresis, setHysteresis] = useState<number | null>(null);
  const [minDuration, setMinDuration] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (dataset && (!column || !dataset.signals.some((s) => s.column === column))) setColumn(dataset.signals[0]?.column ?? null);
  }, [dataset, column]);

  useEffect(() => {
    if (activeTab !== "peaks" || !column) return;
    let cancelled = false;
    api
      .workspaceVariable(column)
      .then((v) => !cancelled && (setVec(v), setVecFor(column), setError("")))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [column, dataVersion, activeTab]);

  const t = vec?.edited_time ?? [];
  const y = vec?.edited ?? [];
  const range = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of y) if (v !== null && Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    return hi >= lo ? { lo, hi } : null;
  }, [y]);

  // A new signal starts with a prominence of 10 % of its range and limits at 90 % / 10 %.
  useEffect(() => {
    if (!range) return;
    const span = range.hi - range.lo || 1;
    setProminence(Number((span * 0.1).toPrecision(2)));
    setUpper(Number((range.lo + span * 0.9).toPrecision(3)));
    setLower(Number((range.lo + span * 0.1).toPrecision(3)));
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vecFor]);

  // Typing stays smooth on long signals: detection follows the fields a moment later.
  const params = useDeferredValue({ kind, minValue, maxValue, prominence, threshold, distance, minWidth, maxWidth, relHeight, from, to, maxCount, upper, lower, hysteresis, minDuration });
  const peaks: Peak[] = useMemo(() => {
    const p = params;
    return (mode === "peaks" && t.length
      ? findPeaks(t, y, {
          kind: p.kind,
          minValue: p.minValue,
          maxValue: p.maxValue,
          prominence: p.prominence ?? 0,
          threshold: p.threshold ?? 0,
          distance: p.distance ?? 0,
          minWidth: p.minWidth ?? 0,
          maxWidth: p.maxWidth,
          relHeight: Math.min(1, Math.max(0, (p.relHeight ?? 50) / 100)),
          from: p.from,
          to: p.to,
          maxCount: p.maxCount ?? 0,
        })
      : []
    ).filter((k) => inside(k.time, brush));
  }, [mode, t, y, params, brush]);
  const violations: Violation[] = useMemo(
    () =>
      (mode === "limits" && t.length ? findViolations(t, y, { upper: params.upper, lower: params.lower, hysteresis: params.hysteresis ?? 0, minDuration: params.minDuration ?? 0, from: params.from, to: params.to }) : []).filter(
        (v) => inside(v.start, brush) || inside(v.end, brush),
      ),
    [mode, t, y, params, brush],
  );
  const stale = params.prominence !== prominence || params.upper !== upper || params.lower !== lower || params.minValue !== minValue || params.maxValue !== maxValue || params.distance !== distance;
  /** Arrow-key step for value fields: 1 % of the signal's range. */
  const nudge = range ? Number(((range.hi - range.lo || 1) / 100).toPrecision(1)) : 1;

  const info = dataset?.signals.find((s) => s.column === column);
  const unit = info?.unit ?? "";
  const label = info?.label ?? column ?? "";
  const u = (s: string) => (unit ? `${s} [${unit}]` : s);
  const unitSuffix = unit.length <= 3 ? unit : undefined;

  const panels: ChartPanel[] = useMemo(() => {
    if (!t.length) return [];
    const line: ChartSeries = { name: label, color: INK.secondary, width: 1.2, data: t.map((ti, i) => [ti, y[i] ?? null] as [number, number | null]) };
    if (mode === "peaks") {
      const series: ChartSeries[] = [line];
      if (guides && peaks.length <= 400) {
        // Width at the chosen height (horizontal) and prominence (vertical), drawn as broken lines.
        const w: [number | null, number | null][] = [];
        const p: [number | null, number | null][] = [];
        for (const k of peaks) {
          w.push([k.left, k.widthLevel], [k.right, k.widthLevel], [null, null]);
          const base = k.kind === "max" ? k.value - k.prominence : k.value + k.prominence;
          p.push([k.time, k.value], [k.time, base], [null, null]);
        }
        series.push({ name: "Width", color: wash(seriesColor(2), 0.95), width: 2, data: w }, { name: "Prominence", color: wash(seriesColor(4), 0.95), width: 1.5, dashed: true, data: p });
      }
      const marks = (k: "max" | "min") => peaks.filter((x) => x.kind === k).map((x) => [x.time, x.value] as [number, number]);
      if (kind !== "min") series.push({ name: "Peaks", color: PEAK, type: "scatter", data: marks("max") });
      if (kind !== "max") series.push({ name: "Valleys", color: VALLEY, type: "scatter", data: marks("min") });
      if (selected !== null && peaks[selected]) series.push({ name: "Selected", color: INK.primary, type: "scatter", data: [[peaks[selected].time, peaks[selected].value]] });
      const hLines = [
        ...(minValue !== null ? [{ y: minValue, label: `≥ ${sig(minValue)}` }] : []),
        ...(maxValue !== null ? [{ y: maxValue, label: `≤ ${sig(maxValue)}` }] : []),
      ];
      return [{ id: "peaks", yLabel: label, legend: true, series, hLines, vLines: [...(from !== null ? [{ x: from, label: "from" }] : []), ...(to !== null ? [{ x: to, label: "to" }] : [])] }];
    }
    // Limits: the samples outside each limit drawn in colour over the signal.
    // Only the samples of each violation, one broken-off segment per violation.
    const out = (k: "upper" | "lower") => {
      const pts: [number | null, number | null][] = [];
      let i = 0;
      for (const v of violations.filter((x) => x.kind === k)) {
        while (i < t.length && t[i] < v.start) i++;
        while (i < t.length && t[i] <= v.end) pts.push([t[i], y[i] ?? null]), i++;
        pts.push([null, null]);
      }
      return pts;
    };
    const series: ChartSeries[] = [line];
    if (upper !== null) series.push({ name: "Above upper", color: PEAK, width: 2.2, data: out("upper") });
    if (lower !== null) series.push({ name: "Below lower", color: VALLEY, width: 2.2, data: out("lower") });
    const hLines = [...(upper !== null ? [{ y: upper, label: `upper ${sig(upper)}` }] : []), ...(lower !== null ? [{ y: lower, label: `lower ${sig(lower)}` }] : [])];
    return [{ id: "limits", yLabel: label, legend: true, series, hLines, vLines: selected !== null && violations[selected] ? [{ x: violations[selected].start }, { x: violations[selected].end }] : [] }];
  }, [t, y, mode, peaks, violations, guides, kind, selected, minValue, maxValue, upper, lower, label, from, to]);

  // Summary figures.
  const span = t.length ? (to ?? t[t.length - 1]) - (from ?? t[0]) : 0;
  const peakSummary = useMemo(() => {
    const byKind = (k: "max" | "min") => {
      const ps = peaks.filter((p) => p.kind === k);
      if (!ps.length) return null;
      const vals = ps.map((p) => p.value);
      const gaps = ps.slice(1).map((p, i) => p.time - ps[i].time);
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      return {
        count: ps.length,
        mean: mean(vals),
        extreme: k === "max" ? Math.max(...vals) : Math.min(...vals),
        prominence: mean(ps.map((p) => p.prominence)),
        width: mean(ps.map((p) => p.width)),
        interval: gaps.length ? mean(gaps) : null,
      };
    };
    return { max: byKind("max"), min: byKind("min") };
  }, [peaks]);
  const limitSummary = useMemo(() => {
    const outside = violations.reduce((s, v) => s + v.duration, 0);
    const worst = violations.reduce<Violation | null>((w, v) => (!w || v.excess > w.excess ? v : w), null);
    return { count: violations.length, outside, share: span > 0 ? (outside / span) * 100 : 0, worst };
  }, [violations, span]);

  const exportCsv = () => {
    const stem = fileStem(label);
    if (mode === "peaks")
      return saveCsv(`${stem}-${kind === "min" ? "valleys" : kind === "both" ? "extremes" : "peaks"}.csv`, ["#", "Type", "Time [s]", u("Value"), u("Prominence"), "Width [s]", "Left base [s]", "Right base [s]", "Width from [s]", "Width to [s]"], peaks.map((p, i) => [i + 1, p.kind === "max" ? "peak" : "valley", p.time, p.value, p.prominence, p.width, p.leftBase, p.rightBase, p.left, p.right]));
    return saveCsv(`${stem}-limit-violations.csv`, ["#", "Limit", "Start [s]", "End [s]", "Duration [s]", u("Extreme"), "Extreme at [s]", u("Beyond limit")], violations.map((v, i) => [i + 1, v.kind, v.start, v.end, v.duration, v.extreme, v.extremeTime, v.excess]));
  };

  const addToResults = () => {
    const signal = label;
    const rows: { group: string; name: string; value: number; unit: string }[] = [];
    if (mode === "peaks") {
      for (const k of ["max", "min"] as const) {
        const s = peakSummary[k];
        if (!s) continue;
        const what = k === "max" ? "Peaks" : "Valleys";
        const group = `${what} of ${signal}`;
        rows.push(
          { group, name: "Count", value: s.count, unit: "" },
          { group, name: `Mean ${k === "max" ? "peak" : "valley"} value`, value: s.mean, unit },
          { group, name: k === "max" ? "Highest peak" : "Lowest valley", value: s.extreme, unit },
          { group, name: "Mean prominence", value: s.prominence, unit },
          { group, name: "Mean width", value: s.width, unit: "s" },
          ...(s.interval !== null ? [{ group, name: "Mean interval", value: s.interval, unit: "s" }, { group, name: "Rate", value: 1 / s.interval, unit: "Hz" }] : []),
        );
      }
    } else {
      const group = `Limits of ${signal}`;
      rows.push(
        ...(upper !== null ? [{ group, name: "Upper limit", value: upper, unit }] : []),
        ...(lower !== null ? [{ group, name: "Lower limit", value: lower, unit }] : []),
        { group, name: "Violations", value: limitSummary.count, unit: "" },
        { group, name: "Time outside", value: limitSummary.outside, unit: "s" },
        { group, name: "Share of time outside", value: limitSummary.share, unit: "%" },
        ...(limitSummary.worst ? [{ group, name: "Worst excess", value: limitSummary.worst.excess, unit }] : []),
      );
    }
    addResults(rows.map((r) => ({ ...r, signal, source: mode === "peaks" ? "Peaks" : "Limits" })));
    toast.success(`${rows.length} results added`);
  };

  if (!dataset) return <EmptyState title="No data loaded" />;

  const count = mode === "peaks" ? peaks.length : violations.length;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented
          value={mode}
          onChange={(m) => (setMode(m), setSelected(null))}
          options={[
            { value: "peaks", label: "Peaks", hint: "Peaks and valleys with your own rules" },
            { value: "limits", label: "Limits", hint: "Where the signal leaves upper / lower limits" },
          ]}
        />
        <Field label="Signal" className="w-[300px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} />
        </Field>
        <Field label="From" className="w-32" hint="Search only from this time (empty = start)">
          <OptNumber value={from} onChange={setFrom} suffix="s" placeholder="start" />
        </Field>
        <Field label="To" className="w-32" hint="Search only up to this time (empty = end)">
          <OptNumber value={to} onChange={setTo} suffix="s" placeholder="end" />
        </Field>
      </div>

      {mode === "peaks" ? (
        <Panel bodyClassName="flex flex-wrap items-end gap-x-4 gap-y-2 py-2.5">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "max", label: "Peaks" },
              { value: "min", label: "Valleys", hint: "Minima, e.g. negative peaks below zero" },
              { value: "both", label: "Both" },
            ]}
          />
          <Param label="Value ≥" hint="Only extremes at or above this value. ↑/↓ to nudge.">
            <OptNumber value={minValue} onChange={setMinValue} step={nudge} suffix={unitSuffix} />
          </Param>
          <Param label="Value ≤" hint="Only extremes at or below this value, e.g. 0 for valleys below zero. ↑/↓ to nudge.">
            <OptNumber value={maxValue} onChange={setMaxValue} step={nudge} suffix={unitSuffix} />
          </Param>
          <Param wide label="Prominence" hint="How far an extreme stands out from its surroundings: the main knob against noise. ↑/↓ to nudge.">
            <div className="flex items-center gap-1">
              <OptNumber value={prominence} onChange={setProminence} step={nudge} className="w-24" />
              {range && (
                <Button size="icon-sm" variant="ghost" title="Auto: 10 % of the range" onClick={() => setProminence(Number(((range.hi - range.lo) * 0.1).toPrecision(2)))}>
                  <Wand2 />
                </Button>
              )}
            </div>
          </Param>
          <Param label="Min gap" hint="Smallest time between two extremes; the more prominent one wins">
            <OptNumber value={distance} onChange={setDistance} step={0.1} suffix="s" />
          </Param>
          <Param label="Min width" hint="Width at half prominence (see More)">
            <OptNumber value={minWidth} onChange={setMinWidth} step={0.01} suffix="s" />
          </Param>
          <div className={cn("grid transition-[grid-template-columns,opacity] duration-200 ease-out", more ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0")}>
            <div className="flex items-end gap-x-4 overflow-hidden">
              <Param label="Max width">
                <OptNumber value={maxWidth} onChange={setMaxWidth} step={0.01} suffix="s" />
              </Param>
              <Param label="Width at" hint="Share of the prominence below the extreme where the width is measured">
                <OptNumber value={relHeight} onChange={setRelHeight} step={5} suffix="%" placeholder="50" />
              </Param>
              <Param label="Min step" hint="Smallest rise from both neighbour samples">
                <OptNumber value={threshold} onChange={setThreshold} step={nudge} />
              </Param>
              <Param label="Keep top" hint="Only the N most prominent">
                <OptNumber value={maxCount} onChange={(v) => setMaxCount(v === null ? null : Math.max(0, Math.round(v)))} step={1} placeholder="all" />
              </Param>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="mb-0.5 text-muted-foreground" onClick={() => setMore(!more)} aria-expanded={more}>
            More <ChevronDown className={cn("transition-transform duration-200", more && "rotate-180")} />
          </Button>
          <div className="ml-auto pb-1.5">
            <CheckField checked={guides} onChange={setGuides} label="Guides" hint="Draw each width and prominence" />
          </div>
        </Panel>
      ) : (
        <Panel bodyClassName="flex flex-wrap items-end gap-x-4 gap-y-2 py-2.5">
          <Param label="Upper" hint="Empty = none. ↑/↓ to nudge.">
            <OptNumber value={upper} onChange={setUpper} step={nudge} suffix={unitSuffix} />
          </Param>
          <Param label="Lower" hint="Empty = none. ↑/↓ to nudge.">
            <OptNumber value={lower} onChange={setLower} step={nudge} suffix={unitSuffix} />
          </Param>
          <Param label="Hysteresis" hint="A violation ends once the signal is back inside by this much">
            <OptNumber value={hysteresis} onChange={setHysteresis} step={nudge} />
          </Param>
          <Param label="Min duration" hint="Shorter violations are ignored">
            <OptNumber value={minDuration} onChange={setMinDuration} step={0.1} suffix="s" />
          </Param>
          <div className="ml-auto flex items-center gap-3 pb-1">
            <span
              key={limitSummary.count ? "fail" : "pass"}
              className={cn("animate-in fade-in zoom-in-95 rounded-full px-3 py-1 text-[13px] font-semibold duration-200", limitSummary.count ? "bg-ap-red-soft text-ap-red-dark" : "bg-[#e6f6ef] text-[#0f7a52]")}
            >
              {limitSummary.count ? `FAIL · ${limitSummary.count}` : "PASS"}
            </span>
            <span className="text-[12.5px] text-muted-foreground tabular-nums" title="Time outside the limits">
              {sig(limitSummary.outside, 4)} s · {sig(limitSummary.share, 3)} %
            </span>
          </div>
        </Panel>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className={cn("min-h-0 min-w-0 flex-[3] transition-opacity duration-150", stale && "opacity-80")} bodyClassName="p-1" title={mode === "peaks" ? `${count} found` : `${count} violation${count === 1 ? "" : "s"}`}>
          {panels.length ? <StackedChart panels={panels} xLabel="Time [s]" resetKey={`${column}|${mode}`} time={SECONDS} /> : <EmptyState title="Loading…" />}
        </Panel>
        <Panel
          title={mode === "peaks" ? "Values" : "Violations"}
          className="min-h-0 min-w-0 flex-[2]"
          bodyClassName="flex min-h-0 flex-col gap-2 pt-1"
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={!count && mode === "peaks"} onClick={addToResults} title="Counts, means and extremes to the Results page">
                <ListPlus /> Results
              </Button>
              <Button size="sm" variant="outline" disabled={!count} onClick={exportCsv} title="Every row of the table as a CSV file">
                <Download /> CSV
              </Button>
            </>
          }
        >
          {mode === "peaks" && (peakSummary.max || peakSummary.min) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] tabular-nums">
              {(["max", "min"] as const).map((k) => {
                const s = peakSummary[k];
                if (!s) return null;
                return (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: k === "max" ? PEAK : VALLEY }} />
                    <b>{s.count}</b> {k === "max" ? "peaks" : "valleys"} · mean {sig(s.mean, 4)} · {k === "max" ? "max" : "min"} {sig(s.extreme, 4)}
                    {s.interval !== null && <> · every {sig(s.interval, 3)} s</>}
                  </span>
                );
              })}
            </div>
          )}
          <div className="selectable min-h-0 flex-1 overflow-auto rounded-lg border border-ap-line">
            <table className="w-full border-collapse text-[12.5px] tabular-nums">
              <thead className="sticky top-0 z-10 bg-[#fafbfc] text-left shadow-[0_1px_0_var(--ap-line)]">
                {mode === "peaks" ? (
                  <tr>
                    {["#", "", "Time [s]", u("Value"), u("Prominence"), "Width [s]"].map((h, i) => (
                      <th key={i} className={cn("px-2 py-1.5 font-medium whitespace-nowrap", i > 1 && "text-right")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                ) : (
                  <tr>
                    {["#", "Limit", "Start [s]", "Duration [s]", u("Extreme"), u("Beyond")].map((h, i) => (
                      <th key={i} className={cn("px-2 py-1.5 font-medium whitespace-nowrap", i > 1 && "text-right")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {mode === "peaks"
                  ? peaks.slice(0, MAX_ROWS).map((p, i) => (
                      <tr key={i} onClick={() => setSelected(selected === i ? null : i)} className={cn("cursor-pointer border-b border-ap-line/60 hover:bg-[#f7f8fa]", selected === i && "bg-ap-red-soft")}>
                        <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                        <td className="px-2 py-1">
                          <span className="inline-flex items-center gap-1.5 text-[12px]">
                            <span className="size-2 rounded-full" style={{ background: p.kind === "max" ? PEAK : VALLEY }} />
                            {p.kind === "max" ? "peak" : "valley"}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right">{sig(p.time, 6)}</td>
                        <td className="px-2 py-1 text-right font-medium">{sig(p.value)}</td>
                        <td className="px-2 py-1 text-right">{sig(p.prominence, 4)}</td>
                        <td className="px-2 py-1 text-right">{sig(p.width, 4)}</td>
                      </tr>
                    ))
                  : violations.slice(0, MAX_ROWS).map((v, i) => (
                      <tr key={i} onClick={() => setSelected(selected === i ? null : i)} className={cn("cursor-pointer border-b border-ap-line/60 hover:bg-[#f7f8fa]", selected === i && "bg-ap-red-soft")}>
                        <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                        <td className="px-2 py-1">
                          <span className="inline-flex items-center gap-1.5 text-[12px]">
                            <span className="size-2 rounded-full" style={{ background: v.kind === "upper" ? PEAK : VALLEY }} />
                            {v.kind === "upper" ? "above" : "below"}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right">{sig(v.start, 6)}</td>
                        <td className="px-2 py-1 text-right">{sig(v.duration, 4)}</td>
                        <td className="px-2 py-1 text-right font-medium">{sig(v.extreme)}</td>
                        <td className="px-2 py-1 text-right">{sig(v.excess, 4)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {count > MAX_ROWS && <p className="p-2 text-center text-[12px] text-muted-foreground">First {MAX_ROWS.toLocaleString("en-US")} of {count.toLocaleString("en-US")} shown; CSV has all.</p>}
            {!count && <p className="p-6 text-center text-[13px] text-muted-foreground">{mode === "peaks" ? "None found" : "Inside the limits"}</p>}
          </div>
        </Panel>
      </div>
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}

function Param({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", wide ? "w-[136px]" : "w-28")} title={hint}>
      <span className="ap-caption truncate">{label}</span>
      {children}
    </label>
  );
}
