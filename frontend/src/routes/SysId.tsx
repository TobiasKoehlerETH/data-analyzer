import { useEffect, useState } from "react"
import { Cpu } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { colorFor } from "@/lib/palette"
import type { ModelSummary, SysIdPlan, SysIdResult } from "@/lib/types"
import { useStore } from "@/store"
import { LineChart } from "@/components/plots/LineChart"
import { NoDataset } from "@/components/shared/NoDataset"
import { IconButton } from "@/components/shared/IconButton"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

export default function SysId() {
  const { dataset, signals } = useStore()
  const [inputs, setInputs] = useState<string[]>([])
  const [outputs, setOutputs] = useState<string[]>([])
  const [method, setMethod] = useState("N4SID")
  const [orderMin, setOrderMin] = useState(2)
  const [orderMax, setOrderMax] = useState(8)
  const [autoDecimate, setAutoDecimate] = useState(true)
  const [plan, setPlan] = useState<SysIdPlan | null>(null)
  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>(null)
  const [sweep, setSweep] = useState<ModelSummary[] | null>(null)

  useEffect(() => {
    if (dataset)
      api.sysidSuggestIo(dataset.id).then((r) => {
        setInputs(r.inputs)
        setOutputs(r.outputs)
      })
  }, [dataset])

  useEffect(() => {
    if (!dataset || !inputs.length || !outputs.length) return setPlan(null)
    api
      .sysidPlan({ datasetId: dataset.id, inputs, outputs, orderMin, orderMax, autoDecimate })
      .then(setPlan)
      .catch(() => {})
  }, [dataset, inputs, outputs, orderMin, orderMax, autoDecimate])

  if (!dataset) return <NoDataset />

  const toggle = (name: string, into: "in" | "out") => {
    if (into === "in") {
      setOutputs((o) => o.filter((n) => n !== name))
      setInputs((i) => (i.includes(name) ? i.filter((n) => n !== name) : [...i, name]))
    } else {
      setInputs((i) => i.filter((n) => n !== name))
      setOutputs((o) => (o.includes(name) ? o.filter((n) => n !== name) : [...o, name]))
    }
  }

  async function run() {
    if (!inputs.length || !outputs.length) return toast.error("Pick at least one input and one output")
    setProgress({ pct: 0, msg: "Starting…" })
    setSweep(null)
    try {
      const { jobId } = await api.sysidEstimate({
        datasetId: dataset!.id, inputs, outputs, method, orderMin, orderMax, autoDecimate,
      })
      const res = await api.pollJob<SysIdResult>(jobId, (pct, msg) => setProgress({ pct, msg }))
      setSweep(res.sweep)
      toast.success(res.bestName ? `Best model saved: ${res.bestName}` : "No model identified")
    } catch (e) {
      toast.error("Identification failed", { description: String(e) })
    } finally {
      setProgress(null)
    }
  }

  const byOrder = sweep ? [...sweep].sort((a, b) => a.order - b.order) : []

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Input / output mapping</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-72 pr-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <span className="flex-1">Signal</span>
                  <span className="w-10 text-center">In</span>
                  <span className="w-10 text-center">Out</span>
                </div>
                {signals.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent">
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="flex w-10 justify-center">
                      <Checkbox checked={inputs.includes(s.name)} onCheckedChange={() => toggle(s.name, "in")} />
                    </span>
                    <span className="flex w-10 justify-center">
                      <Checkbox checked={outputs.includes(s.name)} onCheckedChange={() => toggle(s.name, "out")} />
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["N4SID", "MOESP", "CVA"].map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label className="text-xs">Order min</Label>
                <Input type="number" className="mt-1 h-8" value={orderMin} onChange={(e) => setOrderMin(+e.target.value)} />
              </div>
              <div className="flex-1">
                <Label className="text-xs">Order max</Label>
                <Input type="number" className="mt-1 h-8" value={orderMax} onChange={(e) => setOrderMax(+e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Auto-decimate</Label>
              <Switch checked={autoDecimate} onCheckedChange={setAutoDecimate} />
            </div>
            {plan && (
              <p className="text-xs text-muted-foreground">
                {plan.samples.toLocaleString()} samples (÷{plan.decimation}) · est.{" "}
                {plan.estimatedSeconds < 1 ? "<1" : plan.estimatedSeconds.toFixed(0)}s
              </p>
            )}
            {progress ? (
              <div className="space-y-1">
                <Progress value={progress.pct} />
                <p className="text-xs text-muted-foreground">{progress.msg}</p>
              </div>
            ) : (
              <IconButton label="Identify model" onClick={run}>
                <Cpu />
              </IconButton>
            )}
          </CardContent>
        </Card>
      </div>

      {sweep && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">VAF vs. order</CardTitle>
            </CardHeader>
            <CardContent>
              <LineChart
                x={byOrder.map((m) => m.order)}
                series={[{ label: "Mean VAF %", y: byOrder.map((m) => m.meanVaf), color: colorFor(0) }]}
                xLabel="Model order"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order sweep</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead className="text-right">Mean VAF</TableHead>
                    <TableHead className="text-right">Best VAF</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byOrder.map((m) => (
                    <TableRow key={m.name}>
                      <TableCell>{m.order}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.meanVaf.toFixed(1)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{m.bestVaf.toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
