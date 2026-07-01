import { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useStore } from "@/store"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

export default function Load() {
  const navigate = useNavigate()
  const setDataset = useStore((s) => s.setDataset)
  const { dataset, preview } = useStore()
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function handleFile(file?: File) {
    if (!file) return
    setLoading(true)
    try {
      const { dataset, signals, preview } = await api.load(file)
      setDataset(dataset, signals, preview)
      toast.success(`Loaded ${dataset.filename}`, {
        description: `${dataset.rows.toLocaleString()} rows · ${dataset.signalCount} signals`,
      })
      navigate("/plot")
    } catch (e) {
      toast.error("Failed to load file", { description: String(e) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void handleFile(e.dataTransfer.files[0])
        }}
      >
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          {loading ? (
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="size-8 text-muted-foreground" />
          )}
          <p className="text-sm text-muted-foreground">
            Drop a CSV here, or browse. Raser DataLog and generic CSVs are auto-detected.
          </p>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <Button disabled={loading} onClick={() => input.current?.click()}>
            Browse files
          </Button>
        </CardContent>
      </Card>

      {dataset && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detected format</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
            <Field label="File" value={dataset.filename} />
            <Field label="Type" value={dataset.raser ? "Raser DataLog" : "Generic CSV"} />
            <Field label="Rows" value={dataset.rows.toLocaleString()} />
            <Field label="Signals" value={String(dataset.signalCount)} />
            {Object.entries(dataset.info).map(([k, v]) => (
              <Field key={k} label={k} value={v} />
            ))}
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview (first {preview.rows.length} rows)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {preview.columns.map((c) => (
                    <TableHead key={c}>{c}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((cell, j) => (
                      <TableCell key={j} className="tabular-nums">{cell}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  )
}
