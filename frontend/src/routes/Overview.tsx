import { Link } from "react-router-dom"
import { Upload } from "lucide-react"

import { useStore } from "@/store"
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
  const { dataset, signals } = useStore()

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
      </Card>
    </div>
  )
}
