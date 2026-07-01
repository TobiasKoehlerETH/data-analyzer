import type { LoadResponse, SignalData, SignalInfo } from "@/lib/types"

const BASE = "/api"

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) throw new Error((await res.text()) || res.statusText)
  return res.json() as Promise<T>
}

export const api = {
  load(file: File) {
    const body = new FormData()
    body.append("file", file)
    return json<LoadResponse>("/dataset/load", { method: "POST", body })
  },

  signals: (id: string) => json<SignalInfo[]>(`/dataset/${id}/signals`),

  /** Binary Float32 payload laid out column-major: [time, ...signals] in request order. */
  async signalData(id: string, names: string[]): Promise<SignalData> {
    const q = encodeURIComponent(names.join(","))
    const res = await fetch(`${BASE}/dataset/${id}/signal-data?names=${q}`)
    if (!res.ok) throw new Error((await res.text()) || res.statusText)
    const buf = new Float32Array(await res.arrayBuffer())
    const cols = names.length + 1
    const n = buf.length / cols
    const time = buf.subarray(0, n)
    const series = Object.fromEntries(
      names.map((name, i) => [name, buf.subarray((i + 1) * n, (i + 2) * n)]),
    )
    return { time, series }
  },
}
