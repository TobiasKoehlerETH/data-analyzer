import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useStore } from "@/store"
import type { SignalData } from "@/lib/types"
import { StackedSignalPlot } from "@/components/plots/StackedSignalPlot"
import { SignalPicker } from "@/components/shared/SignalPicker"
import { NoDataset } from "@/components/shared/NoDataset"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function Plot() {
  const { dataset, signals, selected, toggleSignal } = useStore()
  // Keep names paired with their fetched data so a stale selection never mis-indexes.
  const [plot, setPlot] = useState<{ data: SignalData; names: string[] } | null>(null)
  const units = useMemo(
    () => Object.fromEntries(signals.map((s) => [s.name, s.unit])),
    [signals],
  )

  useEffect(() => {
    if (!dataset || selected.length === 0) return setPlot(null)
    let cancelled = false
    const names = selected
    api
      .signalData(dataset.id, names)
      .then((data) => !cancelled && setPlot({ data, names }))
      .catch((e) => toast.error("Failed to load signals", { description: String(e) }))
    return () => {
      cancelled = true
    }
  }, [dataset, selected])

  if (!dataset) return <NoDataset />

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card>
        <CardContent className="p-3">
          <SignalPicker selected={selected} onToggle={toggleSignal} />
        </CardContent>
      </Card>
      <div>
        {selected.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Select signals to plot.</p>
        ) : plot ? (
          <StackedSignalPlot data={plot.data} names={plot.names} units={units} />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    </div>
  )
}
