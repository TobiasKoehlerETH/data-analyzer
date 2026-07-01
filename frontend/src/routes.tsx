import type { ReactElement } from "react"

import Overview from "@/routes/Overview"
import Load from "@/routes/Load"
import Plot from "@/routes/Plot"
import Filter from "@/routes/Filter"
import Spectrum from "@/routes/Spectrum"
import Correlation from "@/routes/Correlation"
import { Placeholder } from "@/routes/placeholder"

/** Path -> screen. Placeholders get replaced as each area is built (see document/PLAN.md). */
export const routes: { path: string; element: ReactElement }[] = [
  { path: "/", element: <Overview /> },
  { path: "/load", element: <Load /> },
  { path: "/plot", element: <Plot /> },
  { path: "/compare", element: <Placeholder title="Multi-File Compare" /> },
  { path: "/filter", element: <Filter /> },
  { path: "/spectrum", element: <Spectrum /> },
  { path: "/correlation", element: <Correlation /> },
  { path: "/sysid", element: <Placeholder title="System Identification" /> },
  { path: "/models", element: <Placeholder title="Model Library" /> },
  { path: "/simulate", element: <Placeholder title="Simulation" /> },
  { path: "/validate", element: <Placeholder title="Validation" /> },
  { path: "/report", element: <Placeholder title="Report Export" /> },
]
