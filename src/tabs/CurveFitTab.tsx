import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, Download, Play, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, NumberInput, Panel } from "@/components/common";
import { Plot } from "@/components/Plot";
import { analysisVectors, curveFit, downloadText, finitePairs, FIT_MODELS, type FitRequest, type FitResult, type Parameter, type Point } from "@/lib/analysis";
import { INK, axis, baseLayout, esc, fmtG, markerStyle, seriesColor, wash } from "@/lib/chart";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

interface SavedFit {
  name: string;
  result: FitResult;
  request: FitRequest;
  x: string;
  y: string;
  model: number;
  range: [string, string];
  excluded: number[];
}

const ROW = "__row";
const TIME = "__time";
const CUSTOM = FIT_MODELS.length - 1;

const initialParameters = (starts: number[]): Parameter[] =>
  starts.map((start, i) => ({ name: String.fromCharCode(97 + i), start, lower: null, upper: null, fixed: false }));

function Check({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; title?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px]" title={title}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} />
      {label}
    </label>
  );
}

export function CurveFitTab() {
  const { dataset, dataVersion, activeTab } = useApp();
  const [xCol, setXCol] = useState(TIME);
  const [yCol, setYCol] = useState("");
  const [points, setPoints] = useState<Point[]>([]);
  const [model, setModel] = useState(0);
  const [expression, setExpression] = useState(FIT_MODELS[0].equation);
  const [parameters, setParameters] = useState(initialParameters(FIT_MODELS[0].starts));
  const [normalize, setNormalize] = useState(false);
  const [robust, setRobust] = useState(false);
  const [range, setRange] = useState<[string, string]>(["", ""]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [bands, setBands] = useState(true);
  const [residuals, setResiduals] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Coefficient bounds, X range and scaling stay out of the way until asked for. */
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [fits, setFits] = useState<SavedFit[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const revision = useRef(0);
  const current = active === null ? null : fits[active];

  const label = (c: string) => (c === ROW ? "Row" : c === TIME ? "Time" : (dataset?.signals.find((s) => s.column === c)?.label ?? c));

  useEffect(() => {
    if (!dataset) return;
    if (!dataset.signals.some((s) => s.column === yCol)) setYCol(dataset.signals[0]?.column ?? "");
    if (xCol !== ROW && xCol !== TIME && !dataset.signals.some((s) => s.column === xCol)) setXCol(TIME);
  }, [dataset, xCol, yCol]);

  // Load the X/Y vectors.
  useEffect(() => {
    if (!dataset || !yCol || activeTab !== "curvefit") return;
    let cancelled = false;
    const cols = [...new Set([yCol, ...(xCol === ROW || xCol === TIME ? [] : [xCol])])];
    analysisVectors(cols, 200_000)
      .then((v) => {
        if (cancelled) return;
        const y = v.columns[yCol] ?? [];
        const x = xCol === ROW ? y.map((_, i) => i * v.step + 1) : xCol === TIME ? v.time : (v.columns[xCol] ?? []);
        setPoints(finitePairs(x, y));
        setExcluded(new Set());
        setActive(null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [dataset, dataVersion, xCol, yCol, activeTab]);

  const included = useMemo(
    () =>
      points.filter(
        (p, i) => !excluded.has(i) && (range[0] === "" || p[0] >= Number(range[0])) && (range[1] === "" || p[0] <= Number(range[1])),
      ),
    [points, excluded, range],
  );

  const invalidate = () => {
    revision.current++;
    setActive(null);
    setError("");
  };

  const chooseModel = (index: number) => {
    invalidate();
    setModel(index);
    setExpression(FIT_MODELS[index].equation);
    setParameters(suggestParameters(index, included, normalize));
  };

  const run = async () => {
    const token = ++revision.current;
    setBusy(true);
    setError("");
    try {
      if (range.some((v) => v !== "" && !Number.isFinite(Number(v))) || (range.every((v) => v !== "") && Number(range[0]) > Number(range[1])))
        throw new Error("Check the X range.");
      const request = { points: included, expression, parameters, normalize, robust };
      const result = await curveFit(request);
      if (revision.current !== token) return;
      setFits([...fits, { name: `${FIT_MODELS[model].name} · ${label(yCol)}`, result, request, x: xCol, y: yCol, model, range, excluded: [...excluded] }]);
      setActive(fits.length);
    } catch (e) {
      if (revision.current === token) setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const step = Math.max(1, Math.ceil(points.length / 10000));
  const preview = useMemo(() => {
    const plotted = points.filter((_, i) => i % step === 0);
    const split = residuals && current;
    const data = seriesColor(0);
    const fit = seriesColor(1);
    const colors = plotted.map((p, k) => {
      const i = k * step;
      const out = excluded.has(i) || (range[0] !== "" && p[0] < Number(range[0])) || (range[1] !== "" && p[0] > Number(range[1]));
      return out ? INK.faded : data;
    });
    const xName = esc(label(xCol));
    const yName = esc(label(yCol));
    const traces: any[] = [
      {
        type: "scattergl",
        mode: "markers",
        name: yName,
        x: plotted.map((p) => p[0]),
        y: plotted.map((p) => p[1]),
        marker: markerStyle(plotted.length, colors),
        hovertemplate: `<b>%{y:.6~g}</b>  ${yName}<br><span style="color:${INK.muted}">${xName} %{x:.6~g} · click to exclude</span><extra></extra>`,
      },
    ];
    if (current && bands) {
      const [lo, hi] = [current.result.lower, current.result.upper];
      traces.push(
        { type: "scattergl", mode: "lines", name: "95% band", x: lo.map((p) => p[0]), y: lo.map((p) => p[1]), line: { width: 0, color: fit }, hoverinfo: "skip", showlegend: false },
        { type: "scattergl", mode: "lines", name: "95% band", x: hi.map((p) => p[0]), y: hi.map((p) => p[1]), line: { width: 0, color: fit }, fill: "tonexty", fillcolor: wash(fit, 0.16), hoverinfo: "skip" },
      );
    }
    if (current) {
      traces.push({
        type: "scattergl",
        mode: "lines",
        name: "Fit",
        x: current.result.curve.map((p) => p[0]),
        y: current.result.curve.map((p) => p[1]),
        line: { color: fit, width: 3 },
        hovertemplate: `<b>%{y:.6~g}</b>  fit<extra></extra>`,
      });
    }
    if (split) {
      const res = current.result.residuals.filter((_, i) => i % step === 0);
      traces.push({
        type: "scattergl",
        mode: "markers",
        name: "Residual",
        xaxis: "x2",
        yaxis: "y2",
        x: res.map((p) => p[0]),
        y: res.map((p) => p[1]),
        showlegend: false,
        marker: markerStyle(res.length, data),
        hovertemplate: `<b>%{y:.4~g}</b>  residual<extra></extra>`,
      });
    }
    return {
      data: traces,
      layout: baseLayout({
        hovermode: "closest",
        showlegend: !!current,
        margin: { l: 64, r: 12, t: 28, b: 44 },
        xaxis: axis(split ? undefined : label(xCol), { anchor: "y", showticklabels: !split }),
        yaxis: axis(label(yCol), { domain: split ? [0.34, 1] : [0, 1] }),
        ...(split
          ? {
              xaxis2: axis(label(xCol), { anchor: "y2", matches: "x" }),
              yaxis2: axis("Residual", { domain: [0, 0.24], zeroline: true, zerolinecolor: INK.axis, zerolinewidth: 1 }),
            }
          : {}),
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, current, bands, residuals, excluded, range, xCol, yCol, step]);

  if (!dataset) return <EmptyState title="No data loaded" />;

  const columns = [
    { value: ROW, label: "Row" },
    { value: TIME, label: "Time" },
    ...dataset.signals.map((s) => ({ value: s.column, label: s.label })),
  ];
  const pick = (value: string, onChange: (v: string) => void, all: boolean) => (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        invalidate();
        setRange(["", ""]);
        onChange(v);
      }}
    >
      <SelectTrigger className="h-8 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {(all ? columns : columns.slice(2)).map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex h-full gap-4">
      <div className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto">
        <Panel bodyClassName="flex flex-col gap-2.5">
          <div className="grid grid-cols-[18px_1fr] items-center gap-x-2 gap-y-2 text-[12.5px]">
            <span className="text-muted-foreground">X</span>
            {pick(xCol, setXCol, true)}
            <span className="text-muted-foreground">Y</span>
            {pick(yCol, setYCol, false)}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={xCol === ROW || xCol === TIME}
            onClick={() => {
              invalidate();
              setXCol(yCol);
              setYCol(xCol);
            }}
          >
            <ArrowLeftRight /> Swap
          </Button>
          <Select value={String(model)} onValueChange={(v) => chooseModel(Number(v))}>
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIT_MODELS.map((m, i) => (
                <SelectItem key={m.name} value={String(i)}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model === CUSTOM ? (
            <Input
              aria-label="Custom equation"
              title="Use x and the named coefficients. Functions: exp, ln, sqrt, sin, cos. Powers: ^."
              value={expression}
              onChange={(e) => {
                invalidate();
                setExpression(e.target.value);
              }}
              placeholder="a*exp(-x/b)+c"
            />
          ) : (
            <code className="rounded-md bg-ap-bluegray-15 px-2.5 py-1.5 text-[12.5px] break-all">y = {expression}</code>
          )}
          <Button onClick={run} disabled={busy || included.length < 3}>
            <Play /> {busy ? "Fitting…" : "Fit"}
          </Button>
          <button
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
            className="flex items-center gap-1 self-start text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !advanced && "-rotate-90")} /> Advanced
          </button>
        </Panel>

        {advanced && <Panel title="Advanced" bodyClassName="flex flex-col gap-2.5">
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <Input
                key={i}
                type="number"
                className="h-8"
                value={range[i]}
                placeholder={i ? "X max" : "X min"}
                onChange={(e) => {
                  invalidate();
                  setRange((v) => (i === 0 ? [e.target.value, v[1]] : [v[0], e.target.value]));
                }}
              />
            ))}
          </div>
          <Check
            checked={normalize}
            onChange={(v) => {
              invalidate();
              setNormalize(v);
            }}
            label="Center and scale X"
          />
          <Check
            checked={robust}
            onChange={(v) => {
              invalidate();
              setRobust(v);
            }}
            label="Robust fit"
            title="Huber loss reduces the influence of outliers"
          />
          {excluded.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                invalidate();
                setExcluded(new Set());
              }}
            >
              <RotateCcw /> Include {excluded.size} excluded
            </Button>
          )}
          <div className="mt-1 flex flex-col gap-2 border-t border-ap-line pt-2">
            {parameters.map((p, i) => (
              <div key={i} className="grid grid-cols-[28px_1fr_auto] items-center gap-1.5">
                {model === CUSTOM ? (
                  <Input
                    aria-label={`Coefficient ${i + 1} name`}
                    className="h-8 px-1 text-center"
                    value={p.name}
                    onChange={(e) => {
                      invalidate();
                      setParameters(parameters.map((q, j) => (i === j ? { ...q, name: e.target.value } : q)));
                    }}
                  />
                ) : (
                  <span className="text-center text-[12.5px]">{p.name}</span>
                )}
                <NumberInput
                  title={`${p.name}: start value`}
                  value={p.start}
                  onChange={(value) => {
                    invalidate();
                    setParameters(parameters.map((q, j) => (i === j ? { ...q, start: value } : q)));
                  }}
                />
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Keep fixed">
                  <Checkbox
                    checked={p.fixed}
                    onCheckedChange={(v) => {
                      invalidate();
                      setParameters(parameters.map((q, j) => (i === j ? { ...q, fixed: !!v } : q)));
                    }}
                  />
                  fix
                </label>
                <div className="col-span-3 grid grid-cols-2 gap-1.5 pl-[34px]">
                  {(["lower", "upper"] as const).map((key) => (
                    <Input
                      key={key}
                      aria-label={`${p.name} ${key}`}
                      className="h-7 text-[12px]"
                      type="number"
                      placeholder={key === "lower" ? "min" : "max"}
                      value={p[key] ?? ""}
                      onChange={(e) => {
                        invalidate();
                        setParameters(parameters.map((q, j) => (i === j ? { ...q, [key]: e.target.value === "" ? null : Number(e.target.value) } : q)));
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {model === CUSTOM && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={parameters.length >= 8}
                  onClick={() => {
                    invalidate();
                    setParameters([...parameters, { name: String.fromCharCode(97 + parameters.length), start: 1, lower: null, upper: null, fixed: false }]);
                  }}
                >
                  <Plus /> Coefficient
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={parameters.length <= 1}
                  onClick={() => {
                    invalidate();
                    setParameters(parameters.slice(0, -1));
                  }}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        </Panel>}

        {fits.length > 0 && (
          <Panel title="Fits" bodyClassName="p-1">
            {fits.map((fit, i) => (
              <button
                key={i}
                className={cn("flex w-full justify-between gap-2 px-2 py-1.5 text-left text-[12.5px] hover:bg-[#f7f8f8]", active === i && "bg-ap-bluegray-15 text-ap-red")}
                onClick={() => {
                  revision.current++;
                  setXCol(fit.x);
                  setYCol(fit.y);
                  setModel(fit.model);
                  setExpression(fit.request.expression);
                  setParameters(fit.request.parameters);
                  setNormalize(fit.request.normalize);
                  setRobust(fit.request.robust);
                  setRange(fit.range);
                  setExcluded(new Set(fit.excluded));
                  setError("");
                  setActive(i);
                }}
              >
                <span className="truncate">{fit.name}</span>
                <span className="text-muted-foreground tabular-nums" title="RMSE">
                  {fmtG(fit.result.rmse)}
                </span>
              </button>
            ))}
          </Panel>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Panel
          className="min-h-0 flex-1"
          bodyClassName="p-1"
          actions={
            <>
              <Check checked={bands} onChange={setBands} label="95% bands" />
              <span className="w-3" />
              <Check checked={residuals} onChange={setResiduals} label="Residuals" />
            </>
          }
          title="Click a point to leave it out"
        >
          <Plot
            data={preview.data}
            layout={preview.layout}
            uirevision={`${xCol}|${yCol}|${dataVersion}`}
            events={{
              click: (e: { points?: { curveNumber: number; pointNumber: number }[] }) => {
                const p = e.points?.[0];
                if (!p || p.curveNumber !== 0) return;
                invalidate();
                const i = p.pointNumber * step;
                setExcluded((v) => {
                  const next = new Set(v);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                });
              },
            }}
          />
        </Panel>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {current && (
          <Panel
            bodyClassName="flex flex-col gap-2 text-[12.5px]"
            title={current.name}
            actions={
              <Button size="sm" variant="ghost" title="Export equation, data, settings and results (JSON)" onClick={() => downloadText("curve-fit.json", JSON.stringify(current, null, 2))}>
                <Download />
              </Button>
            }
          >
            {current.result.warning && <p className="text-amber-800">{current.result.warning}</p>}
            <div className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums">
              <span>
                R² <b>{fmtG(current.result.r_squared ?? NaN)}</b>
              </span>
              <span>
                adj. R² <b>{fmtG(current.result.adjusted_r_squared ?? NaN)}</b>
              </span>
              <span>
                RMSE <b>{fmtG(current.result.rmse)}</b>
              </span>
              <span>
                n <b>{current.result.count.toLocaleString("en-US")}</b>
              </span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums" title="± approx. 95% confidence interval">
              {current.request.parameters.map((p, i) => (
                <span key={i}>
                  {p.name} = <b>{fmtG(current.result.coefficients[i])}</b>
                  {current.result.standard_errors[i] != null && ` ± ${fmtG(1.96 * current.result.standard_errors[i]!)}`}
                  {p.fixed && " (fixed)"}
                </span>
              ))}
            </div>
            {current.request.normalize && (
              <p className="text-muted-foreground">
                x′ = (x − {fmtG(current.result.x_center)}) / {fmtG(current.result.x_scale)}
              </p>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

function suggestParameters(model: number, points: [number, number][], normalize: boolean): Parameter[] {
  if (!points.length) return initialParameters(FIT_MODELS[model].starts);
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity,
    peak = 0;
  for (const [x, y] of points) {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    if (y > ymax) {
      ymax = y;
      peak = x;
    }
  }
  const span = normalize ? 2 : Math.max(xmax - xmin, 1e-6);
  const center = normalize ? 0 : (xmin + xmax) / 2;
  if (normalize) peak = (peak - (xmin + xmax) / 2) / Math.max((xmax - xmin) / 2, 1e-6);
  const amplitude = Math.max(ymax - ymin, 1e-6);
  const starts: Record<number, number[]> = {
    3: [amplitude, -1 / span, ymin],
    4: [amplitude, span / 3, ymin],
    5: [amplitude / span, 1, ymin],
    6: [1, ymin],
    7: [amplitude, peak, span / 5, ymin],
    8: [amplitude, peak, span / 5, ymin],
    9: [amplitude, 4 / span, center, ymin],
    10: [amplitude / 2, (2 * Math.PI) / span, 0, (ymin + ymax) / 2],
  };
  const parameters = initialParameters(starts[model] ?? FIT_MODELS[model].starts);
  if ([4, 7, 8].includes(model)) parameters[model === 4 ? 1 : 2].lower = 1e-12;
  return parameters;
}
