import { useState } from "react"
import { Download, FileText, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useStore } from "@/store"
import { NoDataset } from "@/components/shared/NoDataset"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"

const SECTIONS: { id: string; label: string }[] = [
  { id: "metadata", label: "File metadata" },
  { id: "stats", label: "Descriptive statistics" },
  { id: "plots", label: "Signal plots (selected signals)" },
  { id: "correlation", label: "Correlation heatmap" },
  { id: "models", label: "State-space models" },
]

export default function Report() {
  const { dataset, selected } = useStore()
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.id))
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (!dataset) return <NoDataset />

  const toggle = (id: string) =>
    setSections((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  async function generate() {
    setLoading(true)
    setHtml(null)
    try {
      const { jobId } = await api.report(dataset!.id, sections, selected, [])
      const res = await api.pollJob<{ html: string }>(jobId)
      setHtml(res.html)
      toast.success("Report generated")
    } catch (e) {
      toast.error("Report failed", { description: String(e) })
    } finally {
      setLoading(false)
    }
  }

  function download() {
    if (!html) return
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
    Object.assign(document.createElement("a"), {
      href: url,
      download: `${dataset!.filename}_report.html`,
    }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Report sections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {SECTIONS.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={sections.includes(s.id)} onCheckedChange={() => toggle(s.id)} />
              {s.label}
            </label>
          ))}
          <div className="flex gap-2 pt-2">
            <Button onClick={generate} disabled={loading || !sections.length}>
              {loading ? <Loader2 className="animate-spin" /> : <FileText />} Generate
            </Button>
            {html && (
              <Button variant="outline" onClick={download}>
                <Download /> Download HTML
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {html && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <iframe title="report" srcDoc={html} className="h-[70vh] w-full rounded border bg-white" />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
