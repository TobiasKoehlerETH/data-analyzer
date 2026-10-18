import { Ban, Clock, Heading, ListStart, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

type Role = "pre" | "header" | "data" | "ignored";

export function ImportSettings({
  preview,
  options,
  onChange,
}: {
  preview: PreviewResult;
  options: ImportOptions;
  onChange: (o: ImportOptions) => void;
}) {
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
        <Heading /> Header row
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ data_start: i, ...(header >= i && !noHeader ? { no_header: true } : {}) })}>
        <ListStart /> Data starts here
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ no_header: true, data_start: i })}>
        <ListStart /> Data starts here (no header)
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ skip_rows: toggle(skipRows, i) })}>
        {skipRows.includes(i) ? <Undo2 /> : <Ban />} {skipRows.includes(i) ? "Include row" : "Ignore row"}
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
        {userSkipCols.includes(c) ? <Undo2 /> : <Ban />} {userSkipCols.includes(c) ? "Include column" : "Ignore column"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => set({ time_column: c })}>
        <Clock /> Use as time axis
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ap-line px-3 py-2">
        {!isExcel && (
          <Field label="Separator" className="w-48">
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
        <Field label="Header row" className="w-36">
          <NumberInput value={header + 1} min={1} max={Math.max(1, preview.n_lines)} integer disabled={noHeader} onChange={(v) => set({ header_row: v - 1, no_header: false, data_start: null })} />
        </Field>
        <label className="flex h-8 items-center gap-2 text-[12.5px]">
          <Checkbox checked={noHeader} onCheckedChange={(v) => set({ no_header: !!v, data_start: v ? (options.data_start ?? header) : null })} />
          None
        </label>
        <Field label="Data from row" className="w-40">
          <NumberInput value={dataStart + 1} min={1} max={Math.max(1, preview.n_lines)} integer onChange={(v) => set({ data_start: v - 1 })} />
        </Field>
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" onClick={() => onChange({})} title="Back to automatic detection" disabled={Object.keys(options).length === 0}>
          <RotateCcw />
        </Button>
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
