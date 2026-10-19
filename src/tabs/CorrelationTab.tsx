import { useEffect, useMemo, useState } from "react";
import { Calculator, Clock, ScatterChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, Panel, StatusText } from "@/components/common";
import { Plot } from "@/components/Plot";
import { SignalSelect } from "@/components/SignalSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type CorrelationView, type PairAnalysis, type PairDto } from "@/lib/api";
import { DIVERGING, INK, axis, baseLayout, esc, seriesColor, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function CorrelationTab() {
  const { dataset, dataVersion } = useApp();
  const [result, setResult] = useState<CorrelationView | null>(null);
  const [method, setMethod] = useState<"Pearson" | "Spearman">("Pearson");
  const [pairs, setPairs] = useState<PairDto[]>([]);
  const [selectedPair, setSelectedPair] = useState<number | null>(null);
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [pair, setPair] = useState<PairAnalysis | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResult(null);
    setPairs([]);
    setPair(null);
    setSelectedPair(null);
    setA(dataset?.signals[0]?.column ?? null);
    setB(dataset?.signals[1]?.column ?? null);
  }, [dataset?.path]);

  useEffect(() => {
    // Filtering invalidates the correlation matrix.
    if (result) setStatus({ text: "Data changed — recompute correlations to update." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const compute = async () => {
    setBusy(true);
    try {
      const r = await api.correlationCompute();
      setResult(r);
      setPairs(r.top_pairs);
      setStatus({ text: `Correlation matrix for ${r.columns.length} signals. Click a cell or pair to analyse it.` });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const showPair = async (ca: string, cb: string) => {
    if (ca === cb) return;
    try {
      setPair(await api.correlationPair(ca, cb));
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
  };

  const heatmap = useMemo(() => {
    if (!result) return null;
    const m = method === "Spearman" ? result.spearman : result.pearson;
    const names = result.names.map((n) => esc(n.length > 22 ? n.slice(0, 21) + "…" : n));
    const full = result.names.map(esc);
    const showValues = names.length <= 12;
    return {
      data: [
        {
          type: "heatmap",
          z: m,
          x: names,
          y: names,
          customdata: m.map((row, i) => row.map((_, j) => [full[i], full[j]])),
          zmin: -1,
          zmax: 1,
          colorscale: DIVERGING,
          xgap: 2,
          ygap: 2,
          hoverongaps: false,
          texttemplate: showValues ? "%{z:.2f}" : "",
          textfont: { size: 11 },
          colorbar: { thickness: 10, len: 0.8, outlinewidth: 0, tickfont: { size: 11, color: INK.muted }, tickvals: [-1, -0.5, 0, 0.5, 1], title: { text: "r", font: { size: 12, color: INK.secondary } } },
          hovertemplate: "<b>r = %{z:.3f}</b><br>%{customdata[0]} ↔ %{customdata[1]}<extra></extra>",
        },
      ],
      layout: baseLayout({
        hovermode: "closest",
        dragmode: false,
        margin: { l: 8, r: 8, t: 32, b: 8 },
        xaxis: axis(undefined, { type: "category", showgrid: false, showline: false, ticks: "", tickangle: -60, tickfont: { size: 11, color: INK.secondary } }),
        yaxis: axis(undefined, { type: "category", showgrid: false, showline: false, ticks: "", autorange: "reversed", tickfont: { size: 11, color: INK.secondary } }),
      }),
    };
  }, [result, method]);

  const scatterPanels: ChartPanel[] = useMemo(
    () =>
      pair
        ? [{ id: "s", yLabel: pair.label_b, series: [{ name: "Samples", color: seriesColor(0), data: zip(pair.scatter.x, pair.scatter.y), type: "scatter" }] }]
        : [],
    [pair],
  );
  const lagPanels: ChartPanel[] = useMemo(
    () =>
      pair
        ? [{ id: "l", yLabel: "Correlation", hLines: [{ y: 0 }], series: [{ name: "Cross-correlation", color: seriesColor(0), data: zip(pair.lags, pair.corr) }] }]
        : [],
    [pair],
  );

  if (!dataset) return <EmptyState title="No data loaded">Load a file in the File tab to analyse correlations.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button onClick={compute} disabled={busy} title="Compute the full correlation matrix for all numeric signals">
          <Calculator /> Compute Correlations
        </Button>
        <Field label="Method" className="w-56" hint="Pearson measures linear correlation; Spearman measures monotonic relationships">
          <Select value={method} onValueChange={(v) => setMethod(v as "Pearson" | "Spearman")}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Pearson">Pearson</SelectItem>
              <SelectItem value="Spearman">Spearman</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <StatusText tone={status.error ? "error" : "muted"}>{status.text}</StatusText>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <Panel title={`${method} correlation matrix`} className="min-w-0 flex-[2]" bodyClassName="p-1">
          {heatmap ? (
            <Plot
              data={heatmap.data}
              layout={heatmap.layout}
              uirevision={method}
              table={() => ({
                columns: ["Signal A", "Signal B", "r"],
                rows: result!.names.flatMap((na, i) => result!.names.map((nb, j) => [na, nb, (method === "Spearman" ? result!.spearman : result!.pearson)[i][j]])),
              })}
              events={{
                click: (e: { points?: { pointNumber: [number, number] }[] }) => {
                  const pn = e.points?.[0]?.pointNumber;
                  if (!result || !pn) return;
                  const [i, j] = pn;
                  if (i !== j) showPair(result.columns[i], result.columns[j]);
                },
              }}
            />
          ) : (
            <EmptyState title="Click 'Compute Correlations'">The matrix is pre-computed in the background when a file is loaded, so this is instant.</EmptyState>
          )}
        </Panel>
        <div className="flex w-[320px] shrink-0 flex-col gap-3">
          <Panel title="Top correlated pairs · |r|" className="min-h-0 flex-1" bodyClassName="p-0 overflow-auto">
            <ul>
              {pairs.map((p, i) => (
                <li
                  key={i}
                  onClick={() => {
                    setSelectedPair(i);
                    showPair(p.signal_a, p.signal_b);
                  }}
                  className={cn("cursor-pointer border-b border-ap-line px-2.5 py-1.5 text-[12px] hover:bg-ap-bluegray-15", selectedPair === i && "bg-ap-bluegray-15")}
                  title="Click to view scatter plot and cross-correlation"
                >
                  <span className="mr-1.5 inline-block w-11 font-medium tabular-nums">{Math.abs(p.pearson_r).toFixed(3)}</span>
                  {p.name_a} ↔ {p.name_b}
                  {p.lag_seconds !== 0 && <span className="text-muted-foreground">, lag={p.lag_seconds.toFixed(1)}s</span>}
                </li>
              ))}
              {pairs.length === 0 && <li className="p-3 text-xs text-muted-foreground">Compute correlations to rank the top 20 pairs.</li>}
            </ul>
          </Panel>
          <Panel title="Custom pair" bodyClassName="flex flex-col gap-2">
            <Field label="Signal A">
              <SignalSelect signals={dataset.signals} value={a} onChange={setA} />
            </Field>
            <Field label="Signal B">
              <SignalSelect signals={dataset.signals} value={b} onChange={setB} />
            </Field>
            <Button size="sm" variant="outline" disabled={!a || !b || a === b} onClick={() => a && b && showPair(a, b)}>
              <ScatterChart /> Analyse Pair
            </Button>
          </Panel>
          <Button
            variant="outline"
            disabled={!result}
            title="Compute the optimal lag (±300 s) for each top pair using cross-correlation"
            onClick={async () => {
              setBusy(true);
              try {
                setPairs(await api.correlationLags());
                setStatus({ text: "Lag analysis complete." });
              } catch (e) {
                setStatus({ text: errorText(e), error: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Clock /> Compute Lag Analysis
          </Button>
        </div>
        <div className="flex min-w-0 flex-[2] flex-col gap-3">
          <Panel title={pair ? `Scatter · r = ${pair.pearson_r.toFixed(3)}` : "Scatter plot"} className="min-h-0 flex-1" bodyClassName="p-1">
            {pair ? <StackedChart panels={scatterPanels} xLabel={pair.label_a} /> : <EmptyState title="Select a pair" />}
          </Panel>
          <Panel title="Cross-correlation (lag)" className="min-h-0 flex-1" bodyClassName="p-1">
            {pair && <StackedChart panels={lagPanels} xLabel="Lag [samples]" />}
          </Panel>
        </div>
      </div>
    </div>
  );
}
