import { create } from "zustand";
import type { DatasetInfo, ModelSummary } from "./api";
import { api } from "./api";

export type TabId =
  | "file"
  | "prepare"
  | "timeseries"
  | "statistics"
  | "compare"
  | "spectrum"
  | "spectrogram"
  | "frf"
  | "cycles"
  | "peaks"
  | "correlation"
  | "curvefit"
  | "model"
  | "results"
  | "report";

export const DEFAULT_TAB_ORDER: TabId[] = [
  "file",
  "prepare",
  "timeseries",
  "statistics",
  "compare",
  "spectrum",
  "spectrogram",
  "frf",
  "peaks",
  "cycles",
  "correlation",
  "curvefit",
  "model",
  "results",
  "report",
];

/** One scalar result (a measurement, a cycle statistic, a fitted coefficient). */
export interface ResultRow {
  id: string;
  /** Rows added together share a group, e.g. "Cycles of Force". */
  group: string;
  name: string;
  signal: string;
  value: number;
  unit: string;
  /** The page it came from. */
  source: string;
}

const RESULTS_KEY = "results.v1";
function loadResults(): ResultRow[] {
  try {
    const raw = localStorage.getItem(RESULTS_KEY);
    const v = raw ? (JSON.parse(raw) as ResultRow[]) : [];
    return Array.isArray(v) ? v.filter((r) => r && typeof r.value === "number") : [];
  } catch {
    return [];
  }
}
function saveResults(r: ResultRow[]) {
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}
let resultSeq = 0;

interface ProgressState {
  value: number;
  message: string;
  task: string;
  startedAt: number;
}

interface AppStore {
  dataset: DatasetInfo | null;
  /** Bumped whenever the data changes (imports, edits, filters) so pages refetch. */
  dataVersion: number;
  activeTab: TabId;
  tabOrder: TabId[];
  status: string;
  flash: string | null;
  progress: ProgressState | null;
  models: ModelSummary[];
  /** Variable the Prepare page should open (set from the Workspace list). */
  prepareVariable: string | null;
  setPrepareVariable: (name: string | null) => void;
  setDataset: (d: DatasetInfo | null) => void;
  bumpData: (d?: DatasetInfo) => void;
  setActiveTab: (t: TabId) => void;
  setTabOrder: (o: TabId[]) => void;
  showStatus: (text: string, timeoutMs?: number) => void;
  setProgress: (task: string, value: number, message: string) => void;
  refreshModels: () => Promise<void>;
  results: ResultRow[];
  /** Adds rows; a row with the same group, name and signal as an existing one replaces it. */
  addResults: (rows: Omit<ResultRow, "id">[]) => void;
  removeResults: (ids: string[]) => void;
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
  prepareVariable: null,
  setPrepareVariable: (name) => set({ prepareVariable: name }),
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
  results: loadResults(),
  addResults: (rows) => {
    const key = (r: Omit<ResultRow, "id">) => `${r.group}\u0000${r.name}\u0000${r.signal}`;
    const incoming = new Map(rows.filter((r) => Number.isFinite(r.value)).map((r) => [key(r), r]));
    const kept = get().results.filter((r) => !incoming.has(key(r)));
    const added = [...incoming.values()].map((r) => ({ ...r, id: `r${Date.now().toString(36)}${(resultSeq++).toString(36)}` }));
    const results = [...kept, ...added];
    saveResults(results);
    set({ results });
  },
  removeResults: (ids) => {
    const results = get().results.filter((r) => !ids.includes(r.id));
    saveResults(results);
    set({ results });
  },
}));

export function signalLabel(ds: DatasetInfo | null, column: string): string {
  return ds?.signals.find((s) => s.column === column)?.label ?? column;
}

export function signalName(ds: DatasetInfo | null, column: string): string {
  return ds?.signals.find((s) => s.column === column)?.name ?? column;
}
