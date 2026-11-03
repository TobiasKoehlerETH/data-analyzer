import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface Command {
  id: string;
  /** Section heading the command is listed under. */
  group: string;
  label: string;
  /** Muted text after the label (a file, a unit, a hint). */
  detail?: string;
  icon?: LucideIcon;
  /** Shortcut shown on the right, e.g. "Ctrl O". */
  keys?: string;
  /** Extra words that should match, e.g. "fft" for Spectrum. */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** Scores how well `query` matches `text`: every query word must appear; earlier and word-start matches rank higher. */
function score(query: string, text: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    const wordStart = i === 0 || /[\s\-_(·/[]/.test(hay[i - 1]);
    total += (wordStart ? 3 : 1) + 1 / (1 + i);
  }
  return total;
}

/** Ctrl+K: jump to any page or signal and run common actions from the keyboard. */
export function CommandPalette({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (v: boolean) => void; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = commands
      .filter((c) => !c.disabled)
      .map((c, order) => ({ c, order, s: score(query, `${c.label} ${c.detail ?? ""} ${c.group} ${c.keywords ?? ""}`) }))
      .filter((r) => r.s > 0);
    // Without a query keep the given order (grouped); with one, best match first.
    if (query.trim()) scored.sort((a, b) => b.s - a.s || a.order - b.order);
    return scored.map((r) => r.c).slice(0, 60);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    // Let the dialog close before the command opens another one or moves focus.
    setTimeout(c.run, 0);
  };

  // Group headings only for the unfiltered list; a ranked list reads better flat.
  const grouped = !query.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[14%] translate-y-0 gap-0 overflow-hidden bg-white p-0 sm:max-w-[600px]" aria-describedby="palette-help">
        <DialogTitle className="sr-only">Search pages, signals and actions</DialogTitle>
        <DialogDescription id="palette-help" className="sr-only">
          Type to filter. Use the arrow keys to choose and Enter to run.
        </DialogDescription>
        <div className="flex items-center gap-2.5 border-b border-ap-line px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(results[active]);
              }
            }}
            placeholder="Go to a page, open a signal or run an action…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          />
          <kbd className="rounded border border-ap-line bg-ap-bluegray-15 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="max-h-[420px] overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">Nothing matches “{query}”.</p>}
          {results.map((c, i) => {
            const Icon = c.icon;
            const heading = grouped && (i === 0 || results[i - 1].group !== c.group);
            return (
              <div key={c.id}>
                {heading && <p className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{c.group}</p>}
                <button
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(c)}
                  className={cn("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13.5px]", i === active ? "bg-ap-bluegray-15" : "")}
                >
                  <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md border border-ap-line bg-white", i === active ? "text-ap-red" : "text-ap-bluegray")}>
                    {Icon && <Icon className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {c.label}
                    {c.detail && <span className="ml-2 text-[12px] text-muted-foreground">{c.detail}</span>}
                  </span>
                  {!grouped && <span className="shrink-0 text-[11.5px] text-muted-foreground">{c.group}</span>}
                  {c.keys && <Keys keys={c.keys} />}
                  {i === active && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-ap-line bg-[#fafbfc] px-4 py-2 text-[11.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Keys keys="↑ ↓" /> choose
          </span>
          <span className="flex items-center gap-1.5">
            <Keys keys="Enter" /> run
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            <Keys keys="?" /> all shortcuts
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A key combination as small key caps: "Ctrl K" → [Ctrl] [K]. */
export function Keys({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {keys.split(" ").map((k, i) => (
        <kbd key={i} className="min-w-5 rounded border border-ap-line bg-white px-1 py-px text-center font-sans text-[10.5px] leading-4 text-muted-foreground shadow-[0_1px_0_var(--ap-line)]">
          {k}
        </kbd>
      ))}
    </span>
  );
}
