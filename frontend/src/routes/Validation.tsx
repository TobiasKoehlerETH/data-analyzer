import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { ModelSummary, ValOutput, ValResult } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

function Histogram({ counts }: { counts: number[] }) {
  const max = Math.max(...counts, 1)
  return (
    <div className="flex h-56 items-end gap-px">
      {counts.map((c, i) => (
        <div key={i} className="flex-1 bg-primary/60" style={{ height: `${(c / max) * 100}%` }} />
      ))}
    </div>
  )
}

function Metrics({ m }: { m: ValOutput["metrics"] }) {
  const rows: [string, string][] = [
    ["RMSE", m.rmse.toFixed(4)],
    ["NRMSE", `${m.nrmse.toFixed(2)}%`],
    ["MAE", m.mae.toFixed(4)],
    ["R²", m.r_squared.toFixed(4)],
    ["VAF", `${m.vaf.toFixed(2)}%`],
  ]
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between border-b py-1">
          <span className="text-muted-foreground">{k}</span>
          <span className="tabular-nums font-medium">{v}</span>
        </div>
      ))}
    </div>
  )
}

function OutputPanel({ out, time }: { out: ValOutput; time: number[] }) {
  const n = out.acf.acf.length
  const conf = out.acf.confidence
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {out.name}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (Shapiro p = {out.shapiro.p.toFixed(3)})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Residuals</p>
          <LineChart
            x={time}
            series={[{ label: "residual", y: out.residuals, color: colorFor(3) }]}
            xLabel="Time [s]"
            height={200}
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Residual histogram</p>
          <Histogram counts={out.hist.counts} />
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Autocorrelation (95% bounds)</p>
          <LineChart
            x={out.acf.lags}
            series={[
              { label: "ACF", y: out.acf.acf, color: colorFor(0) },
              { label: "+95%", y: Array(n).fill(conf), color: "#888", dash: [4, 4] },
              { label: "−95%", y: Array(n).fill(-conf), color: "#888", dash: [4, 4] },
            ]}
            xLabel="Lag"
            height={200}
          />
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Metrics</p>
          <Metrics m={out.metrics} />
        </div>
      </CardContent>
    </Card>
  )
}

export default function Validation() {
  const { dataset } = useStore()
  const [models, setModels] = useState<ModelSummary[]>([])
  const [model, setModel] = useState("")
  const [result, setResult] = useState<ValResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.models().then((m) => {
      setModels(m)
      if (m[0]) setModel(m[0].name)
    })
  }, [])

  useEffect(() => {
    if (!dataset || !model) return
    setLoading(true)
    setResult(null)
    api
      .validate(dataset.id, model)
      .then(setResult)
      .catch((e) => toast.error("Validation failed", { description: String(e) }))
      .finally(() => setLoading(false))
  }, [dataset, model])

  if (!dataset) return <NoDataset />

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models.{" "}
            <Link to="/sysid" className="underline">
              Identify one
            </Link>
            .
          </p>
        ) : (
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.name} value={m.name}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {loading && <Skeleton className="h-96 w-full" />}
      {result?.outputs.map((out) => (
        <OutputPanel key={out.name} out={out} time={result.time} />
      ))}
    </div>
  )
}
