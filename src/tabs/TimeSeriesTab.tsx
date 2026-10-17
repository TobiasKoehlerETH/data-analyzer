import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EmptyState, NumberInput, Panel } from "@/components/common";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { analysisVectors, finitePairs, type Vectors } from "@/lib/analysis";
import { PALETTE, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

const MAX_PLOTS = 8;

export function TimeSeriesTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const loadedRequest = useRef("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [groups, setGroups] = useState<Record<string, number>>({});
  const [data, setData] = useState<Vectors | null>(null);
  const [xColumn, setXColumn] = useState("__row");
  const [coord, setCoord] = useState("");
  const xSignal = xColumn.startsWith("column:") ? xColumn.slice(7) : null;

  useEffect(() => {
    const initial = dataset?.signals.slice(0, 1).map((s) => s.column) ?? [];
    setSelected(initial);
    setGroups(Object.fromEntries(initial.map((c, i) => [c, i + 1])));
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
    setData(null);
    const columns = [
      ...new Set([...selected, ...(xSignal !== null ? [xSignal] : [])]),
    ];
    analysisVectors(columns)
      .then((v) => {
        if (!cancelled) { loadedRequest.current = requestKey; setData(v); }
      })
      .catch((e) => {
        if (!cancelled) toast.error(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, xSignal, dataVersion, dataset, activeTab]);

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
      ? "Row position"
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
    let ci = 0;
    return byGroup.map(([g, cols]) => ({
      id: String(g),
      yLabel:
        cols.length === 1
          ? dataset.signals.find((s) => s.column === cols[0])?.label
          : undefined,
      legend: cols.length > 1,
      series: cols.map((c) => {
        const y = data.columns[c];
        return {
          name: dataset.signals.find((s) => s.column === c)?.label ?? c,
          color: PALETTE[ci++ % PALETTE.length],
          data: y ? zip(x, y) : [],
          type: xSignal === null ? ("line" as const) : ("scatter" as const),
        };
      }),
    }));
  }, [data, byGroup, dataset, x, xSignal]);

  const fitSources = useMemo(
    () =>
      panels
        .flatMap((p) => p.series)
        .map((s, seriesIndex) => ({
          name: s.name,
          points: finitePairs(
            s.data.map((p) => p[0]),
            s.data.map((p) => p[1]),
          ),
          seriesIndex,
          xLabel,
          scope: "Full vector (finite XY pairs)",
        })),
    [panels, xLabel],
  );

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
        title="Y columns"
        className="w-[270px] shrink-0"
        bodyClassName="flex flex-col gap-2 p-2"
      >
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-ap-bluegray" />
          <Input
            className="h-8 pl-7"
            placeholder="Search signals..."
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
                    <span className="text-[11px] text-muted-foreground">
                      {s.unit}
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {selected.length} selected
        </p>
      </Panel>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-end gap-3">
          <label className="analysis-field min-w-0 max-w-[360px] flex-1">
            X
            <select
              aria-label="X axis"
              value={xColumn}
              onChange={(e) => {
                setXColumn(e.target.value);
                setCoord("");
              }}
            >
              <option value="__row">Row position (1…N)</option>
              <option value="__time">Time</option>
              {dataset.signals.map((s) => (
                <option key={s.column} value={`column:${s.column}`}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
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
          <label className="analysis-field min-w-0 max-w-[360px] flex-1">
            Y
            <select
              aria-label="Y axis"
              value={selected.length === 1 ? `column:${selected[0]}` : ""}
              onChange={(e) => {
                select([e.target.value.slice(7)]);
                setCoord("");
              }}
            >
              {selected.length !== 1 && (
                <option value="" disabled>
                  {selected.length
                    ? `${selected.length} columns selected`
                    : "Choose a column"}
                </option>
              )}
              {dataset.signals.map((s) => (
                <option key={s.column} value={`column:${s.column}`}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
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
        <Panel className="min-h-0 flex-1" bodyClassName="p-1">
          {selected.length === 0 ? (
            <EmptyState title="Select signals from the panel on the left to plot." />
          ) : (
            <StackedChart
              panels={panels}
              fitSources={fitSources}
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
