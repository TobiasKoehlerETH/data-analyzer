import { useEffect, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A+P content panel: white surface, thin rule, uppercase eyebrow title. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col border border-ap-line bg-white", className)}>
      {(title || actions) && (
        <header className="flex min-h-9 items-center justify-between gap-2 border-b border-ap-line px-3 py-1.5">
          {title && <h3 className="ap-eyebrow truncate">{title}</h3>}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn("min-h-0 flex-1 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  const field = (
    <div className={cn("flex items-center gap-2", className)}>
      <Label className="shrink-0 text-[12px] font-normal text-muted-foreground">{label}</Label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
  if (!hint) return field;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{field}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Numeric input that keeps a local text buffer and commits valid values. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  integer = false,
  className,
  suffix,
  disabled,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  className?: string;
  suffix?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = (raw: string) => {
    let v = Number(raw.replace(",", "."));
    if (!Number.isFinite(v)) return;
    if (integer) v = Math.round(v);
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <div className={cn("relative", className)}>
      <Input
        type="number"
        className={cn("h-8 tabular-nums", suffix && "pr-7")}
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        title={title}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) {
            commit(e.target.value);
          }
        }}
        onBlur={(e) => {
          commit(e.target.value);
          setText(String(value));
        }}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export interface CheckItem {
  id: string;
  label: string;
  hint?: string;
  color?: string;
}

export function CheckList({
  items,
  checked,
  onChange,
  className,
  emptyText = "Nothing to show.",
}: {
  items: CheckItem[];
  checked: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="p-2 text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <ul className={cn("min-h-0 overflow-auto", className)}>
      {items.map((it) => {
        const on = checked.includes(it.id);
        return (
          <li key={it.id}>
            <label
              className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12.5px] hover:bg-ap-bluegray-15"
              title={it.hint ?? it.label}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(v) => onChange(v ? [...checked, it.id] : checked.filter((c) => c !== it.id))}
              />
              {it.color && <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: it.color }} />}
              <span className="truncate">{it.label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="text-ap-bluegray-60">{icon}</div>}
      <p className="text-[15px] text-ap-red">{title}</p>
      {children && <div className="max-w-md text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

export function StatusText({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" | "ok" }) {
  return (
    <p
      className={cn(
        "min-h-5 truncate text-xs",
        tone === "error" ? "text-destructive" : tone === "ok" ? "text-ap-darkblue" : "text-muted-foreground",
      )}
      title={typeof children === "string" ? children : undefined}
    >
      {children}
    </p>
  );
}

export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export function Radios<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; hint?: string }[];
  className?: string;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className={cn("flex flex-wrap gap-x-4 gap-y-1", className)}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-[12.5px]" title={o.hint}>
          <RadioGroupItem value={o.value} />
          {o.label}
        </label>
      ))}
    </RadioGroup>
  );
}

export function CheckField({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px]" title={hint}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} />
      {label}
    </label>
  );
}
