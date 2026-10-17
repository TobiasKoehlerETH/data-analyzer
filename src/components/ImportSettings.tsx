import { useEffect, useState } from "react";
import { Ban, Clock, Heading, ListStart, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, NumberInput } from "@/components/common";
import type { ImportOptions, PreviewResult } from "@/lib/api";
import { cn } from "@/lib/utils";

const DELIMS = [
  { value: "auto", label: "Auto-detect" },
  { value: ",", label: "Comma ( , )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "\\t", label: "Tab" },
  { value: "|", label: "Pipe ( | )" },
  { value: " ", label: "Whitespace" },
];

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "3, 5-7" ↔ [2, 4, 5, 6] (displayed 1-based, stored 0-based). */
export function formatRows(rows: number[]): string {
  const s = [...rows].sort((a, b) => a - b).map((r) => r + 1);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return out.join(", ");
}

export function parseRows(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let r = Math.min(a, b); r <= Math.max(a, b) && r - a < 100000; r++) if (r >= 1) out.add(r - 1);
  }
  return [...out];
}

type Role = "pre" | "header" | "data" | "ignored";

export function ImportSettings({
  preview,
  options,
  onChange,
  onLoad,
  loading,
}: {
  preview: PreviewResult;
  options: ImportOptions;
  onChange: (o: ImportOptions) => void;
  onLoad: () => void;
  loading: boolean;
}) {
  const [rowsText, setRowsText] = useState(formatRows(options.skip_rows ?? []));
  useEffect(() => setRowsText(formatRows(options.skip_rows ?? [])), [options.skip_rows]);

  const header = preview.header_row;
  const noHeader = preview.no_header;
  const dataStart = preview.data_start;
  const skipRows = options.skip_rows ?? [];
  const skipCols = preview.skipped_columns;
  const userSkipCols = options.skip_columns ?? [];
  const nCols = Math.max(preview.headers.length, ...preview.raw.map((r) => r.length));
  const isExcel = preview.file_type === "Excel workbook";

  const role = (i: number): Role => {
    if (skipRows.includes(i)) return "ignored";
    if (!noHeader && i === header) return "header";
    if (i < dataStart) return "pre";
    return "data";
  };

  const set = (patch: Partial<ImportOptions>) => onChange({ ...options, ...patch });
  const toggle = (list: number[], v: number) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const rowMenu = (i: number) => (
    <DropdownMenuContent align="start" className="rounded-none">
      <DropdownMenuLabel className="text-xs">Row {i + 1}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => set({ header_row: i, no_header: false, data_start: null })}>
        <Heading /> Use as header row (column names)
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ data_start: i, ...(header >= i && !noHeader ? { no_header: true } : {}) })}>
        <ListStart /> Data starts here
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ no_header: true, data_start: i })}>
        <ListStart /> No header — data starts here
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ skip_rows: toggle(skipRows, i) })}>
        {skipRows.includes(i) ? <Undo2 /> : <Ban />} {skipRows.includes(i) ? "Include this row again" : "Ignore this row"}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const colMenu = (c: number) => (
    <DropdownMenuContent align="start" className="rounded-none">
      <DropdownMenuLabel className="text-xs">
        Column {colName(c)} {preview.headers[c] ? `· ${preview.headers[c]}` : ""}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => set({ skip_columns: toggle(userSkipCols, c) })}>
        {userSkipCols.includes(c) ? <Undo2 /> : <Ban />} {userSkipCols.includes(c) ? "Include this column" : "Ignore this column"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ time_column: c })}>
        <Clock /> Use as time axis
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-ap-line p-3">
        {!isExcel && (
          <Field label="Delimiter" className="w-52">
            <Select value={options.delimiter ?? "auto"} onValueChange={(v) => set({ delimiter: v === "auto" ? null : v })}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIMS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Header row" className="w-40" hint="Line holding the column names (1-based)">
          <NumberInput value={header + 1} min={1} max={Math.max(1, preview.n_lines)} integer disabled={noHeader} onChange={(v) => set({ header_row: v - 1, no_header: false, data_start: null })} />
        </Field>
        <label className="flex h-8 items-center gap-2 text-[12.5px]" title="The file has no header line; columns are named Column 1, Column 2, …">
          <Checkbox checked={noHeader} onCheckedChange={(v) => set({ no_header: !!v, data_start: v ? (options.data_start ?? header) : null })} />
          No header row
        </label>
        <Field label="Data starts at row" className="w-48" hint="First line of numeric data (1-based)">
          <NumberInput value={dataStart + 1} min={1} max={Math.max(1, preview.n_lines)} integer onChange={(v) => set({ data_start: v - 1 })} />
        </Field>
        <Field label="Ignore rows" className="w-56" hint="Lines to skip inside the data, e.g. 12, 40-45 (1-based)">
          <Input
            className={cn("h-8", parseRows(rowsText) === null && "border-destructive")}
            value={rowsText}
            placeholder="e.g. 12, 40-45"
            onChange={(e) => setRowsText(e.target.value)}
            onBlur={() => {
              const r = parseRows(rowsText);
              if (r) set({ skip_rows: r });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const r = parseRows(rowsText);
                if (r) set({ skip_rows: r });
              }
            }}
          />
        </Field>
        <Field label="Time axis" className="w-64" hint="Column used as the x axis (seconds or timestamps)">
          <Select
            value={options.time_column === undefined || options.time_column === null ? "auto" : String(options.time_column)}
            onValueChange={(v) => set({ time_column: v === "auto" ? null : Number(v) })}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto ({preview.time_column ?? "sample index"})</SelectItem>
              <SelectItem value="-1">None — use sample index</SelectItem>
              {preview.headers.map((h, i) =>
                skipCols.includes(i) ? null : (
                  <SelectItem key={i} value={String(i)}>
                    {colName(i)} · {h}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Field>
        <Button size="sm" variant="ghost" onClick={() => onChange({})} title="Discard all manual settings">
          <RotateCcw /> Reset to auto
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={onLoad} disabled={loading}>
          Apply &amp; Load
        </Button>
      </div>

      <div className="flex items-center gap-4 border-b border-ap-line px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <span>Click a row or column header to change its role.</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 bg-ap-red" /> header</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 border border-ap-line bg-white" /> data</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 bg-ap-bluegray-15" /> skipped / metadata</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 bg-[repeating-linear-gradient(45deg,#d1d1d1_0_2px,transparent_2px_5px)]" /> ignored</span>
        <span className="ml-auto">
          Showing first {preview.raw.length} of {preview.n_lines.toLocaleString("en-US")} lines · {preview.numeric_columns.length} signal column(s)
          {preview.time_column ? ` · time axis: ${preview.time_column}` : " · time axis: sample index"}
        </span>
      </div>

      <div className="selectable min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              <th className="sticky left-0 z-20 w-24 border-r border-b border-ap-line bg-white px-2 py-1 text-right font-normal text-muted-foreground">Row</th>
              {Array.from({ length: nCols }, (_, c) => {
                const skipped = skipCols.includes(c);
                const isTime = preview.time_column_index === c;
                const isNum = preview.numeric_columns.includes(c);
                return (
                  <th key={c} className="border-b border-l border-ap-line p-0 text-left font-normal">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className={cn(
                            "flex w-full min-w-24 items-center gap-1.5 px-2 py-1 hover:bg-ap-bluegray-15",
                            skipped && "text-muted-foreground line-through",
                          )}
                          title={skipped ? "Ignored (or empty) column — click to change" : "Click to ignore this column or use it as time axis"}
                        >
                          <span className="text-muted-foreground">{colName(c)}</span>
                          {isTime && <Clock className="size-3 text-ap-red" />}
                          {!skipped && !isTime && <span className={cn("text-[10px] uppercase tracking-wider", isNum ? "text-ap-darkblue" : "text-muted-foreground")}>{isNum ? "signal" : "text"}</span>}
                        </button>
                      </DropdownMenuTrigger>
                      {colMenu(c)}
                    </DropdownMenu>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {preview.raw.map((cells, i) => {
              const r = role(i);
              return (
                <tr
                  key={i}
                  className={cn(
                    r === "header" && "bg-ap-red text-white",
                    r === "pre" && "bg-ap-bluegray-15 text-muted-foreground",
                    r === "ignored" && "bg-[repeating-linear-gradient(45deg,#ebedee_0_3px,transparent_3px_8px)] text-muted-foreground line-through",
                  )}
                >
                  <td className={cn("sticky left-0 border-r border-b border-ap-line p-0", r === "header" ? "bg-ap-red" : "bg-white")}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className={cn("flex w-full items-center justify-end gap-1.5 px-2 py-0.5 tabular-nums hover:underline", r === "header" ? "text-white" : "text-muted-foreground")}>
                          <span className="text-[9.5px] tracking-wider uppercase">{r === "header" ? "header" : r === "pre" ? "skip" : r === "ignored" ? "ignored" : i === dataStart ? "data ▸" : ""}</span>
                          {i + 1}
                        </button>
                      </DropdownMenuTrigger>
                      {rowMenu(i)}
                    </DropdownMenu>
                  </td>
                  {Array.from({ length: nCols }, (_, c) => (
                    <td
                      key={c}
                      className={cn(
                        "max-w-56 truncate border-b border-l border-ap-line px-2 py-0.5 whitespace-nowrap tabular-nums",
                        skipCols.includes(c) && r !== "header" && "text-muted-foreground/60 line-through",
                      )}
                      title={cells[c]}
                    >
                      {cells[c] ?? ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
