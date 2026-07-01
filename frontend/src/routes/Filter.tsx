import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Download, Plus, Trash2, Upload, Wand2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { FILTER_LABELS, FILTER_TYPES, newStep } from "@/lib/filters"
import { colorFor } from "@/lib/palette"
import type { FilterStep } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { SignalSelect } from "@/components/shared/SignalSelect"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

export default function Filter() {
  const { dataset, signals, selected, filters, setFilter } = useStore()
  const [signal, setSignal] = useState(selected[0] ?? signals[0]?.name ?? "")
  const steps = filters[signal] ?? []
  const setSteps = (s: FilterStep[]) => setFilter(signal, s)

  const [orig, setOrig] = useState<{ time: Float32Array; y: Float32Array } | null>(null)
  const [filtered, setFiltered] = useState<Float32Array | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!dataset || !signal) return
    setOrig(null)
    api.signalData(dataset.id, [signal]).then((d) => setOrig({ time: d.time, y: d.series[signal] }))
  }, [dataset, signal])

  const enabled = steps.filter((s) => s.enabled)
  const chainKey = JSON.stringify(enabled)
  useEffect(() => {
    if (!dataset || !signal) return
    if (enabled.length === 0) return setFiltered(null)
    const t = setTimeout(() => {
      api
        .filterApply(dataset.id, signal, { steps: enabled })
        .then(setFiltered)
        .catch((e) => toast.error("Filter failed", { description: String(e) }))
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, signal, chainKey])

  if (!dataset) return <NoDataset />

  const update = (i: number, fn: (s: FilterStep) => FilterStep) =>
    setSteps(steps.map((s, k) => (k === i ? fn(s) : s)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSteps(next)
  }

  async function suggest() {
    try {
      const s = await api.filterSuggest(dataset!.id, signal)
      if (!s.length) return toast.info("No filters suggested for this signal")
      setSteps([
        ...steps,
        ...s.map((x) => ({ filter_type: x.filterType, params: x.params, enabled: true })),
      ])
      toast.success(`Added ${s.length} suggested filter(s)`)
    } catch (e) {
      toast.error(String(e))
    }
  }

  function saveJson() {
    const blob = new Blob([JSON.stringify({ steps }, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement("a"), { href: url, download: `${signal}_filters.json` }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Filter chain</CardTitle>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" title="Auto-suggest" onClick={suggest}>
              <Wand2 />
            </Button>
            <Button size="icon" variant="ghost" title="Save chain" onClick={saveJson}>
              <Download />
            </Button>
            <Button size="icon" variant="ghost" title="Load chain" onClick={() => fileRef.current?.click()}>
              <Upload />
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) f.text().then((t) => setSteps(JSON.parse(t).steps ?? []))
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <SignalSelect value={signal} onChange={setSignal} />

          {steps.map((step, i) => (
            <div key={i} className="rounded-md border p-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={step.enabled}
                  onCheckedChange={() => update(i, (s) => ({ ...s, enabled: !s.enabled }))}
                />
                <span className="flex-1 text-sm font-medium">{FILTER_LABELS[step.filter_type]}</span>
                <Button size="icon" variant="ghost" className="size-7" onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button size="icon" variant="ghost" className="size-7" onClick={() => move(i, 1)}>
                  <ArrowDown />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setSteps(steps.filter((_, k) => k !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {Object.entries(step.params).map(([key, val]) => (
                  <label key={key} className="text-xs text-muted-foreground">
                    {key}
                    <Input
                      type="number"
                      value={val}
                      className="mt-0.5 h-7"
                      onChange={(e) =>
                        update(i, (s) => ({
                          ...s,
                          params: { ...s.params, [key]: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full">
                <Plus /> Add filter
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {FILTER_TYPES.map((t) => (
                <DropdownMenuItem key={t} onClick={() => setSteps([...steps, newStep(t)])}>
                  {FILTER_LABELS[t]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preview: {signal}</CardTitle>
        </CardHeader>
        <CardContent>
          {orig ? (
            <LineChart
              x={orig.time}
              series={[
                { label: "Original", y: orig.y, color: colorFor(0) },
                ...(filtered ? [{ label: "Filtered", y: filtered, color: colorFor(1) }] : []),
              ]}
              xLabel="Time [s]"
              height={360}
            />
          ) : (
            <Skeleton className="h-80 w-full" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
