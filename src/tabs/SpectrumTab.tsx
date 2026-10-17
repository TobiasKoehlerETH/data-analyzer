import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Field, NumberInput, Panel, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import type { EChartsInstance } from "@/components/EChart";
import { api, errorText, type SpectrumView, type Xy } from "@/lib/api";
import { useApp } from "@/lib/store";

function positive(xy: Xy): [number | null, number | null][] {
  const out: [number | null, number | null][] = [];
  for (let i = 0; i < xy.x.length; i++) {
    const y = xy.y[i];
    out.push([xy.x[i], y !== null && y > 0 ? y : null]);
  }
  return out;
}

export function SpectrumTab() {
  const { dataset, dataVersion } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [nperseg, setNperseg] = useState(4096);
  const [view, setView] = useState<SpectrumView | null>(null);
  const [cutoff, setCutoff] = useState(0.1);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const dragging = useRef(false);
  const cutoffRef = useRef(cutoff);
  cutoffRef.current = cutoff;

  useEffect(() => {
    setColumn(dataset?.signals[0]?.column ?? null);
    if (dataset) setCutoff(Math.min(0.1, dataset.sample_rate / 4));
  }, [dataset?.path]);

  useEffect(() => {
    if (!column || !dataset) {
      setView(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .spectrum(column, nperseg)
        .then((v) => {
          setView(v);
          setError("");
          setInfo(`Detected ${v.n_peaks} significant frequency peaks. Drag the red line to set the cutoff.`);
        })
        .catch((e) => setError(errorText(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [column, nperseg, dataVersion, dataset]);

  const fftPanels: ChartPanel[] = useMemo(
    () =>
      view
        ? [
            {
              id: "fft",
              yLabel: "Magnitude",
              yLog: true,
              series: [{ name: "FFT", color: "#274259", data: positive(view.fft), width: 1 }],
              vLines: view.peaks.map((p) => ({ x: p.frequency, color: "#ff2400", dashed: true, label: `${p.frequency.toFixed(4)} Hz` })),
            },
          ]
        : [],
    [view],
  );

  const psdPanels: ChartPanel[] = useMemo(() => {
    if (!view) return [];
    const series: ChartSeries[] = [{ name: "Original", color: "#274259", data: positive(view.psd), width: 1.4 }];
    if (view.psd_filtered) series.push({ name: "Filtered", color: "#ff2400", data: positive(view.psd_filtered), width: 1.4, dashed: true });
    return [
      {
        id: "psd",
        yLabel: "PSD",
        yLog: true,
        legend: true,
        series,
        vLines: [{ x: cutoff, color: "#ff2400", label: `Cutoff=${cutoff.toFixed(4)} Hz` }],
      },
    ];
  }, [view, cutoff]);

  const attachDrag = (chart: EChartsInstance) => {
    const zr = chart.getZr();
    const toX = (e: { offsetX: number; offsetY: number }) => {
      if (!chart.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return null;
      return (chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as number[])[0];
    };
    zr.on("mousedown", (e: { offsetX: number; offsetY: number }) => {
      const x = toX(e);
      if (x === null) return;
      const px = chart.convertToPixel({ gridIndex: 0 }, [cutoffRef.current, 1]) as number[];
      dragging.current = true;
      if (Math.abs(px[0] - e.offsetX) > 8) setCutoff(Math.max(0, x));
    });
    zr.on("mousemove", (e: { offsetX: number; offsetY: number }) => {
      if (!dragging.current) return;
      const x = toX(e);
      if (x !== null) setCutoff(Math.max(0, x));
    });
    zr.on("mouseup", () => {
      if (dragging.current) setInfo(`Cutoff frequency: ${cutoffRef.current.toFixed(4)} Hz`);
      dragging.current = false;
    });
  };

  if (!dataset) return <EmptyState title="No data loaded">Load a file in the File tab to analyse spectra.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-4">
        <Field label="Signal" className="w-[460px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} filtered={dataset.filtered} title="Select the signal to compute the frequency spectrum for" />
        </Field>
        <Field label="PSD nperseg" className="w-56" hint="Number of samples per Welch segment. Higher = smoother PSD, lower = more detail">
          <NumberInput value={nperseg} min={64} max={65536} step={256} integer onChange={setNperseg} />
        </Field>
        <Field label="Cutoff" className="w-52" hint="Drag the red line in the PSD plot or type a frequency">
          <NumberInput value={Number(cutoff.toFixed(6))} min={0} max={view?.nyquist ?? 1e6} step={0.001} suffix="Hz" onChange={setCutoff} />
        </Field>
        {view && view.nperseg_used < nperseg && <span className="text-xs text-muted-foreground">Signal shorter than nperseg — using {view.nperseg_used}.</span>}
      </div>
      <Panel title="FFT magnitude spectrum" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={fftPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} />}
      </Panel>
      <Panel title="Power spectral density (Welch)" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={psdPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} panOnDrag={false} onReady={attachDrag} />}
      </Panel>
      <StatusText tone={error ? "error" : "muted"}>{error || info}</StatusText>
    </div>
  );
}
