import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Crop, Eraser, RotateCcw, Spline, Trash2, Undo2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckField, EmptyState, Field, NumberInput, Panel, Radios, StatusText } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type VariableEdit, type VariableSamples } from "@/lib/api";
import { INK, fmtG, seriesColor } from "@/lib/chart";
import { useApp } from "@/lib/store";

type Box = { panel: number; x: [number, number]; y: [number, number] };

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Clean one workspace variable while the imported values stay visible in gray. */
export function PrepareTab() {
  const { dataset, dataVersion, activeTab, setDataset, setActiveTab, prepareVariable, setPrepareVariable } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [xMode, setXMode] = useState<"time" | "row">("time");
  const [showChange, setShowChange] = useState(true);
  const [vec, setVec] = useState<VariableSamples | null>(null);
  const [loading, setLoading] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [selectionKey, setSelectionKey] = useState(0);
  const [spikeK, setSpikeK] = useState(4);
  const [offset, setOffset] = useState(0);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

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
    api
      .workspaceVariable(column)
      .then((v) => !cancelled && setVec(v))
      .catch((e) => !cancelled && setStatus({ text: errorText(e), error: true }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [column, dataVersion, activeTab]);

  const clearSelection = () => {
    setBox(null);
    setSelectionKey((k) => k + 1);
  };
  useEffect(clearSelection, [column, xMode]);

  const label = dataset?.signals.find((s) => s.column === column)?.label ?? column ?? "";
  // The variable's own samples: no interpolation, times on the aligned axis.
  const time = useMemo(() => vec?.time ?? [], [vec]);
  const origin = vec?.time_origin ?? null;
  const dateAxis = xMode === "time" && origin !== null;
  const x = useMemo(
    () => (xMode === "row" ? time.map((_, i) => i + 1) : dateAxis ? time.map((t) => (origin! + t) * 1000) : time),
    [time, xMode, dateAxis, origin],
  );
  const edited = !!vec && vec.edits.length > 0;

  const stats = useMemo(() => {
    if (!vec) return null;
    let missing = 0;
    let changed = 0;
    let gaps = 0;
    let seen = false;
    let pending = 0;
    for (let i = 0; i < vec.edited.length; i++) {
      const a = vec.original[i];
      const b = vec.edited[i];
      if (!finite(b)) {
        missing++;
        if (seen) pending++;
      } else {
        gaps += pending;
        pending = 0;
        seen = true;
      }
      if (finite(a) !== finite(b) || (finite(a) && finite(b) && a !== b)) changed++;
    }
    return { rows: vec.edited.length, missing, changed, gaps };
  }, [vec]);

  const selection = useMemo(() => {
    if (!box || !vec) return null;
    let first = -1;
    let last = -1;
    const points: number[] = [];
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      if (!finite(xi) || xi < box.x[0] || xi > box.x[1]) continue;
      if (first < 0) first = i;
      last = i;
      const y = vec.edited[i];
      if (box.panel === 0 && finite(y) && y >= box.y[0] && y <= box.y[1]) points.push(i);
    }
    // Edits are stored as times, so they replay correctly in recipes and projects.
    return first < 0 ? null : { range: [time[first], time[last]] as [number, number], rows: last - first + 1, points: points.map((i) => time[i]) };
  }, [box, vec, x, time]);

  const panels: ChartPanel[] = useMemo(() => {
    if (!vec) return [];
    const pairs = (v: (number | null)[]) => v.map((y, i) => [x[i] ?? null, finite(y) ? y : null] as [number | null, number | null]);
    const main: ChartPanel = {
      id: "values",
      yLabel: label,
      series: edited
        ? [
            { name: "Original", color: INK.muted, data: pairs(vec.original) },
            { name: "Edited", color: seriesColor(0), data: pairs(vec.edited) },
          ]
        : [{ name: label, color: seriesColor(0), data: pairs(vec.edited) }],
    };
    if (!edited || !showChange) return [main];
    const diff = vec.edited.map((b, i) => {
      const a = vec.original[i];
      return finite(a) && finite(b) ? b - a : null;
    });
    if (!diff.some((d) => d !== null && d !== 0)) return [main];
    return [main, { id: "change", yLabel: "Edited − original", hLines: [{ y: 0 }], series: [{ name: "Change", color: seriesColor(1), data: pairs(diff) }] }];
  }, [vec, x, label, edited, showChange]);

  const run = async (action: "edit" | "undo" | "reset", edit?: VariableEdit) => {
    if (!column) return;
    setBusy(true);
    try {
      const v = await api.workspaceEdit(column, action, edit);
      setDataset(v.dataset);
      const info = v.variables.find((x) => x.name === column);
      const done = action === "edit" ? info?.edits.at(-1) : action === "undo" ? "Last edit undone" : "Back to the imported values";
      setStatus({ text: done ? `${done[0].toUpperCase()}${done.slice(1)}.` : "" });
      clearSelection();
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!dataset) return <EmptyState title="No data loaded">Add variables in Workspace to prepare them.</EmptyState>;

  const xLabel = xMode === "time" ? (dateAxis ? "Time" : "Time [s]") : "Row";
  const rows = selection?.rows ?? 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Field label="Signal" className="w-[340px]">
          <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} />
        </Field>
        <Radios
          value={xMode}
          onChange={setXMode}
          options={[
            { value: "time", label: "Time" },
            { value: "row", label: "Row" },
          ]}
        />
        <CheckField checked={showChange} onChange={setShowChange} label="Show change" hint="Plot edited − original below the signal" />
        {stats && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {stats.rows.toLocaleString()} rows · {stats.missing.toLocaleString()} missing · {stats.changed.toLocaleString()} changed
          </span>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setActiveTab("timeseries")} title="Open the prepared data in Plots">
          Explore in Plots <ArrowRight />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel
          className={`min-w-0 flex-1 transition-opacity ${loading ? "opacity-60" : ""}`}
          bodyClassName="p-1"
          title={edited ? `${label} · edited vs original` : label}
        >
          {panels.length ? (
            <StackedChart
              panels={panels}
              xLabel={xLabel}
              xDate={dateAxis}
              resetKey={`${column}|${xMode}`}
              onSelect={setBox}
              selectionKey={selectionKey}
            />
          ) : (
            <EmptyState title="Loading…" />
          )}
        </Panel>

        <div className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto">
          <Panel title="Selection" bodyClassName="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {selection
                ? `${rows.toLocaleString()} rows in range · ${selection.points.length.toLocaleString()} points in the box`
                : "Drag a box on the plot to select."}
            </p>
            <Button size="sm" variant="outline" disabled={busy || !selection?.points.length} onClick={() => run("edit", { op: "clear_points", value: selection!.points })} title="Mark the points inside the box as missing (outliers)">
              <Eraser /> Remove points in box
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !selection} onClick={() => run("edit", { op: "clear_range", value: selection!.range })} title="Mark every row in the selected X range as missing">
              <Trash2 /> Remove range
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !selection} onClick={() => run("edit", { op: "keep_range", value: selection!.range })} title="Mark every row outside the selected X range as missing">
              <Crop /> Keep only range
            </Button>
          </Panel>

          <Panel title="Clean" bodyClassName="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <NumberInput className="w-20" value={spikeK} min={1} max={20} step={0.5} suffix="σ" onChange={setSpikeK} title="Threshold in robust standard deviations from the local median" />
              <Button size="sm" variant="outline" className="flex-1" disabled={busy} onClick={() => run("edit", { op: "despike", value: spikeK })} title="Hampel filter: remove points far from the local median">
                <Zap /> Remove spikes
              </Button>
            </div>
            <Button size="sm" variant="outline" disabled={busy || !stats?.gaps} onClick={() => run("edit", { op: "fill_gaps" })} title="Linearly interpolate missing values between valid neighbours">
              <Spline /> Fill gaps{stats?.gaps ? ` (${stats.gaps.toLocaleString()})` : ""}
            </Button>
          </Panel>

          <Panel title="Adjust" bodyClassName="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <NumberInput className="flex-1" value={offset} step={0.1} onChange={setOffset} title="Value added to every point" />
              <Button size="sm" variant="outline" className="w-20" disabled={busy || offset === 0} onClick={() => run("edit", { op: "offset", value: offset })}>
                Offset
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput className="flex-1" value={scale} step={0.1} onChange={setScale} title="Factor every point is multiplied by" />
              <Button size="sm" variant="outline" className="w-20" disabled={busy || scale === 1} onClick={() => run("edit", { op: "scale", value: scale })}>
                Scale
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["demean", "Remove mean"],
                  ["zero_start", "Start at zero"],
                  ["normalize", "Normalize 0–1"],
                  ["zscore", "Z-score"],
                  ["invert", "Invert sign"],
                ] as const
              ).map(([op, text]) => (
                <Button key={op} size="sm" variant="outline" disabled={busy} onClick={() => run("edit", { op })}>
                  {text}
                </Button>
              ))}
            </div>
          </Panel>

          <Panel title={`History · ${vec?.edits.length ?? 0}`} bodyClassName="flex flex-col gap-2">
            {vec?.edits.length ? (
              <ol className="list-inside list-decimal text-[12.5px] leading-6">
                {vec.edits.map((e, i) => (
                  <li key={i} className="truncate" title={e}>
                    {e}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted-foreground">No edits yet. The imported values are always kept.</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" disabled={busy || !vec?.can_undo} onClick={() => run("undo")}>
                <Undo2 /> Undo
              </Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={busy || !edited} onClick={() => run("reset")}>
                <RotateCcw /> Reset
              </Button>
            </div>
          </Panel>
        </div>
      </div>
      <StatusText tone={status.error ? "error" : "muted"}>
        {status.text ||
          (box
            ? dateAxis
              ? `Box: ${new Date(box.x[0]).toISOString().slice(11, 23)} – ${new Date(box.x[1]).toISOString().slice(11, 23)}`
              : `Box: ${xLabel} ${fmtG(box.x[0])} – ${fmtG(box.x[1])}`
            : "")}
      </StatusText>
    </div>
  );
}
