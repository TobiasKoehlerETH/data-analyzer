import { useEffect, useMemo, useRef, useState } from "react";
import { open, save, message } from "@/lib/platform";
import { ArrowDown, ArrowUp, Eraser, FolderOpen, GripVertical, Plus, Save, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, NumberInput, Panel, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel, type ChartSeries } from "@/components/StackedChart";
import { api, errorText, JSON_FILTERS, type FilterChain, type FilterPreview, type FilterStep, type FilterType, type Suggestion } from "@/lib/api";
import { INK, seriesColor, zip } from "@/lib/chart";
import { defaultStep, describeStep, FILTER_TYPES, filterTitle, paramDefs } from "@/lib/filters";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

function ParamEditor({ step, onChange, nyquist }: { step: FilterStep; onChange: (s: FilterStep) => void; nyquist: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {paramDefs(step.filter_type).map((p) => (
        <Field key={p.key} label={p.label} className="[&>label]:w-24">
          <NumberInput
            value={step.params[p.key] ?? p.def}
            min={p.min}
            max={p.freq ? Math.max(p.max, nyquist) : p.max}
            step={p.integer ? 1 : p.freq ? 0.001 : (p.max - p.min) / 100}
            integer={p.integer}
            onChange={(v) => onChange({ ...step, params: { ...step.params, [p.key]: v } })}
          />
        </Field>
      ))}
    </div>
  );
}

export function FilterTab() {
  const { dataset, bumpData, showStatus } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [chain, setChain] = useState<FilterChain>({ steps: [] });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [draftType, setDraftType] = useState<FilterType>("lowpass");
  const [draft, setDraft] = useState<FilterStep>(defaultStep("lowpass"));
  const [showDraft, setShowDraft] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<FilterPreview | null>(null);
  const [status, setStatus] = useState<{ text: string; tone?: "error" | "ok" }>({ text: "" });
  const [busy, setBusy] = useState(false);
  const dragIdx = useRef<number | null>(null);

  const nyquist = (dataset?.sample_rate ?? 2) / 2;

  useEffect(() => {
    setColumn(dataset?.signals[0]?.column ?? null);
  }, [dataset?.path]);

  useEffect(() => {
    setSuggestions([]);
    setSelected(null);
    if (!column) {
      setChain({ steps: [] });
      return;
    }
    api.filterGetChain(column).then((c) => setChain(c ?? { steps: [] }));
  }, [column, dataset?.path]);

  useEffect(() => {
    if (!column || !dataset) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .filterPreview(column, chain, showDraft ? draft : null)
        .then((p) => {
          setPreview(p);
          if (p.error) setStatus({ text: p.error, tone: "error" });
        })
        .catch((e) => setStatus({ text: errorText(e), tone: "error" }));
    }, 120);
    return () => clearTimeout(t);
  }, [column, chain, draft, showDraft, dataset]);

  const panels: ChartPanel[] = useMemo(() => {
    if (!preview) return [];
    // The original recedes to gray so the edited signal carries the emphasis.
    const edited = !!(preview.filtered || preview.draft);
    const series: ChartSeries[] = [{ name: "Original", color: edited ? INK.muted : seriesColor(0), data: zip(preview.x, preview.original) }];
    if (preview.filtered) series.push({ name: "Filtered", color: seriesColor(0), data: zip(preview.x, preview.filtered) });
    if (preview.draft) series.push({ name: "With new filter", color: seriesColor(1), data: zip(preview.x, preview.draft) });
    return [{ id: "p", yLabel: dataset?.signals.find((s) => s.column === column)?.label ?? "Value", legend: true, series }];
  }, [preview, dataset, column]);

  const updateStep = (i: number, s: FilterStep) => setChain({ steps: chain.steps.map((x, j) => (j === i ? s : x)) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.steps.length) return;
    const steps = [...chain.steps];
    const [s] = steps.splice(from, 1);
    steps.splice(to, 0, s);
    setChain({ steps });
    setSelected(to);
  };

  const runSuggest = async () => {
    if (!column) return;
    setBusy(true);
    try {
      const s = await api.filterSuggest(column);
      setSuggestions(s);
      setStatus({ text: s.length ? `${s.length} suggestion(s). Double-click to add to the chain.` : "No filter suggestions for this signal." });
    } catch (e) {
      setStatus({ text: errorText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const applyFull = async () => {
    if (!column || !chain.steps.some((s) => s.enabled)) return;
    setBusy(true);
    try {
      const info = await api.filterApply(column, chain);
      bumpData(info);
      showStatus(`Filter applied to ${column}`);
      setStatus({ text: `Filter applied to ${column} (full data).`, tone: "ok" });
    } catch (e) {
      setStatus({ text: errorText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!dataset) return <EmptyState title="No data loaded">Load a file in the File tab to design filters.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <Field label="Signal" className="max-w-xl">
        <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} filtered={dataset.filtered} title="Select the signal to apply filters to" />
      </Field>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-[300px] shrink-0 flex-col gap-3">
          <Panel title="Auto-suggestions" className="min-h-0 flex-1" bodyClassName="flex flex-col gap-2 p-2">
            <Button size="sm" onClick={runSuggest} disabled={busy} title="Analyze the signal spectrum and suggest appropriate filters">
              <Sparkles /> Analyze &amp; Suggest
            </Button>
            <ul className="min-h-0 flex-1 overflow-auto border border-ap-line">
              {suggestions.map((s, i) => (
                <li
                  key={i}
                  onDoubleClick={() => setChain({ steps: [...chain.steps, s.step] })}
                  title={`Type: ${s.step.filter_type}, Params: ${JSON.stringify(s.step.params)}\nDouble-click to add to the filter chain`}
                  className="group flex cursor-default items-start gap-1 border-b border-ap-line px-2 py-1.5 text-[12px] leading-snug last:border-0 hover:bg-ap-bluegray-15"
                >
                  <span className="flex-1">{s.reason}</span>
                  <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => setChain({ steps: [...chain.steps, s.step] })}>
                    <Plus />
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Add filter manually" bodyClassName="flex flex-col gap-2">
            <Select
              value={draftType}
              onValueChange={(v) => {
                setDraftType(v as FilterType);
                setDraft(defaultStep(v as FilterType));
              }}
            >
              <SelectTrigger className="h-8 w-full" title="Select the type of filter to add manually">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {filterTitle(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ParamEditor step={draft} onChange={setDraft} nyquist={nyquist} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={showDraft} onCheckedChange={(v) => setShowDraft(!!v)} /> Live preview of this filter
            </label>
            <Button size="sm" variant="outline" onClick={() => setChain({ steps: [...chain.steps, { ...draft }] })}>
              <Plus /> Add to Chain
            </Button>
          </Panel>
        </div>

        <div className="flex w-[300px] shrink-0 flex-col gap-3">
          <Panel
            title="Filter chain"
            className="min-h-0 flex-1"
            bodyClassName="flex flex-col gap-2 p-2"
            actions={
              <>
                <Button size="icon-xs" variant="ghost" title="Save chain as JSON" onClick={async () => {
                  const p = await save({ filters: JSON_FILTERS, defaultPath: "filter_chain.json", title: "Save Filter Chain" });
                  if (p) await api.filterSaveChain(p, chain).catch((e) => message(errorText(e), { kind: "error" }));
                }}>
                  <Save />
                </Button>
                <Button size="icon-xs" variant="ghost" title="Load chain from JSON" onClick={async () => {
                  const p = await open({ filters: JSON_FILTERS, title: "Load Filter Chain" });
                  if (typeof p === "string") {
                    try {
                      setChain(await api.filterLoadChain(p));
                      setSelected(null);
                    } catch (e) {
                      await message(errorText(e), { kind: "error" });
                    }
                  }
                }}>
                  <FolderOpen />
                </Button>
              </>
            }
          >
            <ul className="min-h-24 flex-1 overflow-auto border border-ap-line">
              {chain.steps.map((s, i) => (
                <li
                  key={i}
                  draggable
                  onDragStart={() => (dragIdx.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx.current !== null) move(dragIdx.current, i);
                    dragIdx.current = null;
                  }}
                  onClick={() => setSelected(i)}
                  className={cn("flex items-center gap-1.5 border-b border-ap-line px-1.5 py-1 text-[12px] last:border-0", selected === i && "bg-ap-bluegray-15")}
                >
                  <GripVertical className="size-3.5 shrink-0 cursor-grab text-ap-bluegray-60" />
                  <Checkbox checked={s.enabled} onCheckedChange={(v) => updateStep(i, { ...s, enabled: !!v })} onClick={(e) => e.stopPropagation()} />
                  <span className={cn("flex-1 truncate", !s.enabled && "text-muted-foreground line-through")} title={describeStep(s)}>
                    {i + 1}. {describeStep(s)}
                  </span>
                </li>
              ))}
              {chain.steps.length === 0 && <li className="p-2 text-xs text-muted-foreground">Add suggestions or manual filters.</li>}
            </ul>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={selected === null} onClick={() => selected !== null && move(selected, selected - 1)} title="Move up">
                <ArrowUp />
              </Button>
              <Button size="sm" variant="outline" disabled={selected === null} onClick={() => selected !== null && move(selected, selected + 1)} title="Move down">
                <ArrowDown />
              </Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={selected === null} onClick={() => {
                if (selected === null) return;
                setChain({ steps: chain.steps.filter((_, j) => j !== selected) });
                setSelected(null);
              }}>
                <X /> Remove
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setChain({ steps: [] }); setSelected(null); }} title="Clear all steps">
                <Trash2 />
              </Button>
            </div>
            {selected !== null && chain.steps[selected] && (
              <div className="border-t border-ap-line pt-2">
                <p className="ap-eyebrow mb-1.5">Edit step {selected + 1}</p>
                <ParamEditor step={chain.steps[selected]} onChange={(s) => updateStep(selected, s)} nyquist={nyquist} />
              </div>
            )}
          </Panel>
          <Button onClick={applyFull} disabled={busy || !chain.steps.some((s) => s.enabled)} className="h-10">
            <Wand2 /> Apply to Full Data
          </Button>
          <Button variant="outline" disabled={!column || !dataset.filtered.includes(column)} onClick={async () => {
            if (!column) return;
            bumpData(await api.filterClear(column));
            setStatus({ text: `Filtered data cleared for ${column}.` });
          }}>
            <Eraser /> Clear Filtered Data
          </Button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Panel title="Preview (≤ 5 000 points)" className="min-h-0 flex-1" bodyClassName="p-1">
            {panels.length ? <StackedChart panels={panels} xLabel="Time [s]" resetKey={column ?? ""} /> : <EmptyState title="Select a signal" />}
          </Panel>
          <StatusText tone={status.tone ?? "muted"}>{status.text}</StatusText>
        </div>
      </div>
    </div>
  );
}
