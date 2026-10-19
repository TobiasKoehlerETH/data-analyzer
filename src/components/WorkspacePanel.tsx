import { useState } from "react";
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
import { api, errorText, type Align, type VariableInfo, type WorkspaceView } from "@/lib/api";
import { ask, message, open, save } from "@/lib/platform";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const fmtRange = (lo: number | null, hi: number | null) => (lo === null || hi === null ? "" : `${Number(lo.toPrecision(4))} … ${Number(hi.toPrecision(4))}`);
const PROJECT_FILTERS = [{ name: "Data Analyzer project", extensions: ["daproj"] }];
const RECIPE_FILTERS = [{ name: "Recipe", extensions: ["recipe.json", "json"] }];
const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.recipe\.json$|\.json$/i, "");

/** Formula text referring to a variable: bare for plain identifiers, quoted otherwise. */
const ref = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`);

interface Props {
  ws: WorkspaceView;
  fresh: string[];
  run: (f: () => Promise<WorkspaceView>) => Promise<void>;
  onAddFiles: () => void;
  onExport: () => void;
}

/** Workspace list: variables grouped by file, derived variables, alignment, projects and recipes. */
export function WorkspacePanel({ ws, fresh, run, onAddFiles, onExport }: Props) {
  const { setActiveTab, setPrepareVariable, showStatus } = useApp();
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [formula, setFormula] = useState<{ name: string; text: string; editing: string | null; error: string } | null>(null);
  const numeric = ws.variables.filter((v) => v.kind !== "text");

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

  const row = (v: VariableInfo) => (
    <li key={v.name} className={cn("group flex items-center gap-2 py-1.5 pr-2 pl-3 hover:bg-[#f7f8f8]", fresh.includes(v.name) && "bg-[#fff4f1]")}>
      {v.kind === "imported" ? (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => run(() => api.workspaceSetTime(v.name, !v.is_time))}
          title={v.is_time ? "Time axis of this file (click to unset)" : "Use as this file's time axis"}
          className={v.is_time ? "text-ap-red" : "text-ap-bluegray-60 opacity-0 group-hover:opacity-100"}
        >
          <Clock />
        </Button>
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground" title={v.kind === "text" ? "Text column (for grouping)" : "Computed from a formula"}>
          {v.kind === "text" ? <Type className="size-3.5" /> : <Sigma className="size-3.5" />}
        </span>
      )}
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
          <p className="truncate text-[13px]" onDoubleClick={() => setRenaming({ name: v.name, value: v.name })} title={`${v.source}\nDouble-click to rename`}>
            {v.name}
          </p>
        )}
        <p className={cn("truncate text-[11px] tabular-nums", v.error ? "text-destructive" : "text-muted-foreground")} title={[v.error ?? v.source, ...v.edits].join("\n")}>
          {v.error ? (
            v.error
          ) : v.kind === "derived" ? (
            <>= {v.formula}</>
          ) : v.kind === "text" ? (
            <>text · {v.len.toLocaleString("en-US")} rows</>
          ) : (
            <>
              {v.edits.length > 0 && <span className="mr-1 text-ap-red">{v.edits.length} step{v.edits.length === 1 ? "" : "s"} ·</span>}
              {v.len.toLocaleString("en-US")} · {fmtRange(v.min, v.max)}
            </>
          )}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" title="Edit">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-none">
          {v.kind !== "text" && !v.is_time && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  setPrepareVariable(v.name);
                  setActiveTab("prepare");
                }}
              >
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

  const derived = ws.variables.filter((v) => v.kind === "derived");

  return (
    <section className="flex w-[340px] shrink-0 flex-col border border-ap-line bg-white">
      <header className="flex h-11 items-center gap-1 border-b border-ap-line pr-2 pl-4">
        <h2 className="flex-1 text-[14px]">
          Workspace <span className="text-muted-foreground tabular-nums">{ws.variables.length || ""}</span>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" title="Projects and recipes">
              <BookOpen /> <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-none">
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
        <Button size="icon-sm" variant="ghost" disabled={!ws.variables.length} onClick={onExport} title="Export as CSV (Ctrl+E)">
          <Download />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={!ws.variables.length}
          title="Clear workspace"
          onClick={async () => {
            if (await ask("Remove all variables?", { title: "Clear workspace", kind: "warning" })) run(api.workspaceClear);
          }}
        >
          <Trash2 />
        </Button>
      </header>

      {ws.auto_recipe && (
        <div className="flex items-center gap-2 border-b border-ap-line bg-[#fff4f1] px-4 py-1.5 text-[12px]">
          <BookOpen className="size-3.5 text-ap-red" />
          <span className="flex-1 truncate">
            New imports get <b className="font-medium">{ws.auto_recipe}</b>
          </span>
          <Button size="icon-xs" variant="ghost" title="Stop applying the recipe" onClick={() => run(() => api.recipeSetAuto(null))}>
            <X />
          </Button>
        </div>
      )}

      {ws.sources.length > 0 && (
        <div className="flex items-center gap-2 border-b border-ap-line px-4 py-2 text-[12px]">
          {ws.sources.length > 1 ? (
            <>
              <span className="text-muted-foreground">Align</span>
              <Select value={ws.align} onValueChange={(a) => run(() => api.workspaceSetAlign(a as Align, ws.grid_step))}>
                <SelectTrigger className="h-7 flex-1" title="How files with different time bases are combined">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="time">By time</SelectItem>
                  <SelectItem value="clock">By clock time</SelectItem>
                  <SelectItem value="row">By row</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : (
            <span className="flex-1 text-muted-foreground">Resample to</span>
          )}
          {ws.align !== "row" && (
            <NumberInput
              className="w-24"
              value={ws.grid_step ?? 0}
              min={0}
              step={0.001}
              suffix="s"
              title="Time step of the common grid (0 = the files' own, finest step). A coarser step averages the samples in each step."
              onChange={(s) => run(() => api.workspaceSetAlign(ws.align, s > 0 ? s : null))}
            />
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {ws.sources.map((s) => (
          <div key={s.id} className="mb-1">
            <div className="group flex items-center gap-2 bg-[#f7f8f8] py-1 pr-2 pl-3 text-[12px]">
              <FileSpreadsheet className="size-3.5 shrink-0 text-ap-red" />
              <span className="min-w-0 flex-1 truncate" title={`${s.path}\n${s.rows.toLocaleString("en-US")} rows · ${Number(s.sample_rate.toPrecision(4))} Hz${s.origin ? `\nStarts ${new Date(s.origin * 1000).toISOString().replace("T", " ").replace(".000Z", "")}` : ""}`}>
                {s.name}
              </span>
              {ws.sources.length > 1 && ws.align !== "row" && (
                <NumberInput
                  className="w-24"
                  value={s.offset}
                  step={0.1}
                  suffix="s"
                  title="Shift this file in time when aligning"
                  onChange={(o) => run(() => api.workspaceSetOffset(s.id, o))}
                />
              )}
              <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" title="Remove this file" onClick={() => run(() => api.workspaceRemoveSource(s.id))}>
                <X />
              </Button>
            </div>
            <ul>{ws.variables.filter((v) => v.source_id === s.id).map(row)}</ul>
          </div>
        ))}
        {derived.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center gap-2 bg-[#f7f8f8] py-1 pr-2 pl-3 text-[12px]">
              <Sigma className="size-3.5 text-ap-red" />
              <span className="flex-1">Derived</span>
            </div>
            <ul>{derived.map(row)}</ul>
          </div>
        )}
      </div>

      <footer className="flex gap-2 border-t border-ap-line p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="flex-1">
              <Plus /> Add data <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 rounded-none">
            <DropdownMenuItem onSelect={onAddFiles}>
              <FileSpreadsheet /> Files…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={addFolder}>
              <FolderTree /> Folder of runs…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="icon" disabled={!numeric.length} title="New variable from a formula" onClick={() => setFormula({ name: "", text: "", editing: null, error: "" })}>
          <Sigma />
        </Button>
        <Button className="flex-1" disabled={!ws.dataset} onClick={() => setActiveTab("timeseries")}>
          <ChartLine /> Plot
        </Button>
      </footer>

      <Dialog open={!!formula} onOpenChange={(o) => !o && setFormula(null)}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-normal">{formula?.editing ? `Edit formula · ${formula.editing}` : "New variable from a formula"}</DialogTitle>
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
                <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                  Name
                  <Input autoFocus value={formula.name} placeholder="Power [W]" onChange={(e) => setFormula({ ...formula, name: e.target.value, error: "" })} />
                </label>
              )}
              <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                Formula
                <Textarea
                  className="min-h-20 font-mono text-[13px]"
                  value={formula.text}
                  placeholder='"Voltage [V]" * Current'
                  onChange={(e) => setFormula({ ...formula, text: e.target.value, error: "" })}
                />
              </label>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {numeric
                  .filter((v) => v.name !== formula.editing)
                  .map((v) => (
                    <button
                      type="button"
                      key={v.name}
                      className="border border-ap-line px-1.5 py-0.5 text-[11.5px] hover:border-ap-red"
                      onClick={() => setFormula({ ...formula, text: `${formula.text}${formula.text && !formula.text.endsWith(" ") ? " " : ""}${ref(v.name)}`, error: "" })}
                    >
                      {v.name}
                    </button>
                  ))}
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                Click a variable to insert it. Names with spaces or units go in double quotes. Use + − * / ^, sqrt, exp, ln, abs, sin, cos, min, max and t for time.
              </p>
              {formula.error && (
                <p role="alert" className="text-[12px] text-destructive">
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
    </section>
  );
}
