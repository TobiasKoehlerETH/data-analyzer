import { useMemo } from "react"
import uPlot from "uplot"

import { UPlotChart } from "./UPlotChart"

const axis = (label?: string): uPlot.Axis => ({
  label,
  stroke: "#888",
  grid: { stroke: "rgba(128,128,128,0.15)" },
  ticks: { stroke: "rgba(128,128,128,0.2)" },
})

type Line = { label: string; y: number[] | Float32Array; color: string; dash?: number[] }

/** Single uPlot chart with one shared x axis and one or more line (or scatter) series. */
export function LineChart({
  x, series, xLabel, yLabel, height = 260, logY = false, scatter = false,
}: {
  x: number[] | Float32Array
  series: Line[]
  xLabel?: string
  yLabel?: string
  height?: number
  logY?: boolean
  scatter?: boolean
}) {
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(
    () => ({
      scales: { x: { time: false }, y: logY ? { distr: 3 } : {} },
      legend: { show: series.length > 1 },
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: scatter ? 0 : 1,
          dash: s.dash,
          points: scatter ? { show: true, size: 3, fill: s.color } : { show: false },
        })),
      ],
      axes: [axis(xLabel), axis(yLabel)],
    }),
    [series, xLabel, yLabel, logY, scatter],
  )
  const data = useMemo<uPlot.AlignedData>(() => [x, ...series.map((s) => s.y)], [x, series])
  return <UPlotChart options={options} data={data} height={height} />
}
