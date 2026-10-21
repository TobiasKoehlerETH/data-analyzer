import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  BrushCleaning,
  ChartLine,
  ChevronDown,
  Clock,
  Copy,
  Download,
  FileSpreadsheet,
  FolderOpen,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Sigma,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/common";
import { api, errorText, type Align, type SourceInfo, type TimeMap, type VariableInfo, type WorkspaceView } from "@/lib/api";
import { ask, message, open, save } from "@/lib/platform";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const fmtRange = (lo: number | null, hi: number | null) => (lo === null || hi === null ? "" : `${Number(lo.toPrecision(4))} … ${Number(hi.toPrecision(4))}`);
const PROJECT_FILTERS = [{ name: "Data Analyzer project", extensions: ["daproj"] }];
const RECIPE_FILTERS = [{ name: "Recipe", extensions: ["recipe.json", "json"] }];
const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.recipe\.json$|\.json$/i, "");

/** Formula text referring to a variable: bare for plain identifiers, quoted otherwise. */
const ref = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`);

/** About 120 points that keep a signal's peaks: the min and max of each bucket, in order. */
function shape(v: (number | null)[], buckets = 60): (number | null)[] {
  if (v.length <= buckets * 2) return v;
  const size = v.length / buckets;
  const out: (number | null)[] = [];
  for (let b = 0; b < buckets; b++) {
    let lo = Infinity;
    let hi = -Infinity;
    let iLo = 0;
    let iHi = 0;
    for (let i = Math.floor(b * size); i < Math.min(v.length, Math.floor((b + 1) * size)); i++) {
      const y = v[i];
      if (y === null || !Number.isFinite(y)) continue;
      if (y < lo) {
        lo = y;
        iLo = i;
      }
      if (y > hi) {
        hi = y;
        iHi = i;
      }
    }
    if (lo === Infinity) out.push(null, null);
    else out.push(...(iLo <= iHi ? [lo, hi] : [hi, lo]));
  }
  return out;
}

/** Tiny line of a signal's shape. */
function Sparkline({ values }: { values: (number | null)[] | undefined }) {
  const path = useMemo(() => {
    if (!values) return "";
    const ys = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (ys.length < 2) return "";
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const span = hi - lo || 1;
    const n = values.length;
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${((i / (n - 1)) * 118 + 1).toFixed(1)} ${(27 - ((v - lo) / span) * 24).toFixed(1)}`;
      pen = true;
    });
    return d;
  }, [values]);
  return (
    <svg width="120" height="30" viewBox="0 0 120 30" className="shrink-0 text-ap-bluegray" aria-hidden>
      {path && <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

const T = (t: number) => String(Number(t.toPrecision(6)));
const STEP = "__step";
const UNITS = [
  { label: "seconds", scale: 1 },
  { label: "minutes", scale: 60 },
  { label: "hours", scale: 3600 },
  { label: "days", scale: 86400 },
];

/** How a file's rows sit in time: where its time comes from, a ruler of rows against time, and a lookup. */
function TimeMapRow({ s, vars, run }: { s: SourceInfo; vars: VariableInfo[]; run: (f: () => Promise<WorkspaceView>) => Promise<void> }) {
  const dataVersion = useApp((x) => x.dataVersion);
  const [ticks, setTicks] = useState<TimeMap[]>([]);
  const [row, setRow] = useState(1);
  const [at, setAt] = useState<TimeMap | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [near, setNear] = useState<TimeMap | null>(null);
  const columns = vars.filter((v) => v.kind === "imported");
  const source = s.row_step !== null ? STEP : (s.time_var ?? "");

  useEffect(() => {
    let cancelled = false;
    const rows = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.max(1, Math.round(f * s.rows)));
    Promise.all(rows.map((r) => api.sourceTimeMap(s.id, { row: r })))
      .then((t) => !cancelled && setTicks(t))
      .catch(() => !cancelled && setTicks([]));
    return () => {
      cancelled = true;
    };
  }, [s.id, s.rows, s.row_step, s.time_var, s.offset, dataVersion]);

  useEffect(() => {
    let cancelled = false;
    api
      .sourceTimeMap(s.id, { row })
      .then((t) => !cancelled && setAt(t))
      .catch(() => !cancelled && setAt(null));
    return () => {
      cancelled = true;
    };
  }, [s.id, row, s.row_step, s.time_var, s.offset, dataVersion]);

  useEffect(() => {
    if (time === null) return setNear(null);
    let cancelled = false;
    api
      .sourceTimeMap(s.id, { time })
      .then((t) => !cancelled && setNear(t))
      .catch(() => !cancelled && setNear(null));
    return () => {
      cancelled = true;
    };
  }, [s.id, time, s.row_step, s.time_var, s.offset, dataVersion]);

  const label = (t: TimeMap) => (t.clock ? t.clock.slice(11) : `${T(t.time)} s`);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-ap-line px-4 py-2.5 text-[12px]">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Time from</span>
        <Select
          value={source || undefined}
          onValueChange={(v) => {
            if (v === STEP) run(() => api.workspaceSetRowStep(s.id, s.row_step ?? (s.sample_rate > 0 && Number.isFinite(s.sample_rate) ? Number((1 / s.sample_rate).toPrecision(6)) : 1)));
            else run(() => api.workspaceSetTime(v, true));
          }}
        >
          <SelectTrigger className="h-8 w-44" title="Take the time from a column, or from a fixed step per row">
            <SelectValue placeholder="Row number" />
          </SelectTrigger>
          <SelectContent>
            {columns.map((v) => (
              <SelectItem key={v.name} value={v.name}>
                {v.name}
              </SelectItem>
            ))}
            <SelectItem value={STEP}>Fixed step per row</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {s.row_step === null && s.origin === null && (
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">in</span>
          <Select value={String(s.time_scale)} onValueChange={(v) => run(() => api.workspaceSetTimeUnit(s.id, Number(v)))}>
            <SelectTrigger className="h-8 w-28" title="The unit the time column is given in">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((u) => (
                <SelectItem key={u.scale} value={String(u.scale)}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      {s.row_step !== null && (
        <label className="flex items-center gap-2">
          <NumberInput className="w-32" value={s.row_step} min={0} step={0.001} suffix="s/row" title="Seconds between two rows" onChange={(k) => k > 0 && run(() => api.workspaceSetRowStep(s.id, k))} />
        </label>
      )}

      {ticks.length > 0 && (
        <div className="min-w-[260px] flex-1" aria-label="Rows against time">
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            {ticks.map((t, i) => (
              <span key={i}>row {t.row.toLocaleString("en-US")}</span>
            ))}
          </div>
          <div className="relative my-1 h-px bg-ap-gray-light">
            {ticks.map((_, i) => (
              <span key={i} className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ap-bluegray" style={{ left: `${i * 25}%` }} />
            ))}
          </div>
          <div className="flex justify-between text-[11.5px] font-medium tabular-nums">
            {ticks.map((t, i) => (
              <span key={i}>{label(t)}</span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 tabular-nums">
        <span className="text-muted-foreground">Row</span>
        <NumberInput className="w-24" value={row} min={1} max={s.rows} step={1} integer onChange={setRow} />
        <span className="min-w-[72px] font-medium">= {at ? label(at) : "…"}</span>
        <span className="mx-1 text-muted-foreground">·</span>
        <span className="text-muted-foreground">Time</span>
        <NumberInput className="w-28" value={time ?? 0} step={0.1} suffix="s" onChange={setTime} />
        <span className="min-w-[64px] font-medium">{time === null ? "" : near ? `= row ${near.row.toLocaleString("en-US")}` : "…"}</span>
      </div>
    </div>
  );
}

interface Props {
  ws: WorkspaceView;
  fresh: string[];
  run: (f: () => Promise<WorkspaceView>) => Promise<void>;
  onAddFiles: () => void;
  onExport: () => void;
}

/** The workspace: every file with its variables, alignment, formulas, projects and recipes. */
export function WorkspacePanel({ ws, fresh, run, onAddFiles, onExport }: Props) {
  const { setActiveTab, setPrepareVariable, showStatus, dataVersion } = useApp();
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [formula, setFormula] = useState<{ name: string; text: string; editing: string | null; error: string } | null>(null);
  const [spark, setSpark] = useState<Record<string, (number | null)[]>>({});
  const numeric = ws.variables.filter((v) => v.kind !== "text");
  const sparkKey = numeric.map((v) => `${v.name}:${v.edits.length}`).join("|");

  useEffect(() => {
    const names = numeric.filter((v) => !v.is_time && !v.error).map((v) => v.name);
    if (!names.length || !ws.dataset) {
      setSpark({});
      return;
    }
    let cancelled = false;
    // Each signal on its own samples, so files with different time bases keep their shape.
    Promise.all(names.map((n) => api.workspaceVariable(n).then((v) => [n, shape(v.edited)] as const)))
      .then((r) => !cancelled && setSpark(Object.fromEntries(r)))
      .catch(() => !cancelled && setSpark({}));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sparkKey, dataVersion, !!ws.dataset]);

  const warn = async (v: WorkspaceView, done: string) => {
    if (v.warnings.length) await message(v.warnings.join("\n"), { title: done, kind: "warning" });
    else showStatus(done);
  };

  const addFolder = async () => {
    const dir = await open({ directory: true, title: "Folder of runs (each file becomes a run)" });
    if (typeof dir !== "string") return;
    await run(async () => {
      const v = await api.workspaceImportBatch([], dir, null);
      await warn(v, `Imported ${v.sources.length - ws.sources.length} files as runs`);
      return v;
    });
  };

  const saveProject = async () => {
    const p = await save({ filters: PROJECT_FILTERS, title: "Save project", defaultPath: "analysis.daproj" });
    if (!p) return;
    try {
      await api.projectSave(p);
      showStatus(`Project saved to ${p}`);
    } catch (e) {
      await message(errorText(e), { title: "Save failed", kind: "error" });
    }
  };

  const openProject = async () => {
    if (ws.variables.length && !(await ask("Replace the current workspace with the project?", { title: "Open project", kind: "warning" }))) return;
    const p = await open({ filters: PROJECT_FILTERS, title: "Open project" });
    if (typeof p !== "string") return;
    await run(async () => {
      const v = await api.projectOpen(p);
      await warn(v, `Opened ${stem(p)}`);
      return v;
    });
  };

  const saveRecipe = async () => {
    const p = await save({ filters: RECIPE_FILTERS, title: "Save recipe", defaultPath: "cleaning.recipe.json" });
    if (!p) return;
    try {
      const r = await api.recipeSave(p, stem(p), null);
      showStatus(`Recipe saved: ${r.columns.length} column(s), ${r.derived.length} formula(s)`);
    } catch (e) {
      await message(errorText(e), { title: "Save recipe", kind: "error" });
    }
  };

  const loadRecipe = async (auto: boolean) => {
    const p = await open({ filters: RECIPE_FILTERS, title: auto ? "Recipe for new imports" : "Apply recipe" });
    if (typeof p !== "string") return;
    await run(async () => {
      const recipe = await api.recipeLoad(p);
      if (auto) {
        const v = await api.recipeSetAuto(recipe);
        showStatus(`New imports get recipe '${recipe.name}'`);
        return v;
      }
      const v = await api.recipeApply(recipe, null);
      await warn(v, `Applied recipe '${recipe.name}'`);
      return v;
    });
  };

  const submitFormula = async () => {
    if (!formula) return;
    try {
      const v = formula.editing
        ? await api.workspaceSetFormula(formula.editing, formula.text)
        : await api.workspaceAddDerived(formula.name, formula.text);
      const target = v.variables.find((x) => x.name === (formula.editing ?? formula.name));
      if (target?.error) {
        setFormula({ ...formula, error: target.error });
        await run(async () => v);
        return;
      }
      setFormula(null);
      await run(async () => v);
    } catch (e) {
      setFormula({ ...formula, error: errorText(e) });
    }
  };

  const prepare = (name: string) => {
    setPrepareVariable(name);
    setActiveTab("prepare");
  };

  const row = (v: VariableInfo) => {
    const cleanable = v.kind !== "text" && !v.is_time && !v.error;
    return (
      <li key={v.name} className={cn("group flex items-center gap-3 py-2 pr-3 pl-4 transition-colors hover:bg-[#f7f8fa]", fresh.includes(v.name) && "bg-ap-red-soft/60")}>
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground" title={v.is_time ? "Time axis of this file" : v.kind === "text" ? "Text column (for grouping)" : v.kind === "derived" ? "Computed from a formula" : undefined}>
          {v.is_time ? <Clock className="size-3.5 text-ap-red" /> : v.kind === "text" ? <Type className="size-3.5" /> : v.kind === "derived" ? <Sigma className="size-3.5" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          {renaming?.name === v.name ? (
            <Input
              autoFocus
              className="h-7 text-[13px]"
              value={renaming.value}
              onChange={(e) => setRenaming({ name: v.name, value: e.target.value })}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(null);
                if (e.key === "Enter") {
                  const value = renaming.value;
                  setRenaming(null);
                  if (value.trim() && value !== v.name) run(() => api.workspaceRename(v.name, value));
                }
              }}
            />
          ) : (
            <p className="truncate text-[13.5px] font-medium" onDoubleClick={() => setRenaming({ name: v.name, value: v.name })} title={`${v.source}\nDouble-click to rename`}>
              {v.name}
            </p>
          )}
          <p className={cn("truncate text-[12px] tabular-nums", v.error ? "text-destructive" : "text-muted-foreground")} title={[v.error ?? v.source, ...v.edits].join("\n")}>
            {v.error ? (
              v.error
            ) : v.kind === "derived" ? (
              <>= {v.formula}</>
            ) : v.kind === "text" ? (
              <>text · {v.len.toLocaleString("en-US")} rows</>
            ) : (
              <>
                {v.len.toLocaleString("en-US")} rows
                {fmtRange(v.min, v.max) && <> · {fmtRange(v.min, v.max)}</>}
              </>
            )}
          </p>
        </div>
        {cleanable && <Sparkline values={spark[v.name]} />}
        <span className="flex w-[68px] shrink-0 justify-end">
          {v.edits.length > 0 && (
            <button
              onClick={() => prepare(v.name)}
              className="rounded-full bg-ap-red-soft px-2 py-0.5 text-[11.5px] font-medium text-ap-red-dark hover:bg-[#ffe3dd]"
              title={`${v.edits.join("\n")}\nOpen the pipeline in Prepare`}
            >
              {v.edits.length} step{v.edits.length === 1 ? "" : "s"}
            </button>
          )}
        </span>
        {cleanable && (
          <Button size="xs" variant="outline" className="shrink-0 opacity-0 group-hover:opacity-100" onClick={() => prepare(v.name)} title="Clean and filter this signal">
            <BrushCleaning /> Prepare
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" className="shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" title="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {cleanable && (
              <>
                <DropdownMenuItem onSelect={() => prepare(v.name)}>
                  <BrushCleaning /> Clean in Prepare…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {v.kind === "derived" && (
              <DropdownMenuItem onSelect={() => setFormula({ name: v.name, text: v.formula ?? "", editing: v.name, error: "" })}>
                <Sigma /> Edit formula…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setRenaming({ name: v.name, value: v.name })}>
              <Pencil /> Rename
            </DropdownMenuItem>
            {v.kind !== "text" && (
              <DropdownMenuItem onSelect={() => run(() => api.workspaceEdit(v.name, "duplicate"))}>
                <Copy /> Duplicate
              </DropdownMenuItem>
            )}
            {v.edits.length > 0 && (
              <DropdownMenuItem onSelect={() => run(() => api.workspaceEdit(v.name, "reset"))}>
                <RotateCcw /> Reset to original
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => run(() => api.workspaceRemove([v.name]))}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    );
  };

  const derived = ws.variables.filter((v) => v.kind === "derived");
  const empty = ws.sources.length === 0 && derived.length === 0;

  const card = (key: string | number, header: React.ReactNode, body: React.ReactNode, extra?: React.ReactNode) => (
    <section key={key} className="shrink-0 overflow-hidden rounded-xl border border-ap-line bg-white shadow-[var(--ap-shadow-sm)]">
      <header className="group flex items-center gap-2.5 border-b border-ap-line bg-[#fafbfc] py-2 pr-3 pl-4">{header}</header>
      {extra}
      <ul className="divide-y divide-ap-line/60">{body}</ul>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <Plus /> Add data <ChevronDown className="size-3.5 opacity-80" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={onAddFiles}>
              <FileSpreadsheet /> Files…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={addFolder}>
              <FolderTree /> Folder of runs…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" disabled={!numeric.length} title="New variable from a formula" onClick={() => setFormula({ name: "", text: "", editing: null, error: "" })}>
          <Sigma /> Formula
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" title="Projects and recipes">
              <BookOpen /> Project <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={openProject}>
              <FolderOpen /> Open project…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ws.sources.length} onSelect={saveProject}>
              <Save /> Save project…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!ws.variables.length} onSelect={saveRecipe}>
              <Save /> Save processing as recipe…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ws.variables.length} onSelect={() => loadRecipe(false)}>
              <BookOpen /> Apply recipe…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => loadRecipe(true)}>
              <BookOpen /> Recipe for new imports…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="icon" disabled={!ws.variables.length} onClick={onExport} title="Export as CSV (Ctrl+E)">
          <Download />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!ws.variables.length}
          title="Clear all data"
          onClick={async () => {
            if (await ask("Remove all variables?", { title: "Clear workspace", kind: "warning" })) run(api.workspaceClear);
          }}
        >
          <Trash2 />
        </Button>
      </div>

      {ws.auto_recipe && (
        <div className="flex items-center gap-2 rounded-lg bg-ap-red-soft px-3 py-2 text-[12.5px]">
          <BookOpen className="size-3.5 text-ap-red" />
          <span className="flex-1 truncate">
            New imports get the recipe <b>{ws.auto_recipe}</b>
          </span>
          <Button size="icon-xs" variant="ghost" title="Stop applying the recipe" onClick={() => run(() => api.recipeSetAuto(null))}>
            <X />
          </Button>
        </div>
      )}

      {empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <button
            onClick={onAddFiles}
            className="group flex w-[480px] flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-ap-gray-light bg-white px-10 py-14 text-center transition-colors hover:border-ap-red hover:bg-ap-red-soft/40"
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-ap-red-soft text-ap-red">
              <FolderOpen className="size-6" strokeWidth={1.6} />
            </span>
            <span className="text-[19px] font-semibold">Drop files here, or click to browse</span>
            <span className="text-[13px] text-muted-foreground">CSV · TXT · Excel · Parquet · MAT · HDF5 · TDMS</span>
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {ws.sources.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-ap-line bg-white px-4 py-2.5 text-[13px] shadow-[var(--ap-shadow-sm)]">
              {ws.sources.length > 1 && (
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Line up files</span>
                  <Select value={ws.align} onValueChange={(a) => run(() => api.workspaceSetAlign(a as Align, ws.grid_step))}>
                    <SelectTrigger className="h-8 w-40" title="How files with different time bases are combined">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="time">By time</SelectItem>
                      <SelectItem value="clock">By clock time</SelectItem>
                      <SelectItem value="row">By row</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              )}
              {ws.align !== "row" && (
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Resample to</span>
                  <NumberInput
                    className="w-28"
                    value={ws.grid_step ?? 0}
                    min={0}
                    step={0.001}
                    suffix="s"
                    title="Time step of the common grid (0 = the files' own, finest step). A coarser step averages the samples in each step."
                    onChange={(s) => run(() => api.workspaceSetAlign(ws.align, s > 0 ? s : null))}
                  />
                </label>
              )}
              {ws.sources.length > 1 && ws.align !== "row" && (
                <Button
                  variant="outline"
                  size="sm"
                  title="Use the time step of the slowest file. Faster files are averaged, so every signal has the same number of rows."
                  onClick={() => {
                    const rates = ws.sources.map((s) => s.sample_rate).filter((r) => r > 0 && Number.isFinite(r));
                    if (rates.length) run(() => api.workspaceSetAlign(ws.align, Number((1 / Math.min(...rates)).toPrecision(6))));
                  }}
                >
                  Same length
                </Button>
              )}
              <span className="text-[12px] text-muted-foreground">0 = keep each file's own time step</span>
              <div className="flex-1" />
              <Button disabled={!ws.dataset} onClick={() => setActiveTab("prepare")}>
                <BrushCleaning /> Prepare
              </Button>
              <Button variant="outline" disabled={!ws.dataset} onClick={() => setActiveTab("timeseries")}>
                <ChartLine /> Plot
              </Button>
            </div>
          )}

          {ws.sources.map((s) =>
            card(
              s.id,
              <>
                <FileSpreadsheet className="size-4 shrink-0 text-ap-red" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold" title={s.path}>
                    {s.name}
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground tabular-nums">
                    {s.rows.toLocaleString("en-US")} rows · {Number(s.sample_rate.toPrecision(4))} Hz
                    {s.origin ? ` · starts ${new Date(s.origin * 1000).toISOString().replace("T", " ").replace(".000Z", "")}` : ""}
                  </p>
                </div>
                {ws.sources.length > 1 && ws.align !== "row" && (
                  <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    Shift
                    <NumberInput className="w-28" value={s.offset} step={0.1} suffix="s" title="Shift this file in time when aligning" onChange={(o) => run(() => api.workspaceSetOffset(s.id, o))} />
                  </label>
                )}
                <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" title="Remove this file" onClick={() => run(() => api.workspaceRemoveSource(s.id))}>
                  <X />
                </Button>
              </>,
              ws.variables.filter((v) => v.source_id === s.id).map(row),
              <TimeMapRow s={s} vars={ws.variables.filter((v) => v.source_id === s.id)} run={run} />,
            ),
          )}
          {derived.length > 0 &&
            card(
              "derived",
              <>
                <Sigma className="size-4 shrink-0 text-ap-red" />
                <p className="flex-1 text-[13.5px] font-semibold">Formulas</p>
              </>,
              derived.map(row),
            )}
        </div>
      )}

      <Dialog open={!!formula} onOpenChange={(o) => !o && setFormula(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{formula?.editing ? `Edit formula · ${formula.editing}` : "New variable from a formula"}</DialogTitle>
          </DialogHeader>
          {formula && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                submitFormula();
              }}
            >
              {!formula.editing && (
                <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
                  Name
                  <Input autoFocus value={formula.name} placeholder="Power [W]" onChange={(e) => setFormula({ ...formula, name: e.target.value, error: "" })} />
                </label>
              )}
              <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
                Formula
                <Textarea
                  className="min-h-20 font-mono text-[13px]"
                  value={formula.text}
                  placeholder='"Voltage [V]" * Current'
                  onChange={(e) => setFormula({ ...formula, text: e.target.value, error: "" })}
                />
              </label>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {numeric
                  .filter((v) => v.name !== formula.editing)
                  .map((v) => (
                    <button
                      type="button"
                      key={v.name}
                      className="rounded-md border border-ap-line px-2 py-0.5 text-[12px] hover:border-ap-red hover:bg-ap-red-soft"
                      onClick={() => setFormula({ ...formula, text: `${formula.text}${formula.text && !formula.text.endsWith(" ") ? " " : ""}${ref(v.name)}`, error: "" })}
                    >
                      {v.name}
                    </button>
                  ))}
              </div>
              <p className="text-[12px] text-muted-foreground">
                Click a variable to insert it. Names with spaces or units go in double quotes. Use + − * / ^, sqrt, exp, ln, abs, sin, cos, min, max and t for time.
              </p>
              {formula.error && (
                <p role="alert" className="text-[12.5px] text-destructive">
                  {formula.error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormula(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!formula.text.trim() || (!formula.editing && !formula.name.trim())}>
                  {formula.editing ? "Update" : "Add variable"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
