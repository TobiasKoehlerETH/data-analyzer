import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceActive } from "@/lib/workspace";
import type * as echarts from "echarts";
import { EChart, type EChartsInstance } from "./EChart";
import type { FitSource } from "@/lib/analysis";
import { AXIS_COLOR, FONT, MUTED, baseTextStyle, tooltipStyle, valueAxis } from "@/lib/chart";

export interface ChartSeries {
  name: string;
  color: string;
  data: [number | null, number | null][];
  dashed?: boolean;
  width?: number;
  type?: "line" | "scatter" | "bar";
  symbolSize?: number;
}

export interface ChartPanel {
  id: string;
  yLabel?: string;
  title?: string;
  series: ChartSeries[];
  legend?: boolean;
  /** Horizontal reference lines */
  hLines?: { y: number; color: string; dashed?: boolean; label?: string }[];
  /** Vertical marker lines */
  vLines?: { x: number; color: string; dashed?: boolean; label?: string }[];
  yLog?: boolean;
}

export interface StackedChartProps {
  fitSources?: FitSource[];
  panels: ChartPanel[];
  /** Columns per row; panels fill row-major (side-by-side layouts). */
  columns?: number;
  xLabel?: string;
  xRange?: [number, number] | null;
  /** Called (debounced) with the visible x range after zoom/pan; null = full range. */
  onZoom?: (range: [number, number] | null) => void;
  onCursor?: (x: number) => void;
  onClick?: (panelIndex: number, x: number, y: number) => void;
  /** Changing this key resets the zoom. */
  resetKey?: string | number;
  showSlider?: boolean;
  tooltip?: boolean;
  /** Pan with mouse drag (disable when the chart has draggable elements). */
  panOnDrag?: boolean;
  className?: string;
  onReady?: (chart: EChartsInstance) => void;
}

const LEFT = 78;
const RIGHT = 18;
const TOP = 30;
const GAP = 18;

export function StackedChart({
  fitSources,
  panels,
  columns = 1,
  xLabel,
  xRange,
  onZoom,
  onCursor,
  onClick,
  resetKey,
  showSlider = true,
  tooltip = true,
  panOnDrag = true,
  className,
  onReady,
}: StackedChartProps) {
  const active = useContext(WorkspaceActive);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const zoom = useRef<{ start: number; end: number }>({ start: 0, end: 100 });
  const zoomTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cursorTimer = useRef(0);
  const cbs = useRef({ onZoom, onCursor, onClick });
  cbs.current = { onZoom, onCursor, onClick };
  const chartRef = useRef<EChartsInstance | null>(null);

  useEffect(() => {
    zoom.current = { start: 0, end: 100 };
  }, [resetKey]);

  useEffect(() => {
    if (!host.current || !active) return;
    const ro = new ResizeObserver(() => {
      if (host.current) setSize({ w: host.current.clientWidth, h: host.current.clientHeight });
    });
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [active]);

  const n = panels.length;
  const rows = Math.max(1, Math.ceil(n / columns));
  const bottom = showSlider ? 66 : 40;
  const panelH = Math.max(40, (size.h - TOP - bottom - GAP * (rows - 1)) / rows);
  const colW = (size.w - GAP * (columns - 1)) / columns;

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const grids: object[] = [];
    const xAxes: object[] = [];
    const yAxes: object[] = [];
    const series: object[] = [];
    const legends: object[] = [];
    const titles: object[] = [];
    panels.forEach((p, i) => {
      const row = Math.floor(i / columns);
      const col = i % columns;
      const top = TOP + row * (panelH + GAP);
      const left = col * (colW + GAP) + LEFT;
      const width = colW - LEFT - RIGHT;
      const lastRow = row === rows - 1 || i + columns >= n;
      grids.push({ left, top, width: Math.max(40, width), height: panelH, containLabel: false });
      xAxes.push(
        valueAxis({
          gridIndex: i,
          scale: false,
          min: xRange ? xRange[0] : "dataMin",
          max: xRange ? xRange[1] : "dataMax",
          axisLabel: { show: lastRow, color: MUTED, fontSize: 10.5, fontFamily: FONT, hideOverlap: true },
          name: lastRow ? xLabel : undefined,
          nameLocation: "middle",
          nameGap: 24,
        }),
      );
      const yl = p.yLabel ? (p.yLabel.length > 30 ? p.yLabel.slice(0, 29) + "…" : p.yLabel) : undefined;
      yAxes.push(
        valueAxis({
          gridIndex: i,
          type: p.yLog ? "log" : "value",
          scale: !p.yLog,
          name: yl,
          nameLocation: "middle",
          nameGap: 56,
          nameRotate: 90,
          axisLabel: {
            color: MUTED,
            fontSize: 10.5,
            fontFamily: FONT,
            formatter: (v: number) => {
              const a = Math.abs(v);
              return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential(1) : String(Number(v.toPrecision(6)));
            },
          },
        }),
      );
      if (p.title) {
        titles.push({ text: p.title, left: left + width, top: top - 16, textAlign: "right", textStyle: { fontSize: 11, fontWeight: 400, color: "#000", fontFamily: FONT } });
      }
      p.series.forEach((s, si) => {
        const markLine =
          si === 0 && ((p.hLines?.length ?? 0) > 0 || (p.vLines?.length ?? 0) > 0)
            ? {
                silent: true,
                symbol: "none",
                animation: false,
                data: [
                  ...(p.hLines ?? []).map((h) => ({
                    yAxis: h.y,
                    lineStyle: { color: h.color, type: h.dashed ? "dashed" : "solid", width: 1 },
                    label: { show: !!h.label, formatter: h.label ?? "", color: h.color, fontSize: 10, position: "insideEndTop" },
                  })),
                  ...(p.vLines ?? []).map((v) => ({
                    xAxis: v.x,
                    lineStyle: { color: v.color, type: v.dashed ? "dotted" : "solid", width: 1 },
                    label: { show: !!v.label, formatter: v.label ?? "", color: v.color, fontSize: 10, position: "insideEndTop" },
                  })),
                ],
              }
            : undefined;
        const type = s.type ?? "line";
        series.push({
          type,
          name: s.name,
          xAxisIndex: i,
          yAxisIndex: i,
          data: s.data,
          showSymbol: type === "scatter",
          symbolSize: s.symbolSize ?? 3,
          animation: false,
          connectNulls: false,
          sampling: type === "line" ? "lttb" : undefined,
          large: type === "scatter",
          barWidth: type === "bar" ? "70%" : undefined,
          itemStyle: { color: s.color },
          lineStyle: { color: s.color, width: s.width ?? 1.3, type: s.dashed ? "dashed" : "solid" },
          emphasis: { disabled: true },
          markLine,
        });
      });
      if (p.legend && p.series.length > 0) {
        legends.push({
          data: p.series.map((s) => s.name),
          top: top + 4,
          left: left + 10,
          itemWidth: 16,
          itemHeight: 6,
          textStyle: { fontSize: 10.5, fontFamily: FONT },
          backgroundColor: "rgba(255,255,255,0.8)",
        });
      }
    });
    const allX = panels.map((_, i) => i);
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series,
      legend: legends,
      title: titles,
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: "#a5a5a5", type: "dashed" }, label: { backgroundColor: "#274259", fontFamily: FONT } },
      tooltip: tooltip
        ? {
            trigger: "axis",
            confine: true,
            ...tooltipStyle,
            axisPointer: { type: "line", animation: false },
            valueFormatter: (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : v.toFixed(4)) : String(v)),
          }
        : undefined,
      toolbox: {
        right: 12,
        top: 2,
        itemSize: 13,
        iconStyle: { borderColor: "#5c5c5c" },
        emphasis: { iconStyle: { borderColor: "#ff2400" } },
        feature: {
          dataZoom: { xAxisIndex: allX, yAxisIndex: false, title: { zoom: "Box zoom", back: "Undo zoom" } },
          restore: { title: "Reset view" },
          saveAsImage: { title: "Save image", pixelRatio: 2, backgroundColor: "#fff", name: "plot" },
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: allX, filterMode: "none", moveOnMouseMove: panOnDrag, start: zoom.current.start, end: zoom.current.end },
        ...(showSlider
          ? [
              {
                type: "slider",
                xAxisIndex: allX,
                filterMode: "none",
                height: 16,
                bottom: 6,
                start: zoom.current.start,
                end: zoom.current.end,
                borderColor: "#d9dcde",
                fillerColor: "rgba(255,36,0,0.08)",
                handleStyle: { color: "#fff", borderColor: "#ff2400" },
                moveHandleStyle: { color: "#ff2400" },
                dataBackground: { lineStyle: { color: "#a6b0b5" }, areaStyle: { color: "#ebedee" } },
                textStyle: { fontSize: 10, fontFamily: FONT, color: MUTED },
                labelFormatter: (v: number) => Number(v.toPrecision(5)).toString(),
              },
            ]
          : []),
      ],
      color: [AXIS_COLOR],
    };
  }, [panels, columns, xLabel, xRange, panelH, colW, rows, n, showSlider, tooltip, panOnDrag]);

  const events = useMemo(
    () => ({
      datazoom: (_: unknown, chart: EChartsInstance) => {
        const dz = (chart.getOption() as { dataZoom?: { start: number; end: number }[] }).dataZoom?.[0];
        if (!dz) return;
        zoom.current = { start: dz.start, end: dz.end };
        if (!cbs.current.onZoom) return;
        clearTimeout(zoomTimer.current);
        zoomTimer.current = setTimeout(() => {
          const full = dz.start <= 0.001 && dz.end >= 99.999;
          if (full) {
            cbs.current.onZoom?.(null);
          } else if (xRange) {
            const span = xRange[1] - xRange[0];
            cbs.current.onZoom?.([xRange[0] + (span * dz.start) / 100, xRange[0] + (span * dz.end) / 100]);
          }
        }, 140);
      },
      updateAxisPointer: (p: { axesInfo?: { axisDim: string; value: number }[] }) => {
        const xInfo = p.axesInfo?.find((a) => a.axisDim === "x");
        if (!xInfo || !cbs.current.onCursor) return;
        const now = performance.now();
        if (now - cursorTimer.current < 40) return;
        cursorTimer.current = now;
        cbs.current.onCursor(xInfo.value);
      },
    }),
    [xRange],
  );

  const handleReady = (chart: EChartsInstance) => {
    chartRef.current = chart;
    chart.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      if (!cbs.current.onClick) return;
      const count = (chart.getOption() as { grid?: unknown[] }).grid?.length ?? 0;
      for (let i = 0; i < count; i++) {
        if (chart.containPixel({ gridIndex: i }, [e.offsetX, e.offsetY])) {
          const [x, y] = chart.convertFromPixel({ gridIndex: i }, [e.offsetX, e.offsetY]) as number[];
          cbs.current.onClick(i, x, y);
          return;
        }
      }
    });
    onReady?.(chart);
  };

  return (
    <div ref={host} className={className ?? "h-full w-full min-h-0"}>
      {n > 0 && <EChart option={option} fitSources={fitSources} onReady={handleReady} onEvents={events} />}
    </div>
  );
}
