import { useEffect, useMemo, useState } from "react";
import { listen } from "@/lib/platform";
import { message } from "@/lib/platform";
import { Play, Save, Square, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckList, EmptyState, Field, NumberInput, Panel, StaleNote, StatusText } from "@/components/common";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { seriesColor } from "@/lib/chart";
import { api, errorText, type ProgressEvent, type SysIdRow } from "@/lib/api";
import { useApp } from "@/lib/store";

const SETPOINT = ["setpoint", "set_point"];
const COMMAND = ["heater", "water_valve"];
const OUTPUT = ["measured", "t_left", "t_right", "leakage", "pressure", "vibration"];
const EXCLUDE = ["max_", "min_", "setpoint", "heater", "water_valve"];

export function SysIdTab() {
  const { dataset, refreshModels } = useApp();
  const [inputs, setInputs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [name, setName] = useState("Model");
  const [method, setMethod] = useState("N4SID");
  const [orderMin, setOrderMin] = useState(1);
  const [orderMax, setOrderMax] = useState(10);
  const [decimation, setDecimation] = useState(1);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [estimate, setEstimate] = useState("Estimated time: —");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [results, setResults] = useState<SysIdRow[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [ranAt, setRanAt] = useState<number | null>(null);

  const n = dataset?.n_samples ?? 0;

  // Keep results and selections across edits; drop only signals that no longer exist.
  useEffect(() => {
    const cols = new Set(dataset?.signals.map((s) => s.column));
    setInputs((v) => v.filter((c) => cols.has(c)));
    setOutputs((v) => v.filter((c) => cols.has(c)));
    setStart(0);
    setEnd(n);
  }, [dataset, n]);

  useEffect(() => {
    const un = listen<ProgressEvent>("progress", (e) => {
      if (e.payload.task === "sysid") setStatus({ text: e.payload.message });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const samples = Math.max(1, Math.floor((end - start) / Math.max(1, decimation)));
    api
      .sysidEstimateTime(samples, Math.max(1, inputs.length), Math.max(1, outputs.length), orderMin, orderMax)
      .then((t) => setEstimate(`Estimated time: ~${t.toFixed(1)}s (${samples} samples after decimation)`));
  }, [inputs, outputs, orderMin, orderMax, decimation, start, end]);

  const autoSuggest = () => {
    if (!dataset) return;
    const cols = dataset.signals.map((s) => s.column);
    setInputs(cols.filter((c) => [...SETPOINT, ...COMMAND].some((k) => c.toLowerCase().includes(k))));
    setOutputs(cols.filter((c) => OUTPUT.some((k) => c.toLowerCase().includes(k)) && !EXCLUDE.some((k) => c.toLowerCase().includes(k))));
  };

  const autoDecimate = async () => {
    const cols = [...inputs, ...outputs];
    if (!cols.length) return;
    try {
      setDecimation(Math.max(1, await api.sysidAutoDecimation(cols)));
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
  };

  const identify = async () => {
    if (!inputs.length || !outputs.length) {
      await message("Select at least one input and one output signal.", { title: "Selection Required", kind: "warning" });
      return;
    }
    setRunning(true);
    setStatus({ text: "Identifying..." });
    setSaved([]);
    try {
      const r = await api.sysidIdentify({ inputs, outputs, name, method, order_min: orderMin, order_max: Math.max(orderMin, orderMax), decimation, start, end });
      setResults(r);
      setRanAt(useApp.getState().dataVersion);
      setStatus({ text: `Done — ${r.length} models identified.` });
    } catch (e) {
      setStatus({ text: `Error: ${errorText(e)}`, error: true });
      useApp.getState().setProgress("sysid", 100, "");
    } finally {
      setRunning(false);
    }
  };

  const vafPanels: ChartPanel[] = useMemo(() => {
    const sorted = [...results].sort((a, b) => a.order - b.order);
    return sorted.length
      ? [
          {
            id: "vaf",
            yLabel: "VAF [%]",
            series: [
              { name: "Mean VAF", color: seriesColor(0), data: sorted.map((r) => [r.order, r.mean_vaf] as [number, number]) },
              { name: "Best VAF", color: seriesColor(1), data: sorted.map((r) => [r.order, r.best_vaf] as [number, number]) },
            ],
          },
        ]
      : [];
  }, [results]);

  if (!dataset) return <EmptyState title="No data loaded">Load a file in the File tab to identify state-space models.</EmptyState>;

  const items = dataset.signals.map((s) => ({ id: s.column, label: s.label }));

  return (
    <div className="flex h-full gap-3">
      <div className="flex w-[290px] shrink-0 flex-col gap-3">
        <Panel title={`Input signals (u) · ${inputs.length}`} className="min-h-0 flex-1" bodyClassName="p-1">
          <CheckList className="h-full" items={items} checked={inputs} onChange={setInputs} />
        </Panel>
        <Panel title={`Output signals (y) · ${outputs.length}`} className="min-h-0 flex-1" bodyClassName="p-1">
          <CheckList className="h-full" items={items} checked={outputs} onChange={setOutputs} />
        </Panel>
        <Button variant="outline" onClick={autoSuggest} title="Setpoints / heaters / valves → inputs; temperatures / pressures / leakage → outputs">
          <Wand2 /> Auto-Suggest I/O
        </Button>
      </div>

      <div className="flex w-[330px] shrink-0 flex-col gap-3">
        <Panel title="Parameters" bodyClassName="flex flex-col gap-2">
          <Field label="Model name">
            <Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Method" hint="Subspace identification weighting: N4SID, MOESP or CVA">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["N4SID", "MOESP", "CVA"].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Field label="Order min" hint="Minimum model order of the sweep">
              <NumberInput value={orderMin} min={1} max={50} integer onChange={setOrderMin} />
            </Field>
            <Field label="max" hint="Maximum model order of the sweep">
              <NumberInput value={orderMax} min={1} max={50} integer onChange={setOrderMax} />
            </Field>
          </div>
          <div className="flex items-end gap-2">
            <Field label="Decimation" className="flex-1" hint="Downsample the data before identification to speed it up">
              <NumberInput value={decimation} min={1} max={1000} integer onChange={setDecimation} />
            </Field>
            <Button size="sm" variant="outline" onClick={autoDecimate} title="Estimate decimation from the signal bandwidths (≈4× the highest knee frequency)">
              Auto
            </Button>
          </div>
          <div className="flex gap-2">
            <Field label="Window start" hint="First sample index">
              <NumberInput value={start} min={0} max={Math.max(0, n - 1)} integer onChange={setStart} />
            </Field>
            <Field label="end" hint="End sample index (exclusive)">
              <NumberInput value={end} min={1} max={n} integer onChange={setEnd} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground italic">{estimate}</p>
        </Panel>
        <Button className="h-11 text-[15px]" disabled={running} onClick={identify} title="Run state-space identification across the selected order range">
          <Play /> Identify
        </Button>
        <Button variant="outline" className="h-10 text-destructive" disabled={!running} onClick={() => { api.sysidCancel(); setStatus({ text: "Cancelling..." }); }}>
          <Square /> Stop
        </Button>
        <StatusText tone={status.error ? "error" : "muted"}>{status.text}</StatusText>
        {results.length > 0 && <StaleNote version={ranAt} />}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Panel title="Results (sorted by mean VAF)" className="min-h-0 flex-1" bodyClassName="p-0 overflow-auto">
          <Table className="text-[12.5px]">
            <TableHeader className="sticky top-0 bg-white">
              <TableRow>
                <TableHead className="text-black">Order</TableHead>
                <TableHead className="text-black">Mean VAF%</TableHead>
                <TableHead className="text-black">Best VAF%</TableHead>
                <TableHead className="text-black">Per output</TableHead>
                <TableHead className="w-24 text-black">Save</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.index}>
                  <TableCell className="py-1 tabular-nums">{r.order}</TableCell>
                  <TableCell className="py-1 tabular-nums">{r.mean_vaf.toFixed(2)}</TableCell>
                  <TableCell className="py-1 tabular-nums">{r.best_vaf.toFixed(2)}</TableCell>
                  <TableCell className="max-w-64 truncate py-1 text-xs text-muted-foreground" title={r.metrics.map((m) => `${m.name}: ${m.vaf.toFixed(1)}%`).join("\n")}>
                    {r.metrics.map((m) => `${m.vaf.toFixed(0)}%`).join(" · ")}
                  </TableCell>
                  <TableCell className="py-1">
                    <Button
                      size="xs"
                      variant={saved.includes(r.index) ? "secondary" : "outline"}
                      onClick={async () => {
                        const nm = await api.sysidSaveResult(r.index);
                        setSaved([...saved, r.index]);
                        await refreshModels();
                        setStatus({ text: `Model '${nm}' saved to library.` });
                      }}
                    >
                      <Save /> {saved.includes(r.index) ? "Saved" : "Save"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {results.length === 0 && <p className="p-3 text-xs text-muted-foreground">Select inputs and outputs, then click Identify.</p>}
        </Panel>
        <Panel title="VAF vs model order" className="min-h-0 flex-1" bodyClassName="p-1">
          {vafPanels.length > 0 && <StackedChart panels={vafPanels} xLabel="Model order" />}
        </Panel>
      </div>
    </div>
  );
}
