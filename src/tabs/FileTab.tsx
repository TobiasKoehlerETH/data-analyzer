import { useEffect, useMemo, useState } from "react";
import { Clock, FileSpreadsheet, FolderOpen, Info, Loader2, Plus, SlidersHorizontal, Type, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberInput } from "@/components/common";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ImportSettings } from "@/components/ImportSettings";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { api, DATA_FILE_FILTERS, errorText, type ImportOptions, type Json, type PreviewResult, type WorkspaceView } from "@/lib/api";
import { message, open, save } from "@/lib/platform";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function metaText(v: Json): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  return typeof v === "string" ? v : JSON.stringify(v);
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5 border border-ap-line bg-white px-2.5 py-1 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-black">{value}</span>
    </span>
  );
}

/** Columns that can become variables: the time column first, then numeric and text columns. */
function importable(p: PreviewResult): number[] {
  const rest = [...p.numeric_columns, ...p.text_columns].sort((a, b) => a - b);
  return [...(p.time_column_index !== null ? [p.time_column_index] : []), ...rest];
}

export function FileTab() {
  const { setDataset, setProgress, showStatus, dataVersion } = useApp();
  const [ws, setWs] = useState<WorkspaceView>({ variables: [], sources: [], align: "time", grid_step: null, auto_recipe: null, dataset: null, added: [], warnings: [] });
  const [queue, setQueue] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [options, setOptions] = useState<ImportOptions>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [adjust, setAdjust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<string[]>([]);
  const [valueEdit, setValueEdit] = useState<{ name: string; op: "offset" | "scale"; value: number; all: boolean } | null>(null);

  const applyWs = (v: WorkspaceView) => {
    setWs(v);
    setDataset(v.dataset);
  };

  // Refresh after any data change, including edits made on the Prepare page.
  useEffect(() => {
    api.workspaceView().then(setWs).catch(() => {});
  }, [dataVersion]);

  const openFile = async (p: string, sh: string | null = null, opts: ImportOptions = {}, keepPicked = false) => {
    setError("");
    try {
      const r = await api.previewFile(p, sh, opts);
      setPath(p);
      setPreview(r);
      setSheet(r.sheet);
      setOptions(opts);
      const cols = importable(r).map((i) => r.headers[i]);
      setPicked((prev) => (keepPicked ? prev.filter((c) => cols.includes(c)) : cols));
      return r;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };

  const closeFile = () => {
    setPath("");
    setPreview(null);
    setOptions({});
    setAdjust(false);
    setError("");
    const [next, ...rest] = queue;
    setQueue(rest);
    if (next) openFile(next);
  };

  const enqueue = (paths: string[]) => {
    if (paths.length === 0) return;
    if (!preview) {
      openFile(paths[0]);
      setQueue((q) => [...q, ...paths.slice(1)]);
    } else setQueue((q) => [...q, ...paths]);
  };

  const browse = async () => {
    const sel = await open({ multiple: true, filters: DATA_FILE_FILTERS, title: "Add data" });
    enqueue(Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : []);
  };

  useEffect(() => {
    const h = (e: Event) => enqueue((e as CustomEvent<string[]>).detail);
    window.addEventListener("workspace-add-files", h);
    return () => window.removeEventListener("workspace-add-files", h);
  });

  const addVariables = async () => {
    if (!preview || picked.length === 0) return;
    // Keep the file's column order.
    const ordered = importable(preview).map((i) => preview.headers[i]).filter((c) => picked.includes(c));
    setBusy(true);
    setError("");
    setProgress("load", 10, "Reading file...");
    try {
      const v = await api.workspaceImport(path, sheet, options, ordered);
      applyWs(v);
      setFresh(v.added);
      showStatus(`Added ${v.added.length} variable${v.added.length === 1 ? "" : "s"} from ${fileName(path)}`);
      if (v.warnings.length) await message(v.warnings.join("\n"), { title: "Recipe", kind: "warning" });
      closeFile();
    } catch (e) {
      setProgress("load", 100, "");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    const p = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], title: "Export workspace as CSV", defaultPath: "workspace.csv" });
    if (!p) return;
    try {
      const rows = await api.exportDataset(p);
      showStatus(`Exported ${rows.toLocaleString("en-US")} rows to ${p}`);
    } catch (e) {
      await message(errorText(e), { title: "Export failed", kind: "error" });
    }
  };

  useEffect(() => {
    const h = () => {
      if (ws.variables.length) exportCsv();
    };
    window.addEventListener("export-data", h);
    return () => window.removeEventListener("export-data", h);
  });

  const run = async (f: () => Promise<WorkspaceView>) => {
    try {
      applyWs(await f());
    } catch (e) {
      await message(errorText(e), { kind: "error" });
    }
  };

  const cols = useMemo(() => (preview ? importable(preview) : []), [preview]);
  const meta = preview ? Object.entries(preview.metadata) : [];

  return (
    <div className="flex h-full gap-4">
      <WorkspacePanel
        ws={ws}
        fresh={fresh}
        run={run}
        onAddFiles={browse}
        onExport={exportCsv}
        onValueEdit={(name, op) => setValueEdit({ name, op, value: op === "offset" ? 0 : 1, all: false })}
      />

      {/* Import from a file */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {!preview ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <button
              onClick={browse}
              className="flex w-[440px] flex-col items-center gap-4 border border-dashed border-ap-bluegray-60 bg-white px-10 py-14 text-center transition-colors hover:border-ap-red"
            >
              <FolderOpen className="size-12 text-ap-red" strokeWidth={1.2} />
              <span className="text-[22px] text-black">Add data</span>
              <span className="text-[12.5px] text-muted-foreground">CSV · TXT · Excel · Parquet · MAT · HDF5 · TDMS</span>
            </button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border border-ap-line bg-white px-3 py-2">
              <FileSpreadsheet className="size-5 shrink-0 text-ap-red" />
              <span className="min-w-0 truncate text-[14px]" title={path}>
                {fileName(path)}
              </span>
              {preview.sheets.length > 1 && (
                <Select value={sheet ?? undefined} onValueChange={(v) => openFile(path, v, {})}>
                  <SelectTrigger className="h-8 w-44" title="Worksheet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.sheets.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {queue.length > 0 && (
                <span className="text-[12px] text-muted-foreground" title={queue.map(fileName).join("\n")}>
                  +{queue.length} queued
                </span>
              )}
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={closeFile} title={queue.length ? "Skip this file" : "Close"}>
                <X />
              </Button>
              <Button onClick={addVariables} disabled={busy || picked.length === 0} className="min-w-40">
                {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add {picked.length} variable{picked.length === 1 ? "" : "s"}
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!adjust && (
                <>
                  <Chip label="Header" value={preview.no_header ? "none" : `row ${preview.header_row + 1}`} />
                  <Chip label="Data from" value={`row ${preview.data_start + 1}`} />
                  {preview.file_type !== "Excel workbook" && <Chip label="Separator" value={preview.delimiter === "\\t" ? "tab" : preview.delimiter} />}
                </>
              )}
              {meta.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-muted-foreground" title="File header information">
                      <Info /> {meta.length}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="selectable max-h-80 w-96 overflow-auto rounded-none p-3 text-[12px]">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      {meta.map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-ap-red">{k}</dt>
                          <dd className="break-words">{metaText(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <div className="flex-1" />
              <Button variant={adjust ? "default" : "outline"} size="sm" onClick={() => setAdjust(!adjust)} title="Header row, data start, ignored rows and columns">
                <SlidersHorizontal /> Rows &amp; columns
                {Object.keys(options).length > 0 && !adjust && <span className="ml-0.5 size-1.5 rounded-full bg-ap-red" />}
              </Button>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <section className="min-h-0 flex-1 border border-ap-line bg-white">
              {adjust ? (
                <ImportSettings preview={preview} options={options} onChange={(o) => openFile(path, sheet, o, true)} />
              ) : (
                <div className="selectable h-full overflow-auto">
                  <Table className="text-[12px]">
                    <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_var(--ap-line)]">
                      <TableRow>
                        <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
                        {preview.headers.map((h, i) => {
                          if (preview.skipped_columns.includes(i)) return null;
                          const can = cols.includes(i);
                          const on = picked.includes(h);
                          return (
                            <TableHead key={i} className="whitespace-nowrap">
                              {can ? (
                                <label className={cn("flex cursor-pointer items-center gap-1.5", on ? "text-black" : "text-muted-foreground")}>
                                  <Checkbox checked={on} onCheckedChange={(v) => setPicked(v ? [...picked, h] : picked.filter((x) => x !== h))} />
                                  {h}
                                  {preview.time_column_index === i && <Clock className="size-3 text-ap-red" />}
                                  {preview.text_columns.includes(i) && <Type className="size-3 text-muted-foreground" aria-label="Text column" />}
                                </label>
                              ) : (
                                <span className="text-muted-foreground/70" title="Empty or not importable">
                                  {h}
                                </span>
                              )}
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.map((r, i) => (
                        <TableRow key={i} className="even:bg-[#f7f8f8]">
                          <TableCell className="py-1 text-right text-muted-foreground tabular-nums">{preview.data_start + i + 1}</TableCell>
                          {r.map((c, j) =>
                            preview.skipped_columns.includes(j) ? null : (
                              <TableCell key={j} className={cn("py-1 whitespace-nowrap tabular-nums", !picked.includes(preview.headers[j]) && "text-muted-foreground/60")}>
                                {c}
                              </TableCell>
                            ),
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Dialog open={!!valueEdit} onOpenChange={(o) => !o && setValueEdit(null)}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-normal">
              {valueEdit?.op === "offset" ? "Add offset" : "Multiply by"}
              {!valueEdit?.all && (
                <>
                  {" "}
                  · <span className="text-ap-red">{valueEdit?.name}</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {valueEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const { name, op, value, all } = valueEdit;
                setValueEdit(null);
                const names = all ? ws.variables.filter((x) => x.kind !== "text" && !x.is_time).map((x) => x.name) : [name];
                run(async () => {
                  let last = ws;
                  for (const n of names) last = await api.workspaceEdit(n, "edit", { op, value });
                  return last;
                });
              }}
            >
              <NumberInput value={valueEdit.value} step={0.1} onChange={(value) => setValueEdit({ ...valueEdit, value })} />
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12.5px]">
                <Checkbox checked={valueEdit.all} onCheckedChange={(c) => setValueEdit({ ...valueEdit, all: !!c })} />
                All variables
              </label>
              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={() => setValueEdit(null)}>
                  Cancel
                </Button>
                <Button type="submit">Apply</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
