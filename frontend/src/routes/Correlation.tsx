import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { CorrelationMatrix } from "@/lib/types"
import { useStore } from "@/store"
import { CorrelationHeatmap } from "@/components/plots/CorrelationHeatmap"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

type Pair = { a: string; b: string }

/** Evenly sample then sort by x — uPlot needs ascending x for a clean scatter. */
function scatterData(a: Float32Array, b: Float32Array) {
  const n = a.length
  const step = Math.max(1, Math.floor(n / 3000))
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < n; i += step) {
    xs.push(a[i])
    ys.push(b[i])
  }
  const idx = [...xs.keys()].sort((p, q) => xs[p] - xs[q])
  return { x: idx.map((k) => xs[k]), y: idx.map((k) => ys[k]) }
}

export default function Correlation() {
  const { dataset } = useStore()
  const [matrix, setMatrix] = useState<CorrelationMatrix | null>(null)
  const [pair, setPair] = useState<Pair | null>(null)
  const [xcorr, setXcorr] = useState<{ lags: number[]; corr: number[] } | null>(null)
  const [scatter, setScatter] = useState<{ x: number[]; y: number[] } | null>(null)

  useEffect(() => {
    if (dataset) api.correlation(dataset.id).then(setMatrix).catch((e) => toast.error(String(e)))
  }, [dataset])

  useEffect(() => {
    if (!dataset || !pair) return
    setXcorr(null)
    setScatter(null)
    api.correlationPair(dataset.id, pair.a, pair.b).then(setXcorr).catch(() => {})
    api
      .signalData(dataset.id, [pair.a, pair.b])
      .then((d) => setScatter(scatterData(d.series[pair.a], d.series[pair.b])))
      .catch(() => {})
  }, [dataset, pair])

  if (!dataset) return <NoDataset />

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pearson correlation</CardTitle>
            <CardDescription>Click a cell to inspect a pair.</CardDescription>
          </CardHeader>
          <CardContent>
            {matrix ? (
              <CorrelationHeatmap
                columns={matrix.columns}
                matrix={matrix.pearson}
                onSelect={(a, b) => setPair({ a, b })}
              />
            ) : (
              <Skeleton className="h-[520px] w-[520px]" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top correlated pairs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {matrix?.topPairs.map((p) => (
              <button
                key={`${p.a}|${p.b}`}
                onClick={() => setPair({ a: p.a, b: p.b })}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">
                  {p.a} × {p.b}
                </span>
                <span className="tabular-nums font-medium">{p.pearson.toFixed(3)}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      {pair && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Scatter: {pair.a} vs {pair.b}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {scatter ? (
                <LineChart
                  x={scatter.x}
                  series={[{ label: pair.b, y: scatter.y, color: colorFor(2) }]}
                  xLabel={pair.a}
                  yLabel={pair.b}
                  scatter
                />
              ) : (
                <Skeleton className="h-64 w-full" />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cross-correlation (lag)</CardTitle>
            </CardHeader>
            <CardContent>
              {xcorr ? (
                <LineChart
                  x={xcorr.lags}
                  series={[{ label: "xcorr", y: xcorr.corr, color: colorFor(3) }]}
                  xLabel="Lag [samples]"
                />
              ) : (
                <Skeleton className="h-64 w-full" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
