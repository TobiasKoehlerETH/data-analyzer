import { useEffect, useMemo, useState } from "react";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, Panel, Segmented, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { analysisVectors, type Vectors } from "@/lib/analysis";
import { errorText } from "@/lib/api";
import { seriesColor } from "@/lib/chart";
import { fillMissing, frequencyResponse, medianStep, resonance } from "@/lib/dsp";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const SEGMENTS = [256, 512, 1024, 2048, 4096, 8192, 16384];
const sig = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(4))));

/** Bode plot and coherence from a measured input to a measured output (H1 estimate). */
export function FrfTab() {
  const { dataset, dataVersion, activeTab, addResults } = useApp();
  const [input, setInput] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [nperseg, setNperseg] = useState(1024);
  const [scale, setScale] = useState<"log" | "lin">("log");
  const [data, setData] = useState<Vectors | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dataset) return;
    const cols = dataset.signals.map((s) => s.column);
    setInput((c) => (c && cols.includes(c) ? c : (cols[0] ?? null)));
    setOutput((c) => (c && cols.includes(c) ? c : (cols[1] ?? cols[0] ?? null)));
  }, [dataset]);

  useEffect(() => {
    if (activeTab !== "frf" || !input || !output) return;
    let cancelled = false;
    setLoading(true);
    analysisVectors([...new Set([input, output])])
      .then((v) => !cancelled && (setData(v), setError("")))
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [input, output, dataVersion, activeTab]);

  const fs = useMemo(() => (data ? 1 / medianStep(data.time) : 1), [data]);
  const h = useMemo(() => {
    if (!data || !input || !output || !data.columns[input] || !data.columns[output]) return null;
    return frequencyResponse(fillMissing(data.columns[input]), fillMissing(data.columns[output]), fs, nperseg);
  }, [data, input, output, fs, nperseg]);
  const peak = useMemo(() => (h ? resonance(h) : null), [h]);

  const info = (c: string | null) => dataset?.signals.find((s) => s.column === c);
  const gainUnit = info(output)?.unit && info(input)?.unit ? `${info(output)!.unit}/${info(input)!.unit}` : "";

  const panels: ChartPanel[] = useMemo(() => {
    if (!h) return [];
    const xy = (y: number[]) => h.f.map((f, i) => [f, y[i]] as [number, number]);
    return [
      {
        id: "mag",
        yLabel: `Gain [dB${gainUnit ? ` re 1 ${gainUnit}` : ""}]`,
        series: [{ name: "Gain", color: seriesColor(0), data: xy(h.magDb) }],
        points: peak ? [{ x: peak.f, y: peak.gainDb, label: `${sig(peak.f)} Hz · ${sig(peak.gainDb)} dB` }] : [],
        hLines: peak ? [{ y: peak.gainDb - 3, label: "−3 dB" }] : [],
      },
      { id: "phase", yLabel: "Phase [°]", series: [{ name: "Phase", color: seriesColor(1), data: xy(h.phase) }] },
      { id: "coh", yLabel: "Coherence", hLines: [{ y: 1 }], series: [{ name: "Coherence", color: seriesColor(2), data: xy(h.coherence) }] },
    ];
  }, [h, peak, gainUnit]);

  const meanCoherence = h && h.coherence.length ? h.coherence.reduce((a, b) => a + b, 0) / h.coherence.length : null;

  const add = () => {
    if (!h || !peak) return;
    const signal = `${info(input)?.label ?? input} → ${info(output)?.label ?? output}`;
    const group = `Frequency response ${signal}`;
    const rows = [
      { name: "Peak frequency", value: peak.f, unit: "Hz" },
      { name: "Peak gain", value: peak.gainDb, unit: "dB" },
      { name: "Gain at lowest frequency", value: h.magDb[0], unit: "dB" },
      ...(peak.low !== null && peak.high !== null ? [{ name: "−3 dB bandwidth", value: peak.high - peak.low, unit: "Hz" }] : []),
      ...(meanCoherence !== null ? [{ name: "Mean coherence", value: meanCoherence, unit: "" }] : []),
    ];
    addResults(rows.map((r) => ({ ...r, group, signal, source: "Frequency response" })));
    toast.success(`${rows.length} results added`);
  };

  if (!dataset) return <EmptyState title="No data loaded" />;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Field label="Input" className="w-[280px]" hint="The excitation (force, voltage, command)">
          <SignalSelect signals={dataset.signals} value={input} onChange={setInput} edited={dataset.edited} />
        </Field>
        <Field label="Output" className="w-[280px]" hint="The response (acceleration, position, current)">
          <SignalSelect signals={dataset.signals} value={output} onChange={setOutput} edited={dataset.edited} />
        </Field>
        <Field label="Segment" className="w-36" hint="Samples per averaged segment: longer gives finer frequency, shorter a smoother estimate">
          <Select value={String(nperseg)} onValueChange={(v) => setNperseg(Number(v))}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEGMENTS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {w}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Segmented
          value={scale}
          onChange={setScale}
          options={[
            { value: "log", label: "Log f" },
            { value: "lin", label: "Linear f" },
          ]}
        />
        {h && (
          <p className="text-[12.5px] text-muted-foreground tabular-nums" title="H1 = Gxy / Gxx, Hann window, 50 % overlap">
            {h.segments} averages · Δf {sig(fs / Math.min(nperseg, 2 ** Math.floor(Math.log2(Math.max(8, data?.time.length ?? 8)))))} Hz
            {meanCoherence !== null && <> · mean coherence {sig(meanCoherence)}</>}
          </p>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={!peak} onClick={add} title="Peak frequency and gain, −3 dB bandwidth, low-frequency gain and mean coherence">
          <ListPlus /> Add to results
        </Button>
      </div>
      {input === output && <StatusText>Input and output are the same signal: the gain is 1 everywhere.</StatusText>}
      <Panel title="Bode plot" className={cn("min-h-0 flex-1 transition-opacity", loading && "opacity-60")} bodyClassName="p-1">
        {panels.length ? (
          <StackedChart panels={panels} xLabel="Frequency [Hz]" xLog={scale === "log"} resetKey={`${input}|${output}|${scale}|${nperseg}`} />
        ) : (
          <EmptyState title={loading ? "Loading…" : "Pick an input and an output"}>Both signals must be sampled together for long enough to fill at least one segment.</EmptyState>
        )}
      </Panel>
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}
