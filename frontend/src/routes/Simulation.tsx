import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Play } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { ModelSummary, SimResult } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { IconButton } from "@/components/shared/IconButton"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"

export default function Simulation() {
  const { dataset } = useStore()
  const [models, setModels] = useState<ModelSummary[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<SimResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.models().then((m) => {
      setModels(m)
      if (m[0]) setSelected([m[0].name])
    })
  }, [])

  if (!dataset) return <NoDataset />

  async function run() {
    if (!selected.length) return toast.error("Select a model")
    setLoading(true)
    try {
      setResult(await api.simulate(dataset!.id, selected))
    } catch (e) {
      toast.error("Simulation failed", { description: String(e) })
    } finally {
      setLoading(false)
    }
  }

  const toggle = (name: string) =>
    setSelected((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]))

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Models</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {models.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No models.{" "}
              <Link to="/sysid" className="underline">
                Identify one
              </Link>
              .
            </p>
          ) : (
            models.map((m) => (
              <label key={m.name} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={selected.includes(m.name)} onCheckedChange={() => toggle(m.name)} />
                <span className="truncate">{m.name}</span>
              </label>
            ))
          )}
          <IconButton label="Run simulation" onClick={run} disabled={!selected.length}>
            <Play />
          </IconButton>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {loading && <Skeleton className="h-64 w-full" />}
        {result?.outputs.map((out) => (
          <Card key={out.name}>
            <CardHeader>
              <CardTitle className="text-base">{out.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <LineChart
                x={result.time}
                series={[
                  { label: "Measured", y: out.measured, color: colorFor(0) },
                  ...result.sims.map((s, i) => ({
                    label: s.model,
                    y: s.byOutput[out.name],
                    color: colorFor(i + 1),
                    dash: [6, 4],
                  })),
                ]}
                xLabel="Time [s]"
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
