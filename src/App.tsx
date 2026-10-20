import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, open, save, message, isTauri } from "@/lib/platform";
import { BrushCleaning, ChartLine, Cpu, Database, FileText, FolderOpen, Microscope, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, DATA_FILE_EXTENSIONS, DATA_FILE_FILTERS, errorText, JSON_FILTERS, type ProgressEvent } from "@/lib/api";
import { useApp, type TabId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { WorkspaceActive } from "@/lib/workspace";
import { FileTab } from "@/tabs/FileTab";
import { PrepareTab } from "@/tabs/PrepareTab";
import { TimeSeriesTab } from "@/tabs/TimeSeriesTab";
import { StatisticsTab } from "@/tabs/StatisticsTab";
import { CompareTab } from "@/tabs/CompareTab";
import { SpectrumTab } from "@/tabs/SpectrumTab";
import { CorrelationTab } from "@/tabs/CorrelationTab";
import { ModelTab } from "@/tabs/ModelTab";
import { ReportTab } from "@/tabs/ReportTab";
import { CurveFitTab } from "@/tabs/CurveFitTab";

interface PageDef {
  label: string;
  component: () => React.ReactElement;
  /** One-line instruction shown beside the page tabs. */
  hint: string;
  needsData?: boolean;
}

const PAGES: Record<TabId, PageDef> = {
  file: { label: "Data", component: FileTab, hint: "Add columns from any number of files as variables." },
  prepare: { label: "Prepare", component: PrepareTab, hint: "Clean and filter one signal at a time. Every step is a block you can inspect, edit or delete.", needsData: true },
  timeseries: { label: "Plot", component: TimeSeriesTab, hint: "Tick signals on the left to plot them. Drag to zoom, double-click to reset.", needsData: true },
  statistics: { label: "Distribution", component: StatisticsTab, hint: "Pick a signal; drag on any chart to select rows and compare.", needsData: true },
  compare: { label: "Compare files", component: CompareTab, hint: "Overlay the workspace's files and line them up; shifts apply everywhere." },
  spectrum: { label: "Spectrum", component: SpectrumTab, hint: "See which frequencies a signal contains. Drag the cutoff line, then add a low-pass there.", needsData: true },
  correlation: { label: "Correlations", component: CorrelationTab, hint: "Find signals that move together. Click a cell or pair for details.", needsData: true },
  curvefit: { label: "Curve fit", component: CurveFitTab, hint: "Pick X and Y variables, choose a model and fit.", needsData: true },
  model: { label: "Model", component: ModelTab, hint: "Identify, store, simulate and validate state-space models." },
  report: { label: "Report", component: ReportTab, hint: "Choose sections and export the analysis as HTML or PDF." },
};

interface Step {
  id: string;
  label: string;
  icon: LucideIcon;
  pages: TabId[];
}

/** The workflow, left to right. Steps with several pages show them as tabs underneath. */
const STEPS: Step[] = [
  { id: "data", label: "Data", icon: Database, pages: ["file"] },
  { id: "prepare", label: "Prepare", icon: BrushCleaning, pages: ["prepare"] },
  { id: "explore", label: "Explore", icon: ChartLine, pages: ["timeseries", "statistics", "compare"] },
  { id: "analyse", label: "Analyse", icon: Microscope, pages: ["spectrum", "correlation", "curvefit"] },
  { id: "model", label: "Model", icon: Cpu, pages: ["model"] },
  { id: "report", label: "Report", icon: FileText, pages: ["report"] },
];
const ORDER: TabId[] = STEPS.flatMap((s) => s.pages);

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `~${s}s left`;
  return `~${Math.floor(s / 60)}m ${s % 60}s left`;
}

function NeedsData({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-[420px] flex-col items-center gap-4 rounded-2xl border border-ap-line bg-white p-10 text-center shadow-[var(--ap-shadow)]">
        <span className="flex size-12 items-center justify-center rounded-full bg-ap-red-soft text-ap-red">
          <Database className="size-5" />
        </span>
        <div>
          <h2 className="text-[18px]">No data yet</h2>
        </div>
        <Button size="lg" onClick={onImport}>
          <Plus /> Add data
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const { activeTab, setActiveTab, flash, progress, setProgress, dataset, models, refreshModels, showStatus } = useApp();
  const [now, setNow] = useState(Date.now());
  const [visited, setVisited] = useState(() => new Set<TabId>([activeTab]));
  /** The page last open in each step, so switching steps returns to where you were. */
  const [lastPage, setLastPage] = useState<Record<string, TabId>>({});

  useEffect(() => {
    setVisited((v) => (v.has(activeTab) ? v : new Set([...v, activeTab])));
    const step = STEPS.find((s) => s.pages.includes(activeTab));
    if (step) setLastPage((l) => (l[step.id] === activeTab ? l : { ...l, [step.id]: activeTab }));
  }, [activeTab]);

  useEffect(() => {
    refreshModels().catch(() => {});
    // Restore the backend's current dataset after a reload.
    api.datasetInfo().then((d) => d && !useApp.getState().dataset && useApp.getState().setDataset(d)).catch(() => {});
  }, [refreshModels]);

  useEffect(() => {
    const un = listen<ProgressEvent>("progress", (e) => setProgress(e.payload.task, e.payload.value, e.payload.message));
    return () => {
      un.then((f) => f());
    };
  }, [setProgress]);

  useEffect(() => {
    if (!progress) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [progress]);

  /** Sends files to the Data page import queue. */
  const addFiles = (paths: string[]) => {
    if (!paths.length) return;
    setActiveTab("file");
    setTimeout(() => window.dispatchEvent(new CustomEvent("workspace-add-files", { detail: paths })), 0);
  };
  const openFiles = async () => {
    const picked = await open({ multiple: true, filters: DATA_FILE_FILTERS, title: "Open data file(s)" });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    addFiles(paths);
  };
  const saveModels = async () => {
    const path = await save({ filters: JSON_FILTERS, title: "Save Model Library", defaultPath: "models.json" });
    if (!path) return;
    try {
      await api.modelsSave(path);
      showStatus(`Models saved to ${path}`);
    } catch (e) {
      await message(errorText(e), { title: "Save failed", kind: "error" });
    }
  };
  const loadModels = async () => {
    const path = await open({ filters: JSON_FILTERS, title: "Load Model Library" });
    if (typeof path !== "string") return;
    try {
      await api.modelsLoad(path);
      await refreshModels();
      showStatus(`Models loaded from ${path}`);
    } catch (e) {
      await message(errorText(e), { title: "Load failed", kind: "error" });
    }
  };
  const exportData = () => window.dispatchEvent(new Event("export-data"));
  const exit = () => {
    if (isTauri) getCurrentWindow().close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if ((k === "pageup" || k === "pagedown") && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        const step = k === "pagedown" ? 1 : -1;
        setActiveTab(ORDER[(ORDER.indexOf(activeTab) + step + ORDER.length) % ORDER.length]);
      } else if (k === "o") {
        e.preventDefault();
        openFiles();
      } else if (k === "e") {
        e.preventDefault();
        exportData();
      } else if (k === "s") {
        e.preventDefault();
        saveModels();
      } else if (k === "l") {
        e.preventDefault();
        loadModels();
      } else if (k === "q") {
        e.preventDefault();
        exit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Drag & drop of data files onto the window.
  useEffect(() => {
    if (!isTauri) return;
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      const paths = e.payload.paths.filter((p) => DATA_FILE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? ""));
      if (paths.length === 0) {
        showStatus("Unsupported file type. Drop CSV, TXT, TSV or Excel files.");
        return;
      }
      if (useApp.getState().activeTab === "compare") window.dispatchEvent(new CustomEvent("compare-add-files", { detail: paths }));
      else addFiles(paths);
    });
    return () => {
      un.then((f) => f());
    };
  });

  const eta = progress && progress.value > 2 ? formatEta(((now - progress.startedAt) * (100 - progress.value)) / progress.value) : "";
  const stepIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.pages.includes(activeTab)),
  );
  const step = STEPS[stepIndex];
  const dataName = useMemo(() => {
    if (!dataset) return "";
    return dataset.path === "Workspace" ? "Workspace" : (dataset.path.split(/[\\/]/).pop() ?? dataset.path);
  }, [dataset]);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        {/* Top bar: brand, the workflow, the data in use */}
        <header className="flex h-14 shrink-0 items-center gap-6 border-b border-ap-line bg-white px-5">
          <span className="shrink-0 text-[15px] font-semibold tracking-tight">Data Analyzer</span>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Workflow">
            {STEPS.map((s, si) => {
              const active = si === stepIndex;
              const locked = !dataset && s.pages.every((p) => PAGES[p].needsData);
              const badge = s.id === "model" && models.length > 0 ? models.length : null;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveTab(lastPage[s.id] ?? s.pages[0])}
                  title={PAGES[s.pages[0]].hint}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "group relative flex h-9 items-center gap-2 rounded-lg px-3 text-[13.5px] whitespace-nowrap transition-colors",
                    active ? "bg-ap-bluegray-15 font-semibold text-foreground" : "text-muted-foreground hover:bg-[#f6f7f9] hover:text-foreground",
                    locked && !active && "opacity-55",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold",
                      active ? "bg-ap-red text-white" : "bg-ap-bluegray-15 text-ap-bluegray",
                    )}
                  >
                    {si + 1}
                  </span>
                  <Icon className="hidden size-4 xl:block" strokeWidth={1.8} />
                  {s.label}
                  {badge !== null && <span className="rounded-full bg-ap-red px-1.5 text-[10.5px] font-semibold text-white">{badge}</span>}
                </button>
              );
            })}
          </nav>
          <button
            onClick={() => setActiveTab("file")}
            className="flex max-w-[320px] shrink-0 items-center gap-2.5 max-lg:hidden rounded-lg border border-ap-line bg-white py-1.5 pr-3 pl-2.5 text-left hover:border-ap-bluegray-60"
            title={dataset ? `${dataset.path}\nClick to manage the data` : "Add data"}
          >
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", dataset ? "bg-ap-bluegray-15 text-ap-bluegray" : "bg-ap-red-soft text-ap-red")}>
              {dataset ? <FolderOpen className="size-4" /> : <Plus className="size-4" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] leading-tight font-medium">{dataset ? dataName : "Add data"}</span>
              <span className="block truncate text-[11.5px] leading-tight text-muted-foreground tabular-nums">
                {dataset ? `${dataset.n_signals} signals · ${dataset.duration >= 100 ? Math.round(dataset.duration).toLocaleString("en-US") : Number(dataset.duration.toPrecision(3))} s` : "Nothing loaded"}
              </span>
            </span>
          </button>
        </header>

        {/* Page tabs, only for steps with more than one page */}
        {step.pages.length > 1 && (
          <div className="flex h-12 shrink-0 items-center border-b border-ap-line bg-[#fafbfc] px-5">
            <div role="tablist" className="flex items-center gap-0.5 rounded-lg bg-[#e8eaee] p-0.5">
              {step.pages.map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={id === activeTab}
                  onClick={() => setActiveTab(id)}
                  title={PAGES[id].hint}
                  className={cn(
                    "h-7 rounded-md px-3.5 text-[13px] whitespace-nowrap transition-colors",
                    id === activeTab ? "bg-white font-semibold text-foreground shadow-[var(--ap-shadow-sm)]" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {PAGES[id].label}
                </button>
              ))}
            </div>
          </div>
        )}

        <main className="relative min-h-0 flex-1">
          {ORDER.map((id) => {
            if (id !== activeTab && !visited.has(id)) return null;
            const P = PAGES[id];
            const C = P.component;
            const locked = P.needsData && !dataset;
            return (
              <div key={id} className={cn("absolute inset-0 overflow-hidden p-4", id === activeTab ? "visible ap-workspace" : "invisible")}>
                <WorkspaceActive.Provider value={id === activeTab}>
                  {locked ? <NeedsData onImport={() => setActiveTab("file")} /> : <C />}
                </WorkspaceActive.Provider>
              </div>
            );
          })}
        </main>

        {/* Status bar */}
        {(flash || progress) && (
          <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-ap-line bg-white px-5 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-foreground">{flash}</span>
            {progress && (
              <>
                <span className="truncate text-muted-foreground">{progress.message}</span>
                <Progress value={progress.value} className="h-1.5 w-[220px] [&>div]:bg-ap-red" />
                <span className="w-20 text-right text-muted-foreground tabular-nums">{eta}</span>
              </>
            )}
          </footer>
        )}
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
