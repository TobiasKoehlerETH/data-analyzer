import { useCallback, useEffect, useMemo, useState } from "react";
import { open, message, ask } from "@/lib/platform";
import { FilePlus2, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckField, CheckList, EmptyState, Field, NumberInput, Panel, Radios, Segmented } from "@/components/common";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, DATA_FILE_FILTERS, errorText, type CompareSignalSeries, type CompareState, type CompareStatistics } from "@/lib/api";
import { zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

type AlignMode = "manual" | "click" | "trigger";
const NONE = "__none__";

export function CompareTab() {
  const { setProgress, setDataset, dataset } = useApp();
  const [state, setState] = useState<CompareState>({ files: [], mapped_signals: [], mappings: [], dataset: null });
  const [checked, setChecked] = useState<string[]>([]);
  const [mode, setMode] = useState<AlignMode>("manual");
  const multiple = () => state.files.length >= 2;
  const [trigSignal, setTrigSignal] = useState("");
  const [threshold, setThreshold] = useState(0);
  const [rising, setRising] = useState(true);
  const [clicks, setClicks] = useState<Record<string, number>>({});
  const [view, setView] = useState<"overlay" | "side">("overlay");
  const [showDiff, setShowDiff] = useState(false);
  const [showStats, setShowStats] = useState(true);
  const [series, setSeries] = useState<CompareSignalSeries[]>([]);
  const [diffs, setDiffs] = useState<CompareSignalSeries[]>([]);
  const [stats, setStats] = useState<CompareStatistics[]>([]);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);

  const apply = (s: CompareState) => {
    setState(s);
    setChecked((c) => c.filter((x) => s.mapped_signals.includes(x)));
    setTrigSignal((t) => (s.mapped_signals.includes(t) ? t : (s.mapped_signals[0] ?? "")));
    // A time shift rebuilds the workspace dataset; the effect below then refreshes this view.
    if (s.dataset) setDataset(s.dataset);
  };

  // Compare is a view over the workspace's files: refresh whenever the workspace changes.
  useEffect(() => {
    api.compareState().then(apply).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  const run = async (f: () => Promise<CompareState>) => {
    try {
      apply(await f());
    } catch (e) {
      await message(errorText(e), { title: "Compare", kind: "error" });
    }
  };

  /** Adds files to the workspace with all their columns (named "Column · file"). */
  const addPaths = useCallback(async (paths: string[]) => {
    setProgress("compare", 5, "Loading files...");
    try {
      const v = await api.workspaceImportBatch(paths, null, null);
      setDataset(v.dataset ?? null);
      for (const w of v.warnings) await message(w, { title: "Import", kind: "warning" });
    } catch (e) {
      await message(errorText(e), { title: "Load Error", kind: "error" });
    } finally {
      setProgress("compare", 100, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeFile = async (id: string) => {
    const f = state.files.find((x) => x.id === id);
    if (!f || !(await ask(`Remove ${f.short_name} and its variables from the workspace?`, { title: "Remove file", kind: "warning" }))) return;
    try {
      const v = await api.workspaceRemoveSource(Number(id));
      setDataset(v.dataset ?? null);
    } catch (e) {
      await message(errorText(e), { title: "Compare", kind: "error" });
    }
  };

  useEffect(() => {
    const h = (e: Event) => addPaths((e as CustomEvent<string[]>).detail);
    window.addEventListener("compare-add-files", h);
    return () => window.removeEventListener("compare-add-files", h);
  }, [addPaths]);

  const addFiles = async () => {
    const p = await open({ multiple: true, filters: DATA_FILE_FILTERS, title: "Add files to the workspace" });
    if (Array.isArray(p) && p.length) addPaths(p);
    else if (typeof p === "string") addPaths([p]);
  };

  useEffect(() => {
    if (mode === "click") setClicks({});
  }, [mode, state.files.length]);

  const xRange = useMemo<[number, number] | null>(() => {
    if (!state.files.length) return null;
    const lo = Math.min(...state.files.map((f) => f.t_start + f.offset));
    const hi = Math.max(...state.files.map((f) => f.t_end + f.offset));
    return hi > lo ? [lo, hi] : null;
  }, [state.files]);

  useEffect(() => {
    if (!checked.length || !state.files.length) {
      setSeries([]);
      setDiffs([]);
      setStats([]);
      return;
    }
    api.compareSeries(checked, range, 3000).then(setSeries);
    if (showDiff && state.files.length >= 2) api.compareDifferences(checked, 3000).then(setDiffs);
    else setDiffs([]);
    if (showStats && state.files.length >= 2) api.compareStats(checked).then(setStats);
    else setStats([]);
  }, [checked, state, range, showDiff, showStats]);

  const panels: ChartPanel[] = useMemo(() => {
    if (view === "overlay") {
      return series.map((s) => ({
        id: s.signal,
        yLabel: s.signal,
        legend: true,
        series: s.traces.map((t) => ({ name: t.name, color: t.color, data: zip(t.x, t.y) })),
      }));
    }
    const out: ChartPanel[] = [];
    for (const s of series) {
      for (const f of state.files) {
        const t = s.traces.find((x) => x.file_id === f.id);
        out.push({ id: `${s.signal}-${f.id}`, yLabel: s.signal, title: f.short_name, series: t ? [{ name: f.short_name, color: f.color, data: zip(t.x, t.y) }] : [] });
      }
    }
    return out;
  }, [series, view, state.files]);

  const diffPanels: ChartPanel[] = useMemo(
    () =>
      diffs.map((s) => ({
        id: s.signal,
        yLabel: `Δ ${s.signal}`,
        legend: true,
        hLines: [{ y: 0 }],
        series: s.traces.map((t) => ({ name: t.name, color: t.color, data: zip(t.x, t.y) })),
      })),
    [diffs],
  );

  const onChartClick = async (panelIndex: number, x: number, y: number) => {
    if (mode !== "click" || view !== "overlay") return;
    const sig = series[panelIndex]?.signal;
    if (!sig) return;
    const fid = await api.compareNearestFile(sig, x, y);
    if (!fid) return;
    const next = { ...clicks, [fid]: x };
    if (state.files.every((f) => next[f.id] !== undefined)) {
      await run(() => api.compareAlignClicks(Object.entries(next)));
      setClicks({});
    } else {
      setClicks(next);
    }
  };

  const ref = state.files[0];

  return (
    <div className="flex h-full gap-3">
      <div className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto">
        <Panel
          title="Files"
          bodyClassName="flex flex-col gap-1 p-2"
          actions={
            <Button size="xs" variant="outline" onClick={addFiles} title="Add files to the workspace">
              <FilePlus2 /> Add
            </Button>
          }
        >
          {state.files.map((f) => (
            <div key={f.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-ap-bluegray-15" title={f.path}>
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: f.color }} />
              <span className="min-w-0 flex-1 truncate">{f.short_name}</span>
              {mode === "manual" && state.files.length > 1 && (
                <NumberInput className="w-24" value={f.offset} step={0.1} suffix="s" title="Time shift of this file" onChange={(v) => run(() => api.compareSetOffset(f.id, v))} />
              )}
              <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" title="Remove this file" onClick={() => removeFile(f.id)}>
                <X />
              </Button>
            </div>
          ))}
          {state.files.length === 0 && <p className="px-2 py-3 text-[13px] text-muted-foreground">Add two or more runs.</p>}
        </Panel>

        <Panel
          title="Signals"
          className="min-h-40 flex-1"
          bodyClassName="p-1"
          actions={
            <Button size="xs" variant="ghost" disabled={state.files.length < 2} onClick={() => setMappingOpen(true)} title="Manually override the automatic signal matching">
              <Link2 /> Mapping
            </Button>
          }
        >
          <CheckList
            className="h-full"
            items={state.mapped_signals.map((s) => ({ id: s, label: s }))}
            checked={checked}
            onChange={setChecked}
            emptyText="No signal is in two files."
          />
        </Panel>

        {state.files.length > 1 && (
          <Panel title="Line up" bodyClassName="flex flex-col gap-3">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "manual", label: "Shift", hint: "Type a time shift per file" },
                { value: "click", label: "Click", hint: "Click the same event on each trace" },
                { value: "trigger", label: "Trigger", hint: "Line up the first threshold crossing" },
              ]}
            />
            {mode === "click" && (
              <ul className="text-[12.5px] text-muted-foreground">
                {state.files.map((f) => (
                  <li key={f.id} className="flex items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: f.color }} />
                    {f.short_name}: {clicks[f.id] !== undefined ? `${clicks[f.id].toFixed(3)} s` : "click its trace"}
                  </li>
                ))}
              </ul>
            )}
            {mode === "trigger" && (
              <>
                <Field label="Signal">
                  <Select value={trigSignal || undefined} onValueChange={setTrigSignal}>
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue placeholder="Select signal" />
                    </SelectTrigger>
                    <SelectContent>
                      {state.mapped_signals.map((sg) => (
                        <SelectItem key={sg} value={sg}>
                          {sg}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Threshold">
                  <NumberInput value={threshold} step={0.1} onChange={setThreshold} />
                </Field>
                <Radios
                  value={rising ? "r" : "f"}
                  onChange={(v) => setRising(v === "r")}
                  options={[
                    { value: "r", label: "Rising" },
                    { value: "f", label: "Falling" },
                  ]}
                />
                <Button variant="outline" disabled={!trigSignal} onClick={() => run(() => api.compareAlignTrigger(trigSignal, threshold, rising))}>
                  Line up
                </Button>
              </>
            )}
          </Panel>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Panel
          className="min-h-0 flex-[4]"
          bodyClassName="p-1"
          actions={
            multiple() ? (
              <div className="flex items-center gap-4">
                <CheckField checked={showDiff} onChange={setShowDiff} label="Difference" />
                <CheckField checked={showStats} onChange={setShowStats} label="Statistics" />
                <Segmented
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "overlay", label: "Overlay" },
                    { value: "side", label: "Side by side" },
                  ]}
                />
              </div>
            ) : undefined
          }
        >
          {panels.length === 0 ? (
            <EmptyState title={state.files.length < 2 ? "Add at least two files" : "Tick a signal to compare"} />
          ) : (
            <StackedChart
              panels={panels}
              columns={view === "side" ? Math.max(1, state.files.length) : 1}
              xLabel="Time [s]"
              xRange={xRange}
              onZoom={setRange}
              onClick={onChartClick}
              resetKey={`${view}-${state.files.length}`}
            />
          )}
        </Panel>
        {showDiff && diffPanels.length > 0 && (
          <Panel className="min-h-32 flex-[2]" bodyClassName="p-1">
            <StackedChart panels={diffPanels} xLabel="Time [s]" />
          </Panel>
        )}
        {showStats && multiple() && (
          <Panel title={ref ? `Against ${ref.short_name}` : "Statistics"} className="max-h-56 min-h-24 flex-1" bodyClassName="p-0 overflow-auto selectable">
            <Table className="text-[12px]">
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  {["Signal", "File", "RMSE", "Max Dev", "R²", "Mean Error"].map((h) => (
                    <TableHead key={h} className="text-black">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-1">{s.signal}</TableCell>
                    <TableCell className="py-1">{s.file_name}</TableCell>
                    <TableCell className="py-1 tabular-nums">{s.rmse.toFixed(6)}</TableCell>
                    <TableCell className="py-1 tabular-nums">{s.max_deviation.toFixed(6)}</TableCell>
                    <TableCell className="py-1 tabular-nums">{s.r_squared.toFixed(4)}</TableCell>
                    <TableCell className="py-1 tabular-nums">{s.mean_error.toFixed(6)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
      </div>

      <Dialog open={mappingOpen} onOpenChange={setMappingOpen}>
        <DialogContent className="max-h-[80vh] max-w-4xl overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Signal mapping</DialogTitle>
          </DialogHeader>
          <Table className="text-[12px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-black">Signal</TableHead>
                {state.files.map((f) => (
                  <TableHead key={f.id} className="text-black">
                    <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: f.color }} />
                    {f.short_name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.mappings.map((m) => (
                <TableRow key={m.canonical}>
                  <TableCell className="py-1">{m.canonical}</TableCell>
                  {state.files.map((f) => (
                    <TableCell key={f.id} className="py-1">
                      <Select
                        value={m.file_columns[f.id] ?? NONE}
                        onValueChange={(v) => run(() => api.compareSetMapping(m.canonical, f.id, v === NONE ? null : v))}
                      >
                        <SelectTrigger className="h-7 w-full min-w-36 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— not mapped —</SelectItem>
                          {f.columns.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
