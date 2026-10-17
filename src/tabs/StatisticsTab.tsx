import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import { EChart } from "@/components/EChart";
import { EmptyState, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import {
  analysisVectors,
  finitePairs,
  summarize,
  histogram,
  downloadText,
  matchingRows,
  type PlotSelection,
  type Vectors,
  type Point,
} from "@/lib/analysis";
import { tooltipStyle, valueAxis, fmtG } from "@/lib/chart";

type Selection = PlotSelection | null;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const fields = [
  "count",
  "missing",
  "mean",
  "std",
  "min",
  "q1",
  "median",
  "q3",
  "max",
  "iqr",
] as const;
const labels = [
  "n",
  "Missing",
  "Mean",
  "Std dev",
  "Min",
  "Q1",
  "Median",
  "Q3",
  "Max",
  "IQR",
];

export function StatisticsTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const loadedRequest = useRef("");
  const [xColumn, setXColumn] = useState("__row");
  const [yColumn, setYColumn] = useState("");
  const [data, setData] = useState<Vectors | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState("");
  const [bins, setBins] = useState(30);
  useEffect(() => {
    setXColumn("__row");
    setYColumn(dataset?.signals[0]?.column ?? "");
    setSelection(null);
    setData(null);
  }, [dataset?.path, dataset?.sheet]);
  useEffect(() => {
    if (!dataset || !yColumn || activeTab !== "statistics") return;
    const requestKey = JSON.stringify([dataset.path, dataset.sheet, dataVersion, yColumn, xColumn]);
    if (loadedRequest.current === requestKey && data) return;
    let cancelled = false;
    setError("");
    setData(null);
    setSelection(null);
    analysisVectors([
      ...new Set([yColumn, ...(xColumn === "__row" ? [] : [xColumn])]),
    ])
      .then((v) => {
        if (!cancelled) { loadedRequest.current = requestKey; setData(v); }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, dataset, yColumn, xColumn, activeTab]);
  const x = useMemo(
    () =>
      !data
        ? []
        : xColumn === "__row"
          ? data.time.map((_, i) => i + 1)
          : (data.columns[xColumn] ?? []),
    [data, xColumn],
  );
  const y = data?.columns[yColumn] ?? [];
  const xLabel =
    xColumn === "__row"
      ? "Row position"
      : (dataset?.signals.find((s) => s.column === xColumn)?.label ?? "X");
  const yLabel =
    dataset?.signals.find((s) => s.column === yColumn)?.label ?? "Y";
  const selectedRows = useMemo(() => {
    if (!selection) return null;
    return matchingRows(x, y, selection);
  }, [selection, x, y]);
  const selectedY = useMemo(
    () => (selectedRows ? [...selectedRows].map((i) => y[i]) : y),
    [y, selectedRows],
  );
  const selectedX = useMemo(
    () => (selectedRows ? [...selectedRows].map((i) => x[i]) : x),
    [x, selectedRows],
  );
  const summary = useMemo(() => {
    const rows = [{ name: yLabel, scope: "All", ...summarize(y) }];
    if (xColumn !== "__row" && xColumn !== yColumn)
      rows.push({ name: xLabel, scope: "All", ...summarize(x) });
    if (selectedRows) {
      rows.push({ name: yLabel, scope: "Selected", ...summarize(selectedY) });
      if (xColumn !== "__row" && xColumn !== yColumn)
        rows.push({ name: xLabel, scope: "Selected", ...summarize(selectedX) });
    }
    return rows;
  }, [
    y,
    x,
    selectedY,
    selectedX,
    xColumn,
    yColumn,
    xLabel,
    yLabel,
    selectedRows,
  ]);
  const pairs = useMemo(() => finitePairs(x, y), [x, y]);
  const rowPairs = useMemo(
    () =>
      finitePairs(
        y.map((_, i) => i + 1),
        y,
      ),
    [y],
  );
  const selectedPairs = useMemo(
    () => finitePairs(selectedX, selectedY),
    [selectedX, selectedY],
  );
  const selectionRows = useMemo(
    () =>
      selectedRows
        ? [...selectedRows].flatMap((i) =>
            finite(y[i]) ? [[i + 1, y[i]] as Point] : [],
          )
        : [],
    [selectedRows, y],
  );
  const sources = useMemo(
    () => [
      {
        name: yLabel,
        points: pairs,
        xLabel,
        seriesIndex: 0,
        scope: "Full vector (finite XY pairs)",
      },
      ...(selectedRows && selectedPairs.length >= 3
        ? [
            {
              name: `${yLabel} · selected`,
              points: selectedPairs,
              xLabel,
              seriesIndex: 0,
              scope: "Full selected rows",
            },
          ]
        : []),
    ],
    [pairs, selectedPairs, selectedRows, xLabel, yLabel],
  );
  const rowSources = useMemo(
    () => [
      {
        name: yLabel,
        points: rowPairs,
        xLabel: "Row position",
        seriesIndex: 0,
        scope: "Full vector (finite XY pairs)",
      },
      ...(selectedRows && selectionRows.length >= 3
        ? [
            {
              name: `${yLabel} · selected`,
              points: selectionRows,
              xLabel: "Row position",
              seriesIndex: 0,
              scope: "Full selected rows",
            },
          ]
        : []),
    ],
    [rowPairs, selectedRows, selectionRows, yLabel],
  );
  const charts = useMemo(() => {
    const common = {
      animation: false,
      tooltip: { ...tooltipStyle, trigger: "item" },
      grid: { left: 62, right: 22, top: 35, bottom: 42 },
      xAxis: valueAxis({ scale: true }),
      yAxis: valueAxis({ scale: true }),
      brush: {
        toolbox: ["rect", "lineX", "clear"],
        xAxisIndex: "all",
        brushMode: "single",
        throttleType: "debounce",
        throttleDelay: 150,
      },
      toolbox: { right: 70, top: 0 },
    };
    const step = Math.max(1, Math.ceil(y.length / 8000));
    const scatter: any[] = [];
    const rows: any[] = [];
    for (let i = 0; i < y.length; i += step) {
      const color = selectedRows
        ? selectedRows.has(i)
          ? "#ff2400"
          : "#d1d1d1"
        : "#274259";
      if (finite(y[i])) {
        rows.push({ value: [i + 1, y[i]], itemStyle: { color } });
        if (finite(x[i]))
          scatter.push({ value: [x[i], y[i]], itemStyle: { color } });
      }
    }
    const allBins = histogram(y, bins);
    const yStats = summarize(y);
    const selectedBins =
      selectedRows && yStats.min !== null
        ? histogram(selectedY, bins, [yStats.min, yStats.max!])
        : [];
    const boxRows = [
      { name: "All", stats: yStats },
      ...(selectedRows
        ? [{ name: "Selected", stats: summarize(selectedY) }]
        : []),
    ].filter((r) => r.stats.count > 0);
    return {
      scatter: {
        ...common,
        xAxis: valueAxis({
          name: xLabel,
          nameLocation: "middle",
          nameGap: 26,
          scale: true,
        }),
        yAxis: valueAxis({ scale: true }),
        series: [
          { type: "scatter", name: yLabel, symbolSize: 4, data: scatter },
        ],
      },
      row: {
        ...common,
        xAxis: valueAxis({
          name: "Row position",
          nameLocation: "middle",
          nameGap: 26,
        }),
        series: [{ type: "scatter", name: yLabel, symbolSize: 3, data: rows }],
      },
      histogram: {
        ...common,
        brush: { ...common.brush, toolbox: ["lineX", "clear"] },
        xAxis: valueAxis({
          name: yLabel,
          nameLocation: "middle",
          nameGap: 26,
          scale: true,
        }),
        yAxis: valueAxis({ name: "Count" }),
        series: [
          {
            name: "All",
            type: "bar",
            data: allBins,
            itemStyle: { color: "#a6b0b5" },
            barGap: "-100%",
          },
          ...(selectedRows
            ? [
                {
                  name: "Selected",
                  type: "bar",
                  data: selectedBins,
                  itemStyle: { color: "#ff2400" },
                },
              ]
            : []),
        ],
      },
      box: {
        animation: false,
        tooltip: { ...tooltipStyle, trigger: "item" },
        grid: { left: 62, right: 22, top: 20, bottom: 35 },
        xAxis: { type: "category", data: boxRows.map((r) => r.name) },
        yAxis: valueAxis({ scale: true }),
        series: [
          {
            name: yLabel,
            type: "boxplot",
            data: boxRows.map(({ stats: s }) => [
              s.min,
              s.q1,
              s.median,
              s.q3,
              s.max,
            ]),
            itemStyle: { color: "#ebedee", borderColor: "#274259" },
          },
        ],
      },
    };
  }, [x, y, xLabel, yLabel, bins, selectedRows, selectedY]);
  const brush = (kind: NonNullable<Selection>["kind"]) => (event: any) => {
    const area = event.areas?.[0];
    if (!area) {
      setSelection(null);
      return;
    }
    const range = area.coordRange;
    if (!Array.isArray(range)) return;
    const sorted = (v: number[]): [number, number] => [
      Math.min(...v),
      Math.max(...v),
    ];
    if (area.brushType === "rect")
      setSelection({
        kind,
        x: sorted(range[0]),
        ...(kind === "scatter" ? { y: sorted(range[1]) } : {}),
      });
    else if (area.brushType === "lineX")
      setSelection({ kind, x: sorted(range) });
  };
  if (!dataset)
    return (
      <EmptyState title="No data loaded">
        Open a data file to explore it.
      </EmptyState>
    );
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto">
      <div className="flex shrink-0 items-end gap-3">
        <label className="analysis-field w-[240px]">
          X
          <select value={xColumn} onChange={(e) => setXColumn(e.target.value)}>
            <option value="__row">Row position</option>
            {dataset.signals.map((s) => (
              <option key={s.column} value={s.column}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="analysis-field w-[240px]">
          Y
          <select value={yColumn} onChange={(e) => setYColumn(e.target.value)}>
            {dataset.signals.map((s) => (
              <option key={s.column} value={s.column}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!selection}
          onClick={() => setSelection(null)}
          title="Clear the linked selection"
        >
          <RotateCcw className="size-3.5" />
          Reset
        </Button>
        <span className="pb-2 text-xs text-muted-foreground">
          {selectedRows
            ? `${selectedRows.size.toLocaleString()} selected`
            : `${y.length.toLocaleString()} rows`}
        </span>
        <span
          className="ml-auto pb-2 text-xs text-muted-foreground"
          title="Brush any plot to select matching rows in every view. Statistics use full data; scatter previews show up to 8,000 points."
        >
          Drag to select
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : !data ? (
        <EmptyState title="Loading…" />
      ) : (
        <>
          <div className="grid min-h-[420px] flex-1 grid-cols-2 grid-rows-2 gap-3">
            <Panel title="Scatter" bodyClassName="p-1">
              <EChart
                option={charts.scatter}
                fitSources={sources}
                onEvents={{ brushEnd: brush("scatter") }}
                brushType="rect"
              />
            </Panel>
            <Panel title="By row" bodyClassName="p-1">
              <EChart
                option={charts.row}
                fitSources={rowSources}
                onEvents={{ brushEnd: brush("row") }}
                brushType="lineX"
              />
            </Panel>
            <Panel
              title="Distribution"
              actions={
                <label className="flex items-center gap-1 text-xs">
                  Bins
                  <input
                    aria-label="Histogram bins"
                    className="analysis-input w-14"
                    type="number"
                    min={5}
                    max={100}
                    value={bins}
                    onChange={(e) =>
                      setBins(
                        Math.max(5, Math.min(100, Number(e.target.value) || 5)),
                      )
                    }
                  />
                </label>
              }
              bodyClassName="p-1"
            >
              <EChart
                option={charts.histogram}
                onEvents={{ brushEnd: brush("histogram") }}
                brushType="lineX"
              />
            </Panel>
            <Panel
              title="Quartiles"
              actions={
                <span className="text-[11px] text-muted-foreground">
                  Whiskers: min–max
                </span>
              }
              bodyClassName="p-1"
            >
              <EChart option={charts.box} fitting={false} />
            </Panel>
          </div>
          <Panel
            title="Summary"
            className="max-h-[210px] shrink-0"
            actions={
              <Button
                size="sm"
                variant="ghost"
                title="Export summary CSV"
                onClick={() =>
                  downloadText(
                    "statistics.csv",
                    [
                      ["Signal", "Scope", ...labels],
                      ...summary.map((r) => [
                        r.name,
                        r.scope,
                        ...fields.map((f) => r[f] ?? ""),
                      ]),
                    ]
                      .map((row) =>
                        row
                          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
                          .join(","),
                      )
                      .join("\r\n"),
                    "text/csv",
                  )
                }
              >
                <Download className="size-3.5" />
              </Button>
            }
            bodyClassName="overflow-auto p-0"
          >
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="p-2 text-left">Signal</th>
                  <th className="p-2 text-left">Scope</th>
                  {labels.map((l) => (
                    <th key={l} className="px-2">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-t ${r.scope === "Selected" ? "text-ap-red" : ""}`}
                  >
                    <td
                      className="max-w-[200px] truncate p-2 text-left"
                      title={r.name}
                    >
                      {r.name}
                    </td>
                    <td className="p-2 text-left">{r.scope}</td>
                    {fields.map((f) => (
                      <td key={f} className="px-2 tabular-nums">
                        {r[f] === null ? "—" : fmtG(r[f]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
