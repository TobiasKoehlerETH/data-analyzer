import * as echarts from "echarts";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  forwardRef,
  useMemo,
  useState,
  useContext,
} from "react";
import { cn } from "@/lib/utils";
import { WorkspaceActive } from "@/lib/workspace";
import { CurveFitter } from "./CurveFitter";
import {
  chartFitSources,
  type FitSource,
  type FitResult,
} from "@/lib/analysis";

export type EChartsInstance = echarts.ECharts;

export interface EChartHandle {
  chart: () => EChartsInstance | null;
}

interface Props {
  brushType?: "rect" | "lineX";
  fitting?: boolean;
  fitSources?: FitSource[];
  option: echarts.EChartsCoreOption;
  /** Replace instead of merging the option (default true). */
  notMerge?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onReady?: (chart: EChartsInstance) => void;
  onEvents?: Record<string, (params: any, chart: EChartsInstance) => void>;
}

/** Thin ECharts wrapper: owns the instance, resizes with its container. */
export const EChart = forwardRef<EChartHandle, Props>(function EChart(
  {
    option,
    notMerge = true,
    className,
    style,
    onReady,
    onEvents,
    fitting = true,
    fitSources,
    brushType,
  },
  ref,
) {
  const active = useContext(WorkspaceActive);
  const activeRef = useRef(active);
  activeRef.current = active;
  const el = useRef<HTMLDivElement>(null);
  const [fitSession, setFitSession] = useState<FitSource[] | null>(null);
  useEffect(() => { if (!active) setFitSession(null); }, [active]);
  const [overlay, setOverlay] = useState<{
    source: FitSource;
    result: FitResult;
    option: unknown;
  } | null>(null);
  const sources = useMemo(
    () => (active && fitting ? (fitSources ?? chartFitSources(option)) : []),
    [option, fitting, fitSources, active],
  );
  const displayOption = useMemo(() => {
    if (!overlay || overlay.option !== option) return option;
    const series = Array.isArray(option.series)
      ? option.series
      : [option.series];
    const original = series[overlay.source.seriesIndex ?? 0] as any;
    return {
      ...option,
      series: [
        ...series,
        {
          id: "curve-fit-overlay",
          name: "Fit",
          type: "line",
          showSymbol: false,
          data: overlay.result.curve,
          xAxisIndex: original?.xAxisIndex ?? 0,
          yAxisIndex: original?.yAxisIndex ?? 0,
          lineStyle: { color: "#ff2400", width: 2, type: "dashed" },
        },
      ],
    };
  }, [option, overlay]);
  const inst = useRef<EChartsInstance | null>(null);
  const ready = useRef(false);
  const rendered = useRef<unknown>(null);
  const handlers = useRef(onEvents);
  handlers.current = onEvents;

  useImperativeHandle(ref, () => ({ chart: () => inst.current }), []);

  useEffect(() => {
    if (!el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer: "canvas" });
    inst.current = chart;
    let resizeFrame = 0;
    const ro = new ResizeObserver(() => {
      if (
        activeRef.current &&
        el.current &&
        el.current.clientWidth > 0 &&
        el.current.clientHeight > 0
      ) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (activeRef.current) chart.resize();
        });
      }
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(resizeFrame);
      chart.dispose();
      inst.current = null;
      ready.current = false;
      rendered.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = inst.current;
    if (!chart) return;
    const names = Object.keys(onEvents ?? {});
    for (const name of names) {
      chart.off(name);
      chart.on(name, (p: unknown) => handlers.current?.[name]?.(p, chart));
    }
    return () => {
      for (const name of names) chart.off(name);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(onEvents ?? {}).join("|")]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const chart = inst.current;
      if (!chart) return;
      chart.resize();
      if (rendered.current !== displayOption) {
        chart.setOption(displayOption, { notMerge, lazyUpdate: false });
        rendered.current = displayOption;
        if (brushType) chart.dispatchAction({
          type: "takeGlobalCursor", key: "brush", brushOption: { brushType, brushMode: "single" },
        });
      }
      if (!ready.current) { ready.current = true; onReady?.(chart); }
    });
    return () => cancelAnimationFrame(frame);
  }, [displayOption, notMerge, brushType, active]);

  return (
    <div
      className={cn("relative h-full w-full min-h-0", className)}
      style={style}
    >
      <div ref={el} className="h-full w-full" />
      {sources.length > 0 && (
        <button
          className="absolute right-1 top-0 z-10 border bg-white/90 px-2 py-0.5 text-[11px] text-ap-darkblue hover:text-ap-red"
          title="Fit a curve to this chart"
          onClick={() => setFitSession(sources)}
        >
          Fit curve
        </button>
      )}
      {fitSession && (
        <CurveFitter
          sources={fitSession}
          onClose={() => setFitSession(null)}
          onApply={(source, result) => setOverlay({ source, result, option })}
        />
      )}
    </div>
  );
});
