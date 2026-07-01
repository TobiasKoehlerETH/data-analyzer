import { create } from "zustand"
import type { DatasetMeta, FilterStep, Preview, SignalInfo } from "@/lib/types"

type State = {
  dataset: DatasetMeta | null
  signals: SignalInfo[]
  preview: Preview | null
  selected: string[] // selected signal names, shared across screens
  filters: Record<string, FilterStep[]> // signal name -> filter chain steps

  setDataset: (dataset: DatasetMeta, signals: SignalInfo[], preview: Preview) => void
  toggleSignal: (name: string) => void
  setSelected: (names: string[]) => void
  setFilter: (signal: string, steps: FilterStep[]) => void
}

export const useStore = create<State>((set) => ({
  dataset: null,
  signals: [],
  preview: null,
  selected: [],
  filters: {},

  setDataset: (dataset, signals, preview) =>
    set({
      dataset,
      signals,
      preview,
      selected: signals.slice(0, 3).map((s) => s.name),
      filters: {},
    }),
  toggleSignal: (name) =>
    set((s) => ({
      selected: s.selected.includes(name)
        ? s.selected.filter((n) => n !== name)
        : [...s.selected, name],
    })),
  setSelected: (names) => set({ selected: names }),
  setFilter: (signal, steps) => set((s) => ({ filters: { ...s.filters, [signal]: steps } })),
}))
