import { useEffect, useMemo, useState } from "react"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { CompareOverlay } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { SignalSelect } from "@/components/shared/SignalSelect"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

type CmpFile = { id: string; name: string; offset: number }

export default function Compare() {
  const { dataset, selected, signals } = useStore()
  const [files, setFiles] = useState<CmpFile[]>([])
  const [signal, setSignal] = useState(selected[0] ?? signals[0]?.name ?? "")
  const [overlay, setOverlay] = useState<CompareOverlay | null>(null)

  // Seed with the currently-loaded dataset as the reference file.
  useEffect(() => {
    if (dataset) setFiles([{ id: dataset.id, name: dataset.filename, offset: 0 }])
  }, [dataset])

  const offsets = useMemo(
    () => Object.fromEntries(files.map((f) => [f.id, f.offset])),
    [files],
  )
  const key = JSON.stringify({ ids: files.map((f) => f.id), signal, offsets })

  useEffect(() => {
    if (files.length < 1 || !signal) return
    api
      .compareOverlay(files.map((f) => f.id), signal, offsets)
      .then(setOverlay)
      .catch((e) => toast.error(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!dataset) return <NoDataset />

  async function addFile(file?: File) {
    if (!file) return
    try {
      const { dataset: d } = await api.load(file)
      setFiles((f) => [...f, { id: d.id, name: d.filename, offset: 0 }])
      toast.success(`Added ${d.filename}`)
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Files</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SignalSelect value={signal} onChange={setSignal} />
          {files.map((f, i) => (
            <div key={f.id} className="flex items-center gap-2">
              <span
                className="size-3 shrink-0 rounded-full"
                style={{ background: colorFor(i) }}
              />
              <span className="flex-1 truncate text-sm" title={f.name}>
                {f.name}
              </span>
              <Input
                type="number"
                value={f.offset}
                title="Time offset (s)"
                className="h-7 w-20"
                onChange={(e) =>
                  setFiles((fs) => fs.map((x, k) => (k === i ? { ...x, offset: +e.target.value } : x)))
                }
              />
              {i > 0 && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setFiles((fs) => fs.filter((_, k) => k !== i))}
                >
                  <X />
                </Button>
              )}
            </div>
          ))}
          <label>
            <Button variant="outline" className="w-full" asChild>
              <span>
                <Plus /> Add file
              </span>
            </Button>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void addFile(e.target.files?.[0])}
            />
          </label>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Overlay{overlay && ` — ${overlay.matchedColumn}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overlay ? (
              <LineChart
                x={overlay.time}
                series={overlay.files.map((f, i) => ({
                  label: f.name,
                  y: f.values,
                  color: colorFor(i),
                }))}
                xLabel="Time [s]"
                height={320}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Add a file to compare.</p>
            )}
          </CardContent>
        </Card>

        {overlay && overlay.stats.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comparison stats (vs reference)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead className="text-right">RMSE</TableHead>
                    <TableHead className="text-right">Max dev</TableHead>
                    <TableHead className="text-right">R²</TableHead>
                    <TableHead className="text-right">Mean error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overlay.stats.map((s) => (
                    <TableRow key={s.file}>
                      <TableCell>{s.file}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.rmse.toFixed(4)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.maxDev.toFixed(4)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.r2.toFixed(4)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.meanError.toFixed(4)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
