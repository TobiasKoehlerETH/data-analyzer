import { useEffect, useMemo, useState } from "react";
import { EmptyState, Field, Panel, Segmented, StatusText } from "@/components/common";
import { PipelineDiagram, blockInfo, type AddChoice } from "@/components/PipelineDiagram";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type Pipeline, type VariableEdit, type VariableSamples } from "@/lib/api";
import { INK, seriesColor } from "@/lib/chart";
import { useApp } from "@/lib/store";

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const round = (n: number) => Number(n.toPrecision(6));

/** Clean one signal as a pipeline of steps; the imported values stay visible in gray. */
export function PrepareTab() {
  const { dataset, dataVersion, activeTab, setDataset, prepareVariable, setPrepareVariable, showStatus } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [xMode, setXMode] = useState<"time" | "row">("time");
  const [vec, setVec] = useState<VariableSamples | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Step whose input and output the plot shows (null = original vs final). */
  const [block, setBlock] = useState<number | null>(null);
  const [probe, setProbe] = useState<{ input: (number | null)[]; output: (number | null)[] } | null>(null);
  /** A step being set up: previewed on the plot until it is added. */
  const [draft, setDraft] = useState<VariableEdit | null>(null);
  const [preview, setPreview] = useState<number[] | null>(null);
  const [suggestions, setSuggestions] = useState<{ reason: string; step: VariableEdit }[]>([]);
  const [viewRange, setViewRange] = useState<[number, number] | null>(null);
  /** Rows of every other signal, for downsampling to another signal's length. */
  const [lengths, setLengths] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!dataset) return;
    if (prepareVariable && dataset.signals.some((s) => s.column === prepareVariable)) {
      setColumn(prepareVariable);
      setPrepareVariable(null);
    } else if (!column || !dataset.signals.some((s) => s.column === column)) {
      setColumn(dataset.signals[0]?.column ?? null);
    }
  }, [dataset, prepareVariable, column, setPrepareVariable]);

  useEffect(() => {
    if (!column || activeTab !== "prepare") return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.workspaceVariable(column), api.workspacePipeline(column), api.workspaceView()])
      .then(([v, p, w]) => {
        if (cancelled) return;
        setVec(v);
        setPipeline(p);
        setLengths(Object.fromEntries(w.variables.filter((x) => x.kind !== "text" && !x.is_time).map((x) => [x.name, x.len])));
        setError("");
      })
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [column, dataVersion, activeTab]);

  // A different signal starts clean.
  useEffect(() => {
    setBlock(null);
    setDraft(null);
    setSuggestions([]);
    setViewRange(null);
    setError("");
  }, [column, xMode]);

  // Values on both sides of the selected step.
  useEffect(() => {
    if (block === null || !column || !pipeline || block >= pipeline.stages.length) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    api
      .workspaceStage(column, block)
      .then((p) => !cancelled && setProbe(p))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [block, column, pipeline]);

  // Live preview of the step being set up (not committed).
  useEffect(() => {
    if (!draft || !column) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .workspacePreview(column, draft)
        .then((v) => {
          if (cancelled) return;
          setPreview(v);
          setError("");
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setError(errorText(e));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [draft, column, vec]);

  const label = dataset?.signals.find((s) => s.column === column)?.label ?? column ?? "";
  // The signal's own samples: no interpolation, times on the aligned axis.
  const time = useMemo(() => vec?.time ?? [], [vec]);
  const origin = vec?.time_origin ?? null;
  const dateAxis = xMode === "time" && origin !== null;
  const x = useMemo(
    () => (xMode === "row" ? time.map((_, i) => i + 1) : dateAxis ? time.map((t) => (origin! + t) * 1000) : time),
    [time, xMode, dateAxis, origin],
  );
  const edited = !!vec && vec.edits.length > 0;

  const panels: ChartPanel[] = useMemo(() => {
    if (!vec) return [];
    const pairs = (v: (number | null)[]) => v.map((y, i) => [x[i] ?? null, finite(y) ? y : null] as [number | null, number | null]);
    const before = probe ? probe.input : vec.original;
    const after = probe ? probe.output : vec.edited;
    const names = probe ? [`Before step ${block! + 1}`, `After step ${block! + 1}`] : ["Original", "Edited"];
    const main: ChartPanel = {
      id: "values",
      yLabel: label,
      series: [
        ...(edited
          ? [
              { name: names[0], color: INK.muted, data: pairs(before) },
              { name: names[1], color: seriesColor(0), data: pairs(after) },
            ]
          : [{ name: label, color: seriesColor(0), data: pairs(vec.edited) }]),
        ...(preview && draft ? [{ name: `Preview: ${blockInfo(draft).title}`, color: seriesColor(1), data: pairs(preview) }] : []),
      ],
    };
    if (!edited) return [main];
    const diff = after.map((b, i) => {
      const a = before[i];
      return finite(a) && finite(b) ? b - a : null;
    });
    if (!diff.some((d) => d !== null && d !== 0)) return [main];
    return [main, { id: "change", yLabel: probe ? "Output − input" : "Edited − original", hLines: [{ y: 0 }], series: [{ name: "Change", color: seriesColor(1), data: pairs(diff) }] }];
  }, [vec, x, label, edited, preview, draft, probe, block]);

  const nyquist = useMemo(() => {
    const dts = time.slice(1, 2001).map((t, i) => t - time[i]).filter((d) => d > 0).sort((a, b) => a - b);
    return dts.length ? 0.5 / dts[Math.floor(dts.length / 2)] : 1;
  }, [time]);

  /** Chart x → time on the aligned axis (the axis may show dates or row numbers). */
  const xToTime = (xv: number) => (xMode === "row" ? (time[Math.min(time.length - 1, Math.max(0, Math.round(xv) - 1))] ?? 0) : dateAxis ? xv / 1000 - origin! : xv);
  const rangeDefault: [number, number] = useMemo(() => {
    if (!time.length) return [0, 1];
    if (viewRange) {
      const [a, b] = [xToTime(viewRange[0]), xToTime(viewRange[1])];
      return [round(Math.min(a, b)), round(Math.max(a, b))];
    }
    const [t0, t1] = [time[0], time[time.length - 1]];
    return [round(t0), round(t0 + (t1 - t0) * 0.1)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRange, time, xMode, origin]);

  const fmtTime = (t: number) => (origin !== null ? new Date((origin + t) * 1000).toISOString().slice(11, 23) : `${Number(t.toPrecision(5))} s`);

  const run = async (f: () => Promise<{ dataset: typeof dataset }>, done: string) => {
    setBusy(true);
    try {
      const v = await f();
      setDataset(v.dataset);
      setError("");
      showStatus(done);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async ({ step, now }: AddChoice) => {
    if (!column) return;
    setBlock(null);
    setSuggestions([]);
    if (!now) {
      setDraft(step);
      return;
    }
    const ok = await run(() => api.workspaceEdit(column, "edit", step), `${blockInfo(step).title} added.`);
    if (ok) setDraft(null);
  };

  const onSuggest = async () => {
    if (!column) return;
    try {
      const s = await api.filterSuggest(column);
      setSuggestions(s.map((sg) => ({ reason: sg.reason, step: { op: "filter", value: sg.step } as VariableEdit })));
      setDraft(null);
      setBlock(null);
      if (!s.length) showStatus("No filter suggestions for this signal.");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const step = (action: "remove" | "move" | "replace", index: number, opts: { to?: number; edit?: VariableEdit } = {}) => {
    if (!column) return;
    run(() => api.workspaceStep(column, action, index, opts), action === "remove" ? `Step ${index + 1} deleted.` : action === "move" ? "Step moved." : `Step ${index + 1} updated.`).then((ok) => {
      if (ok) setBlock(action === "move" ? (opts.to ?? null) : action === "replace" ? index : null);
    });
  };

  if (!dataset) return <EmptyState title="No data loaded">Add data first, then clean it here.</EmptyState>;

  const xLabel = xMode === "time" ? (dateAxis ? "Time" : "Time [s]") : "Row";

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Field label="Signal" className="w-[340px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} edited={dataset.edited} />
        </Field>
        <Segmented
          value={xMode}
          onChange={setXMode}
          options={[
            { value: "time", label: "Time" },
            { value: "row", label: "Row" },
          ]}
        />
      </div>

      {pipeline && (
        <PipelineDiagram
          source={pipeline.source}
          sourceKind={pipeline.kind}
          output={label}
          pipeline={pipeline}
          selected={block}
          onSelect={(i) => {
            setBlock(i);
            if (i !== null) {
              setDraft(null);
              setSuggestions([]);
            }
          }}
          busy={busy}
          fmtTime={fmtTime}
          nyquist={nyquist}
          rangeDefault={rangeDefault}
          lengths={lengths}
          ownName={column ?? ""}
          ownLength={vec?.original.length ?? 0}
          onRemove={(i) => step("remove", i)}
          onMove={(i, to) => step("move", i, { to })}
          onReplace={(i, edit) => step("replace", i, { edit })}
          draft={draft}
          onDraftChange={(d) => {
            setDraft(d);
            if (d) {
              setBlock(null);
              setSuggestions([]);
            }
          }}
          onAdd={onAdd}
          onSuggest={onSuggest}
          suggestions={suggestions}
          canUndo={!!vec?.can_undo}
          onUndo={() => column && run(() => api.workspaceEdit(column, "undo"), "Last step removed.")}
          onReset={() => column && run(() => api.workspaceEdit(column, "reset"), "Back to the imported values.")}
        />
      )}

      <Panel
        className={`min-h-0 min-w-0 flex-1 transition-opacity ${loading ? "opacity-60" : ""}`}
        bodyClassName="p-1"
        title={probe ? `Step ${block! + 1}: input and output` : undefined}
      >
        {panels.length ? (
          <StackedChart panels={panels} xLabel={xLabel} xDate={dateAxis} resetKey={`${column}|${xMode}`} onZoom={setViewRange} />
        ) : (
          <EmptyState title="Loading…" />
        )}
      </Panel>
      {error && <StatusText tone="error">{error}</StatusText>}
    </div>
  );
}
