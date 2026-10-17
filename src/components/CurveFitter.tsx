import { useMemo, useRef, useState } from "react";
import { Download, Play, Plus, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { NumberInput } from "./common";
import { EChart } from "./EChart";
import {
  FIT_MODELS,
  curveFit,
  downloadText,
  type FitSource,
  type Parameter,
  type FitResult,
  type FitRequest,
} from "@/lib/analysis";
import { fmtG, tooltipStyle, valueAxis } from "@/lib/chart";

interface SavedFit {
  name: string;
  result: FitResult;
  request: FitRequest;
  source: FitSource;
  model: number;
  range: [string, string];
  excluded: number[];
}
interface Props {
  sources: FitSource[];
  onClose: () => void;
  onApply: (source: FitSource, result: FitResult) => void;
}
const initialParameters = (starts: number[]): Parameter[] =>
  starts.map((start, i) => ({
    name: String.fromCharCode(97 + i),
    start,
    lower: null,
    upper: null,
    fixed: false,
  }));

export function CurveFitter({ sources, onClose, onApply }: Props) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = sources[sourceIndex];
  const [model, setModel] = useState(0);
  const [expression, setExpression] = useState(FIT_MODELS[0].equation);
  const [parameters, setParameters] = useState(
    initialParameters(FIT_MODELS[0].starts),
  );
  const [normalize, setNormalize] = useState(false);
  const [robust, setRobust] = useState(false);
  const [range, setRange] = useState<[string, string]>(["", ""]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [bands, setBands] = useState(true);
  const [residuals, setResiduals] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fits, setFits] = useState<SavedFit[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const revision = useRef(0);
  const current = active === null ? null : fits[active];
  const points = useMemo(
    () =>
      source.points.filter(
        (p, i) =>
          !excluded.has(i) &&
          (range[0] === "" || p[0] >= Number(range[0])) &&
          (range[1] === "" || p[0] <= Number(range[1])),
      ),
    [source, excluded, range],
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
    setParameters(suggestParameters(index, points, normalize));
  };
  const run = async () => {
    const token = ++revision.current;
    setBusy(true);
    setError("");
    try {
      if (
        range.some((v) => v !== "" && !Number.isFinite(Number(v))) ||
        (range.every((v) => v !== "") && Number(range[0]) > Number(range[1]))
      )
        throw new Error("Check the X range.");
      const request = { points, expression, parameters, normalize, robust };
      const result = await curveFit(request);
      if (revision.current !== token) return;
      const saved = {
        name: `${FIT_MODELS[model].name} ${fits.length + 1}`,
        result,
        request,
        source,
        model,
        range,
        excluded: [...excluded],
      };
      setFits([...fits, saved]);
      setActive(fits.length);
    } catch (e) {
      if (revision.current === token) setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const preview = useMemo(() => {
    const plotted = source.points.filter(
      (_, i) => i % Math.max(1, Math.ceil(source.points.length / 10000)) === 0,
    );
    const step = Math.max(1, Math.ceil(source.points.length / 10000));
    return {
      animation: false,
      tooltip: { ...tooltipStyle, trigger: "item" },
      grid:
        residuals && current
          ? [
              { left: 65, right: 25, top: 30, bottom: "36%" },
              { left: 65, right: 25, top: "76%", bottom: 35 },
            ]
          : { left: 65, right: 25, top: 30, bottom: 45 },
      xAxis:
        residuals && current
          ? [
              valueAxis({ name: source.xLabel || "X" }),
              valueAxis({ gridIndex: 1 }),
            ]
          : valueAxis({ name: source.xLabel || "X" }),
      yAxis:
        residuals && current
          ? [
              valueAxis({ scale: true }),
              valueAxis({ gridIndex: 1, name: "Residual", scale: true }),
            ]
          : valueAxis({ scale: true }),
      series: [
        {
          name: source.name,
          type: "scatter",
          symbolSize: 4,
          data: plotted.map((p, i) => ({
            value: p,
            itemStyle: {
              color:
                excluded.has(i * step) ||
                (range[0] !== "" && p[0] < Number(range[0])) ||
                (range[1] !== "" && p[0] > Number(range[1]))
                  ? "#ccc"
                  : "#6b7b84",
            },
          })),
        },
        ...(current
          ? [
              {
                name: current.name,
                type: "line",
                silent: true,
                showSymbol: false,
                data: current.result.curve,
                lineStyle: { color: "#ff2400", width: 2 },
              },
            ]
          : []),
        ...(current && bands
          ? [current.result.lower, current.result.upper].map((data, i) => ({
              name: `Approx. 95% ${i ? "upper" : "lower"}`,
              type: "line",
              silent: true,
              showSymbol: false,
              data,
              lineStyle: { color: "#ff2400", type: "dashed", width: 1 },
            }))
          : []),
        ...(current && residuals
          ? [
              {
                name: "Residuals",
                type: "scatter",
                symbolSize: 3,
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: current.result.residuals.filter((_, i) => i % step === 0),
                itemStyle: { color: "#274259" },
                markLine: {
                  silent: true,
                  symbol: "none",
                  data: [{ yAxis: 0 }],
                },
              },
            ]
          : []),
      ],
    };
  }, [source, current, bands, residuals, excluded, range]);

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) {
          revision.current++;
          onClose();
        }
      }}
    >
      <DialogContent className="flex h-[90vh] w-[1200px] max-w-[96vw] flex-col gap-3 rounded-none p-4 sm:max-w-[96vw]">
        <DialogTitle className="text-ap-red">Curve fitting</DialogTitle>
        <DialogDescription className="sr-only">
          Choose data and a model, fit, then inspect residuals and coefficients.
        </DialogDescription>
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-[260px] shrink-0 flex-col gap-3 overflow-auto pr-1 text-xs">
            <label className="analysis-field">
              Data
              <select
                value={sourceIndex}
                onChange={(e) => {
                  invalidate();
                  setSourceIndex(Number(e.target.value));
                  setExcluded(new Set());
                  setRange(["", ""]);
                }}
              >
                {sources.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-muted-foreground" title={source.scope}>
              {points.length.toLocaleString()} points ·{" "}
              <span>
                {source.scope?.startsWith("Full") ? "Full data" : "Chart data"}
              </span>
            </div>
            <label className="analysis-field">
              Model
              <select
                value={model}
                onChange={(e) => chooseModel(Number(e.target.value))}
              >
                {FIT_MODELS.map((m, i) => (
                  <option key={m.name} value={i}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {model === FIT_MODELS.length - 1 ? (
              <label className="analysis-field">
                Equation
                <input
                  aria-label="Custom equation"
                  title="Use x and the named coefficients. Functions: exp, ln, sqrt, sin, cos. Powers: ^."
                  value={expression}
                  onChange={(e) => {
                    invalidate();
                    setExpression(e.target.value);
                  }}
                  placeholder="a*exp(-x/b)+c"
                />
              </label>
            ) : (
              <code className="break-all bg-muted p-2">y = {expression}</code>
            )}
            <Button onClick={run} disabled={busy || points.length < 3}>
              <Play className="size-3.5" />
              {busy ? "Fitting…" : "Fit"}
            </Button>
            <details>
              <summary className="cursor-pointer py-1">Fit options</summary>
              <div className="mt-2 flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1].map((i) => (
                    <label className="analysis-field" key={i}>
                      {i ? "X max" : "X min"}
                      <input
                        type="number"
                        value={range[i]}
                        placeholder="Auto"
                        onChange={(e) => {
                          invalidate();
                          setRange((v) =>
                            i === 0
                              ? [e.target.value, v[1]]
                              : [v[0], e.target.value],
                          );
                        }}
                      />
                    </label>
                  ))}
                </div>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={normalize}
                    onChange={(e) => {
                      invalidate();
                      setNormalize(e.target.checked);
                    }}
                  />
                  Center and scale X
                </label>
                <label
                  className="flex gap-2"
                  title="Huber loss reduces the influence of large residuals."
                >
                  <input
                    type="checkbox"
                    checked={robust}
                    onChange={(e) => {
                      invalidate();
                      setRobust(e.target.checked);
                    }}
                  />
                  Robust fit
                </label>
                <div className="text-muted-foreground">Coefficients</div>
                {parameters.map((p, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[32px_1fr] gap-1.5 border-b pb-2"
                  >
                    {model === FIT_MODELS.length - 1 ? (
                      <input
                        aria-label={`Coefficient ${i + 1} name`}
                        className="analysis-input"
                        value={p.name}
                        onChange={(e) => {
                          invalidate();
                          setParameters(
                            parameters.map((q, j) =>
                              i === j ? { ...q, name: e.target.value } : q,
                            ),
                          );
                        }}
                      />
                    ) : (
                      <span className="pt-1">{p.name}</span>
                    )}
                    <NumberInput
                      title={`${p.name}: starting value`}
                      value={p.start}
                      onChange={(value) => {
                        invalidate();
                        setParameters(
                          parameters.map((q, j) =>
                            i === j
                              ? { ...q, start: value }
                              : q,
                          ),
                        );
                      }}
                    />
                    <label className="col-span-2 flex gap-2">
                      <input
                        type="checkbox"
                        checked={p.fixed}
                        onChange={(e) => {
                          invalidate();
                          setParameters(
                            parameters.map((q, j) =>
                              i === j ? { ...q, fixed: e.target.checked } : q,
                            ),
                          );
                        }}
                      />
                      Fix {p.name}
                    </label>
                    <div className="col-span-2 grid grid-cols-2 gap-2">
                      {(["lower", "upper"] as const).map((key) => (
                        <input
                          key={key}
                          aria-label={`${p.name} ${key}`}
                          title={`${key} bound`}
                          className="analysis-input"
                          type="number"
                          placeholder={key === "lower" ? "−∞" : "+∞"}
                          value={p[key] ?? ""}
                          onChange={(e) => {
                            invalidate();
                            setParameters(
                              parameters.map((q, j) =>
                                i === j
                                  ? {
                                      ...q,
                                      [key]:
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value),
                                    }
                                  : q,
                              ),
                            );
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {model === FIT_MODELS.length - 1 && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={parameters.length >= 8}
                      onClick={() => {
                        invalidate();
                        setParameters([
                          ...parameters,
                          {
                            name: String.fromCharCode(97 + parameters.length),
                            start: 1,
                            lower: null,
                            upper: null,
                            fixed: false,
                          },
                        ]);
                      }}
                    >
                      <Plus className="size-3" />
                      Coefficient
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
                <p className="text-muted-foreground">
                  Click a point to exclude it.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    invalidate();
                    setExcluded(new Set());
                    setRange(["", ""]);
                  }}
                >
                  <RotateCcw className="size-3" />
                  Reset exclusions ({excluded.size})
                </Button>
              </div>
            </details>
            {fits.length > 0 && (
              <div className="border-t pt-2">
                <div className="mb-1 text-muted-foreground">Fits</div>
                {fits.map((fit, i) => (
                  <button
                    key={i}
                    className={`flex w-full justify-between p-2 text-left ${active === i ? "bg-muted text-ap-red" : ""}`}
                    onClick={() => {
                      revision.current++;
                      setSourceIndex(sources.indexOf(fit.source));
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
                    <span>{fit.name}</span>
                    <span title="RMSE">{fmtG(fit.result.rmse)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-4 text-xs">
              <label className="flex gap-1.5">
                <input
                  type="checkbox"
                  checked={bands}
                  onChange={(e) => setBands(e.target.checked)}
                />
                95% bands
              </label>
              <label className="flex gap-1.5">
                <input
                  type="checkbox"
                  checked={residuals}
                  onChange={(e) => setResiduals(e.target.checked)}
                />
                Residuals
              </label>
              <span
                className="ml-auto text-muted-foreground"
                title={source.scope}
              >
                {source.points.length > 10000
                  ? "Preview sampled · fit uses all included points"
                  : "Click points to exclude"}
              </span>
            </div>
            <EChart
              className="min-h-[220px] flex-1"
              option={preview}
              fitting={false}
              onEvents={{
                click: (p) => {
                  if (p.seriesIndex !== 0) return;
                  invalidate();
                  const i =
                    p.dataIndex *
                    Math.max(1, Math.ceil(source.points.length / 10000));
                  setExcluded((v) => {
                    const next = new Set(v);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  });
                },
              }}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            {current && (
              <div className="space-y-2 border-t pt-2 text-xs">
                {current.result.warning && (
                  <p role="status" className="text-amber-800">
                    {current.result.warning}
                  </p>
                )}
                <div className="flex flex-wrap gap-5">
                  <span>
                    R² <b>{fmtG(current.result.r_squared ?? NaN)}</b>
                  </span>
                  <span>
                    Adjusted R²{" "}
                    <b>{fmtG(current.result.adjusted_r_squared ?? NaN)}</b>
                  </span>
                  <span>
                    RMSE <b>{fmtG(current.result.rmse)}</b>
                  </span>
                  <span>
                    SSE <b>{fmtG(current.result.sse)}</b>
                  </span>
                  <span>n = {current.result.count.toLocaleString()}</span>
                </div>
                <div className="flex flex-wrap gap-4">
                  {current.request.parameters.map((p, i) => (
                    <span
                      key={i}
                      title="± approximate 95% confidence interval; fixed parameters have no interval"
                    >
                      {p.name} = <b>{fmtG(current.result.coefficients[i])}</b>
                      {current.result.standard_errors[i] != null &&
                        ` ± ${fmtG(1.96 * current.result.standard_errors[i]!)}`}
                      {p.fixed && " (fixed)"}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {current.request.normalize
                      ? `Equation uses x′ = (x − ${fmtG(current.result.x_center)}) / ${fmtG(current.result.x_scale)}`
                      : "Equation uses original X"}{" "}
                    ·{" "}
                    {current.result.lower.length > 0
                      ? "Approx. 95% mean-response bands"
                      : "No uncertainty bands"}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      title="Export equation, data, settings and results"
                      onClick={() =>
                        downloadText(
                          "curve-fit.json",
                          JSON.stringify(current, null, 2),
                        )
                      }
                    >
                      <Download className="size-3.5" />
                      Export
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        onApply(current.source, current.result);
                        onClose();
                      }}
                    >
                      Add to plot
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function suggestParameters(
  model: number,
  points: [number, number][],
  normalize: boolean,
): Parameter[] {
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
  if (normalize)
    peak = (peak - (xmin + xmax) / 2) / Math.max((xmax - xmin) / 2, 1e-6);
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
  const parameters = initialParameters(
    starts[model] ?? FIT_MODELS[model].starts,
  );
  if ([4, 7, 8].includes(model)) parameters[model === 4 ? 1 : 2].lower = 1e-12;
  return parameters;
}
