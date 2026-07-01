import { useEffect, useState } from "react"
import { Copy, Download, Pencil, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ModelSummary } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

function Matrix({ label, rows }: { label: string; rows: number[][] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {label} ({rows.length}×{rows[0]?.length ?? 0})
      </p>
      <div className="overflow-auto rounded border p-2 font-mono text-xs">
        {rows.map((r, i) => (
          <div key={i} className="whitespace-nowrap tabular-nums">
            {r.map((v) => v.toFixed(3).padStart(9)).join(" ")}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Models() {
  const [models, setModels] = useState<ModelSummary[]>([])
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)

  const refresh = () => api.models().then(setModels)
  useEffect(() => {
    refresh()
  }, [])

  async function act(fn: Promise<unknown>, msg: string) {
    try {
      await fn
      await refresh()
      toast.success(msg)
    } catch (e) {
      toast.error(String(e))
    }
  }

  function rename(name: string) {
    const next = window.prompt("Rename model", name)
    if (next && next !== name) act(api.renameModel(name, next), "Renamed")
  }

  async function exportLib() {
    const data = await api.exportModels()
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
    Object.assign(document.createElement("a"), { href: url, download: "model_library.json" }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Model library ({models.length})</CardTitle>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={exportLib}>
            <Download /> Export
          </Button>
          <label>
            <Button size="sm" variant="outline" asChild>
              <span>
                <Upload /> Import
              </span>
            </Button>
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) f.text().then((t) => act(api.importModels(JSON.parse(t).models ?? []), "Imported"))
              }}
            />
          </label>
        </div>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No models yet. Identify one in System ID.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Order</TableHead>
                <TableHead className="text-right">I/O</TableHead>
                <TableHead className="text-right">Mean VAF</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.name}>
                  <TableCell>
                    <button className="font-medium hover:underline" onClick={() => api.model(m.name).then(setDetail)}>
                      {m.name}
                    </button>
                  </TableCell>
                  <TableCell>{m.method}</TableCell>
                  <TableCell className="text-right">{m.order}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.nInputs}/{m.nOutputs}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.meanVaf.toFixed(1)}%</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => rename(m.name)}>
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => act(api.duplicateModel(m.name), "Duplicated")}
                    >
                      <Copy />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => act(api.deleteModel(m.name), "Deleted")}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.name as string}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Inputs: {(detail.input_names as string[]).join(", ")} · Outputs:{" "}
                {(detail.output_names as string[]).join(", ")}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Matrix label="A" rows={detail.A as number[][]} />
                <Matrix label="B" rows={detail.B as number[][]} />
                <Matrix label="C" rows={detail.C as number[][]} />
                <Matrix label="D" rows={detail.D as number[][]} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
