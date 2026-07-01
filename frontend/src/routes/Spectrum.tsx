import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { Spectrum as SpectrumData } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { SignalSelect } from "@/components/shared/SignalSelect"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function Spectrum() {
  const { dataset, signals, selected, filters } = useStore()
  const [signal, setSignal] = useState(selected[0] ?? signals[0]?.name ?? "")
  const [raw, setRaw] = useState<SpectrumData | null>(null)
  const [filtered, setFiltered] = useState<SpectrumData | null>(null)

  const steps = filters[signal]?.filter((s) => s.enabled) ?? []
  const chainKey = JSON.stringify(steps)

  useEffect(() => {
    if (!dataset || !signal) return
    setRaw(null)
    setFiltered(null)
    api.spectrum(dataset.id, signal).then(setRaw).catch((e) => toast.error(String(e)))
    if (steps.length) api.spectrum(dataset.id, signal, { steps }).then(setFiltered).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, signal, chainKey])

  if (!dataset) return <NoDataset />

  const fftSeries = raw
    ? [
        { label: "Original", y: raw.fft.magnitude, color: colorFor(0) },
        ...(filtered ? [{ label: "Filtered", y: filtered.fft.magnitude, color: colorFor(1) }] : []),
      ]
    : []
  const psdSeries = raw
    ? [
        { label: "Original", y: raw.psd.psd, color: colorFor(0) },
        ...(filtered ? [{ label: "Filtered", y: filtered.psd.psd, color: colorFor(1) }] : []),
      ]
    : []

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <SignalSelect value={signal} onChange={setSignal} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">FFT magnitude</CardTitle>
        </CardHeader>
        <CardContent>
          {raw ? <LineChart x={raw.fft.freqs} series={fftSeries} xLabel="Frequency [Hz]" /> : <Skeleton className="h-64 w-full" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Welch PSD (log)</CardTitle>
        </CardHeader>
        <CardContent>
          {raw ? <LineChart x={raw.psd.freqs} series={psdSeries} xLabel="Frequency [Hz]" logY /> : <Skeleton className="h-64 w-full" />}
        </CardContent>
      </Card>

      {raw && raw.peaks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detected peaks</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {raw.peaks.map((p, i) => (
              <Badge key={i} variant="secondary" className="tabular-nums">
                {p.frequency.toFixed(4)} Hz
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
