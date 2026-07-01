export type Range = [number, number]

export type Viewport = {
  x: Range
  y: Range
}

export type Anchor = {
  x: number
  y: number
}

function cloneViewport(viewport: Viewport): Viewport {
  return {
    x: [...viewport.x],
    y: [...viewport.y],
  }
}

function zoomRange(range: Range, factor: number, anchor: number): Range {
  return [
    anchor + (range[0] - anchor) * factor,
    anchor + (range[1] - anchor) * factor,
  ]
}

export function zoomViewport(
  viewport: Viewport,
  factor: number,
  anchor: Anchor,
): Viewport {
  return {
    x: zoomRange(viewport.x, factor, anchor.x),
    y: zoomRange(viewport.y, factor, anchor.y),
  }
}

export class ZoomHistory {
  readonly #original: Viewport
  readonly #previous: Viewport[] = []
  #current: Viewport

  constructor(original: Viewport) {
    this.#original = cloneViewport(original)
    this.#current = cloneViewport(original)
  }

  get canGoBack(): boolean {
    return this.#previous.length > 0
  }

  get current(): Viewport {
    return cloneViewport(this.#current)
  }

  push(viewport: Viewport): Viewport {
    this.#previous.push(cloneViewport(this.#current))
    if (this.#previous.length > 50) this.#previous.shift()
    this.#current = cloneViewport(viewport)
    return this.current
  }

  back(): Viewport {
    const previous = this.#previous.pop()
    if (previous) this.#current = previous
    return this.current
  }

  reset(): Viewport {
    this.#previous.length = 0
    this.#current = cloneViewport(this.#original)
    return this.current
  }
}
