import { create } from "zustand"
import type { DatasetMeta, Preview, SignalInfo } from "@/lib/types"

type State = {
  dataset: DatasetMeta | null
  signals: SignalInfo[]
  preview: Preview | null
  selected: string[] // selected signal names, shared across screens

  setDataset: (dataset: DatasetMeta, signals: SignalInfo[], preview: Preview) => void
  toggleSignal: (name: string) => void
  setSelected: (names: string[]) => void
}

export const useStore = create<State>((set) => ({
  dataset: null,
  signals: [],
  preview: null,
  selected: [],

  setDataset: (dataset, signals, preview) =>
    set({ dataset, signals, preview, selected: signals.slice(0, 3).map((s) => s.name) }),
  toggleSignal: (name) =>
    set((s) => ({
      selected: s.selected.includes(name)
        ? s.selected.filter((n) => n !== name)
        : [...s.selected, name],
    })),
  setSelected: (names) => set({ selected: names }),
}))
