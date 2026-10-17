import { useMemo, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, Field, Panel, StatusText } from "@/components/common";
import { EChart } from "@/components/EChart";
import { ModelSelect } from "@/components/ModelSelect";
import { StackedChart, type ChartPanel } from "@/components/StackedChart";
import { api, errorText, type ValidationView } from "@/lib/api";
import { FONT, PALETTE, tooltipStyle, valueAxis, zip } from "@/lib/chart";
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
    () => (a ? [{ id: "r", yLabel: "Residual", hLines: [{ y: 0, color: "#a5a5a5", dashed: true }], series: [{ name: "Residual", color: "#274259", data: zip(a.residuals.x, a.residuals.y), width: 1 }] }] : []),
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
                { y: a.acf_confidence, color: "#ff2400", dashed: true, label: "95%" },
                { y: -a.acf_confidence, color: "#ff2400", dashed: true },
                { y: 0, color: "#000" },
              ],
              series: [{ name: "ACF", color: "#274259", type: "bar", data: a.acf_lags.slice(1).map((l, i) => [l, a.acf[i + 1]] as [number, number | null]) }],
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
              legend: true,
              hLines: [{ y: 0, color: "#a5a5a5", dashed: true }],
              series: a.xcorr.map((x, i) => ({ name: x.label, color: PALETTE[i % PALETTE.length], data: zip(x.lags, x.values), width: 1.4 })),
            },
          ]
        : [],
    [a],
  );
  const histOption = useMemo(() => {
    if (!a) return null;
    return {
      animation: false,
      textStyle: { fontFamily: FONT },
      grid: { left: 70, right: 24, top: 30, bottom: 40 },
      tooltip: { trigger: "axis", ...tooltipStyle },
      legend: { top: 4, right: 24, textStyle: { fontFamily: FONT, fontSize: 11 } },
      xAxis: valueAxis({ name: "Residual", nameLocation: "middle", nameGap: 26 }),
      yAxis: valueAxis({ name: "Density", nameLocation: "middle", nameGap: 52, scale: false }),
      series: [
        { type: "bar", name: "Residuals", data: a.hist_centers.map((c, i) => [c, a.hist_density[i]]), barWidth: "98%", itemStyle: { color: "#6b7b84", opacity: 0.8 }, barCategoryGap: 0 },
        { type: "line", name: `Normal (p=${a.shapiro_p.toFixed(4)})`, data: zip(a.normal.x, a.normal.y), showSymbol: false, lineStyle: { color: "#ff2400", width: 2 }, itemStyle: { color: "#ff2400" } },
      ],
    };
  }, [a]);
  const vafOption = useMemo(() => {
    if (!view) return null;
    const names = view.outputs.map((o) => o.label.slice(0, 15));
    return {
      animation: false,
      grid: { left: 60, right: 20, top: 24, bottom: 70 },
      tooltip: { trigger: "axis", ...tooltipStyle },
      xAxis: { type: "category", data: names, axisLabel: { rotate: 30, fontFamily: FONT, fontSize: 10.5, color: "#000" }, axisLine: { lineStyle: { color: "#000" } } },
      yAxis: valueAxis({ name: "VAF [%]", nameLocation: "middle", nameGap: 40, min: 0, max: 105, scale: false }),
      series: [
        {
          type: "bar",
          data: view.outputs.map((o) => Number(o.metrics.vaf.toFixed(2))),
          itemStyle: { color: "#ff2400" },
          barMaxWidth: 60,
          label: { show: true, position: "top", formatter: (p: { value: number }) => `${p.value.toFixed(1)}%`, fontSize: 10.5, fontFamily: FONT },
        },
      ],
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
              {histOption && <EChart option={histOption} />}
            </Panel>
          </TabsContent>
          <TabsContent value="acf" className="min-h-0">
            <Panel title="Residual autocorrelation (white residuals stay inside the bounds)" className="h-full" bodyClassName="p-1">
              <StackedChart panels={acfPanels} xLabel="Lag" showSlider={false} />
            </Panel>
          </TabsContent>
          <TabsContent value="xcorr" className="min-h-0">
            <Panel title="Input-residual cross-correlation (should be near zero)" className="h-full" bodyClassName="p-1">
              {xcorrPanels.length ? <StackedChart panels={xcorrPanels} xLabel="Lag" showSlider={false} /> : <EmptyState title="No inputs" />}
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
              {vafOption && <EChart option={vafOption} />}
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
