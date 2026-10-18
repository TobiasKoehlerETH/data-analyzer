import { create } from "zustand";
import type { DatasetInfo, ModelSummary } from "./api";
import { api } from "./api";

export type TabId =
  | "file"
  | "timeseries"
  | "statistics"
  | "compare"
  | "filter"
  | "spectrum"
  | "correlation"
  | "curvefit"
  | "sysid"
  | "models"
  | "simulation"
  | "validation"
  | "report";

export const DEFAULT_TAB_ORDER: TabId[] = [
  "file",
  "timeseries",
  "statistics",
  "compare",
  "filter",
  "spectrum",
  "correlation",
  "curvefit",
  "sysid",
  "models",
  "simulation",
  "validation",
  "report",
];

interface ProgressState {
  value: number;
  message: string;
  task: string;
  startedAt: number;
}

interface AppStore {
  dataset: DatasetInfo | null;
  /** Bumped whenever a filter is applied/cleared so plots refetch. */
  dataVersion: number;
  activeTab: TabId;
  tabOrder: TabId[];
  status: string;
  flash: string | null;
  progress: ProgressState | null;
  models: ModelSummary[];
  setDataset: (d: DatasetInfo | null) => void;
  bumpData: (d?: DatasetInfo) => void;
  setActiveTab: (t: TabId) => void;
  setTabOrder: (o: TabId[]) => void;
  showStatus: (text: string, timeoutMs?: number) => void;
  setProgress: (task: string, value: number, message: string) => void;
  refreshModels: () => Promise<void>;
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;

function loadTabOrder(): TabId[] {
  try {
    const raw = localStorage.getItem("tabOrder");
    if (raw) {
      const parsed = JSON.parse(raw) as TabId[];
      if (parsed.length === DEFAULT_TAB_ORDER.length && DEFAULT_TAB_ORDER.every((t) => parsed.includes(t))) return parsed;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_TAB_ORDER;
}

export const useApp = create<AppStore>((set, get) => ({
  dataset: null,
  dataVersion: 0,
  activeTab: "file",
  tabOrder: loadTabOrder(),
  status: "Ready",
  flash: null,
  progress: null,
  models: [],
  setDataset: (d) =>
    set({
      dataset: d,
      dataVersion: get().dataVersion + 1,
      status: d
        ? `Loaded: ${d.n_samples.toLocaleString("en-US")} samples, ${d.n_signals} signals, ${d.sample_rate.toFixed(2)} Hz`
        : "Ready",
    }),
  bumpData: (d) => set({ dataVersion: get().dataVersion + 1, ...(d ? { dataset: d } : {}) }),
  setActiveTab: (t) => set({ activeTab: t }),
  setTabOrder: (o) => {
    try {
      localStorage.setItem("tabOrder", JSON.stringify(o));
    } catch {
      /* ignore */
    }
    set({ tabOrder: o });
  },
  showStatus: (text, timeoutMs = 3000) => {
    if (flashTimer) clearTimeout(flashTimer);
    set({ flash: text });
    flashTimer = setTimeout(() => set({ flash: null }), timeoutMs);
  },
  setProgress: (task, value, message) => {
    const cur = get().progress;
    if (value >= 100) {
      set({ progress: null });
      return;
    }
    const startedAt = cur && cur.task === task ? cur.startedAt : Date.now();
    set({ progress: { task, value, message, startedAt } });
  },
  refreshModels: async () => {
    const models = await api.modelsList();
    set({ models });
  },
}));

export function signalLabel(ds: DatasetInfo | null, column: string): string {
  return ds?.signals.find((s) => s.column === column)?.label ?? column;
}

export function signalName(ds: DatasetInfo | null, column: string): string {
  return ds?.signals.find((s) => s.column === column)?.name ?? column;
}
