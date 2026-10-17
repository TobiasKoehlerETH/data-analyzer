import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import {
  AudioWaveform,
  BadgeCheck,
  ChartLine,
  Cpu,
  FileText,
  FolderOpen,
  Grid3x3,
  GripVertical,
  Library,
  Play,
  Scale,
  SlidersHorizontal,
} from "lucide-react";
import logo from "@/assets/ap-logo.png";
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from "@/components/ui/menubar";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, DATA_FILE_EXTENSIONS, DATA_FILE_FILTERS, errorText, JSON_FILTERS, type ProgressEvent } from "@/lib/api";
import { useApp, type TabId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { FileTab } from "@/tabs/FileTab";
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

const TABS: Record<TabId, { label: string; icon: typeof FolderOpen; component: () => React.ReactElement; description: string }> = {
  file: { label: "File", icon: FolderOpen, component: FileTab, description: "Load CSV, TXT or Excel data and inspect the detected format" },
  timeseries: { label: "Data Plots", icon: ChartLine, component: TimeSeriesTab, description: "Plot by row, time or any column" },
  statistics: { label: "Statistics", icon: Grid3x3, component: StatisticsTab, description: "Explore distributions and linked selections" },
  compare: { label: "Compare", icon: Scale, component: CompareTab, description: "Overlay and align several files" },
  filter: { label: "Filtering", icon: SlidersHorizontal, component: FilterTab, description: "Filter chains with live preview" },
  spectrum: { label: "Spectrum", icon: AudioWaveform, component: SpectrumTab, description: "FFT and Welch power spectral density" },
  correlation: { label: "Correlations", icon: Grid3x3, component: CorrelationTab, description: "Correlation matrix, scatter and lag analysis" },
  sysid: { label: "System ID", icon: Cpu, component: SysIdTab, description: "Identify MIMO state-space models" },
  models: { label: "Models", icon: Library, component: ModelsTab, description: "Model library" },
  simulation: { label: "Simulation", icon: Play, component: SimulationTab, description: "Measured vs. simulated outputs" },
  validation: { label: "Validation", icon: BadgeCheck, component: ValidationTab, description: "Residual analysis and fit metrics" },
  report: { label: "Reports", icon: FileText, component: ReportTab, description: "Export HTML or PDF reports" },
};

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `~${s}s left`;
  return `~${Math.floor(s / 60)}m ${s % 60}s left`;
}

export default function App() {
  const { activeTab, setActiveTab, tabOrder, setTabOrder, status, flash, progress, setProgress, dataset, requestOpen, refreshModels, showStatus } = useApp();
  const [dragTab, setDragTab] = useState<TabId | null>(null);
  const [now, setNow] = useState(Date.now());

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

  const openFile = async () => {
    const path = await open({ multiple: false, filters: DATA_FILE_FILTERS, title: "Open data file" });
    if (typeof path === "string") requestOpen(path);
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
  const exit = () => getCurrentWindow().close();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        openFile();
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
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      const paths = e.payload.paths.filter((p) => DATA_FILE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? ""));
      if (paths.length === 0) {
        showStatus("Unsupported file type. Drop CSV, TXT, TSV or Excel files.");
        return;
      }
      if (useApp.getState().activeTab === "compare") {
        window.dispatchEvent(new CustomEvent("compare-add-files", { detail: paths }));
      } else {
        requestOpen(paths[0]);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [requestOpen, showStatus]);

  const activeIdx = tabOrder.indexOf(activeTab) + 1;
  const eta =
    progress && progress.value > 2 ? formatEta(((now - progress.startedAt) * (100 - progress.value)) / progress.value) : "";

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <aside className="flex w-[218px] shrink-0 flex-col border-r border-ap-line bg-white px-5 pt-6 pb-4">
            <img src={logo} alt="Angst+Pfister" className="w-[168px]" draggable={false} />
            <span className="mt-7 mb-3 block h-[3px] w-[50px] bg-ap-red" />
            <p className="ap-eyebrow">Data Analyzer</p>
            <nav className="mt-3 -mx-2 flex flex-col gap-px overflow-y-auto">
              {tabOrder.map((id, i) => {
                const t = TABS[id];
                const Icon = t.icon;
                const active = id === activeTab;
                return (
                  <button
                    key={id}
                    draggable
                    onDragStart={() => setDragTab(id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (!dragTab || dragTab === id) return;
                      const order = tabOrder.filter((x) => x !== dragTab);
                      order.splice(order.indexOf(id), 0, dragTab);
                      setTabOrder(order);
                      setDragTab(null);
                    }}
                    onClick={() => setActiveTab(id)}
                    title={`${t.description} (drag to reorder)`}
                    className={cn(
                      "group flex items-center gap-2.5 border-l-[3px] px-2 py-[7px] text-left text-[14px] transition-colors",
                      active ? "border-ap-red bg-ap-bluegray-15 text-black" : "border-transparent text-[#333] hover:text-ap-red",
                    )}
                  >
                    <span className={cn("w-5 text-[10px] tabular-nums", active ? "text-ap-red" : "text-ap-bluegray-60")}>{String(i + 1).padStart(2, "0")}</span>
                    <Icon className={cn("size-4 shrink-0", active ? "text-ap-red" : "text-ap-bluegray")} strokeWidth={1.6} />
                    <span className="flex-1 truncate">{t.label}</span>
                    <GripVertical className="size-3.5 text-ap-bluegray-60 opacity-0 group-hover:opacity-100" />
                  </button>
                );
              })}
            </nav>
            <div className="mt-auto pt-4 text-[11px] leading-relaxed text-[#707070]">
              {dataset ? (
                <>
                  <p className="truncate text-black" title={dataset.path}>
                    {dataset.path.split(/[\\/]/).pop()}
                  </p>
                  <p>
                    {dataset.n_samples.toLocaleString("en-US")} samples · {dataset.n_signals} signals
                  </p>
                  <p>{dataset.sample_rate.toFixed(3)} Hz · {dataset.file_type}</p>
                </>
              ) : (
                <p>No file loaded</p>
              )}
            </div>
          </aside>

          {/* Main */}
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-4 border-b border-ap-line bg-white pr-4 pl-2">
              <Menubar className="h-8 border-none bg-transparent p-0 shadow-none">
                <MenubarMenu>
                  <MenubarTrigger className="px-2.5 text-[13px]">File</MenubarTrigger>
                  <MenubarContent>
                    <MenubarItem onSelect={openFile}>
                      Open Data File… <MenubarShortcut>Ctrl+O</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={saveModels}>
                      Save Models… <MenubarShortcut>Ctrl+S</MenubarShortcut>
                    </MenubarItem>
                    <MenubarItem onSelect={loadModels}>
                      Load Models… <MenubarShortcut>Ctrl+L</MenubarShortcut>
                    </MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem onSelect={exit}>
                      Exit <MenubarShortcut>Ctrl+Q</MenubarShortcut>
                    </MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
              <div className="flex min-w-0 items-baseline gap-3">
                <span className="text-[11px] font-bold tracking-[0.12em] text-ap-red">{String(activeIdx).padStart(2, "0")} /</span>
                <h1 className="truncate text-[19px] leading-none text-ap-red">{TABS[activeTab].label}</h1>
                <span className="hidden truncate text-xs text-muted-foreground xl:inline">{TABS[activeTab].description}</span>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {tabOrder.map((id) => {
                const C = TABS[id].component;
                return (
                  <div key={id} className={cn("absolute inset-0 overflow-hidden p-3", id === activeTab ? "visible" : "invisible")}>
                    <C />
                  </div>
                );
              })}
            </div>
          </main>
        </div>

        {/* Status bar */}
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-ap-line bg-white px-3 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate text-[#333]">{flash ?? status}</span>
          {progress && (
            <>
              <span className="truncate text-muted-foreground">{progress.message}</span>
              <Progress value={progress.value} className="h-1.5 w-[220px] [&>div]:bg-ap-red" />
              <span className="w-20 text-right text-muted-foreground tabular-nums">{eta}</span>
            </>
          )}
        </footer>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
