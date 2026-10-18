import { useState } from "react";
import { save, message } from "@/lib/platform";
import { openPath } from "@/lib/platform";
import { ExternalLink, FileDown, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckField, Field, Panel, StatusText } from "@/components/common";
import { api, errorText } from "@/lib/api";
import { useApp } from "@/lib/store";

const SECTIONS: { name: string; hint: string }[] = [
  { name: "Metadata", hint: "File metadata (Raser header, stashed text columns)" },
  { name: "Statistics", hint: "Descriptive statistics of all signals" },
  { name: "Signal Plots", hint: "All signals, four per figure" },
  { name: "Filters Applied", hint: "Filter chains applied to full data" },
  { name: "Correlations", hint: "Heatmap and top pairs (compute in the Correlations tab first)" },
  { name: "Models", hint: "All models in the library with per-output metrics" },
  { name: "Simulations", hint: "Current plots of the Simulation tab" },
  { name: "Validation", hint: "Last validation run (residuals + histogram)" },
  { name: "Comparison", hint: "Compare tab overlays and statistics (≥ 2 files)" },
];

export function ReportTab() {
  const { setProgress } = useApp();
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.name));
  const [format, setFormat] = useState<"HTML" | "PDF">("HTML");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [lastPath, setLastPath] = useState<string | null>(null);

  const browse = async () => {
    const ext = format.toLowerCase();
    const p = await save({ defaultPath: `report.${ext}`, filters: [{ name: `${format} Files`, extensions: [ext] }], title: "Save Report" });
    if (p) setPath(p);
  };

  const generate = async () => {
    if (!path) {
      await message("Select an output file path.", { title: "No Path", kind: "warning" });
      return;
    }
    setBusy(true);
    setStatus({ text: "Generating report..." });
    try {
      const r = await api.reportGenerate(sections, format.toLowerCase(), path);
      setLastPath(r.path);
      setStatus({ text: r.note ? `${r.note} Saved to: ${r.path}` : `Report saved to: ${r.path}`, error: !!r.note });
    } catch (e) {
      setStatus({ text: `Error: ${errorText(e)}`, error: true });
      setProgress("report", 100, "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full max-w-3xl flex-col gap-3">
      <Panel title="Report sections" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-2.5 p-4">
        {SECTIONS.map((s) => (
          <CheckField
            key={s.name}
            label={s.name}
            hint={s.hint}
            checked={sections.includes(s.name)}
            onChange={(v) => setSections(v ? [...sections, s.name] : sections.filter((x) => x !== s.name))}
          />
        ))}
      </Panel>
      <Panel title="Output" bodyClassName="flex flex-col gap-3 p-4">
        <Field label="Format" className="w-64" hint="PDF is rendered with the Edge browser that ships with Windows; falls back to HTML if unavailable">
          <Select
            value={format}
            onValueChange={(v) => {
              setFormat(v as "HTML" | "PDF");
              if (path) setPath(path.replace(/\.(html?|pdf)$/i, v === "PDF" ? ".pdf" : ".html"));
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="HTML">HTML</SelectItem>
              <SelectItem value="PDF">PDF</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="flex gap-2">
          <Input className="h-9 flex-1" placeholder="Select output file..." value={path} onChange={(e) => setPath(e.target.value)} title="Path where the generated report will be saved" />
          <Button variant="outline" className="h-9" onClick={browse}>
            <FolderOpen /> Browse…
          </Button>
        </div>
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-[15px]" onClick={generate} disabled={busy} title="Generate the report with all selected sections">
            <FileDown /> Generate Report
          </Button>
          <Button variant="outline" className="h-11" disabled={!lastPath} onClick={() => lastPath && openPath(lastPath)} title="Open the last generated report">
            <ExternalLink /> Open
          </Button>
        </div>
        <StatusText tone={status.error ? "error" : "muted"}>{status.text}</StatusText>
      </Panel>
    </div>
  );
}
