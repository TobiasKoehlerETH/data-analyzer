import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, PencilLine, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, errorText, type VariableInfo, type VariableSamples, type WorkspaceView } from "@/lib/api";
import { useApp } from "@/lib/store";
import { bareName } from "@/lib/units";
import { cn } from "@/lib/utils";

const ROW = 28;
const fmt = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(Number(v.toPrecision(10))));
const fmtT = (t: number) => String(Number(t.toPrecision(9)));
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A variable's values as a table, like a spreadsheet column. Select cells (click, Shift, Ctrl,
 * arrows), press Delete to remove them, type or double-click to change one, Ctrl+Enter to set all
 * selected, paste a column from Excel. Every change is a step in Prepare, so Undo works.
 */
export function ValuesSheet({ variable, onClose, run }: { variable: VariableInfo | null; onClose: () => void; run: (f: () => Promise<WorkspaceView>) => Promise<void> }) {
  const [vec, setVec] = useState<VariableSamples | null>(null);
  const [version, setVersion] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<{ row: number; text: string } | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [busy, setBusy] = useState(false);
  const [goto, setGoto] = useState("");
  const body = useRef<HTMLDivElement>(null);
  /** How the open edit ends when its field loses focus: set one cell, set all selected, or cancel. */
  const ending = useRef<"one" | "all" | "cancel">("one");
  const name = variable?.name ?? null;
  const readOnly = !!variable?.is_time;

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    api
      .workspaceVariable(name)
      .then((v) => !cancelled && setVec(v))
      .catch((e) => !cancelled && toast.error(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [name, version]);

  useEffect(() => {
    setSel(new Set());
    setCursor(0);
    setAnchor(0);
    setEditing(null);
    setScroll(0);
    if (body.current) body.current.scrollTop = 0;
    if (!name) setVec(null);
  }, [name]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [vec !== null]);

  // Opening at the linked cursor: the row nearest to it.
  const cursorTime = useApp((x) => x.cursor);
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!vec || !name || jumped.current === name) return;
    jumped.current = name;
    const t = vec.edited_time;
    if (cursorTime === null || !t.length) return;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < cursorTime) lo = mid + 1;
      else hi = mid;
    }
    const row = lo > 0 && Math.abs(t[lo - 1] - cursorTime) < Math.abs(t[lo] - cursorTime) ? lo - 1 : lo;
    setCursor(row);
    setAnchor(row);
    setSel(new Set([row]));
    requestAnimationFrame(() => {
      if (body.current) body.current.scrollTop = Math.max(0, row * ROW - body.current.clientHeight / 2);
    });
  }, [vec, name, cursorTime]);
  useEffect(() => {
    if (!name) jumped.current = null;
  }, [name]);

  const values = vec?.edited ?? [];
  const times = vec?.edited_time ?? [];
  const n = values.length;
  // The imported value beside the current one, when the rows still match (no downsample).
  const original = vec && vec.original.length === n ? vec.original : null;
  const changed = useMemo(() => {
    if (!original) return 0;
    let c = 0;
    for (let i = 0; i < n; i++) if (fmt(values[i]) !== fmt(original[i])) c++;
    return c;
  }, [values, original, n]);

  const first = Math.max(0, Math.floor(scroll / ROW) - 5);
  const last = Math.min(n, Math.ceil((scroll + height) / ROW) + 5);

  const reveal = (row: number) => {
    const el = body.current;
    if (!el) return;
    if (row * ROW < el.scrollTop) el.scrollTop = row * ROW;
    else if ((row + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (row + 1) * ROW - el.clientHeight;
  };
  const moveTo = (row: number, extend: boolean) => {
    const r = Math.max(0, Math.min(n - 1, row));
    setCursor(r);
    if (extend) {
      const s = new Set<number>();
      for (let i = Math.min(anchor, r); i <= Math.max(anchor, r); i++) s.add(i);
      setSel(s);
    } else {
      setAnchor(r);
      setSel(new Set([r]));
    }
    reveal(r);
  };

  const apply = async (edit: Parameters<typeof api.workspaceEdit>[2], done: string) => {
    if (!name || readOnly) return;
    setBusy(true);
    await run(async () => {
      const v = await api.workspaceEdit(name, "edit", edit!);
      toast.success(done);
      return v;
    });
    setBusy(false);
    setVersion((x) => x + 1);
  };
  const clearSelected = () => {
    const rows = [...sel].filter((i) => finite(values[i]));
    if (!rows.length) return;
    apply({ op: "clear_points", value: rows.map((i) => times[i]) }, `${rows.length.toLocaleString("en-US")} value${rows.length === 1 ? "" : "s"} removed`);
  };
  const setRows = (rows: number[], value: number) => {
    if (!rows.length || !Number.isFinite(value)) return;
    apply({ op: "set_points", value: rows.map((i) => [times[i], value] as [number, number]) }, `${rows.length.toLocaleString("en-US")} value${rows.length === 1 ? "" : "s"} set`);
  };
  const commit = (all: boolean) => {
    if (!editing) return;
    const text = editing.text.trim().replace(",", ".");
    const row = editing.row;
    setEditing(null);
    body.current?.focus();
    if (text === "") return clearSelectedRows(all ? [...sel] : [row]);
    const v = Number(text);
    if (!Number.isFinite(v)) return toast.error(`'${editing.text}' is not a number`);
    if (!all && fmt(values[row]) === fmt(v)) return;
    setRows(all ? [...sel] : [row], v);
  };
  const clearSelectedRows = (rows: number[]) => {
    const r = rows.filter((i) => finite(values[i]));
    if (r.length) apply({ op: "clear_points", value: r.map((i) => times[i]) }, `${r.length} value${r.length === 1 ? "" : "s"} removed`);
  };
  const undo = async () => {
    if (!name) return;
    setBusy(true);
    await run(() => api.workspaceEdit(name, "undo"));
    setBusy(false);
    setVersion((x) => x + 1);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !n) return;
    const page = Math.max(1, Math.floor(height / ROW) - 1);
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "PageDown" || k === "PageUp" || ((k === "Home" || k === "End") && e.ctrlKey)) {
      e.preventDefault();
      const to = k === "ArrowDown" ? cursor + 1 : k === "ArrowUp" ? cursor - 1 : k === "PageDown" ? cursor + page : k === "PageUp" ? cursor - page : k === "Home" ? 0 : n - 1;
      moveTo(to, e.shiftKey);
    } else if ((k === "Delete" || k === "Backspace") && !readOnly) {
      e.preventDefault();
      clearSelected();
    } else if ((k === "Enter" || k === "F2") && !readOnly) {
      e.preventDefault();
      setEditing({ row: cursor, text: fmt(values[cursor]) });
    } else if (e.ctrlKey && k.toLowerCase() === "a") {
      e.preventDefault();
      setSel(new Set(Array.from({ length: n }, (_, i) => i)));
    } else if (e.ctrlKey && k.toLowerCase() === "c") {
      e.preventDefault();
      const rows = [...sel].sort((a, b) => a - b);
      navigator.clipboard.writeText(rows.map((i) => `${fmtT(times[i])}\t${fmt(values[i])}`).join("\n")).then(() => toast.success(`${rows.length} rows copied`));
    } else if (!readOnly && k.length === 1 && /[-+0-9.,eE]/.test(k) && !e.ctrlKey && !e.metaKey) {
      // Typing starts editing, like a spreadsheet.
      e.preventDefault();
      setEditing({ row: cursor, text: k });
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (readOnly || editing) return;
    const lines = e.clipboardData.getData("text").split(/\r?\n/).map((l) => l.split("\t").pop()!.trim()).filter((l) => l !== "");
    const nums = lines.map((l) => Number(l.replace(",", ".")));
    if (!nums.length || nums.some((x) => !Number.isFinite(x))) return toast.error("Paste a column of numbers");
    e.preventDefault();
    const pts = nums.slice(0, n - cursor).map((v, k) => [times[cursor + k], v] as [number, number]);
    apply({ op: "set_points", value: pts }, `${pts.length} values pasted`);
  };

  // Excel-like status: count, mean, min and max of the selected values.
  const stats = useMemo(() => {
    const vs = [...sel].map((i) => values[i]).filter(finite);
    if (vs.length < 2) return null;
    let s = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vs) (s += v), (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    return { n: vs.length, mean: s / vs.length, lo, hi };
  }, [sel, values]);

  const unit = variable?.unit ?? "";
  return (
    <Dialog open={!!variable} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[82vh] max-h-[900px] flex-col gap-0 overflow-hidden bg-white p-0 sm:max-w-[640px]"
        aria-describedby="sheet-help"
        onEscapeKeyDown={(e) => editing && e.preventDefault()}
      >
        <div className="flex items-center gap-3 border-b border-ap-line px-4 py-3 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px]">
              {variable ? bareName(variable.name, variable.header_unit) : ""}
              {unit && <span className="ml-2 rounded bg-ap-bluegray-15 px-1.5 text-[12px] font-medium text-ap-gray-dark">{unit}</span>}
            </DialogTitle>
            <DialogDescription id="sheet-help" className="text-[12px] tabular-nums">
              {n.toLocaleString("en-US")} rows{changed > 0 && ` · ${changed.toLocaleString("en-US")} changed`}
              {readOnly && " · time axis, read only"}
            </DialogDescription>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const r = Math.round(Number(goto)) - 1;
              if (Number.isFinite(r)) moveTo(r, false);
              body.current?.focus();
            }}
          >
            <input
              value={goto}
              onChange={(e) => setGoto(e.target.value)}
              placeholder="Go to row"
              className="h-8 w-28 rounded-md border border-input px-2.5 text-[13px] tabular-nums outline-none focus:border-ap-red"
              inputMode="numeric"
            />
          </form>
          <Button size="icon-sm" variant="ghost" disabled={busy || !vec?.can_undo || readOnly} onClick={undo} title="Undo the last change">
            <Undo2 />
          </Button>
        </div>

        <div className="grid shrink-0 grid-cols-[72px_1fr_1fr_1fr] border-b border-ap-line bg-[#fafbfc] text-[12px] font-medium text-muted-foreground">
          <span className="px-3 py-1.5 text-right">#</span>
          <span className="px-3 py-1.5 text-right">Time [s]</span>
          <span className="px-3 py-1.5 text-right text-foreground">Value{unit ? ` [${unit}]` : ""}</span>
          <span className="px-3 py-1.5 text-right">{original ? "Original" : ""}</span>
        </div>

        <div
          ref={body}
          tabIndex={0}
          onKeyDown={onKey}
          onPaste={onPaste}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          className={cn("selectable relative min-h-0 flex-1 overflow-y-auto outline-none transition-opacity", busy && "opacity-60")}
        >
          {!vec ? (
            <p className="p-8 text-center text-[13px] text-muted-foreground">Loading…</p>
          ) : (
            <div style={{ height: n * ROW }} className="relative">
              {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
                const i = first + k;
                const v = values[i];
                const o = original?.[i];
                const isSel = sel.has(i);
                const diff = original !== null && fmt(v) !== fmt(o);
                return (
                  <div
                    key={i}
                    style={{ top: i * ROW, height: ROW }}
                    className={cn(
                      "absolute inset-x-0 grid grid-cols-[72px_1fr_1fr_1fr] border-b border-ap-line/50 text-[12.5px] tabular-nums",
                      isSel ? "bg-[#e8f0fc]" : i % 2 ? "bg-[#fbfbfc]" : "bg-white",
                    )}
                    onMouseDown={(e) => {
                      if (editing) return;
                      body.current?.focus();
                      if (e.shiftKey) {
                        e.preventDefault();
                        moveTo(i, true);
                      } else if (e.ctrlKey || e.metaKey) {
                        const s = new Set(sel);
                        if (s.has(i)) s.delete(i);
                        else s.add(i);
                        setSel(s);
                        setCursor(i);
                        setAnchor(i);
                      } else moveTo(i, false);
                    }}
                    onDoubleClick={() => !readOnly && setEditing({ row: i, text: fmt(v) })}
                  >
                    <span className="px-3 leading-7 text-right text-muted-foreground">{(i + 1).toLocaleString("en-US")}</span>
                    <span className="px-3 leading-7 text-right text-muted-foreground">{fmtT(times[i])}</span>
                    {editing?.row === i ? (
                      <input
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ row: i, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") {
                            e.preventDefault();
                            ending.current = e.key === "Escape" ? "cancel" : e.ctrlKey || e.metaKey ? "all" : "one";
                            e.currentTarget.blur();
                          }
                        }}
                        onBlur={() => {
                          const how = ending.current;
                          ending.current = "one";
                          if (how === "cancel") {
                            setEditing(null);
                            body.current?.focus();
                          } else commit(how === "all");
                        }}
                        className="mx-1 my-0.5 rounded border-2 border-ap-red px-2 text-right text-[12.5px] tabular-nums outline-none"
                        title="Enter: set · Ctrl+Enter: set every selected cell · empty: remove · Esc: cancel"
                      />
                    ) : (
                      <span
                        className={cn(
                          "px-3 leading-7 text-right font-medium",
                          cursor === i && "outline-2 -outline-offset-2 outline-ap-red",
                          !finite(v) && "font-normal text-muted-foreground/50",
                          diff && finite(v) && "bg-ap-red-soft text-ap-red-dark",
                        )}
                      >
                        {finite(v) ? fmt(v) : "—"}
                      </span>
                    )}
                    <span className="px-3 leading-7 text-right text-muted-foreground/70">{diff ? (finite(o) ? fmt(o) : "—") : ""}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex h-11 shrink-0 items-center gap-2 border-t border-ap-line bg-[#fafbfc] px-3 text-[12.5px] tabular-nums">
          <span className="text-muted-foreground">
            {sel.size > 1 ? `${sel.size.toLocaleString("en-US")} selected` : `Row ${(cursor + 1).toLocaleString("en-US")}`}
            {stats && ` · mean ${fmt(Number(stats.mean.toPrecision(5)))} · min ${fmt(stats.lo)} · max ${fmt(stats.hi)}`}
          </span>
          <div className="flex-1" />
          {!readOnly && (
            <>
              <Button size="sm" variant="ghost" disabled={busy || !sel.size} onClick={() => setEditing({ row: cursor, text: fmt(values[cursor]) })} title="Edit (Enter, or just type). Ctrl+Enter sets every selected cell.">
                <PencilLine /> Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" disabled={busy || !sel.size} onClick={clearSelected} title="Remove the selected values (Delete)">
                <Eraser /> Remove
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
