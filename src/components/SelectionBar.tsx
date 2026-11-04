import { useEffect, useMemo, useState } from "react";
import { BoxSelect, Crosshair, MessageSquarePlus, MessageSquareText, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common";
import { SignalSelect } from "@/components/SignalSelect";
import { analysisVectors } from "@/lib/analysis";
import { api, errorText, type Note } from "@/lib/api";
import { describe, total, where, type Interval } from "@/lib/brush";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const sig = (v: number) => String(Number(v.toPrecision(5)));
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

/** Saves the notes and refreshes them app-wide. */
async function saveNotes(notes: Note[]) {
  try {
    const v = await api.workspaceSetNotes(notes);
    useApp.getState().setNotes(v.notes ?? []);
  } catch (e) {
    toast.error(errorText(e));
  }
}

/** Header controls for the linked cursor, the app-wide selection and the notes. */
export function SelectionBar() {
  const { dataset, cursor, setCursor, brush, brushLabel, setBrush, notes, dataVersion, setNotes } = useApp();
  const [whereOpen, setWhereOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [draft, setDraft] = useState<{ start: number; end: number; text: string } | null>(null);

  // Notes travel with the workspace (and its projects): reload them when the data changes.
  useEffect(() => {
    api
      .workspaceView()
      .then((v) => setNotes(v.notes ?? []))
      .catch(() => {});
  }, [dataVersion, setNotes]);

  if (!dataset) return null;

  const chip = "flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12.5px] tabular-nums transition-colors";
  return (
    <div className="flex shrink-0 items-center gap-1.5 max-md:hidden">
      {cursor !== null && (
        <span className={cn(chip, "animate-in fade-in border-ap-line bg-white")} title="Linked cursor: click any time chart to move it">
          <Crosshair className="size-3.5 text-muted-foreground" />
          {sig(cursor)} s
          <button className="rounded p-0.5 text-muted-foreground hover:bg-ap-bluegray-15 hover:text-foreground" onClick={() => setCursor(null)} aria-label="Remove cursor">
            <X className="size-3" />
          </button>
        </span>
      )}
      {brush.length ? (
        <span className={cn(chip, "animate-in fade-in border-ap-darkblue/30 bg-ap-darkblue/5")} title={`${brushLabel || "Selection"}: analyses use only these times`}>
          <BoxSelect className="size-3.5 text-ap-darkblue" />
          <span className="max-w-48 truncate">{brushLabel ? `${brushLabel} · ` : ""}{describe(brush)}</span>
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-ap-bluegray-15 hover:text-foreground"
            onClick={() => setDraft({ start: brush[0][0], end: brush[brush.length - 1][1], text: "" })}
            title="Add a note for the selection"
          >
            <MessageSquarePlus className="size-3.5" />
          </button>
          <button className="rounded p-0.5 text-muted-foreground hover:bg-ap-bluegray-15 hover:text-foreground" onClick={() => setBrush([])} aria-label="Clear selection">
            <X className="size-3" />
          </button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setWhereOpen(true)} title="Select where a signal is in a range (or Shift+drag on any time chart)">
          <BoxSelect /> Select
        </Button>
      )}
      <Button size="sm" variant="ghost" className={cn(notes.length ? "text-foreground" : "text-muted-foreground")} onClick={() => setNotesOpen(true)} title="Notes on the data">
        <MessageSquareText /> {notes.length || ""}
      </Button>

      <WhereDialog open={whereOpen} onOpenChange={setWhereOpen} />
      <NotesDialog open={notesOpen} onOpenChange={setNotesOpen} onAdd={() => setDraft({ start: cursor ?? 0, end: cursor ?? 0, ...(brush.length ? { start: brush[0][0], end: brush[brush.length - 1][1] } : {}), text: "" })} />
      <NoteDraft draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}

/** A new note: its time range and text. */
function NoteDraft({ draft, onClose }: { draft: { start: number; end: number; text: string } | null; onClose: () => void }) {
  const notes = useApp((s) => s.notes);
  const [text, setText] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setStart(sig(draft.start));
    setEnd(sig(draft.end));
  }, [draft]);
  const add = async () => {
    const a = num(start);
    const b = num(end);
    if (a === null || !Number.isFinite(a)) return;
    await saveNotes([...notes, { id: `n${Date.now().toString(36)}`, start: a, end: b !== null && Number.isFinite(b) ? b : a, text }]);
    onClose();
  };
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
          <DialogDescription>Shown on every time chart, saved with the project, listed in the report.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Valve stuck here" />
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            From <Input className="h-8 w-28 tabular-nums" value={start} onChange={(e) => setStart(e.target.value)} /> to
            <Input className="h-8 w-28 tabular-nums" value={end} onChange={(e) => setEnd(e.target.value)} /> s
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim()}>
              Add note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every note: edit the text, show it (select its range), delete it. */
function NotesDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (v: boolean) => void; onAdd: () => void }) {
  const { notes, setBrush, setCursor } = useApp();
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) setTexts(Object.fromEntries(notes.map((n) => [n.id, n.text])));
  }, [open, notes]);
  const commit = (id: string) => {
    const n = notes.find((x) => x.id === id);
    if (n && texts[id] !== undefined && texts[id] !== n.text) saveNotes(notes.map((x) => (x.id === id ? { ...x, text: texts[id] } : x)));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Notes</DialogTitle>
          <DialogDescription>Select a range (Shift+drag on a chart), then add a note.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
          {notes.length === 0 && <p className="py-6 text-center text-[13px] text-muted-foreground">No notes yet</p>}
          {notes.map((n) => (
            <div key={n.id} className="group flex items-center gap-2 rounded-lg border border-ap-line px-2.5 py-1.5">
              <button
                className="w-36 shrink-0 text-left text-[12px] text-muted-foreground tabular-nums hover:text-foreground"
                title="Show: select this range"
                onClick={() => {
                  if (n.end > n.start) setBrush([[n.start, n.end]], n.text);
                  setCursor(n.start);
                  onOpenChange(false);
                }}
              >
                {n.end > n.start ? `${sig(n.start)} – ${sig(n.end)} s` : `${sig(n.start)} s`}
              </button>
              <Input
                value={texts[n.id] ?? n.text}
                onChange={(e) => setTexts({ ...texts, [n.id]: e.target.value })}
                onBlur={() => commit(n.id)}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                className="h-8 border-transparent text-[13px] shadow-none hover:border-input focus:border-ap-red"
              />
              <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => saveNotes(notes.filter((x) => x.id !== n.id))} aria-label="Delete note">
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onAdd();
            }}
          >
            <MessageSquarePlus /> Add note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Select every time where a signal lies in a range ("Speed between 1500 and 2000 rpm"). */
function WhereDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { dataset, setBrush } = useApp();
  const [column, setColumn] = useState<string | null>(null);
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [gap, setGap] = useState("");
  const [data, setData] = useState<{ time: (number | null)[]; values: (number | null)[] } | null>(null);

  useEffect(() => {
    if (open && dataset && !column) setColumn(dataset.signals[0]?.column ?? null);
  }, [open, dataset, column]);
  useEffect(() => {
    if (!open || !column) return;
    let cancelled = false;
    analysisVectors([column])
      .then((v) => !cancelled && setData({ time: v.time, values: v.columns[column] ?? [] }))
      .catch((e) => !cancelled && toast.error(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [open, column]);

  const range = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const v of data?.values ?? []) if (v !== null && Number.isFinite(v)) (a = Math.min(a, v)), (b = Math.max(b, v));
    return b >= a ? [a, b] : null;
  }, [data]);
  const intervals: Interval[] = useMemo(() => {
    const a = num(lo);
    const b = num(hi);
    if (!data || (a === null && b === null)) return [];
    return where(data.time, data.values, a, b, num(gap) ?? 0);
  }, [data, lo, hi, gap]);

  const info = dataset?.signals.find((s) => s.column === column);
  const apply = () => {
    const unit = info?.unit ? ` ${info.unit}` : "";
    const a = num(lo);
    const b = num(hi);
    const cond = a !== null && b !== null ? `${sig(a)}–${sig(b)}${unit}` : a !== null ? `≥ ${sig(a)}${unit}` : `≤ ${sig(b!)}${unit}`;
    setBrush(intervals, `${info?.name ?? column} ${cond}`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Select where</DialogTitle>
          <DialogDescription>Analyses then use only these times. Shift+drag on a chart selects a range directly.</DialogDescription>
        </DialogHeader>
        {dataset && (
          <div className="flex flex-col gap-3">
            <Field label="Signal">
              <SignalSelect signals={dataset.signals} value={column} onChange={setColumn} />
            </Field>
            <div className="flex items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">between</span>
              <Input className="h-8 w-28 tabular-nums" value={lo} onChange={(e) => setLo(e.target.value)} placeholder={range ? sig(range[0]) : "min"} />
              <span className="text-muted-foreground">and</span>
              <Input className="h-8 w-28 tabular-nums" value={hi} onChange={(e) => setHi(e.target.value)} placeholder={range ? sig(range[1]) : "max"} />
              <span className="text-muted-foreground">{info?.unit}</span>
            </div>
            <div className="flex items-center gap-2 text-[13px]" title="Stretches closer than this are joined into one">
              <span className="text-muted-foreground">join gaps under</span>
              <Input className="h-8 w-20 tabular-nums" value={gap} onChange={(e) => setGap(e.target.value)} placeholder="0" />
              <span className="text-muted-foreground">s</span>
            </div>
            <p className="text-[12.5px] tabular-nums text-muted-foreground">{intervals.length ? `${intervals.length} range${intervals.length === 1 ? "" : "s"} · ${sig(total(intervals))} s` : "Nothing selected yet"}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!intervals.length}>
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
