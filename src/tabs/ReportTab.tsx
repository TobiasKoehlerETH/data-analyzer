import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Segmented } from "@/components/common";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { save } from "@/lib/platform";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const SECTIONS: { name: string; hint: string }[] = [
  { name: "Metadata", hint: "File information" },
  { name: "Statistics", hint: "Summary statistics of all signals" },
  { name: "Signal Plots", hint: "All signals, four per figure" },
  { name: "Filters Applied", hint: "The processing steps of each signal" },
  { name: "Correlations", hint: "Heatmap and strongest pairs (open Correlations first)" },
  { name: "Models", hint: "Every stored model with its metrics" },
  { name: "Simulations", hint: "The plots of the Model page" },
  { name: "Validation", hint: "The last validation run" },
  { name: "Comparison", hint: "File overlays and statistics (two or more files)" },
];

/** Pick what goes in, press one button, choose where to save: the report is written right away. */
export function ReportTab() {
  const { setProgress, dataset } = useApp();
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.name));
  const [format, setFormat] = useState<"html" | "pdf">("html");
  const [busy, setBusy] = useState(false);

  const exportReport = async () => {
    const stem = dataset && dataset.path !== "Workspace" ? (dataset.path.split(/[\\/]/).pop() ?? "report").replace(/\.[^.]+$/, "") : "report";
    const picked = await save({ defaultPath: `${stem}-report.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }], title: "Save report" });
    if (!picked) return;
    const path = picked.toLowerCase().endsWith(`.${format}`) ? picked : `${picked}.${format}`;
    setBusy(true);
    try {
      const r = await api.reportGenerate(sections, format, path);
      if (r.note) toast.warning(`${r.note} Saved to ${r.path}`);
      else toast.success(`Report saved to ${r.path}`);
    } catch (e) {
      toast.error(errorText(e));
      setProgress("report", 100, "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-[560px] max-w-full flex-col gap-6 rounded-2xl border border-ap-line bg-white p-8 shadow-[var(--ap-shadow)]">
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => {
            const on = sections.includes(s.name);
            return (
              <button
                key={s.name}
                title={s.hint}
                aria-pressed={on}
                onClick={() => setSections(on ? sections.filter((x) => x !== s.name) : [...sections, s.name])}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                  on ? "border-ap-red bg-ap-red-soft font-medium text-ap-red-dark" : "border-ap-line text-muted-foreground hover:border-ap-bluegray-60 hover:text-foreground",
                )}
              >
                {s.name}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: "html", label: "HTML" },
              { value: "pdf", label: "PDF", hint: "Rendered with the Edge browser that ships with Windows" },
            ]}
          />
          <Button size="lg" className="h-11 flex-1 text-[15px]" onClick={exportReport} disabled={busy || sections.length === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <FileDown />} {busy ? "Creating report…" : "Create report"}
          </Button>
        </div>
      </div>
    </div>
  );
}
