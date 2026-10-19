import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, open, save, message, isTauri } from "@/lib/platform";
import {
  AudioWaveform,
  BadgeCheck,
  BrushCleaning,
  ChartLine,
  ChartScatter,
  Database,
  Cpu,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Grid3x3,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Scale,
  SlidersHorizontal,
  Spline,
} from "lucide-react";
import logo from "@/assets/ap-logo.png";
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
import { FilterTab } from "@/tabs/FilterTab";
import { SpectrumTab } from "@/tabs/SpectrumTab";
import { CorrelationTab } from "@/tabs/CorrelationTab";
import { SysIdTab } from "@/tabs/SysIdTab";
import { ModelsTab } from "@/tabs/ModelsTab";
import { SimulationTab } from "@/tabs/SimulationTab";
import { ValidationTab } from "@/tabs/ValidationTab";
import { ReportTab } from "@/tabs/ReportTab";
import { CurveFitTab } from "@/tabs/CurveFitTab";

interface PageDef {
  label: string;
  icon: typeof FolderOpen;
  component: () => React.ReactElement;
  /** One-line instruction shown under the page title. */
  hint: string;
  needsData?: boolean;
}

const PAGES: Record<TabId, PageDef> = {
  file: { label: "Workspace", icon: Database, component: FileTab, hint: "Add columns from any number of files as variables." },
  prepare: { label: "Prepare", icon: BrushCleaning, component: PrepareTab, hint: "Clean a signal before analysis. Drag a box to select, then remove or keep. The original stays in gray.", needsData: true },
  timeseries: { label: "Plots", icon: ChartLine, component: TimeSeriesTab, hint: "Tick signals on the left to plot them. Drag to zoom, double-click to reset.", needsData: true },
  statistics: { label: "Statistics", icon: ChartScatter, component: StatisticsTab, hint: "Pick a signal; drag on any chart to select rows and compare.", needsData: true },
  compare: { label: "Compare files", icon: Scale, component: CompareTab, hint: "Add two or more files to overlay and align the same signals." },
  filter: { label: "Filter", icon: SlidersHorizontal, component: FilterTab, hint: "Pick a signal, let the app suggest filters, preview, then apply.", needsData: true },
  spectrum: { label: "Spectrum", icon: AudioWaveform, component: SpectrumTab, hint: "See which frequencies a signal contains. Drag the cutoff line to read a cutoff.", needsData: true },
  correlation: { label: "Correlations", icon: Grid3x3, component: CorrelationTab, hint: "Find signals that move together. Click a cell or pair for details.", needsData: true },
  curvefit: { label: "Curve fit", icon: Spline, component: CurveFitTab, hint: "Pick X and Y variables, choose a model and fit.", needsData: true },
  sysid: { label: "Identify model", icon: Cpu, component: SysIdTab, hint: "Choose inputs and outputs, then identify a state-space model.", needsData: true },
  models: { label: "Model library", icon: Library, component: ModelsTab, hint: "Saved models. Double-click a model to inspect or edit it." },
  simulation: { label: "Simulate", icon: Play, component: SimulationTab, hint: "Run a saved model on the measured inputs and compare outputs.", needsData: true },
  validation: { label: "Validate", icon: BadgeCheck, component: ValidationTab, hint: "Check a model's residuals and fit quality.", needsData: true },
  report: { label: "Report", icon: FileText, component: ReportTab, hint: "Choose sections and export an A+P report as HTML or PDF." },
};

const STEPS: { label: string; pages: TabId[] }[] = [
  { label: "Import", pages: ["file", "prepare"] },
  { label: "Explore", pages: ["timeseries", "statistics", "compare"] },
  { label: "Analyse", pages: ["filter", "spectrum", "correlation", "curvefit"] },
  { label: "Model", pages: ["sysid", "models", "simulation", "validation"] },
  { label: "Share", pages: ["report"] },
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
      <div className="ap-box flex w-[440px] flex-col items-start gap-4 p-8">
        <span className="h-[3px] w-12 bg-ap-red" />
        <h2 className="text-[26px] leading-tight text-ap-red">Workspace is empty</h2>
        <Button size="lg" onClick={onImport}>
          <Database /> Add data
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const { activeTab, setActiveTab, flash, progress, setProgress, dataset, models, refreshModels, showStatus } = useApp();
  const [now, setNow] = useState(Date.now());
  const [visited, setVisited] = useState(() => new Set<TabId>([activeTab]));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("sidebarCollapsed", c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });

  useEffect(() => {
    setVisited((v) => (v.has(activeTab) ? v : new Set([...v, activeTab])));
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

  /** Sends files to the Workspace import queue. */
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
      } else if (k === "b") {
        e.preventDefault();
        toggleSidebar();
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
  const page = PAGES[activeTab];
  const stepIndex = STEPS.findIndex((s) => s.pages.includes(activeTab));
  const fileName = dataset?.path.split(/[\\/]/).pop() ?? "";

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Sidebar: the workflow */}
          <aside
            className={cn(
              "flex shrink-0 flex-col overflow-hidden border-r border-ap-line bg-white transition-[width] duration-200 ease-out motion-reduce:transition-none",
              collapsed ? "w-[60px]" : "w-[232px]",
            )}
          >
            <div className={cn("relative h-[86px] shrink-0 transition-[padding] duration-200", collapsed ? "px-[21px] pt-8" : "px-6 pt-6")}>
              <img
                src={logo}
                alt="Angst+Pfister"
                draggable={false}
                className={cn("absolute top-6 left-6 w-[164px] max-w-none transition-opacity duration-150", collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-75")}
              />
              <span className={cn("absolute bottom-3 block h-[3px] bg-ap-red transition-all duration-200", collapsed ? "left-[18px] w-6" : "left-6 w-[50px]")} />
            </div>
            <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-2 pt-2 pb-4">
              {STEPS.map((step, si) => (
                <div key={step.label}>
                  <p
                    className="mb-1 flex h-5 items-center gap-3 border-l-[3px] border-transparent px-3 text-[10.5px] font-bold tracking-[0.14em] whitespace-nowrap text-ap-bluegray uppercase"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full text-[9.5px] tracking-normal",
                        si === stepIndex ? "bg-ap-red text-white" : "bg-ap-bluegray-15 text-ap-bluegray",
                      )}
                    >
                      {si + 1}
                    </span>
                    <span className={cn("transition-opacity duration-150", collapsed ? "w-0 opacity-0" : "opacity-100")}>{step.label}</span>
                  </p>
                  {step.pages.map((id) => {
                    const p = PAGES[id];
                    const Icon = p.icon;
                    const active = id === activeTab;
                    const locked = p.needsData && !dataset;
                    const badge = id === "models" && models.length > 0 ? models.length : null;
                    return (
                      <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        title={collapsed ? p.label : p.hint}
                        className={cn(
                          "group relative flex h-9 w-full items-center gap-3 border-l-[3px] px-3 text-left text-[13.5px] whitespace-nowrap transition-colors",
                          active ? "border-ap-red bg-ap-bluegray-15 text-black" : "border-transparent hover:bg-[#f7f8f8] hover:text-ap-red",
                          locked && !active && "text-[#9aa1a6]",
                        )}
                      >
                        <Icon className={cn("size-4 shrink-0", active ? "text-ap-red" : locked ? "text-ap-bluegray-60" : "text-ap-bluegray")} strokeWidth={1.7} />
                        <span className={cn("flex-1 truncate transition-opacity duration-150", collapsed ? "opacity-0" : "opacity-100")}>{p.label}</span>
                        {badge !== null && (
                          <span
                            className={cn(
                              "rounded-full bg-ap-bluegray-15 px-1.5 text-[10.5px] text-ap-bluegray tabular-nums transition-all",
                              collapsed && "absolute top-0.5 right-1 bg-ap-red px-1 text-[9px] text-white",
                            )}
                          >
                            {badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </aside>

          {/* Main */}
          <main className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-[58px] shrink-0 items-center gap-4 border-b border-ap-line bg-white pr-4 pl-3">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={toggleSidebar}
                title={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
                aria-label="Toggle sidebar"
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
              <h1 className="min-w-0 flex-1 truncate text-[20px] text-black" title={page.hint}>
                {page.label}
              </h1>
              {dataset && activeTab !== "file" && (
                <button
                  onClick={() => setActiveTab("file")}
                  className="flex max-w-[360px] items-center gap-2.5 border border-ap-line bg-white px-3 py-1.5 text-left hover:border-ap-red"
                  title={`${dataset.path}\nClick to change the data`}
                >
                  <FileSpreadsheet className="size-4 shrink-0 text-ap-red" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] leading-tight">{fileName}</span>
                    <span className="block text-[11px] leading-tight text-muted-foreground tabular-nums">
                      {dataset.n_samples.toLocaleString("en-US")} rows · {dataset.n_signals} signals
                    </span>
                  </span>
                  
                </button>
              )}
            </header>
            <div className="relative min-h-0 flex-1">
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
            </div>
          </main>
        </div>

        {/* Status bar */}
        {(flash || progress) && (
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-ap-line bg-white px-4 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate text-[#333]">{flash}</span>
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
