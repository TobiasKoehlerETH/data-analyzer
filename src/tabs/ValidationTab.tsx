import { useMemo, useState } from "react";
import { message } from "@/lib/platform";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, Field, Panel, StatusText } from "@/components/common";
import { Plot } from "@/components/Plot";
import { ModelSelect } from "@/components/ModelSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type ValidationView } from "@/lib/api";
import { INK, LINE_WIDTH, axis, baseLayout, esc, seriesColor, zip } from "@/lib/chart";
import { useApp } from "@/lib/store";

export function ValidationTab() {
  const { dataset } = useApp();
  const [model, setModel] = useState<string | null>(null);
  const [view, setView] = useState<ValidationView | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [tab, setTab] = useState("residuals");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!model) {
      await message("Select a model first.", { title: "No Model", kind: "warning" });
      return;
    }
    setBusy(true);
    try {
      const v = await api.validationRun(model);
      setView(v);
      setOutput(v.outputs[0]?.name ?? null);
      setStatus({ text: `Validation complete for '${model}'.` });
    } catch (e) {
      setStatus({ text: `Error: ${errorText(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const a = view?.outputs.find((o) => o.name === output) ?? null;

  const residualPanels: ChartPanel[] = useMemo(
    () => (a ? [{ id: "r", yLabel: "Residual", hLines: [{ y: 0 }], series: [{ name: "Residual", color: seriesColor(0), data: zip(a.residuals.x, a.residuals.y) }] }] : []),
    [a],
  );
  const acfPanels: ChartPanel[] = useMemo(
    () =>
      a
        ? [
            {
              id: "acf",
              yLabel: "ACF",
              hLines: [
                { y: a.acf_confidence, label: "95% bound" },
                { y: -a.acf_confidence },
                { y: 0 },
              ],
              series: [{ name: "ACF", color: seriesColor(0), type: "bar", data: a.acf_lags.slice(1).map((l, i) => [l, a.acf[i + 1]] as [number, number | null]) }],
            },
          ]
        : [],
    [a],
  );
  const xcorrPanels: ChartPanel[] = useMemo(
    () =>
      a && a.xcorr.length
        ? [
            {
              id: "x",
              yLabel: "Cross-corr",
              hLines: [{ y: 0 }],
              series: a.xcorr.map((x, i) => ({ name: x.label, color: seriesColor(i), data: zip(x.lags, x.values) })),
            },
          ]
        : [],
    [a],
  );
  const histogram = useMemo(() => {
    if (!a) return null;
    const binWidth = a.hist_centers.length > 1 ? a.hist_centers[1] - a.hist_centers[0] : 1;
    return {
      data: [
        {
          type: "bar",
          name: "Residuals",
          x: a.hist_centers,
          y: a.hist_density,
          width: binWidth,
          marker: { color: seriesColor(0), cornerradius: 4, line: { color: INK.surface, width: 1 } },
          hovertemplate: "<b>%{y:.4~g}</b>  density<br>residual %{x:.4~g}<extra></extra>",
        },
        {
          type: "scatter",
          mode: "lines",
          name: esc(`Normal fit (Shapiro–Wilk p = ${a.shapiro_p.toFixed(4)})`),
          x: a.normal.x,
          y: a.normal.y,
          line: { color: seriesColor(1), width: LINE_WIDTH },
          hovertemplate: "<b>%{y:.4~g}</b>  normal<extra></extra>",
        },
      ],
      layout: baseLayout({
        showlegend: true,
        bargap: 0,
        hovermode: "closest",
        xaxis: axis("Residual"),
        yaxis: axis("Density", { rangemode: "tozero" }),
      }),
    };
  }, [a]);
  const vaf = useMemo(() => {
    if (!view) return null;
    const names = view.outputs.map((o) => esc(o.label.length > 18 ? o.label.slice(0, 17) + "…" : o.label));
    const values = view.outputs.map((o) => o.metrics.vaf);
    return {
      data: [
        {
          type: "bar",
          name: "VAF",
          x: names,
          y: values,
          marker: { color: seriesColor(0), cornerradius: 4 },
          text: values.map((v) => `${v.toFixed(1)}%`),
          textposition: "outside",
          textfont: { color: INK.primary, size: 12 },
          cliponaxis: false,
          constraintext: "none",
          hovertemplate: "<b>%{y:.2f}%</b>  %{x}<extra></extra>",
        },
      ],
      layout: baseLayout({
        hovermode: "closest",
        xaxis: axis(undefined, { type: "category", showgrid: false, tickfont: { size: 11, color: INK.secondary } }),
        yaxis: axis("VAF [%]", { range: [0, 110] }),
      }),
    };
  }, [view]);

  if (!dataset) return <EmptyState title="No data loaded">Load the measurement file the model's signals come from.</EmptyState>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <Field label="Model" className="w-[420px]">
          <ModelSelect value={model} onChange={setModel} title="Select the model to validate against measured data" />
        </Field>
        <Field label="Output" className="w-72" hint="Output signal to show validation details for">
          <Select value={output ?? undefined} onValueChange={setOutput}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {view?.outputs.map((o) => (
                <SelectItem key={o.name} value={o.name}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button onClick={run} disabled={busy} title="Run simulation and compute residual metrics, ACF and histogram">
          <BadgeCheck /> Validate
        </Button>
        {a && (
          <span className="text-xs text-muted-foreground">
            Shapiro-Wilk W={a.shapiro_stat.toFixed(4)}, p={a.shapiro_p.toFixed(4)} · ACF 95% bound ±{a.acf_confidence.toFixed(4)}
          </span>
        )}
      </div>
      {view ? (
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
          <TabsList className="rounded-none">
            <TabsTrigger value="residuals">Residuals</TabsTrigger>
            <TabsTrigger value="histogram">Histogram</TabsTrigger>
            <TabsTrigger value="acf">ACF</TabsTrigger>
            <TabsTrigger value="xcorr">Input-Residual XCorr</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>
          <TabsContent value="residuals" className="min-h-0">
            <Panel title="Residuals over time (measured − simulated)" className="h-full" bodyClassName="p-1">
              <StackedChart panels={residualPanels} xLabel="Sample" resetKey={output ?? ""} />
            </Panel>
          </TabsContent>
          <TabsContent value="histogram" className="min-h-0">
            <Panel title="Residual distribution with fitted normal" className="h-full" bodyClassName="p-1">
              {histogram && <Plot data={histogram.data} layout={histogram.layout} uirevision={output ?? ""} />}
            </Panel>
          </TabsContent>
          <TabsContent value="acf" className="min-h-0">
            <Panel title="Residual autocorrelation (white residuals stay inside the bounds)" className="h-full" bodyClassName="p-1">
              <StackedChart panels={acfPanels} xLabel="Lag" />
            </Panel>
          </TabsContent>
          <TabsContent value="xcorr" className="min-h-0">
            <Panel title="Input-residual cross-correlation (should be near zero)" className="h-full" bodyClassName="p-1">
              {xcorrPanels.length ? <StackedChart panels={xcorrPanels} xLabel="Lag" /> : <EmptyState title="No inputs" />}
            </Panel>
          </TabsContent>
          <TabsContent value="metrics" className="flex min-h-0 flex-col gap-3">
            <Panel title="Metrics per output" bodyClassName="p-0 selectable">
              <Table className="text-[12.5px]">
                <TableHeader>
                  <TableRow>
                    {["Output", "RMSE", "NRMSE%", "MAE", "R²", "VAF%"].map((h) => (
                      <TableHead key={h} className="text-black">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.outputs.map((o) => (
                    <TableRow key={o.name}>
                      <TableCell className="py-1">{o.label}</TableCell>
                      <TableCell className="py-1 tabular-nums">{o.metrics.rmse.toFixed(6)}</TableCell>
                      <TableCell className="py-1 tabular-nums">{o.metrics.nrmse.toFixed(2)}</TableCell>
                      <TableCell className="py-1 tabular-nums">{o.metrics.mae.toFixed(6)}</TableCell>
                      <TableCell className="py-1 tabular-nums">{o.metrics.r_squared.toFixed(4)}</TableCell>
                      <TableCell className="py-1 tabular-nums text-ap-red">{o.metrics.vaf.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="Fit (VAF) per output" className="min-h-0 flex-1" bodyClassName="p-1">
              {vaf && <Plot data={vaf.data} layout={vaf.layout} uirevision={model ?? ""} />}
            </Panel>
          </TabsContent>
        </Tabs>
      ) : (
        <Panel className="min-h-0 flex-1">
          <EmptyState title="Select a model and click Validate">Residuals, histogram with Shapiro-Wilk test, ACF with 95% bounds, input-residual cross-correlation and RMSE / NRMSE / MAE / R² / VAF per output.</EmptyState>
        </Panel>
      )}
      <StatusText tone={status.error ? "error" : "muted"}>{status.text}</StatusText>
    </div>
  );
}
