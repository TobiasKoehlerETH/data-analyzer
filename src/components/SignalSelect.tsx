import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SignalInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function SignalSelect({
  signals,
  value,
  onChange,
  className,
  placeholder = "Select signal",
  title,
  edited = [],
}: {
  signals: SignalInfo[];
  value: string | null;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  title?: string;
  /** Signals with processing steps, tagged in the list. */
  edited?: string[];
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger className={cn("h-8 w-full", className)} title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {signals.map((s) => (
          <SelectItem key={s.column} value={s.column}>
            {s.label}
            {edited.includes(s.column) && <span className="ml-1 text-[10px] text-muted-foreground">edited</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
