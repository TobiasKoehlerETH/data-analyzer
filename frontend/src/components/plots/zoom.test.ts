import { describe, expect, it } from "vitest"

import { ZoomHistory, zoomViewport, type Viewport } from "./zoom"

describe("zoomViewport", () => {
  it("zooms both axes around their centers", () => {
    expect(
      zoomViewport(
        { x: [0, 10], y: [-10, 10] },
        0.5,
        { x: 5, y: 0 },
      ),
    ).toEqual({ x: [2.5, 7.5], y: [-5, 5] })
  })

  it("keeps the cursor anchor stationary", () => {
    expect(
      zoomViewport(
        { x: [0, 10], y: [0, 20] },
        0.5,
        { x: 2, y: 5 },
      ),
    ).toEqual({ x: [1, 6], y: [2.5, 12.5] })
  })
})

describe("ZoomHistory", () => {
  it("goes back one viewport", () => {
    const original: Viewport = { x: [0, 10], y: [0, 20] }
    const history = new ZoomHistory(original)

    history.push({ x: [2, 8], y: [4, 16] })

    expect(history.canGoBack).toBe(true)
    expect(history.back()).toEqual(original)
    expect(history.canGoBack).toBe(false)
  })

  it("resets to the original viewport and clears history", () => {
    const original: Viewport = { x: [0, 10], y: [0, 20] }
    const history = new ZoomHistory(original)
    history.push({ x: [1, 9], y: [2, 18] })

    expect(history.reset()).toEqual(original)
    expect(history.canGoBack).toBe(false)
  })
})
