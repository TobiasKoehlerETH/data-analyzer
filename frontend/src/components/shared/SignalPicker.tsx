import { useState } from "react"

import { useStore } from "@/store"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"

/** Controlled signal list with search. Reused across screens with different selection semantics. */
export function SignalPicker({
  selected,
  onToggle,
}: {
  selected: string[]
  onToggle: (name: string) => void
}) {
  const signals = useStore((s) => s.signals)
  const [q, setQ] = useState("")
  const filtered = signals.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="flex flex-col gap-2">
      <Input placeholder="Search signals…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ScrollArea className="h-[calc(100vh-14rem)] pr-2">
        <div className="space-y-0.5">
          {filtered.map((s) => (
            <label
              key={s.name}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selected.includes(s.name)}
                onCheckedChange={() => onToggle(s.name)}
              />
              <span className="truncate">{s.name}</span>
              {s.unit && <span className="ml-auto text-xs text-muted-foreground">{s.unit}</span>}
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">No signals.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
