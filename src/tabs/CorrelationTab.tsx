import { useEffect, useMemo, useState } from "react";
import { EmptyState, Panel, Segmented, StatusText } from "@/components/common";
import { Plot } from "@/components/Plot";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type CorrelationView, type PairAnalysis } from "@/lib/api";
import { DIVERGING, INK, axis, baseLayout, esc, seriesColor, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

/** Which signals move together: a matrix to read at a glance, then one pair in detail. */
export function CorrelationTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const [result, setResult] = useState<CorrelationView | null>(null);
  const [method, setMethod] = useState<"pearson" | "spearman">("pearson");
  const [pair, setPair] = useState<PairAnalysis | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResult(null);
    setPair(null);
  }, [dataset?.path]);

  const compute = async () => {
    setBusy(true);
    try {
      const r = await api.correlationCompute();
      setResult(r);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Computed on the first visit and again after the data changed, never at import.
  const [computedFor, setComputedFor] = useState(-1);
  useEffect(() => {
    if (activeTab !== "correlation" || !dataset || busy || computedFor === dataVersion) return;
    setComputedFor(dataVersion);
    compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dataset, dataVersion]);

  const showPair = async (ca: string, cb: string) => {
    if (ca === cb) return;
    try {
      setPair(await api.correlationPair(ca, cb));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const heatmap = useMemo(() => {
    if (!result) return null;
    const m = method === "spearman" ? result.spearman : result.pearson;
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
        margin: { l: 8, r: 8, t: 16, b: 8 },
        xaxis: axis(undefined, { type: "category", showgrid: false, showline: false, ticks: "", tickangle: -60, tickfont: { size: 11, color: INK.secondary } }),
        yaxis: axis(undefined, { type: "category", showgrid: false, showline: false, ticks: "", autorange: "reversed", tickfont: { size: 11, color: INK.secondary } }),
      }),
    };
  }, [result, method]);

  const scatterPanels: ChartPanel[] = useMemo(
    () => (pair ? [{ id: "s", yLabel: pair.label_b, series: [{ name: "Samples", color: seriesColor(0), data: zip(pair.scatter.x, pair.scatter.y), type: "scatter" }] }] : []),
    [pair],
  );
  const lagPanels: ChartPanel[] = useMemo(
    () => (pair ? [{ id: "l", yLabel: "Correlation", hLines: [{ y: 0 }], series: [{ name: "Cross-correlation", color: seriesColor(0), data: zip(pair.lags, pair.corr) }] }] : []),
    [pair],
  );

  if (!dataset) return <EmptyState title="No data loaded" />;

  return (
    <div className="flex h-full min-h-0 gap-3">
      <Panel
        className="min-w-0 flex-[3]"
        bodyClassName="p-1"
        actions={
          <Segmented
            value={method}
            onChange={setMethod}
            options={[
              { value: "pearson", label: "Pearson", hint: "Linear relationships" },
              { value: "spearman", label: "Spearman", hint: "Any steadily rising or falling relationship" },
            ]}
          />
        }
      >
        {heatmap ? (
          <Plot
            zoom={false}
            data={heatmap.data}
            layout={heatmap.layout}
            uirevision={method}
            table={() => ({
              columns: ["Signal A", "Signal B", "r"],
              rows: result!.names.flatMap((na, i) => result!.names.map((nb, j) => [na, nb, (method === "spearman" ? result!.spearman : result!.pearson)[i][j]])),
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
          <EmptyState title={busy ? "Calculating…" : "No result"} />
        )}
      </Panel>
      <div className="flex min-w-0 flex-[2] flex-col gap-3">
        <Panel title={pair ? `${pair.label_a} vs ${pair.label_b}` : "Pair"} className="min-h-0 flex-1" bodyClassName="p-1">
          {pair ? <StackedChart panels={scatterPanels} xLabel={pair.label_a} /> : <EmptyState title="Click a cell or a pair" />}
        </Panel>
        <Panel title="Lag" className="min-h-0 flex-1" bodyClassName="p-1">
          {pair ? <StackedChart panels={lagPanels} xLabel="Lag [samples]" /> : null}
        </Panel>
        {error && <StatusText tone="error">{error}</StatusText>}
      </div>
    </div>
  );
}
