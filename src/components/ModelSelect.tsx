import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/lib/store";

/** Model picker bound to the library; keeps the selection when the list changes. */
export function ModelSelect({ value, onChange, title }: { value: string | null; onChange: (v: string | null) => void; title?: string }) {
  const models = useApp((s) => s.models);
  useEffect(() => {
    if (value && !models.some((m) => m.name === value)) onChange(models[0]?.name ?? null);
    if (!value && models.length) onChange(models[0].name);
  }, [models, value, onChange]);
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-full" title={title}>
        <SelectValue placeholder={models.length ? "Select model" : "No models in library"} />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.name} value={m.name}>
            {m.name} <span className="text-xs text-muted-foreground">· {m.method} · n={m.order} · VAF {m.mean_vaf.toFixed(1)}%</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
