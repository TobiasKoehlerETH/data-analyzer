// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("uplot", () => ({
  default: class {
    scales = {
      x: { min: 0, max: 1 },
      y: { min: 2, max: 3 },
    }
    select = { left: 0, top: 0, width: 0, height: 0 }
    constructor(_options: unknown, _data: unknown, node: HTMLElement) {
      const over = document.createElement("div")
      over.className = "u-over"
      node.append(over)
    }
    batch(callback: () => void) { callback() }
    setData() {}
    setSize() {}
    setScale() {}
    setSelect() {}
    posToVal(value: number) { return value }
    destroy() {}
  },
}))

import { UPlotChart } from "./UPlotChart"

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

describe("UPlotChart zoom controls", () => {
  it("shows zoom in, zoom out, Back, and Reset controls", () => {
    render(
      <UPlotChart
        options={{ series: [{}, {}], axes: [] }}
        data={[[0, 1], [2, 3]]}
      />,
    )

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeTruthy()
  })

  it("starts with Back disabled", () => {
    render(
      <UPlotChart
        options={{ series: [{}, {}], axes: [] }}
        data={[[0, 1], [2, 3]]}
      />,
    )

    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true)
  })
})
