import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckField, EmptyState, NumberInput, Panel } from "@/components/common";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { analysisVectors, type Vectors } from "@/lib/analysis";
import { api } from "@/lib/api";
import { INK, PALETTE, seriesColor, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

/** One palette slot per signal, so colours never repeat. */
const MAX_PLOTS = PALETTE.length;

export function TimeSeriesTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const loadedRequest = useRef("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [groups, setGroups] = useState<Record<string, number>>({});
  /** Colour slot per signal, kept while it stays selected so other plots never repaint. */
  const [slots, setSlots] = useState<Record<string, number>>({});
  const [data, setData] = useState<Vectors | null>(null);
  const [xColumn, setXColumn] = useState("__row");
  const [coord, setCoord] = useState("");
  const [loading, setLoading] = useState(false);
  /** Workspace variables with edits, and their imported values when "Show original" is on. */
  const [editedNames, setEditedNames] = useState<string[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originals, setOriginals] = useState<Record<string, (number | null)[]>>({});
  const xSignal = xColumn.startsWith("column:") ? xColumn.slice(7) : null;

  useEffect(() => {
    const initial = dataset?.signals.slice(0, 1).map((s) => s.column) ?? [];
    setSelected(initial);
    setGroups(Object.fromEntries(initial.map((c, i) => [c, i + 1])));
    setSlots(Object.fromEntries(initial.map((c, i) => [c, i])));
    setXColumn("__row");
    setCoord("");
  }, [dataset?.path, dataset?.sheet]);

  const select = (cols: string[]) => {
    let c = cols;
    if (c.length > MAX_PLOTS) {
      toast.warning(
        `Max ${MAX_PLOTS} plots at once for performance. Showing first ${MAX_PLOTS}.`,
      );
      c = c.slice(0, MAX_PLOTS);
    }
    const g: Record<string, number> = {};
    let next = Math.max(0, ...Object.values(groups)) + 1;
    for (const col of c) g[col] = groups[col] ?? Math.min(MAX_PLOTS, next++);
    const used = new Set(c.filter((col) => slots[col] !== undefined).map((col) => slots[col]));
    const s: Record<string, number> = {};
    for (const col of c) {
      if (slots[col] !== undefined) s[col] = slots[col];
      else {
        let k = 0;
        while (used.has(k)) k++;
        used.add(k);
        s[col] = k;
      }
    }
    setSlots(s);
    setGroups(g);
    setSelected(c);
  };

  useEffect(() => {
    if (activeTab !== "timeseries") return;
    if (!dataset || selected.length === 0) {
      setData(null);
      return;
    }
    const requestKey = JSON.stringify([dataset.path, dataset.sheet, dataVersion, selected, xSignal]);
    if (loadedRequest.current === requestKey && data) return;
    let cancelled = false;
    // Keep the previous plot on screen (dimmed) while the new vectors load.
    setLoading(true);
    const columns = [
      ...new Set([...selected, ...(xSignal !== null ? [xSignal] : [])]),
    ];
    analysisVectors(columns)
      .then((v) => {
        if (!cancelled) { loadedRequest.current = requestKey; setData(v); }
      })
      .catch((e) => {
        if (!cancelled) toast.error(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, xSignal, dataVersion, dataset, activeTab]);

  useEffect(() => {
    api
      .workspaceView()
      .then((v) => setEditedNames(v.variables.filter((x) => x.edits.length > 0).map((x) => x.name)))
      .catch(() => setEditedNames([]));
  }, [dataVersion]);

  const overlay = useMemo(() => selected.filter((c) => editedNames.includes(c)), [selected, editedNames]);
  const originalOn = showOriginal && xSignal === null && overlay.length > 0;
  useEffect(() => {
    if (!originalOn || activeTab !== "timeseries") return;
    let cancelled = false;
    api
      .workspaceVectors(overlay)
      .then((v) => !cancelled && setOriginals(Object.fromEntries(Object.entries(v.variables).map(([k, x]) => [k, x.original]))))
      .catch((e) => !cancelled && toast.error(String(e)));
    return () => {
      cancelled = true;
    };
  }, [originalOn, overlay, dataVersion, activeTab]);

  const x = useMemo(
    () =>
      !data
        ? []
        : xColumn === "__row"
          ? data.time.map((_, i) => i + 1)
          : xColumn === "__time"
            ? data.time
            : (data.columns[xSignal ?? ""] ?? []),
    [data, xColumn, xSignal],
  );
  const xLabel =
    xColumn === "__row"
      ? "Row"
      : xColumn === "__time"
        ? "Time [s]"
        : (dataset?.signals.find((s) => s.column === xSignal)?.label ??
          xSignal ??
          "X");

  const byGroup = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const c of selected)
      m.set(groups[c] ?? 1, [...(m.get(groups[c] ?? 1) ?? []), c]);
    return [...m.entries()];
  }, [selected, groups]);

  const panels: ChartPanel[] = useMemo(() => {
    if (!data || !dataset) return [];
    return byGroup.filter(([, cols]) => cols.some((c) => data.columns[c])).map(([g, cols]) => ({
      id: String(g),
      yLabel:
        cols.length === 1
          ? dataset.signals.find((s) => s.column === cols[0])?.label
          : undefined,
      series: cols.flatMap((c) => {
        const y = data.columns[c];
        const name = dataset.signals.find((s) => s.column === c)?.label ?? c;
        const original = originalOn && overlay.includes(c) ? originals[c] : undefined;
        return [
          // The imported values recede to gray behind the edited signal.
          ...(original ? [{ name: `${name} · original`, color: INK.muted, data: zip(x, original) }] : []),
          {
            name,
            color: seriesColor(slots[c] ?? 0),
            data: y ? zip(x, y) : [],
            type: xSignal === null ? ("line" as const) : ("scatter" as const),
          },
        ];
      }),
    }));
  }, [data, byGroup, dataset, x, xSignal, slots, originalOn, overlay, originals]);

  const grouped = useMemo(() => {
    const m = new Map<
      string,
      typeof dataset extends null
        ? never
        : NonNullable<typeof dataset>["signals"]
    >();
    for (const s of dataset?.signals ?? []) {
      if (search && !s.column.toLowerCase().includes(search.toLowerCase()))
        continue;
      m.set(s.group, [...(m.get(s.group) ?? []), s]);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([g, l]) =>
          [g, [...l].sort((a, b) => a.name.localeCompare(b.name))] as const,
      );
  }, [dataset, search]);

  if (!dataset)
    return (
      <EmptyState title="No data loaded">
        Load a CSV, TXT or Excel file in the File tab to plot its signals.
      </EmptyState>
    );

  return (
    <div className="flex h-full gap-3">
      <Panel
        title="Signals"
        className="w-[270px] shrink-0"
        bodyClassName="flex flex-col gap-2 p-2"
      >
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-ap-bluegray" />
          <Input
            className="h-8 pl-7"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() =>
              select(grouped.flatMap(([, l]) => l.map((s) => s.column)))
            }
          >
            All
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => select([])}
          >
            None
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto text-[12.5px]">
          {grouped.map(([g, list]) => {
            const n = list.filter((s) => selected.includes(s.column)).length;
            return (
              <div key={g} className="mb-1">
                <label className="flex items-center gap-2 px-1 py-1 text-ap-red">
                  <Checkbox
                    checked={
                      n === list.length ? true : n > 0 ? "indeterminate" : false
                    }
                    onCheckedChange={(v) =>
                      select(
                        v
                          ? [
                              ...selected,
                              ...list
                                .map((s) => s.column)
                                .filter((c) => !selected.includes(c)),
                            ]
                          : selected.filter(
                              (c) => !list.some((s) => s.column === c),
                            ),
                      )
                    }
                  />
                  {g}
                </label>
                {list.map((s) => (
                  <label
                    key={s.column}
                    className="flex cursor-pointer items-center gap-2 py-0.5 pr-1 pl-6 hover:bg-ap-bluegray-15"
                  >
                    <Checkbox
                      checked={selected.includes(s.column)}
                      onCheckedChange={(v) =>
                        select(
                          v
                            ? [...selected, s.column]
                            : selected.filter((c) => c !== s.column),
                        )
                      }
                    />
                    <span className="flex-1 truncate">{s.name}</span>
                    {editedNames.includes(s.column) && <span className="text-[10px] text-muted-foreground">edited</span>}
                    {selected.includes(s.column) && (
                      <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(slots[s.column] ?? 0) }} aria-hidden />
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {s.unit}
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </Panel>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground">X axis</span>
          <Select
            value={xColumn}
            onValueChange={(v) => {
              setXColumn(v);
              setCoord("");
            }}
          >
            <SelectTrigger className="h-8 w-[300px]" aria-label="X axis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value="__row">Row number</SelectItem>
              <SelectItem value="__time">Time</SelectItem>
              {dataset.signals.map((s) => (
                <SelectItem key={s.column} value={`column:${s.column}`}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            aria-label="Swap X and Y"
            title="Swap X and Y"
            disabled={xSignal === null || selected.length !== 1}
            onClick={() => {
              if (xSignal !== null && selected.length === 1) {
                setXColumn(`column:${selected[0]}`);
                select([xSignal]);
                setCoord("");
              }
            }}
          >
            <ArrowLeftRight className="size-4" />
          </Button>
          {xSignal === null && overlay.length > 0 && (
            <span className="ml-3">
              <CheckField checked={showOriginal} onChange={setShowOriginal} label="Show original" hint="Overlay the imported values (gray) behind signals edited in Prepare or Workspace" />
            </span>
          )}
        </div>
        {selected.length > 1 && (
          <div className="flex flex-wrap items-center gap-3 border border-ap-line bg-ap-bluegray-15 px-3 py-1.5 text-xs">
            <span className="text-ap-red">Plot #</span>
            {selected.map((c) => (
              <span
                key={c}
                className="flex items-center gap-1.5"
                title="Signals with the same plot number are overlaid on the same subplot"
              >
                {dataset.signals.find((s) => s.column === c)?.name.slice(0, 18)}
                <NumberInput
                  className="w-14"
                  integer
                  min={1}
                  max={MAX_PLOTS}
                  value={groups[c] ?? 1}
                  onChange={(v) => setGroups({ ...groups, [c]: v })}
                />
              </span>
            ))}
          </div>
        )}
        <Panel className={`min-h-0 flex-1 transition-opacity ${loading ? "opacity-60" : ""}`} bodyClassName="p-1">
          {selected.length === 0 ? (
            <EmptyState title="Select signals from the panel on the left to plot." />
          ) : (
            <StackedChart
              panels={panels}
              xLabel={xLabel}
              resetKey={JSON.stringify([
                dataset.path,
                dataset.sheet,
                xColumn,
                selected,
              ])}
              onCursor={(v) => setCoord(`${xLabel}: ${v.toPrecision(6)}`)}
            />
          )}
        </Panel>
        <p className="h-4 truncate font-mono text-[11px] text-muted-foreground">
          {coord}
        </p>
      </div>
    </div>
  );
}
