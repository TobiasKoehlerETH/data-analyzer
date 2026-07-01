import { useEffect, useRef } from "react"
import uPlot from "uplot"
import "uplot/dist/uPlot.min.css"

type Props = {
  /** uPlot options minus width/height, which this wrapper manages from the container. */
  options: Omit<uPlot.Options, "width" | "height">
  data: uPlot.AlignedData
  height?: number
}

/** Minimal React wrapper: creates uPlot on mount, keeps it sized to its container, streams data. */
export function UPlotChart({ options, data, height = 200 }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  useEffect(() => {
    const node = el.current!
    plot.current = new uPlot({ ...options, width: node.clientWidth || 800, height }, data, node)
    const ro = new ResizeObserver(() =>
      plot.current?.setSize({ width: node.clientWidth, height }),
    )
    ro.observe(node)
    return () => {
      ro.disconnect()
      plot.current?.destroy()
      plot.current = null
    }
  }, [options, height])

  useEffect(() => {
    plot.current?.setData(data)
  }, [data])

  return <div ref={el} className="w-full" />
}
