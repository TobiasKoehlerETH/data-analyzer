import { useEffect, useState } from "react";
import { open, message } from "@tauri-apps/plugin-dialog";
import { FileSpreadsheet, FolderOpen, Settings2, Table2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Panel, StatusText } from "@/components/common";
import { ImportSettings } from "@/components/ImportSettings";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, DATA_FILE_FILTERS, errorText, type ImportOptions, type Json, type PreviewResult, type StatRow } from "@/lib/api";
import { fmt } from "@/lib/chart";
import { useApp } from "@/lib/store";

function metaText(v: Json): string {
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? `'${x}'` : JSON.stringify(x))).join(", ")}]`;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function FileTab() {
  const { setDataset, pendingOpen, clearPendingOpen, dataset, setProgress } = useApp();
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone?: "error" | "ok" }>({ text: "" });
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<StatRow[]>([]);
  const [options, setOptions] = useState<ImportOptions>({});
  const [view, setView] = useState<"preview" | "settings">("preview");

  const doPreview = async (p: string, sh: string | null = null, opts: ImportOptions = options) => {
    try {
      const r = await api.previewFile(p, sh, opts);
      setPreview(r);
      setSheet(r.sheet);
      setStatus({ text: "Preview loaded. Click 'Load File' to load all data." });
      return r;
    } catch (e) {
      setPreview(null);
      setStatus({ text: `Preview error: ${errorText(e)}`, tone: "error" });
      return null;
    }
  };

  const doLoad = async (p = path, sh = sheet, opts: ImportOptions = options) => {
    if (!p) return;
    setLoading(true);
    setStatus({ text: "Loading..." });
    setProgress("load", 10, "Loading file...");
    try {
      const info = await api.loadFile(p, sh, opts);
      setDataset(info);
      setStatus({ text: `Loaded ${info.n_samples.toLocaleString("en-US")} samples, ${info.n_signals} signals.`, tone: "ok" });
      setStats(await api.descriptiveStats());
    } catch (e) {
      setStatus({ text: `Error: ${errorText(e)}`, tone: "error" });
      setProgress("load", 100, "");
      await message(errorText(e), { title: "Load Error", kind: "error" });
    } finally {
      setLoading(false);
    }
  };

  const browse = async () => {
    const p = await open({ multiple: false, filters: DATA_FILE_FILTERS, title: "Open data file" });
    if (typeof p === "string") {
      setPath(p);
      setOptions({});
      await doPreview(p, null, {});
    }
  };

  // Menu "Open…" and drag & drop: preview then load immediately (like load_file in the template).
  useEffect(() => {
    if (!pendingOpen) return;
    const { path: p, sheet: sh } = pendingOpen;
    clearPendingOpen();
    setPath(p);
    setOptions({});
    doPreview(p, sh ?? null, {}).then((r) => {
      if (r) doLoad(p, r.sheet, {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen]);

  useEffect(() => {
    if (!dataset) setStats([]);
    else api.descriptiveStats().then(setStats).catch(() => {});
  }, [dataset]);

  const metaLines: [string, string][] = preview
    ? [
        ["File type", preview.file_type],
        ...(preview.is_raser_format ? ([["Format", "Raser DataLog"]] as [string, string][]) : []),
        ["Encoding", preview.encoding],
        ["Delimiter", preview.file_type === "Excel workbook" ? "— (spreadsheet cells)" : `'${preview.delimiter}'`],
        ...(preview.sheet ? ([["Worksheet", preview.sheet]] as [string, string][]) : []),
        ["Header row", preview.no_header ? "none" : String(preview.header_row + 1)],
        ["Data starts at row", String(preview.data_start + 1)],
        ["Columns", `${preview.headers.length - preview.skipped_columns.length} used of ${preview.headers.length}`],
        ["Time axis", preview.time_column ?? "sample index"],
        ...Object.entries(preview.metadata).map(([k, v]) => [k, metaText(v)] as [string, string]),
      ]
    : [];

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          className="h-9 flex-1 font-medium"
          placeholder="Drop a file or paste its path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && path.trim()) {
              setOptions({});
              doPreview(path.trim(), null, {});
            }
          }}
          title="Path of a CSV, TSV, TXT or Excel (xlsx/xls/ods) data file"
        />
        {preview && preview.sheets.length > 1 && (
          <Select
            value={sheet ?? undefined}
            onValueChange={(v) => {
              setSheet(v);
              setOptions({});
              doPreview(path, v, {});
            }}
          >
            <SelectTrigger className="h-9 w-44" title="Worksheet to import">
              <FileSpreadsheet className="size-4 text-ap-bluegray" />
              <SelectValue placeholder="Worksheet" />
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
        <Button variant="outline" className="h-9" onClick={browse} title="Browse for a CSV, TSV, TXT or Excel data file to load">
          <FolderOpen /> Browse…
        </Button>
        <Button className="h-9" disabled={!path || loading} onClick={() => doLoad()} title="Parse and load the selected file into memory for analysis">
          <Upload /> Load
        </Button>
      </div>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="62%" minSize="20%">
          <Panel
            title={view === "preview" ? <span title="First 100 rows">Preview{preview ? ` · ${preview.headers.length - preview.skipped_columns.length} columns` : ""}</span> : "Import settings"}
            className="h-full"
            bodyClassName={view === "preview" ? "p-0 overflow-auto selectable" : "p-0"}
            actions={
              preview && (
                <Tabs value={view} onValueChange={(v) => setView(v as "preview" | "settings")}>
                  <TabsList className="h-7 rounded-none">
                    <TabsTrigger value="preview" className="h-6 rounded-none px-2 text-xs">
                      <Table2 /> Preview
                    </TabsTrigger>
                    <TabsTrigger value="settings" className="h-6 rounded-none px-2 text-xs" title="Choose the header row, where data starts and which rows/columns to ignore">
                      <Settings2 /> Settings
                      {Object.keys(options).length > 0 && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-ap-red" />}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )
            }
          >
            {preview && view === "settings" ? (
              <ImportSettings
                preview={preview}
                options={options}
                loading={loading}
                onChange={(o) => {
                  setOptions(o);
                  doPreview(path, sheet, o);
                }}
                onLoad={() => doLoad()}
              />
            ) : preview ? (
              <Table className="text-[12px]">
                <TableHeader className="sticky top-0 z-10 bg-white">
                  <TableRow>
                    <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
                    {preview.headers.map((h, i) =>
                      preview.skipped_columns.includes(i) ? null : (
                        <TableHead key={i} className="whitespace-nowrap text-black">
                          {h}
                          {preview.time_column_index === i && <span className="ml-1 text-[10px] text-ap-red">time</span>}
                        </TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r, i) => (
                    <TableRow key={i} className="even:bg-[#f7f8f8]">
                      <TableCell className="py-1 text-right text-muted-foreground tabular-nums">{i + 1}</TableCell>
                      {r.map((c, j) =>
                        preview.skipped_columns.includes(j) ? null : (
                          <TableCell key={j} className="py-1 whitespace-nowrap tabular-nums">
                            {c}
                          </TableCell>
                        ),
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState title="Open a dataset" icon={<FolderOpen className="size-10" strokeWidth={1.2} />}>
                CSV, text or Excel. Format detected automatically.
              </EmptyState>
            )}
          </Panel>
        </ResizablePanel>
        <ResizableHandle className="my-1 bg-transparent" />
        <ResizablePanel defaultSize="38%" minSize="15%">
          <div className="flex h-full gap-3">
            <Panel title="File details" className="w-[380px] shrink-0" bodyClassName="overflow-auto selectable">
              {metaLines.length ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                  {metaLines.map(([k, v], i) => (
                    <div key={i} className="contents">
                      <dt className="text-ap-red">{k}</dt>
                      <dd className="break-words">{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">No file selected</p>
              )}
            </Panel>
            <Panel title="Summary" className="min-w-0 flex-1" bodyClassName="p-0 overflow-auto selectable">
              {stats.length ? (
                <Table className="text-[12px]">
                  <TableHeader className="sticky top-0 bg-white">
                    <TableRow>
                      {["Signal", "Count", "Mean", "Std", "Min", "Q1", "Median", "Q3", "Max", "Skew", "Kurtosis"].map((h) => (
                        <TableHead key={h} className="whitespace-nowrap text-black">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.map((s) => (
                      <TableRow key={s.signal}>
                        <TableCell className="py-1 whitespace-nowrap">{s.signal}</TableCell>
                        <TableCell className="py-1 tabular-nums">{s.count}</TableCell>
                        {[s.mean, s.std, s.min, s.q1, s.median, s.q3, s.max, s.skew, s.kurtosis].map((v, i) => (
                          <TableCell key={i} className="py-1 tabular-nums">
                            {fmt(v)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="p-3 text-xs text-muted-foreground">Load data to see statistics</p>
              )}
            </Panel>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <StatusText tone={status.tone === "error" ? "error" : status.tone === "ok" ? "ok" : "muted"}>{status.text}</StatusText>
    </div>
  );
}
