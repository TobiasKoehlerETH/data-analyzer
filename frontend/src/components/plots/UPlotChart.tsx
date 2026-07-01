import { useEffect, useRef, useState } from "react"
import uPlot from "uplot"
import "uplot/dist/uPlot.min.css"

import { ZoomHistory, zoomViewport, type Viewport } from "./zoom"

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
  const history = useRef<ZoomHistory | null>(null)
  const initialData = useRef(data)
  const [canGoBack, setCanGoBack] = useState(false)

  const getViewport = (instance: uPlot): Viewport | null => {
    const x = instance.scales.x
    const y = instance.scales.y
    if (
      x.min == null || x.max == null || y.min == null || y.max == null ||
      !Number.isFinite(x.min) || !Number.isFinite(x.max) ||
      !Number.isFinite(y.min) || !Number.isFinite(y.max)
    ) return null
    return { x: [x.min, x.max], y: [y.min, y.max] }
  }

  const setViewport = (instance: uPlot, viewport: Viewport) => {
    instance.batch(() => {
      instance.setScale("x", { min: viewport.x[0], max: viewport.x[1] })
      instance.setScale("y", { min: viewport.y[0], max: viewport.y[1] })
    })
  }

  const applyViewport = (viewport: Viewport) => {
    const instance = plot.current
    const zoomHistory = history.current
    if (!instance || !zoomHistory) return
    setViewport(instance, zoomHistory.push(viewport))
    setCanGoBack(zoomHistory.canGoBack)
  }

  const zoomBy = (factor: number) => {
    const instance = plot.current
    const viewport = instance && getViewport(instance)
    if (!viewport) return
    applyViewport(zoomViewport(viewport, factor, {
      x: (viewport.x[0] + viewport.x[1]) / 2,
      y: (viewport.y[0] + viewport.y[1]) / 2,
    }))
  }

  useEffect(() => {
    const node = el.current!
    const onSelect: NonNullable<uPlot.Hooks.Defs["setSelect"]> = (instance) => {
      const { left, top, width, height: selectedHeight } = instance.select
      if (width < 2 || selectedHeight < 2) return
      applyViewport({
        x: [instance.posToVal(left, "x"), instance.posToVal(left + width, "x")],
        y: [instance.posToVal(top + selectedHeight, "y"), instance.posToVal(top, "y")],
      })
      instance.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
    }
    const instance = new uPlot({
      ...options,
      width: node.clientWidth || 800,
      height,
      cursor: {
        ...options.cursor,
        drag: {
          ...options.cursor?.drag,
          x: true,
          y: true,
          setScale: false,
        },
      },
      hooks: {
        ...options.hooks,
        setSelect: [...(options.hooks?.setSelect ?? []), onSelect],
      },
    }, initialData.current, node)
    plot.current = instance
    const original = getViewport(instance)
    history.current = original ? new ZoomHistory(original) : null
    setCanGoBack(false)

    const over = node.querySelector<HTMLElement>(".u-over")
    const onWheel = (event: WheelEvent) => {
      const viewport = getViewport(instance)
      if (!viewport || !over) return
      event.preventDefault()
      const rect = over.getBoundingClientRect()
      applyViewport(zoomViewport(viewport, event.deltaY < 0 ? 0.8 : 1.25, {
        x: instance.posToVal(event.clientX - rect.left, "x"),
        y: instance.posToVal(event.clientY - rect.top, "y"),
      }))
    }
    over?.addEventListener("wheel", onWheel, { passive: false })

    const ro = new ResizeObserver(() =>
      plot.current?.setSize({ width: node.clientWidth, height }),
    )
    ro.observe(node)
    return () => {
      over?.removeEventListener("wheel", onWheel)
      ro.disconnect()
      plot.current?.destroy()
      plot.current = null
      history.current = null
    }
  }, [options, height])

  useEffect(() => {
    plot.current?.setData(data)
  }, [data])

  return (
    <div className="relative w-full">
      <div
        className="absolute right-2 top-2 z-10 flex overflow-hidden rounded-md border bg-background/90 shadow-sm backdrop-blur"
        role="group"
        aria-label="Plot zoom controls"
      >
        <button
          type="button"
          className="h-7 min-w-7 border-r px-2 text-sm hover:bg-accent"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomBy(0.8)}
        >
          +
        </button>
        <button
          type="button"
          className="h-7 min-w-7 border-r px-2 text-sm hover:bg-accent"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(1.25)}
        >
          −
        </button>
        <button
          type="button"
          className="h-7 border-r px-2 text-xs hover:bg-accent disabled:opacity-40"
          aria-label="Back"
          title="Previous zoom"
          disabled={!canGoBack}
          onClick={() => {
            const instance = plot.current
            const zoomHistory = history.current
            if (!instance || !zoomHistory) return
            setViewport(instance, zoomHistory.back())
            setCanGoBack(zoomHistory.canGoBack)
          }}
        >
          Back
        </button>
        <button
          type="button"
          className="h-7 px-2 text-xs hover:bg-accent"
          aria-label="Reset zoom"
          title="Reset zoom"
          onClick={() => {
            const instance = plot.current
            const zoomHistory = history.current
            if (!instance || !zoomHistory) return
            setViewport(instance, zoomHistory.reset())
            setCanGoBack(false)
          }}
        >
          Reset
        </button>
      </div>
      <div ref={el} className="w-full" />
    </div>
  )
}
