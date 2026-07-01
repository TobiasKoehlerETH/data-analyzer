import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { HeaderMode, ImportPreview, TableInspection } from "@/lib/types"
import { optionsForMode } from "@/routes/import-options"
import { useStore } from "@/store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

export default function Load() {
  const navigate = useNavigate()
  const setDataset = useStore((state) => state.setDataset)
  const { dataset, preview } = useStore()
  const [loading, setLoading] = useState(false)
  const [inspection, setInspection] = useState<TableInspection | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sheet, setSheet] = useState<string | null>(null)
  const [headerMode, setHeaderMode] = useState<HeaderMode>("auto")
  const [headerRow, setHeaderRow] = useState(1)
  const input = useRef<HTMLInputElement>(null)
  const inspectionToken = inspection?.token

  async function handleFile(file?: File) {
    if (!file) return
    setLoading(true)
    try {
      const result = await api.inspect(file)
      setInspection(result)
      setImportPreview({
        columns: result.columns,
        preview: result.preview,
        warnings: result.warnings,
      })
      setSheet(result.suggestedSheet)
      setHeaderMode("auto")
      setHeaderRow(result.suggestedHeaderRow ?? 1)
    } catch (error) {
      toast.error("Failed to inspect file", { description: String(error) })
    } finally {
      setLoading(false)
      if (input.current) input.current.value = ""
    }
  }

  useEffect(() => {
    if (!inspectionToken) return
    let active = true
    setPreviewing(true)
    api.preview(
      inspectionToken,
      optionsForMode(headerMode, headerRow, sheet),
    ).then((result) => {
      if (active) setImportPreview(result)
    }).catch((error) => {
      if (active) toast.error("Failed to refresh preview", { description: String(error) })
    }).finally(() => {
      if (active) setPreviewing(false)
    })
    return () => {
      active = false
    }
  }, [inspectionToken, sheet, headerMode, headerRow])

  async function confirmImport() {
    if (!inspection) return
    setLoading(true)
    try {
      const result = await api.load(
        inspection.token,
        optionsForMode(headerMode, headerRow, sheet),
      )
      setDataset(result.dataset, result.signals, result.preview)
      setInspection(null)
      setImportPreview(null)
      toast.success(`Loaded ${result.dataset.filename}`, {
        description: `${result.dataset.rows.toLocaleString()} rows · ${result.dataset.signalCount} signals`,
      })
      navigate("/plot")
    } catch (error) {
      toast.error("Failed to import table", { description: String(error) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          void handleFile(event.dataTransfer.files[0])
        }}
      >
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          {loading && !inspection ? (
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="size-8 text-muted-foreground" />
          )}
          <p className="text-sm text-muted-foreground">
            Drop a CSV or XLSX file here, or browse. Sheets and headers can be adjusted before import.
          </p>
          <input
            ref={input}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => void handleFile(event.target.files?.[0])}
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
            <Field
              label="Type"
              value={dataset.raser ? "Raser DataLog" : dataset.sheet ? "Excel workbook" : "Delimited table"}
            />
            {dataset.sheet && <Field label="Sheet" value={dataset.sheet} />}
            <Field label="Rows" value={dataset.rows.toLocaleString()} />
            <Field label="Signals" value={String(dataset.signalCount)} />
            {Object.entries(dataset.info).map(([key, value]) => (
              <Field key={key} label={key} value={value} />
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
            <PreviewTable
              columns={preview.columns.map((name) => ({ name, type: null }))}
              rows={preview.rows}
            />
          </CardContent>
        </Card>
      )}

      <Dialog
        open={inspection !== null}
        onOpenChange={(open) => {
          if (!open && !loading) {
            setInspection(null)
            setImportPreview(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Import {inspection?.filename}</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Review the detected table. Every readable column is retained.
            </p>
          </DialogHeader>

          {inspection && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {inspection.sheets.length > 0 && (
                  <div className="grid gap-1.5">
                    <Label>Sheet</Label>
                    <Select value={sheet ?? undefined} onValueChange={setSheet}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose a sheet" />
                      </SelectTrigger>
                      <SelectContent>
                        {inspection.sheets.map((item) => (
                          <SelectItem key={item.name} value={item.name}>
                            {item.name}{item.empty ? " (empty)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid gap-1.5">
                  <Label>Header</Label>
                  <Select
                    value={headerMode}
                    onValueChange={(value) => setHeaderMode(value as HeaderMode)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      <SelectItem value="first_row">First row</SelectItem>
                      <SelectItem value="none">No header</SelectItem>
                      <SelectItem value="row">Specific row</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {headerMode === "row" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="header-row">Header row</Label>
                    <Input
                      id="header-row"
                      type="number"
                      min={1}
                      value={headerRow}
                      onChange={(event) => setHeaderRow(Number(event.target.value))}
                    />
                  </div>
                )}
              </div>

              {importPreview && importPreview.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  {importPreview.warnings.map((warning) => (
                    <p key={warning} className="flex gap-2 text-sm">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              <div className="max-h-[48vh] overflow-auto rounded-lg border">
                {previewing && (
                  <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Refreshing preview
                  </div>
                )}
                {importPreview && (
                  <PreviewTable
                    columns={importPreview.columns}
                    rows={importPreview.preview.rows}
                  />
                )}
              </div>
            </>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                setInspection(null)
                setImportPreview(null)
              }}
            >
              Cancel
            </Button>
            <Button disabled={loading} onClick={() => void confirmImport()}>
              {loading && <Loader2 className="animate-spin" />}
              Import table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PreviewTable({
  columns,
  rows,
}: {
  columns: { name: string; type: string | null }[]
  rows: (string | number | boolean | null)[][]
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.name}>
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span>{column.name}</span>
                {column.type && <Badge variant="secondary">{column.type}</Badge>}
              </div>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIndex) => (
          <TableRow key={rowIndex}>
            {row.map((cell, columnIndex) => (
              <TableCell key={columnIndex} className="whitespace-nowrap tabular-nums">
                {cell === null ? "" : String(cell)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
