import type { HeaderMode, ImportOptions } from "@/lib/types"

export function optionsForMode(
  headerMode: HeaderMode,
  headerRow: number,
  sheet: string | null,
): ImportOptions {
  return {
    headerMode,
    ...(sheet ? { sheet } : {}),
    ...(headerMode === "row" ? { headerRow: Math.max(1, headerRow || 1) } : {}),
  }
}

export function optionsForInspection(
  inspection: { suggestedSheet: string | null },
): ImportOptions {
  return optionsForMode("auto", 1, inspection.suggestedSheet)
}
