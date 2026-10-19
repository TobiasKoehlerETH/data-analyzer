import { useEffect, useMemo, useState } from "react";
import { AudioWaveform } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Field, NumberInput, Panel, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import { api, errorText, type SpectrumView, type Xy } from "@/lib/api";
import { INK, seriesColor } from "@/lib/chart";
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
  const { dataset, dataVersion, setDataset } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [nperseg, setNperseg] = useState(4096);
  const [view, setView] = useState<SpectrumView | null>(null);
  const [cutoff, setCutoff] = useState(0.1);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setColumn(dataset?.signals[0]?.column ?? null);
    if (dataset) setCutoff(Math.min(0.1, dataset.sample_rate / 4));
  }, [dataset?.path]);

  useEffect(() => setInfo(""), [column]);

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
          setInfo((prev) => (prev.startsWith("Low-pass at") ? prev : `Detected ${v.n_peaks} significant frequency peaks. Drag the cutoff line or click the PSD to move it.`));
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
              series: [{ name: "FFT", color: seriesColor(0), data: positive(view.fft) }],
            },
          ]
        : [],
    [view],
  );

  const psdPanels: ChartPanel[] = useMemo(() => {
    if (!view) return [];
    // With processing steps, the imported signal's PSD recedes to gray behind the current one.
    const series: ChartSeries[] = view.psd_original
      ? [
          { name: "Original", color: INK.muted, data: positive(view.psd_original) },
          { name: "Edited", color: seriesColor(0), data: positive(view.psd) },
        ]
      : [{ name: "PSD", color: seriesColor(0), data: positive(view.psd) }];
    return [
      {
        id: "psd",
        yLabel: "PSD",
        yLog: true,
        series,
        points: view.peaks.filter((p) => p.amplitude > 0).map((p) => ({ x: p.frequency, y: p.amplitude, label: `${p.frequency.toFixed(4)} Hz` })),
        vLines: [{ x: cutoff, draggable: true, label: `Cutoff ${cutoff.toFixed(4)} Hz` }],
      },
    ];
  }, [view, cutoff]);

  if (!dataset) return <EmptyState title="No data loaded">Load a file in the File tab to analyse spectra.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-4">
        <Field label="Signal" className="w-[460px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} title="Select the signal to compute the frequency spectrum for" />
        </Field>
        <Field label="PSD nperseg" className="w-56" hint="Number of samples per Welch segment. Higher = smoother PSD, lower = more detail">
          <NumberInput value={nperseg} min={64} max={65536} step={256} integer onChange={setNperseg} />
        </Field>
        <Field label="Cutoff" className="w-52" hint="Drag the cutoff line in the PSD plot, click the plot or type a frequency">
          <NumberInput value={Number(cutoff.toFixed(6))} min={0} max={view?.nyquist ?? 1e6} step={0.001} suffix="Hz" onChange={setCutoff} />
        </Field>
        <Button
          size="sm"
          variant="outline"
          disabled={!column || !view || cutoff <= 0 || cutoff >= view.nyquist}
          title="Add a 4th-order low-pass at the cutoff to this signal's steps (undo or reset in Prepare)"
          onClick={async () => {
            if (!column) return;
            try {
              const v = await api.workspaceEdit(column, "edit", { op: "filter", value: { filter_type: "lowpass", params: { cutoff, order: 4 }, enabled: true } });
              setDataset(v.dataset);
              setError("");
              setInfo(`Low-pass at ${cutoff.toFixed(4)} Hz added to ${column}. Undo or reset it in Prepare.`);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          <AudioWaveform /> Add low-pass at cutoff
        </Button>
        {view && view.nperseg_used < nperseg && <span className="text-xs text-muted-foreground">Signal shorter than nperseg — using {view.nperseg_used}.</span>}
      </div>
      <Panel title="FFT magnitude spectrum" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={fftPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} />}
      </Panel>
      <Panel title="Power spectral density (Welch)" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={psdPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} onDragLine={(x) => {
              const f = Math.max(0, x);
              setCutoff(f);
              setInfo(`Cutoff frequency: ${f.toFixed(4)} Hz`);
            }} />}
      </Panel>
      <StatusText tone={error ? "error" : "muted"}>{error || info}</StatusText>
    </div>
  );
}
