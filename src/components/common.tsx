import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/lib/store";
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
    <section className={cn("flex min-h-0 flex-col rounded-xl border border-ap-line bg-white shadow-[var(--ap-shadow-sm)]", className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-2 px-4 pt-2">
          {title && <h3 className="ap-eyebrow truncate">{title}</h3>}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn("min-h-0 flex-1 p-4", title || actions ? "pt-2" : "", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  const field = (
    <div className={cn("flex items-center gap-2", className)}>
      <Label className="shrink-0 text-[12.5px] font-normal text-muted-foreground">{label}</Label>
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
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-ap-bluegray-15"
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
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {children && <div className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Warns that the data changed after a result was computed (`version` = dataVersion then). */
export function StaleNote({ version }: { version: number | null }) {
  const current = useApp((s) => s.dataVersion);
  if (version === null || version === current) return null;
  return <p className="rounded-md bg-ap-red-soft px-2.5 py-1.5 text-xs text-ap-red-dark">The data changed since this result was computed. Run it again to update it.</p>;
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
        <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-[13px]" title={o.hint}>
          <RadioGroupItem value={o.value} />
          {o.label}
        </label>
      ))}
    </RadioGroup>
  );
}

export function CheckField({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]" title={hint}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} />
      {label}
    </label>
  );
}

/** Pill-style switch between a few options; the white pill slides to the chosen one. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; hint?: string }[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const measure = () => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const next = el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
    setPill((p) => (p?.left === next?.left && p?.width === next?.width ? p : next));
  };
  useLayoutEffect(measure, [value, options.length]);
  useEffect(() => {
    // Fonts and labels change widths after the first paint.
    if (!ref.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} role="tablist" className={cn("relative inline-flex items-center gap-0.5 rounded-lg bg-[#e8eaee] p-0.5", className)}>
      {pill && (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-md bg-white shadow-[var(--ap-shadow-sm)] transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-10 h-7 rounded-md px-3 text-[13px] whitespace-nowrap transition-colors",
              on ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              on && !pill && "bg-white shadow-[var(--ap-shadow-sm)]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
