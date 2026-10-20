import { useEffect, useMemo, useState } from "react";
import { AudioWaveform } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, Field, NumberInput, Panel, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import { api, errorText, type SpectrumView, type Xy } from "@/lib/api";
import { INK, seriesColor } from "@/lib/chart";
import { useApp } from "@/lib/store";

/** Samples per Welch segment: a good balance between smooth and detailed. */
const NPERSEG = 4096;

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
  const [view, setView] = useState<SpectrumView | null>(null);
  const [cutoff, setCutoff] = useState(0.1);
  const [error, setError] = useState("");

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
        .spectrum(column, NPERSEG)
        .then((v) => {
          setView(v);
          setError("");
        })
        .catch((e) => setError(errorText(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [column, dataVersion, dataset]);

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
        vLines: [{ x: cutoff, draggable: true }],
      },
    ];
  }, [view, cutoff]);

  if (!dataset) return <EmptyState title="No data loaded" />;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Field label="Signal" className="w-[360px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} />
        </Field>
        <Field label="Cutoff" className="w-48" hint="Drag the line in the lower plot, click it, or type a frequency">
          <NumberInput value={Number(cutoff.toFixed(6))} min={0} max={view?.nyquist ?? 1e6} step={0.001} suffix="Hz" onChange={setCutoff} />
        </Field>
        <Button
          variant="outline"
          disabled={!column || !view || cutoff <= 0 || cutoff >= view.nyquist}
          title="Adds a low-pass at the cutoff to this signal's steps in Prepare"
          onClick={async () => {
            if (!column) return;
            try {
              const v = await api.workspaceEdit(column, "edit", { op: "filter", value: { filter_type: "lowpass", params: { cutoff, order: 4 }, enabled: true } });
              setDataset(v.dataset);
              setError("");
              toast.success(`Low-pass at ${cutoff.toFixed(4)} Hz added`);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          <AudioWaveform /> Add low-pass
        </Button>
      </div>
      <Panel title="Magnitude" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={fftPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} />}
      </Panel>
      <Panel title="Power density" className="min-h-0 flex-1" bodyClassName="p-1">
        {view && <StackedChart panels={psdPanels} xLabel="Frequency [Hz]" resetKey={column ?? ""} onDragLine={(x) => setCutoff(Math.max(0, x))} />}
      </Panel>
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}
