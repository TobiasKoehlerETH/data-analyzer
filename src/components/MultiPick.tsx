import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** A button that opens a checklist; the label sums up the choice ("Force, Distance" or "3 signals"). */
export function MultiPick<T extends string>({
  label,
  noun,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  /** Plural noun for the summary, e.g. "signals". */
  noun: string;
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  className?: string;
}) {
  const picked = options.filter((o) => value.includes(o.value));
  const summary = picked.length === 0 ? "None" : picked.length <= 2 ? picked.map((p) => p.label).join(", ") : `${picked.length} ${noun}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={className} title={picked.map((p) => p.label).join("\n")}>
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-48 truncate font-medium">{summary}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={(e) => (e.preventDefault(), onChange(options.map((o) => o.value)))}>Select all</DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => (e.preventDefault(), onChange([]))}>Clear</DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={value.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onChange(on ? options.filter((x) => x.value === o.value || value.includes(x.value)).map((x) => x.value) : value.filter((v) => v !== o.value))}
          >
            <span className="truncate">{o.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
