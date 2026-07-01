import { useEffect, useRef, useState } from "react"

/** Diverging scale: blue (−1) → white (0) → red (+1). */
function cellColor(v: number): string {
  const t = Math.min(1, Math.abs(v))
  const [r, g, b] = v >= 0 ? [239, 68, 68] : [59, 130, 246]
  const mix = (c: number) => Math.round(255 + (c - 255) * t)
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`
}

/** Canvas Pearson heatmap. Hover shows the pair + value; click selects it. */
export function CorrelationHeatmap({
  columns, matrix, onSelect,
}: {
  columns: string[]
  matrix: number[][]
  onSelect?: (a: string, b: string) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ i: number; j: number; x: number; y: number } | null>(null)
  const n = columns.length
  const cell = Math.max(6, Math.min(28, Math.floor(520 / Math.max(n, 1))))
  const size = n * cell

  useEffect(() => {
    const ctx = ref.current?.getContext("2d")
    if (!ctx) return
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = cellColor(matrix[i][j])
        ctx.fillRect(j * cell, i * cell, cell, cell)
      }
  }, [matrix, n, cell])

  const at = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    return { i: Math.floor((e.clientY - rect.top) / cell), j: Math.floor((e.clientX - rect.left) / cell) }
  }

  return (
    <div className="relative inline-block">
      <canvas
        ref={ref}
        width={size}
        height={size}
        className="rounded border"
        onMouseMove={(e) => {
          const { i, j } = at(e)
          if (i >= 0 && i < n && j >= 0 && j < n) setHover({ i, j, x: e.clientX, y: e.clientY })
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const { i, j } = at(e)
          if (onSelect && i !== j) onSelect(columns[i], columns[j])
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded bg-popover px-2 py-1 text-xs shadow"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          {columns[hover.i]} × {columns[hover.j]}:{" "}
          <span className="tabular-nums font-medium">{matrix[hover.i][hover.j].toFixed(3)}</span>
        </div>
      )}
    </div>
  )
}
