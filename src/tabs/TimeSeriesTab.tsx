import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Search, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckField, EmptyState, Panel, Segmented } from "@/components/common";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { analysisVectors, type Vectors } from "@/lib/analysis";
import { api } from "@/lib/api";
import { INK, PALETTE, seriesColor, zip } from "@/lib/chart";
import { dateAxis as dateAxisOf, rowAxis, SECONDS } from "@/lib/brush";
import { useApp } from "@/lib/store";

/** One palette slot per signal, so colours never repeat. */
const MAX_PLOTS = PALETTE.length;

export function TimeSeriesTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const [query, setQuery] = useState("");
  const loadedRequest = useRef("");
  const [selected, setSelected] = useState<string[]>([]);
  /** Stack: one plot per signal. Overlay: every signal in one plot. */
  const [overlayAll, setOverlayAll] = useState(false);
  /** Colour slot per signal, kept while it stays selected so other plots never repaint. */
  const [slots, setSlots] = useState<Record<string, number>>({});
  const [data, setData] = useState<Vectors | null>(null);
  const [xColumn, setXColumn] = useState("__row");
  const [loading, setLoading] = useState(false);
  /** Workspace variables with edits, and their imported values when "Show original" is on. */
  const [editedNames, setEditedNames] = useState<string[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originals, setOriginals] = useState<Record<string, { x: number[]; y: (number | null)[] }>>({});
  /** Line plots: only the visible window, decimated by the backend (x in axis units). */
  const [lines, setLines] = useState<Record<string, { x: (number | null)[]; y: (number | null)[] }> | null>(null);
  /** Visible X range in axis units (row, seconds or Unix ms); null = everything. */
  const [win, setWin] = useState<[number, number] | null>(null);
  const xSignal = xColumn.startsWith("column:") ? xColumn.slice(7) : null;

  useEffect(() => {
    const initial = dataset?.signals.slice(0, 1).map((s) => s.column) ?? [];
    setSelected(initial);
    setSlots(Object.fromEntries(initial.map((c, i) => [c, i])));
    // Plots open on the index; time is one click away in the X menu.
    setXColumn("__row");
  }, [dataset?.path, dataset?.sheet]);

  const select = (cols: string[]) => {
    let c = cols;
    if (c.length > MAX_PLOTS) {
      toast.warning(
        `Max ${MAX_PLOTS} plots at once for performance. Showing first ${MAX_PLOTS}.`,
      );
      c = c.slice(0, MAX_PLOTS);
    }
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
    setSelected(c);
  };

  const groups = useMemo(() => Object.fromEntries(selected.map((c, i) => [c, overlayAll ? 1 : i + 1])) as Record<string, number>, [selected, overlayAll]);
  const origin = dataset?.time_origin ?? null;
  const dateAxis = xColumn === "__time" && origin !== null;
  const rowAxisOn = xColumn === "__row";
  /** Axis units → backend units (seconds, or 1-based rows). */
  const toBackend = (v: number) => (dateAxis ? v / 1000 - origin! : v);
  const toAxis = (v: number | null) => (v === null ? null : dateAxis ? (origin! + v) * 1000 : v);
  const resetKey = JSON.stringify([dataset?.path, dataset?.sheet, xColumn, selected]);
  // The dataset's row times, so an Index axis still links to the cursor and the selection.
  const [gridTime, setGridTime] = useState<number[] | null>(null);
  useEffect(() => {
    if (!rowAxisOn || activeTab !== "timeseries" || !dataset) return;
    let cancelled = false;
    analysisVectors([])
      .then((v) => !cancelled && setGridTime(v.time.map((t) => t ?? NaN)))
      .catch(() => !cancelled && setGridTime(null));
    return () => {
      cancelled = true;
    };
  }, [rowAxisOn, dataVersion, activeTab, !!dataset]);
  const timeAxis = useMemo(
    () => (xSignal !== null ? undefined : xColumn === "__time" ? (dateAxis ? dateAxisOf(origin!) : SECONDS) : gridTime ? rowAxis(gridTime) : undefined),
    [xSignal, xColumn, dateAxis, origin, gridTime],
  );
  useEffect(() => setWin(null), [resetKey]);

  // Line plots: fetch the visible window at about two points per pixel column.
  useEffect(() => {
    if (activeTab !== "timeseries" || xSignal !== null) return;
    if (!dataset || selected.length === 0) {
      setLines(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const range = win ? ([toBackend(win[0]), toBackend(win[1])] as [number, number]) : null;
    api
      .getSeries(selected, range, 3000, rowAxisOn)
      .then((r) => {
        if (cancelled) return;
        setLines(Object.fromEntries(r.series.map((s) => [s.column, { x: s.x.map(toAxis), y: s.y }])));
      })
      .catch((e) => !cancelled && toast.error(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, xSignal, xColumn, win, dataVersion, dataset, activeTab]);

  // Signal-vs-signal scatter needs both full vectors.
  useEffect(() => {
    if (activeTab !== "timeseries" || xSignal === null) return;
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
    analysisVectors(columns, 100_000)
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
    const range = win ? ([toBackend(win[0]), toBackend(win[1])] as [number, number]) : null;
    api
      .workspaceVectors(overlay, range, 3000, rowAxisOn)
      .then(
        (v) =>
          !cancelled &&
          setOriginals(Object.fromEntries(Object.entries(v.variables).map(([k, o]) => [k, { x: o.x.map((t) => toAxis(t) as number), y: o.original }]))),
      )
      .catch((e) => !cancelled && toast.error(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalOn, overlay, win, xColumn, dataVersion, activeTab]);

  const xLabel =
    xColumn === "__row"
      ? "Index"
      : xColumn === "__time"
        ? dateAxis
          ? "Time"
          : "Time [s]"
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
    if (!dataset) return [];
    const scatter = xSignal !== null;
    if (scatter ? !data : !lines) return [];
    const has = (c: string) => (scatter ? !!data?.columns[c] : !!lines?.[c]);
    const sx = scatter ? (data!.columns[xSignal] ?? []) : [];
    const pairs = (c: string): [number | null, number | null][] => {
      if (scatter) {
        const y = data!.columns[c];
        return y ? zip(sx, y) : [];
      }
      const l = lines![c];
      return l ? zip(l.x, l.y) : [];
    };
    return byGroup.filter(([, cols]) => cols.some(has)).map(([g, cols]) => ({
      id: String(g),
      yLabel:
        cols.length === 1
          ? dataset.signals.find((s) => s.column === cols[0])?.label
          : undefined,
      series: cols.flatMap((c) => {
        const name = dataset.signals.find((s) => s.column === c)?.label ?? c;
        const original = originalOn && overlay.includes(c) ? originals[c] : undefined;
        return [
          // The imported values recede to gray behind the edited signal.
          ...(original ? [{ name: `${name} · original`, color: INK.original, width: 1.4, data: zip(original.x, original.y) }] : []),
          {
            name,
            color: seriesColor(slots[c] ?? 0),
            data: pairs(c),
            type: scatter ? ("scatter" as const) : ("line" as const),
          },
        ];
      }),
    }));
  }, [data, lines, byGroup, dataset, xSignal, slots, originalOn, overlay, originals]);

  const grouped = useMemo(() => {
    const m = new Map<
      string,
      typeof dataset extends null
        ? never
        : NonNullable<typeof dataset>["signals"]
    >();
    const q = query.trim().toLowerCase();
    for (const s of dataset?.signals ?? []) {
      if (q && !`${s.label} ${s.group}`.toLowerCase().includes(q)) continue;
      m.set(s.group, [...(m.get(s.group) ?? []), s]);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([g, l]) =>
          [g, [...l].sort((a, b) => a.name.localeCompare(b.name))] as const,
      );
  }, [dataset, query]);

  if (!dataset) return <EmptyState title="No data loaded" />;

  const single = grouped.length === 1;
  const visible = grouped.flatMap(([, l]) => l.map((s) => s.column));
  const many = dataset.signals.length > 6;

  return (
    <div className="flex h-full gap-3">
      <Panel
        title={
          <>
            Signals <span className="font-normal text-muted-foreground tabular-nums">{selected.length}/{dataset.signals.length}</span>
          </>
        }
        actions={
          <>
            <button
              className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-ap-bluegray-15 hover:text-foreground disabled:opacity-40"
              disabled={visible.every((c) => selected.includes(c))}
              onClick={() => select([...selected, ...visible.filter((c) => !selected.includes(c))])}
              title={query ? "Plot every signal that matches" : "Plot every signal"}
            >
              All
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-ap-bluegray-15 hover:text-foreground disabled:opacity-40"
              disabled={selected.length === 0}
              onClick={() => select([])}
              title="Clear the plot"
            >
              None
            </button>
          </>
        }
        className="w-[250px] shrink-0"
        bodyClassName="flex min-h-0 flex-col gap-1 p-2"
      >
        {many && (
          <label className="relative mx-0.5 mb-1 block">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder="Find a signal" className="h-8 pr-7 pl-8 text-[13px]" aria-label="Find a signal" />
            {query && (
              <button className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            )}
          </label>
        )}
        <div className="min-h-0 flex-1 overflow-auto text-[13px]">
          {visible.length === 0 && <p className="px-2 py-4 text-center text-[12.5px] text-muted-foreground">No signal matches “{query}”.</p>}
          {grouped.map(([g, list]) => (
            <div key={g} className="mb-2">
              {!single && <p className="px-2 py-1 text-[12px] font-medium text-muted-foreground">{g}</p>}
              {list.map((s) => (
                <label key={s.column} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-ap-bluegray-15">
                  <Checkbox
                    checked={selected.includes(s.column)}
                    onCheckedChange={(v) => select(v ? [...selected, s.column] : selected.filter((c) => c !== s.column))}
                  />
                  <span className="flex-1 truncate">{s.name}</span>
                  {editedNames.includes(s.column) && <span className="size-1.5 shrink-0 rounded-full bg-ap-red" title="Processed in Prepare" />}
                  {selected.includes(s.column) && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(slots[s.column] ?? 0) }} aria-hidden />}
                </label>
              ))}
            </div>
          ))}
        </div>
      </Panel>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground">X</span>
            <Select value={xColumn} onValueChange={setXColumn}>
              <SelectTrigger className="h-8 w-[240px]" aria-label="X axis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectItem value="__row">Index</SelectItem>
                <SelectItem value="__time">Time</SelectItem>
                {dataset.signals.map((s) => (
                  <SelectItem key={s.column} value={`column:${s.column}`}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected.length > 1 && (
            <Segmented
              value={overlayAll ? "overlay" : "stack"}
              onChange={(v) => setOverlayAll(v === "overlay")}
              options={[
                { value: "stack", label: "Stacked" },
                { value: "overlay", label: "Overlaid" },
              ]}
            />
          )}
          {xSignal === null && overlay.length > 0 && <CheckField checked={showOriginal} onChange={setShowOriginal} label="Show original" />}
        </div>
        <Panel className={`min-h-0 flex-1 transition-opacity ${loading ? "opacity-60" : ""}`} bodyClassName="p-1">
          {selected.length === 0 ? (
            <EmptyState title="Tick a signal to plot it" />
          ) : (
            <StackedChart panels={panels} xLabel={xLabel} xDate={dateAxis} resetKey={resetKey} onZoom={xSignal === null ? setWin : undefined} time={timeAxis} />
          )}
        </Panel>
      </div>
    </div>
  );
}
