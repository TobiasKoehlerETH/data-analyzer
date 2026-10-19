import { useEffect, useMemo, useState } from "react";
import { message } from "@/lib/platform";
import { Eraser, Layers, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckField, EmptyState, Field, NumberInput, Panel, StatusText } from "@/components/common";
import { ModelSelect } from "@/components/ModelSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type SimulationView } from "@/lib/api";
import { seriesColor, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

export function SimulationTab() {
  const { dataset } = useApp();
  const [model, setModel] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(1);
  const [autoX0, setAutoX0] = useState(true);
  const [view, setView] = useState<SimulationView | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const n = dataset?.n_samples ?? 0;

  useEffect(() => {
    setStart(0);
    setEnd(n);
    setView(null);
  }, [dataset?.path, n]);

  const run = async (append: boolean) => {
    if (!model) {
      await message("Select a model first.", { title: "No Model", kind: "warning" });
      return;
    }
    try {
      setView(await api.simulationRun(model, start, end, autoX0, append));
      setStatus({ text: `Simulation complete for '${model}'.` });
    } catch (e) {
      setStatus({ text: `Error: ${errorText(e)}`, error: true });
    }
  };

  const panels: ChartPanel[] = useMemo(
    () =>
      (view?.plots ?? []).map((p) => ({
        id: p.output,
        yLabel: p.label,
        legend: true,
        series: [
          { name: "Measured", color: seriesColor(0), data: zip(p.measured.x, p.measured.y) },
          ...p.simulated.map((s, i) => ({ name: `Sim: ${s.model}`, color: seriesColor(i + 1), data: zip(s.x, s.y) })),
        ],
      })),
    [view],
  );

  if (!dataset) return <EmptyState title="No data loaded">Load the measurement file the model's signals come from.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Field label="Model" className="w-[420px]">
          <ModelSelect value={model} onChange={setModel} title="Select the identified model to simulate" />
        </Field>
        <Field label="Start" className="w-40" hint="Starting sample index">
          <NumberInput value={start} min={0} max={Math.max(0, n - 1)} integer onChange={setStart} />
        </Field>
        <Field label="End" className="w-40" hint="Ending sample index">
          <NumberInput value={end} min={1} max={n} integer onChange={setEnd} />
        </Field>
        <CheckField checked={autoX0} onChange={setAutoX0} label="Auto x0" hint="Estimate the initial state vector from data (least squares on the observability matrix)" />
        <Button onClick={() => run(false)} title="Run the simulation and plot measured vs. simulated outputs">
          <Play /> Simulate
        </Button>
        <Button variant="outline" onClick={() => run(true)} title="Overlay another model's simulation on the current plot">
          <Layers /> Add Model Overlay
        </Button>
        <Button variant="outline" onClick={async () => { await api.simulationClear(); setView(null); setStatus({ text: "" }); }}>
          <Eraser /> Clear
        </Button>
      </div>
      <Panel className="min-h-0 flex-1" bodyClassName="p-1" title={view ? `Measured vs simulated · ${view.models.join(", ")}` : "Measured vs simulated"}>
        {panels.length ? (
          <StackedChart panels={panels} xLabel="Time [s]" resetKey={view?.models.join("|")} />
        ) : (
          <EmptyState title="No simulation yet">Pick a model from the library and click Simulate. Inputs and outputs are mean-removed and decimated exactly as during identification.</EmptyState>
        )}
      </Panel>
      <StatusText tone={status.error ? "error" : "muted"}>{status.text}</StatusText>
    </div>
  );
}
