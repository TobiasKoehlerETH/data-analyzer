import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Segmented } from "@/components/common";
import { Button } from "@/components/ui/button";
import { analysisVectors } from "@/lib/analysis";
import { api, errorText } from "@/lib/api";
import { buildInteractiveReport } from "@/lib/interactiveReport";
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
  { name: "Results", hint: "The table on the Results page" },
  { name: "Notes", hint: "Comments on time ranges" },
];
/** What the interactive report can hold. */
const INTERACTIVE = ["Metadata", "Statistics", "Signal Plots", "Filters Applied", "Results", "Notes"];

/** Pick what goes in, press one button, choose where to save: the report is written right away. */
export function ReportTab() {
  const { setProgress, dataset, results, notes } = useApp();
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.name));
  const [format, setFormat] = useState<"html" | "interactive" | "pdf">("html");
  const [busy, setBusy] = useState(false);

  const exportReport = async () => {
    const stem = dataset && dataset.path !== "Workspace" ? (dataset.path.split(/[\\/]/).pop() ?? "report").replace(/\.[^.]+$/, "") : "report";
    const ext = format === "pdf" ? "pdf" : "html";
    const picked = await save({ defaultPath: `${stem}-report${format === "interactive" ? "-interactive" : ""}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], title: "Save report" });
    if (!picked) return;
    const path = picked.toLowerCase().endsWith(`.${ext}`) ? picked : `${picked}.${ext}`;
    setBusy(true);
    if (format === "interactive") {
      try {
        if (!dataset) throw "No data loaded.";
        const [{ default: plotlyJs }, view, vec] = await Promise.all([
          import("plotly.js-dist-min/plotly.min.js?raw"),
          api.workspaceView(),
          analysisVectors(dataset.signals.map((x) => x.column), 200_000),
        ]);
        const title = view.sources.length === 1 ? view.sources[0].name.replace(/\.[^.]+$/, "") : stem === "report" ? `${view.sources.length} files` : stem;
        const html = buildInteractiveReport({ title, dataset, view, time: vec.time, columns: vec.columns, step: vec.step, results, notes, sections: sections.filter((x) => INTERACTIVE.includes(x)), plotlyJs });
        await api.saveText(path, html);
        toast.success(`Interactive report saved to ${path}`);
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const r = await api.reportGenerate(
        sections,
        format,
        path,
        results.map(({ group, name, signal, value, unit, source }) => ({ group, name, signal, value, unit, source })),
      );
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
            const off = format === "interactive" && !INTERACTIVE.includes(s.name);
            return (
              <button
                key={s.name}
                title={off ? `${s.hint} (HTML and PDF only)` : s.hint}
                aria-pressed={on}
                onClick={() => setSections(on ? sections.filter((x) => x !== s.name) : [...sections, s.name])}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                  on ? "border-ap-red bg-ap-red-soft font-medium text-ap-red-dark" : "border-ap-line text-muted-foreground hover:border-ap-bluegray-60 hover:text-foreground",
                  off && "opacity-40",
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
              { value: "interactive", label: "Interactive", hint: "One HTML file with zoomable charts and filterable tables; opens anywhere, no internet needed" },
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
