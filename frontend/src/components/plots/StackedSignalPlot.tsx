import { useMemo } from "react"
import uPlot from "uplot"

import { UPlotChart } from "./UPlotChart"
import { colorFor } from "@/lib/palette"
import type { SignalData } from "@/lib/types"

// Shared cursor => a single crosshair tracks across every stacked chart.
const sync = uPlot.sync("signals")

const axis = (label?: string): uPlot.Axis => ({
  label,
  stroke: "#888",
  grid: { stroke: "rgba(128,128,128,0.15)" },
  ticks: { stroke: "rgba(128,128,128,0.2)" },
})

function SignalRow({
  time, y, name, unit, color,
}: {
  time: Float32Array
  y: Float32Array
  name: string
  unit?: string
  color: string
}) {
  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(
    () => ({
      scales: { x: { time: false } }, // x is elapsed seconds, not a timestamp
      cursor: { sync: { key: sync.key }, drag: { x: true, y: false } },
      legend: { show: false },
      series: [{}, { label: name, stroke: color, width: 1, points: { show: false } }],
      axes: [axis("Time [s]"), axis(unit || name)],
    }),
    [name, unit, color],
  )
  const data = useMemo<uPlot.AlignedData>(() => [time, y], [time, y])
  return <UPlotChart options={options} data={data} height={160} />
}

export function StackedSignalPlot({
  data, names, units,
}: {
  data: SignalData
  names: string[]
  units?: Record<string, string>
}) {
  return (
    <div className="space-y-3">
      {names.filter((n) => data.series[n]).map((name, i) => (
        <SignalRow
          key={name}
          time={data.time}
          y={data.series[name]}
          name={name}
          unit={units?.[name]}
          color={colorFor(i)}
        />
      ))}
    </div>
  )
}
