import { useStore } from "@/store"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

/** Single-signal dropdown backed by the loaded dataset's signals. */
export function SignalSelect({
  value,
  onChange,
  placeholder = "Select a signal",
}: {
  value?: string
  onChange: (name: string) => void
  placeholder?: string
}) {
  const signals = useStore((s) => s.signals)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {signals.map((s) => (
          <SelectItem key={s.name} value={s.name}>
            {s.name}
            {s.unit && <span className="text-muted-foreground"> [{s.unit}]</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
