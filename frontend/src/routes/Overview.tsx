import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Upload } from "lucide-react"

import { api } from "@/lib/api"
import type { SignalData } from "@/lib/types"
import { useStore } from "@/store"
import { StackedSignalPlot } from "@/components/plots/StackedSignalPlot"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

export default function Overview() {
  const { dataset, signals, selected } = useStore()
  const preview = useMemo(() => selected.slice(0, 3), [selected])
  const [data, setData] = useState<SignalData | null>(null)
  const units = useMemo(() => Object.fromEntries(signals.map((s) => [s.name, s.unit])), [signals])

  useEffect(() => {
    if (!dataset || preview.length === 0) return
    api.signalData(dataset.id, preview).then(setData).catch(() => {})
  }, [dataset, preview])

  if (!dataset)
    return (
      <Card className="mx-auto mt-16 max-w-md text-center">
        <CardHeader>
          <CardTitle>No dataset loaded</CardTitle>
          <CardDescription>Load a CSV to start exploring your signals.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/load">
              <Upload /> Load a CSV
            </Link>
          </Button>
        </CardContent>
      </Card>
    )

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Rows" value={dataset.rows.toLocaleString()} />
      <Stat label="Signals" value={String(dataset.signalCount)} />
      <Stat label="Duration" value={`${dataset.duration.toFixed(0)} s`} />
      <Stat label="Sample rate" value={`${dataset.sampleRate.toFixed(2)} Hz`} />
      <Card className="sm:col-span-2 lg:col-span-4">
        <CardHeader>
          <CardTitle className="text-base">{dataset.filename}</CardTitle>
          <CardDescription>
            {dataset.raser ? "Raser DataLog" : "Generic CSV"} · {signals.length} numeric signals
          </CardDescription>
        </CardHeader>
        {data && preview.length > 0 && (
          <CardContent>
            <StackedSignalPlot data={data} names={preview} units={units} />
          </CardContent>
        )}
      </Card>
    </div>
  )
}
