import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type UnitChange, type VariableInfo, type WorkspaceView } from "@/lib/api";
import { bareName, canonical, conversion, describeConversion, guessUnit, lookup, QUANTITIES, related } from "@/lib/units";
import { cn } from "@/lib/utils";

interface Row {
  name: string;
  /** The unit typed in the dialog. */
  draft: string;
  convert: boolean;
  /** Back to the header's unit. */
  reset: boolean;
}

const LIST_ID = "unit-catalog";

/** Every catalog unit, offered as suggestions in each unit field. */
function UnitOptions() {
  return (
    <datalist id={LIST_ID}>
      {QUANTITIES.flatMap((q) =>
        q.units.map((u) => (
          <option key={`${q.name}:${u.symbol}`} value={u.symbol}>
            {q.name}
          </option>
        )),
      )}
    </datalist>
  );
}

/**
 * Units of the workspace's signals, many at once. A new unit of the same quantity can convert the
 * values (mm → m divides by 1000); otherwise only the label changes (a wrong or missing unit).
 */
export function UnitsDialog({
  open,
  onOpenChange,
  variables,
  focus,
  run,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  variables: VariableInfo[];
  /** Show only these signals (one clicked unit), or all when null. */
  focus: string[] | null;
  run: (f: () => Promise<WorkspaceView>) => Promise<void>;
}) {
  const numeric = useMemo(() => variables.filter((v) => v.kind !== "text"), [variables]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(Object.fromEntries(numeric.map((v) => [v.name, { name: v.name, draft: v.unit, convert: true, reset: false }])));
    setFilter("");
    setPicked([]);
    setBulk("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = numeric.filter((v) => (!focus || focus.includes(v.name)) && (!filter.trim() || v.name.toLowerCase().includes(filter.trim().toLowerCase())));
  const single = !!focus && focus.length === 1;

  const set = (name: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [name]: { ...r[name], ...patch } }));

  /** What applying a row would do: null when nothing changes. */
  const plan = (v: VariableInfo): UnitChange | null => {
    const r = rows[v.name];
    if (!r) return null;
    if (r.reset) return v.unit_set ? { name: v.name, unit: null } : null;
    const unit = r.draft.trim();
    if (unit === v.unit) return null;
    const c = r.convert && !v.is_time ? conversion(v.unit, unit) : null;
    const identity = !c || (Math.abs(c.scale - 1) < 1e-12 && Math.abs(c.offset) < 1e-12);
    return { name: v.name, unit, scale: identity ? null : c.scale, offset: identity ? null : c.offset };
  };
  const changes = numeric.map(plan).filter((c): c is UnitChange => c !== null);

  const apply = async () => {
    if (!changes.length) return onOpenChange(false);
    setBusy(true);
    await run(() => api.workspaceSetUnits(changes));
    setBusy(false);
    onOpenChange(false);
  };

  const suggest = () => {
    for (const v of shown) {
      if (rows[v.name]?.draft.trim()) continue;
      const g = guessUnit(v.name);
      if (g) set(v.name, { draft: g, reset: false });
    }
  };

  const missing = shown.filter((v) => !rows[v.name]?.draft.trim()).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("flex max-h-[85vh] flex-col gap-3 bg-white", single ? "sm:max-w-[560px]" : "sm:max-w-[920px]")}>
        <DialogHeader>
          <DialogTitle>{single ? `Unit of ${focus![0]}` : "Units"}</DialogTitle>
          <DialogDescription>Relabel, or convert the values to a new unit.</DialogDescription>
        </DialogHeader>
        <UnitOptions />

        {!single && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter signals" className="h-8 pl-8 text-[13px]" />
            </label>
            <Button size="sm" variant="outline" disabled={!missing} onClick={suggest} title="Fill missing units from the names (Temperature → °C, Pressure → bar)">
              <Sparkles /> Suggest{missing ? ` ${missing}` : ""}
            </Button>
            <div className="flex-1" />
            {picked.length > 0 && <span className="text-[12.5px] text-muted-foreground">{picked.length} ticked</span>}
            <Input value={bulk} onChange={(e) => setBulk(e.target.value)} list={LIST_ID} placeholder="unit" className="h-8 w-28 text-[13px]" disabled={!picked.length} title="Tick rows, type a unit, press Set" />
            <Button size="sm" variant="outline" disabled={!picked.length || !bulk.trim()} onClick={() => picked.forEach((n) => set(n, { draft: canonical(bulk), reset: false }))}>
              Set
            </Button>
          </div>
        )}

        <div className="selectable min-h-0 flex-1 overflow-auto rounded-lg border border-ap-line">
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-[#fafbfc] text-left text-[12px] text-muted-foreground shadow-[0_1px_0_var(--ap-line)]">
              <tr>
                {!single && (
                  <th className="w-8 px-2 py-2">
                    <Checkbox
                      checked={shown.length > 0 && shown.every((v) => picked.includes(v.name))}
                      onCheckedChange={(on) => setPicked(on ? shown.map((v) => v.name) : [])}
                      aria-label="Tick all"
                    />
                  </th>
                )}
                <th className="px-2 py-2 font-medium">Signal</th>
                <th className="px-2 py-2 font-medium" title="The unit written in the file">File</th>
                <th className="px-2 py-2 font-medium">Unit</th>
                <th className="px-2 py-2 font-medium" title="Ticked: the values are converted. Unticked: only the label changes.">Convert</th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => {
                const r = rows[v.name];
                if (!r) return null;
                const draft = r.reset ? v.header_unit : r.draft.trim();
                const changed = draft !== v.unit;
                const c0 = !r.reset && changed && !v.is_time ? conversion(v.unit, draft) : null;
                // C → °C is the same unit spelled differently: nothing to convert.
                const c = c0 && (Math.abs(c0.scale - 1) > 1e-12 || Math.abs(c0.offset) > 1e-12) ? c0 : null;
                const known = !draft || lookup(draft).length > 0;
                const quantity = lookup(draft)[0]?.quantity.name;
                const quick = related(v.unit || draft).filter((x) => x.symbol !== draft).slice(0, 6);
                return (
                  <tr key={v.name} className={cn("group border-b border-ap-line/60 align-top", changed && "bg-ap-red-soft/40")}>
                    {!single && (
                      <td className="px-2 py-2">
                        <Checkbox checked={picked.includes(v.name)} onCheckedChange={(on) => setPicked(on ? [...picked, v.name] : picked.filter((p) => p !== v.name))} />
                      </td>
                    )}
                    <td className="max-w-64 px-2 py-2">
                      <p className="truncate font-medium" title={v.name}>
                        {bareName(v.name, v.header_unit)}
                      </p>
                      {(quantity || v.is_time) && <p className="text-[11.5px] text-muted-foreground">{v.is_time ? "time axis" : quantity}</p>}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{v.header_unit || "—"}</td>
                    <td className="px-2 py-1.5">
                      <Input
                        autoFocus={single}
                        value={r.reset ? v.header_unit : r.draft}
                        list={LIST_ID}
                        placeholder="none"
                        onChange={(e) => set(v.name, { draft: e.target.value, reset: false })}
                        onBlur={(e) => e.target.value.trim() && set(v.name, { draft: canonical(e.target.value) })}
                        onKeyDown={(e) => e.key === "Enter" && single && apply()}
                        className={cn("h-8 w-32 text-[13px]", !known && "border-amber-400")}
                        title={known ? undefined : "Not in the unit catalog: it labels the signal but cannot convert"}
                      />
                      {quick.length > 0 && (
                        <div className="mt-1 hidden max-w-56 flex-wrap gap-1 group-focus-within:flex">
                          {quick.map((q) => (
                            <button
                              key={q.symbol}
                              className="rounded border border-ap-line px-1.5 text-[11.5px] text-muted-foreground hover:border-ap-red hover:text-foreground"
                              onClick={() => set(v.name, { draft: q.symbol, reset: false })}
                            >
                              {q.symbol}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[12.5px]">
                      {changed && c ? (
                        <label className="flex cursor-pointer items-center gap-2 tabular-nums" title={`${v.unit} → ${draft}. Untick to change only the label.`}>
                          <Checkbox checked={r.convert} onCheckedChange={(on) => set(v.name, { convert: !!on })} />
                          <span className={cn(!r.convert && "text-muted-foreground line-through")}>{describeConversion(c)}</span>
                        </label>
                      ) : (
                        <span className="text-muted-foreground" title={changed ? (v.is_time ? "Time axes: set the unit next to 'Time from'" : "Different or unknown quantity: label only") : undefined}>
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {v.unit_set && (
                        <Button size="icon-xs" variant="ghost" title={`Back to the header's unit (${v.header_unit || "none"})`} onClick={() => set(v.name, { reset: true })}>
                          <RotateCcw />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <p className="p-6 text-center text-[13px] text-muted-foreground">No signal matches.</p>}
        </div>

        <DialogFooter className="items-center">
          <p className="mr-auto text-[12.5px] text-muted-foreground" title="Conversions become Gain / Offset steps in Prepare, so Undo works">
            {changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : ""}
          </p>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={busy || !changes.length}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
