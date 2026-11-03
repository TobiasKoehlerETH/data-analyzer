import { useEffect, useMemo, useState } from "react";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, NumberInput, Panel, Segmented, StatusText } from "@/components/common";
import { Plot } from "@/components/Plot";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { analysisVectors, type Vectors } from "@/lib/analysis";
import { errorText } from "@/lib/api";
import { axis, baseLayout, INK, SEQUENTIAL, seriesColor } from "@/lib/chart";
import { angleResample, fillMissing, medianStep, orderMap, orderSpectrum, spectrogram } from "@/lib/dsp";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const WINDOWS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const sig = (v: number) => String(Number(v.toPrecision(4)));

/** Time-filled copy of the dataset time axis (missing rows interpolated). */
const timeAxis = (v: Vectors) => fillMissing(v.time);

function heatmapLayout(xLabel: string, yLabel: string) {
  return baseLayout({
    hovermode: "closest",
    margin: { l: 64, r: 16, t: 8, b: 44 },
    xaxis: axis(xLabel, { showgrid: false }),
    yaxis: axis(yLabel, { showgrid: false }),
  });
}

/** How the frequency content changes over time, or over shaft speed (order analysis). */
export function SpectrogramTab() {
  const { dataset, dataVersion, activeTab, addResults } = useApp();
  const [mode, setMode] = useState<"time" | "order">("time");
  const [column, setColumn] = useState<string | null>(null);
  const [nfft, setNfft] = useState(1024);
  const [overlap, setOverlap] = useState(75);
  const [fmax, setFmax] = useState(0);
  const [range, setRange] = useState(60);
  const [speed, setSpeed] = useState<string | null>(null);
  const [speedUnit, setSpeedUnit] = useState<"rpm" | "hz">("rpm");
  const [spr, setSpr] = useState(64);
  const [frameRevs, setFrameRevs] = useState(16);
  const [maxOrder, setMaxOrder] = useState(20);
  const [data, setData] = useState<Vectors | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dataset) return;
    const cols = dataset.signals.map((s) => s.column);
    setColumn((c) => (c && cols.includes(c) ? c : (cols[0] ?? null)));
    // A signal named like a speed is the likely tacho.
    setSpeed((s) => (s && cols.includes(s) ? s : (dataset.signals.find((x) => /rpm|speed|drehzahl|tacho/i.test(x.label))?.column ?? cols[1] ?? cols[0] ?? null)));
  }, [dataset]);

  const columns = useMemo(() => [...new Set([column, ...(mode === "order" ? [speed] : [])].filter((c): c is string => !!c))], [column, speed, mode]);
  useEffect(() => {
    if (activeTab !== "spectrogram" || !columns.length) return;
    let cancelled = false;
    setLoading(true);
    analysisVectors(columns)
      .then((v) => !cancelled && (setData(v), setError("")))
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [columns.join("|"), dataVersion, activeTab]);

  const fs = useMemo(() => (data ? 1 / medianStep(data.time) : 1), [data]);
  const label = (c: string | null) => dataset?.signals.find((s) => s.column === c)?.label ?? c ?? "";

  const spec = useMemo(() => {
    if (mode !== "time" || !data || !column || !data.columns[column]) return null;
    const t = timeAxis(data);
    return spectrogram(fillMissing(data.columns[column]), fs, { nfft, overlap: overlap / 100, t0: t[0] ?? 0, fmax: fmax > 0 ? fmax : undefined, maxFrames: 700, maxBins: 400 });
  }, [mode, data, column, fs, nfft, overlap, fmax]);

  const orders = useMemo(() => {
    if (mode !== "order" || !data || !column || !speed || !data.columns[column] || !data.columns[speed]) return null;
    const t = timeAxis(data);
    const sp = fillMissing(data.columns[speed]);
    const revPerSec = Float64Array.from(sp, (v) => (speedUnit === "rpm" ? v / 60 : v));
    const a = angleResample(t, fillMissing(data.columns[column]), revPerSec, spr);
    if (a.y.length < 16) return { error: "The shaft turns less than one frame. Check the speed signal and its unit." as const };
    const spectrum = orderSpectrum(a, spr, frameRevs);
    const map = orderMap(a, spr, frameRevs, Math.min(maxOrder, spr / 2));
    // rpm on the y axis when the speed only rises or only falls; otherwise time.
    const inc = map.rpm.every((v, i) => i === 0 || v > map.rpm[i - 1]);
    const dec = map.rpm.every((v, i) => i === 0 || v < map.rpm[i - 1]);
    return { spectrum, map, byRpm: map.rpm.length > 1 && (inc || dec), revs: a.revs.length / spr };
  }, [mode, data, column, speed, speedUnit, spr, frameRevs, maxOrder]);

  const specFigure = useMemo(() => {
    if (!spec) return null;
    let zmax = -Infinity;
    for (const row of spec.power) for (const v of row) if (v > zmax) zmax = v;
    return {
      data: [
        {
          type: "heatmap",
          x: spec.times,
          y: spec.freqs,
          z: spec.power,
          zmin: zmax - range,
          zmax,
          colorscale: SEQUENTIAL,
          colorbar: { thickness: 10, len: 0.9, outlinewidth: 0, tickfont: { size: 11, color: INK.muted }, title: { text: "dB", font: { size: 12, color: INK.secondary } } },
          hovertemplate: "%{x:.4~g} s · %{y:.4~g} Hz<br><b>%{z:.1f} dB</b><extra></extra>",
        },
      ],
      layout: heatmapLayout("Time [s]", "Frequency [Hz]"),
    };
  }, [spec, range]);

  const orderFigure = useMemo(() => {
    if (!orders || "error" in orders) return null;
    const { map, byRpm } = orders;
    let zmax = 0;
    for (const row of map.amplitude) for (const v of row) if (v > zmax) zmax = v;
    // Frames along y: transpose to z[frame][order].
    const z = map.rpm.map((_, f) => map.amplitude.map((row) => row[f]));
    return {
      data: [
        {
          type: "heatmap",
          x: map.orders,
          y: byRpm ? map.rpm : map.time,
          z,
          zmin: 0,
          zmax: zmax || 1,
          colorscale: SEQUENTIAL,
          colorbar: { thickness: 10, len: 0.9, outlinewidth: 0, tickfont: { size: 11, color: INK.muted }, title: { text: "Amp.", font: { size: 12, color: INK.secondary } } },
          hovertemplate: `order %{x:.3~g} · %{y:.4~g} ${byRpm ? "rpm" : "s"}<br><b>%{z:.4~g}</b><extra></extra>`,
        },
      ],
      layout: heatmapLayout("Order", byRpm ? "Speed [rpm]" : "Time [s]"),
    };
  }, [orders]);

  const spectrumPanels: ChartPanel[] = useMemo(() => {
    if (!orders || "error" in orders) return [];
    const s = orders.spectrum;
    const keep = s.orders.map((o, i) => [o, s.amplitude[i]] as [number, number]).filter(([o]) => o <= maxOrder);
    let k = 0;
    keep.forEach(([, a], i) => a > keep[k][1] && (k = i));
    return [
      {
        id: "orders",
        yLabel: `Amplitude${dataset?.signals.find((x) => x.column === column)?.unit ? ` [${dataset.signals.find((x) => x.column === column)!.unit}]` : ""}`,
        series: [{ name: "Order spectrum", color: seriesColor(0), data: keep }],
        points: keep.length ? [{ x: keep[k][0], y: keep[k][1], label: `order ${sig(keep[k][0])}` }] : [],
      },
    ];
  }, [orders, maxOrder, column, dataset]);

  const addOrders = () => {
    if (!orders || "error" in orders) return;
    const s = orders.spectrum;
    const unit = dataset?.signals.find((x) => x.column === column)?.unit ?? "";
    const ranked = s.orders.map((o, i) => ({ o, a: s.amplitude[i] })).filter((p) => p.o <= maxOrder);
    // The three strongest peaks (local maxima), largest first.
    const peaks = ranked.filter((p, i) => i > 0 && i < ranked.length - 1 && p.a >= ranked[i - 1].a && p.a >= ranked[i + 1].a).sort((a, b) => b.a - a.a).slice(0, 3);
    const group = `Orders of ${label(column)}`;
    addResults(
      peaks.flatMap((p, i) => [
        { group, name: `Peak ${i + 1} order`, signal: label(column), value: p.o, unit: "", source: "Spectrogram" },
        { group, name: `Peak ${i + 1} amplitude`, signal: label(column), value: p.a, unit, source: "Spectrogram" },
      ]),
    );
    toast.success(`${peaks.length * 2} results added`);
  };

  if (!dataset) return <EmptyState title="No data loaded" />;

  const nyquist = fs / 2;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "time", label: "Spectrogram", hint: "Frequency content over time" },
            { value: "order", label: "Order analysis", hint: "Content in multiples of a shaft speed" },
          ]}
        />
        <Field label="Signal" className="w-[300px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} />
        </Field>
        {mode === "time" ? (
          <>
            <Field label="Window" className="w-36" hint="Samples per frame: longer gives finer frequency, shorter finer time">
              <Select value={String(nfft)} onValueChange={(v) => setNfft(Number(v))}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w} value={String(w)}>
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Overlap" className="w-32">
              <NumberInput value={overlap} min={0} max={95} step={5} suffix="%" onChange={setOverlap} />
            </Field>
            <Field label="Up to" className="w-36" hint={`0 = up to half the sample rate (${sig(nyquist)} Hz)`}>
              <NumberInput value={fmax} min={0} max={nyquist} step={1} suffix="Hz" onChange={setFmax} />
            </Field>
            <Field label="Range" className="w-32" hint="Colour range below the strongest value">
              <NumberInput value={range} min={10} max={200} step={10} suffix="dB" onChange={setRange} />
            </Field>
            {spec && (
              <p className="text-[12.5px] text-muted-foreground tabular-nums">
                Δf {sig(fs / spec.nfft)} Hz · Δt {sig(spec.hop / fs)} s
              </p>
            )}
          </>
        ) : (
          <>
            <Field label="Speed" className="w-[260px]" hint="The shaft speed signal (tacho)">
              <SignalSelect signals={dataset.signals} value={speed} onChange={setSpeed} />
            </Field>
            <Segmented
              value={speedUnit}
              onChange={setSpeedUnit}
              options={[
                { value: "rpm", label: "rpm" },
                { value: "hz", label: "rev/s" },
              ]}
            />
            <Field label="Samples/rev" className="w-40" hint="Angle resolution; the highest order is half of this">
              <Select value={String(spr)} onValueChange={(v) => setSpr(Number(v))}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[16, 32, 64, 128, 256].map((w) => (
                    <SelectItem key={w} value={String(w)}>
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Frame" className="w-36" hint="Revolutions per frame: longer gives finer orders">
              <NumberInput value={frameRevs} min={1} max={256} step={1} integer suffix="rev" onChange={setFrameRevs} />
            </Field>
            <Field label="Max order" className="w-32">
              <NumberInput value={maxOrder} min={1} max={spr / 2} step={1} onChange={setMaxOrder} />
            </Field>
          </>
        )}
      </div>

      {mode === "time" ? (
        <Panel title={`Spectrogram of ${label(column)}`} className={cn("min-h-0 flex-1 transition-opacity", loading && "opacity-60")} bodyClassName="p-1">
          {specFigure ? <Plot data={specFigure.data} layout={specFigure.layout} uirevision={`${column}|${nfft}`} /> : <EmptyState title={loading ? "Loading…" : "No data"} />}
        </Panel>
      ) : orders && "error" in orders ? (
        <EmptyState title="No order analysis">{orders.error}</EmptyState>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-3 transition-opacity", loading && "opacity-60")}>
          <Panel title={orders ? `Order map · ${sig(orders.revs)} revolutions` : "Order map"} className="min-h-0 flex-[3]" bodyClassName="p-1">
            {orderFigure ? <Plot data={orderFigure.data} layout={orderFigure.layout} uirevision={`${column}|${speed}`} /> : <EmptyState title={loading ? "Loading…" : "No data"} />}
          </Panel>
          <Panel
            title="Order spectrum"
            className="min-h-0 flex-[2]"
            bodyClassName="p-1"
            actions={
              <Button size="sm" variant="outline" disabled={!spectrumPanels.length} onClick={addOrders} title="The three strongest orders and their amplitudes">
                <ListPlus /> Add to results
              </Button>
            }
          >
            {spectrumPanels.length ? <StackedChart panels={spectrumPanels} xLabel="Order" resetKey={`${column}|${speed}`} /> : <EmptyState title="No data" />}
          </Panel>
        </div>
      )}
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}
