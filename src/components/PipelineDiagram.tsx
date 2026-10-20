import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  AudioWaveform,
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Eraser,
  FileSpreadsheet,
  FlipVertical2,
  Flag,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Scaling,
  Sigma,
  Sparkles,
  Spline,
  Trash2,
  Undo2,
  Waves,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/common";
import { FilterParams } from "@/components/FilterParams";
import type { FilterType, Pipeline, StageInfo, VariableEdit } from "@/lib/api";
import { defaultStep, filterTitle } from "@/lib/filters";
import { cn } from "@/lib/utils";

/** Block families, shown as the accent on each block. */
export type BlockKind = "clean" | "filter" | "adjust";

export const KIND_COLOR: Record<BlockKind, string> = { clean: "#2a78d6", filter: "#6250d6", adjust: "#1baf7a" };
export const KIND_LABEL: Record<BlockKind, string> = { clean: "Clean", filter: "Filter", adjust: "Adjust" };

const g = (n: number) => String(Number(n.toPrecision(4)));

const FILTER_NAMES: Record<FilterType, string> = {
  lowpass: "Low-pass",
  highpass: "High-pass",
  bandpass: "Band-pass",
  bandstop: "Band-stop",
  savgol: "Savitzky–Golay",
  moving_average: "Moving average",
  exp_moving_average: "Exp. average",
  median: "Median",
  notch: "Notch",
};

export interface BlockInfo {
  kind: BlockKind;
  icon: typeof Zap;
  title: string;
  /** Parameter lines, e.g. "fc = 0.05 Hz". */
  params: string[];
}

/** What a step is, in plain words (title and parameters). */
export function blockInfo(step: VariableEdit, fmtTime: (t: number) => string = g): BlockInfo {
  switch (step.op) {
    case "clear_points":
      return { kind: "clean", icon: Eraser, title: "Remove points", params: [`${step.value.length.toLocaleString("en-US")} picked`] };
    case "clear_range":
      return { kind: "clean", icon: Trash2, title: "Remove range", params: [fmtTime(step.value[0]), `→ ${fmtTime(step.value[1])}`] };
    case "keep_range":
      return { kind: "clean", icon: Crop, title: "Keep range", params: [fmtTime(step.value[0]), `→ ${fmtTime(step.value[1])}`] };
    case "despike":
      return { kind: "clean", icon: Zap, title: "Remove spikes", params: [`Hampel, k = ${g(step.value)}σ`] };
    case "fill_gaps":
      return { kind: "clean", icon: Spline, title: "Fill gaps", params: ["linear"] };
    case "filter": {
      const f = step.value;
      const p = f.params;
      const params: string[] = [];
      if (p.cutoff !== undefined) params.push(`fc = ${g(p.cutoff)} Hz`);
      if (p.low !== undefined && p.high !== undefined) params.push(`${g(p.low)} – ${g(p.high)} Hz`);
      if (p.freq !== undefined) params.push(`f0 = ${g(p.freq)} Hz`, ...(p.Q !== undefined ? [`Q = ${g(p.Q)}`] : []));
      if (p.order !== undefined) params.push(`order ${g(p.order)}`);
      if (p.window !== undefined) params.push(`window ${g(p.window)}`);
      if (p.polyorder !== undefined) params.push(`poly ${g(p.polyorder)}`);
      if (p.alpha !== undefined) params.push(`α = ${g(p.alpha)}`);
      return { kind: "filter", icon: f.filter_type === "notch" ? Waves : AudioWaveform, title: FILTER_NAMES[f.filter_type] ?? filterTitle(f.filter_type), params };
    }
    case "offset":
      return { kind: "adjust", icon: ArrowUpDown, title: "Offset", params: [`${step.value >= 0 ? "+" : "−"}${g(Math.abs(step.value))}`] };
    case "scale":
      return { kind: "adjust", icon: Maximize2, title: "Gain", params: [`× ${g(step.value)}`] };
    case "normalize":
      return { kind: "adjust", icon: Scaling, title: "Normalize", params: ["to 0 … 1"] };
    case "zscore":
      return { kind: "adjust", icon: Sigma, title: "Z-score", params: ["mean 0, σ 1"] };
    case "demean":
      return { kind: "adjust", icon: Minus, title: "Remove mean", params: [] };
    case "zero_start":
      return { kind: "adjust", icon: ArrowDownToLine, title: "Start at zero", params: [] };
    case "invert":
      return { kind: "adjust", icon: FlipVertical2, title: "Invert sign", params: ["× −1"] };
  }
}

/** One line on what a block did to the samples. */
export function effectText(s: StageInfo): string {
  const parts: string[] = [];
  if (s.removed) parts.push(`−${s.removed.toLocaleString("en-US")} removed`);
  if (s.filled) parts.push(`+${s.filled.toLocaleString("en-US")} filled`);
  if (s.changed) parts.push(`${s.changed.toLocaleString("en-US")} changed`);
  return parts.join(" · ") || "no change";
}

/** Steps that need no input are applied as soon as they are picked. */
const NOW = (step: VariableEdit) => ({ step, now: true });
const ASK = (step: VariableEdit) => ({ step, now: false });

export interface AddChoice {
  step: VariableEdit;
  /** True when the step has nothing to set and can be applied right away. */
  now: boolean;
}

const FILTER_MENU: FilterType[] = ["lowpass", "highpass", "bandpass", "bandstop", "notch", "moving_average", "median", "savgol", "exp_moving_average"];

/** Arrow between two blocks, drawn as a signal line. */
function Wire({ active }: { active?: boolean }) {
  return (
    <svg width="28" height="12" viewBox="0 0 28 12" className={cn("shrink-0 transition-colors", active ? "text-ap-red" : "text-ap-bluegray-60")} aria-hidden>
      <line x1="0" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M20 1.5 L27.5 6 L20 10.5 Z" fill="currentColor" />
    </svg>
  );
}

/** One block: icon chip and name, its settings, and what it did. */
function Block({
  accent,
  selected,
  onClick,
  title,
  icon,
  children,
  tone = "block",
  tooltip,
}: {
  accent: string;
  selected?: boolean;
  onClick?: () => void;
  title: string;
  icon: ReactNode;
  children?: ReactNode;
  tone?: "block" | "end" | "draft";
  tooltip?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      title={tooltip}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "relative flex w-[156px] shrink-0 flex-col justify-center gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-shadow",
        tone === "end" && "border-ap-line bg-[#f6f7f9]",
        tone === "block" && "border-ap-line bg-white shadow-[var(--ap-shadow-sm)]",
        tone === "draft" && "border-dashed bg-white",
        onClick && "cursor-pointer hover:shadow-[var(--ap-shadow)]",
        selected && "border-ap-red ring-2 ring-ap-red/25",
      )}
      style={tone === "draft" ? { borderColor: accent } : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5" style={{ background: `${accent}1f`, color: accent }}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-tight font-semibold break-words">{title}</span>
      </div>
      {children && <p className="pl-8 text-[12px] leading-[1.3] break-words text-muted-foreground tabular-nums">{children}</p>}
    </Comp>
  );
}

interface Props {
  /** "file.csv · column" or "= formula". */
  source: string;
  sourceKind: "imported" | "derived";
  /** Name of the variable the pipeline produces. */
  output: string;
  pipeline: Pipeline | null;
  selected: number | null;
  onSelect: (i: number | null) => void;
  busy?: boolean;
  /** Time on the aligned axis → text (dates when the data has a clock). */
  fmtTime?: (t: number) => string;
  nyquist: number;
  /** Starting range for "Remove range" and "Keep range" (what is on screen). */
  rangeDefault: [number, number];
  onRemove: (i: number) => void;
  onMove: (i: number, to: number) => void;
  onReplace: (i: number, step: VariableEdit) => void;
  /** A step being set up: previewed on the plot, added with the button. */
  draft: VariableEdit | null;
  onDraftChange: (s: VariableEdit | null) => void;
  onAdd: (choice: AddChoice) => void;
  onSuggest: () => void;
  suggestions: { reason: string; step: VariableEdit }[];
  canUndo: boolean;
  onUndo: () => void;
  onReset: () => void;
}

/** The processing steps of one signal as a block diagram: Source → blocks → Output. */
export function PipelineDiagram(p: Props) {
  const { source, sourceKind, output, pipeline, selected, onSelect, busy, fmtTime, nyquist, draft, onDraftChange } = p;
  const stages = pipeline?.stages ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useStepCopy(selected !== null ? stages[selected]?.step : undefined);

  // Keep the block being worked on in view.
  useEffect(() => {
    scroller.current?.querySelector('[data-selected="true"], [data-draft="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected, draft]);

  const infos = useMemo(() => stages.map((s) => blockInfo(s.step, fmtTime)), [stages, fmtTime]);
  const sel = selected !== null ? stages[selected] : undefined;
  const dirty = !!sel && !!editing && JSON.stringify(editing) !== JSON.stringify(sel.step);
  const draftInfo = draft ? blockInfo(draft, fmtTime) : null;

  const addItem = (label: string, icon: ReactNode, c: AddChoice) => (
    <DropdownMenuItem key={label} onSelect={() => p.onAdd(c)}>
      {icon} {label}
    </DropdownMenuItem>
  );

  return (
    <div className="flex shrink-0 flex-col rounded-xl border border-ap-line bg-white shadow-[var(--ap-shadow-sm)]">
      <div className="flex items-center gap-2 px-4 pt-2.5">
        <h3 className="ap-eyebrow">Processing</h3>
        <div className="flex-1" />
        <Button size="xs" variant="ghost" disabled={busy || !p.canUndo} onClick={p.onUndo} title="Remove the last step">
          <Undo2 /> Undo
        </Button>
        <Button size="xs" variant="ghost" disabled={busy || stages.length === 0} onClick={p.onReset} title="Remove every step and go back to the imported values">
          <RotateCcw /> Reset
        </Button>
      </div>

      <div ref={scroller} className="flex items-center overflow-x-auto px-4 pt-2.5 pb-3">
        <Block tone="end" accent="#66717d" icon={sourceKind === "derived" ? <Sigma /> : <FileSpreadsheet />} title="Source" tooltip={source} />

        {stages.map((s, i) => {
          const info = infos[i];
          const Icon = info.icon;
          return (
            <div key={i} className="flex items-center">
              <Wire active={selected === i || selected === i - 1} />
              <Block
                accent={KIND_COLOR[info.kind]}
                selected={selected === i}
                onClick={() => onSelect(selected === i ? null : i)}
                icon={<Icon />}
                title={info.title}
                tooltip={`${effectText(s)}${s.rms_change !== null ? ` (rms ${g(s.rms_change)})` : ""}`}
              >
                {info.params.join(" · ")}
              </Block>
            </div>
          );
        })}

        <Wire />
        {draft && draftInfo ? (
          <div data-draft="true" className="flex items-center">
            <Block tone="draft" accent={KIND_COLOR[draftInfo.kind]} icon={<draftInfo.icon />} title={draftInfo.title}>
              {draftInfo.params.join(" · ")}
            </Block>
            <Wire />
          </div>
        ) : (
          <div className="flex items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={busy}
                  className="flex h-[52px] w-[124px] shrink-0 items-center justify-center gap-2 rounded-lg border-2 border-dashed border-ap-gray-light text-[13px] font-medium text-muted-foreground transition-colors hover:border-ap-red hover:bg-ap-red-soft/50 hover:text-ap-red-dark data-[state=open]:border-ap-red data-[state=open]:text-ap-red-dark"
                  title="Add a step to the pipeline"
                >
                  <span className="flex size-7 items-center justify-center rounded-full bg-ap-bluegray-15 group-hover:bg-white">
                    <Plus className="size-4" />
                  </span>
                  Add step
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onSelect={p.onSuggest}>
                  <Sparkles /> Suggest filters
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Eraser /> Clean
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    {addItem("Remove spikes", <Zap />, ASK({ op: "despike", value: 4 }))}
                    {addItem("Fill gaps", <Spline />, NOW({ op: "fill_gaps" }))}
                    {addItem("Remove range", <Trash2 />, ASK({ op: "clear_range", value: p.rangeDefault }))}
                    {addItem("Keep range only", <Crop />, ASK({ op: "keep_range", value: p.rangeDefault }))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <AudioWaveform /> Filter
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    {FILTER_MENU.map((t) => addItem(FILTER_NAMES[t], t === "notch" ? <Waves /> : <AudioWaveform />, ASK({ op: "filter", value: defaultStep(t) })))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ArrowUpDown /> Adjust
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    {addItem("Offset", <ArrowUpDown />, ASK({ op: "offset", value: 0 }))}
                    {addItem("Gain", <Maximize2 />, ASK({ op: "scale", value: 1 }))}
                    <DropdownMenuSeparator />
                    {addItem("Remove mean", <Minus />, NOW({ op: "demean" }))}
                    {addItem("Start at zero", <ArrowDownToLine />, NOW({ op: "zero_start" }))}
                    {addItem("Normalize 0–1", <Scaling />, NOW({ op: "normalize" }))}
                    {addItem("Z-score", <Sigma />, NOW({ op: "zscore" }))}
                    {addItem("Invert sign", <FlipVertical2 />, NOW({ op: "invert" }))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            <Wire />
          </div>
        )}

        <Block tone="end" accent="#ff2400" icon={<Flag />} title="Output" tooltip={output} />
      </div>

      {p.suggestions.length > 0 && !draft && selected === null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-ap-line bg-[#fafbfc] px-4 py-2.5">
          {p.suggestions.map((s, i) => (
            <button
              key={i}
              className="rounded-full border border-ap-line bg-white px-3 py-1 text-[12px] hover:border-ap-red hover:bg-ap-red-soft"
              onClick={() => onDraftChange(s.step)}
            >
              {s.reason}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-ap-line bg-[#fafbfc] px-4 py-3">
          <div className="min-w-[140px]">
            <p className="text-[14px] font-semibold">{draftInfo?.title}</p>
          </div>
          <div className="flex min-w-[220px] flex-1 flex-wrap items-end gap-x-4 gap-y-1.5">
            <StepEditor step={draft} onChange={onDraftChange} nyquist={nyquist} />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onDraftChange(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => p.onAdd({ step: draft, now: true })}>
              <Check /> Add to pipeline
            </Button>
          </div>
        </div>
      )}

      {!draft && sel && editing && (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-ap-line bg-[#fafbfc] px-4 py-3">
          <div className="min-w-[140px]">
            <p className="text-[12px] text-muted-foreground tabular-nums">{effectText(sel)}</p>
            <p className="text-[14px] font-semibold">{infos[selected!].title}</p>
          </div>
          <div className="flex min-w-[220px] flex-1 flex-wrap items-end gap-x-4 gap-y-1.5">
            <StepEditor step={editing} onChange={setEditing} nyquist={nyquist} />
          </div>
          <div className="flex items-center gap-1.5">
            {dirty && (
              <Button disabled={busy} onClick={() => p.onReplace(selected!, editing)} title="Re-run the pipeline with the new settings">
                <Check /> Apply
              </Button>
            )}
            <Button size="icon" variant="ghost" disabled={busy || selected === 0} onClick={() => p.onMove(selected!, selected! - 1)} title="Move this step earlier">
              <ChevronLeft />
            </Button>
            <Button size="icon" variant="ghost" disabled={busy || selected === stages.length - 1} onClick={() => p.onMove(selected!, selected! + 1)} title="Move this step later">
              <ChevronRight />
            </Button>
            <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => p.onRemove(selected!)} title="Delete this step; the steps after it run on its input">
              <Trash2 /> Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A copy of a step to edit, reset whenever the selected step changes. */
function useStepCopy(step: VariableEdit | undefined): [VariableEdit | null, (s: VariableEdit | null) => void] {
  const [value, setValue] = useState<VariableEdit | null>(step ?? null);
  const key = step ? JSON.stringify(step) : "";
  const last = useRef(key);
  if (last.current !== key) {
    last.current = key;
    setValue(step ?? null);
  }
  return [value, setValue];
}

/** Editable settings of one step; steps without settings say so. */
function StepEditor({ step, onChange, nyquist }: { step: VariableEdit; onChange: (s: VariableEdit) => void; nyquist: number }) {
  switch (step.op) {
    case "filter":
      return (
        <div className="min-w-[240px] flex-1">
          <FilterParams step={step.value} onChange={(value) => onChange({ op: "filter", value })} nyquist={nyquist} />
        </div>
      );
    case "offset":
    case "scale":
    case "despike":
      return (
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          {step.op === "offset" ? "Add" : step.op === "scale" ? "Multiply by" : "Threshold"}
          <NumberInput
            className="w-32"
            value={step.value}
            step={step.op === "despike" ? 0.5 : 0.1}
            min={step.op === "despike" ? 1 : undefined}
            suffix={step.op === "despike" ? "σ" : undefined}
            onChange={(value) => onChange({ op: step.op as "offset" | "scale" | "despike", value })}
          />
        </label>
      );
    case "clear_range":
    case "keep_range":
      return (
        <>
          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            From
            <NumberInput className="w-36" value={step.value[0]} step={1} suffix="s" onChange={(a) => onChange({ op: step.op as "clear_range" | "keep_range", value: [a, step.value[1]] })} />
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            To
            <NumberInput className="w-36" value={step.value[1]} step={1} suffix="s" onChange={(b) => onChange({ op: step.op as "clear_range" | "keep_range", value: [step.value[0], b] })} />
          </label>
        </>
      );
    case "clear_points":
      return <p className="text-[12.5px] text-muted-foreground">Picked points cannot be edited. Delete this step to bring them back.</p>;
    default:
      return <p className="text-[12.5px] text-muted-foreground">Nothing to set.</p>;
  }
}
