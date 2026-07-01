import { describe, expect, it } from "vitest"

import { optionsForInspection, optionsForMode } from "./import-options"

describe("optionsForMode", () => {
  it.each(["auto", "first_row", "none"] as const)(
    "omits a header row for %s mode",
    (mode) => {
      expect(optionsForMode(mode, 9, "Data")).toEqual({
        headerMode: mode,
        sheet: "Data",
      })
    },
  )

  it("sends a one-based row for explicit row mode", () => {
    expect(optionsForMode("row", 4, null)).toEqual({
      headerMode: "row",
      headerRow: 4,
    })
  })

  it("clamps an invalid explicit row to the first row", () => {
    expect(optionsForMode("row", 0, null).headerRow).toBe(1)
  })
})

describe("optionsForInspection", () => {
  it("uses the suggested sheet with automatic header detection", () => {
    expect(optionsForInspection({ suggestedSheet: "Measurements" })).toEqual({
      headerMode: "auto",
      sheet: "Measurements",
    })
  })
})
