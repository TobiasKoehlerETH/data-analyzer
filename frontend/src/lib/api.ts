import type {
  CorrelationMatrix, FilterChain, FilterSuggestion, LoadResponse,
  SignalData, SignalInfo, Spectrum,
} from "@/lib/types"

const BASE = "/api"

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) throw new Error((await res.text()) || res.statusText)
  return res.json() as Promise<T>
}

const post = <T>(path: string, body: unknown) =>
  json<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

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

  spectrum: (datasetId: string, signal: string, chain?: FilterChain) =>
    post<Spectrum>("/spectrum", { datasetId, signal, chain }),

  correlation: (datasetId: string) => json<CorrelationMatrix>(`/correlation/${datasetId}`),

  correlationPair: (datasetId: string, a: string, b: string) =>
    post<{ lags: number[]; corr: number[] }>("/correlation/pair", { datasetId, a, b }),

  filterSuggest: (datasetId: string, signal: string) =>
    post<FilterSuggestion[]>("/filter/suggest", { datasetId, signal }),

  /** Apply a filter chain to one signal; returns the filtered Float32 samples. */
  async filterApply(datasetId: string, signal: string, chain: FilterChain): Promise<Float32Array> {
    const res = await fetch(BASE + "/filter/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasetId, signal, chain }),
    })
    if (!res.ok) throw new Error((await res.text()) || res.statusText)
    return new Float32Array(await res.arrayBuffer())
  },
}
