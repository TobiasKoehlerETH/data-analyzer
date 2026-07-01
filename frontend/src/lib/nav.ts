import {
  LayoutDashboard, Upload, Activity, GitCompare, Filter, AudioWaveform,
  Grid3x3, Cpu, Library, Play, ClipboardCheck, FileText, type LucideIcon,
} from "lucide-react"

export type NavItem = { title: string; url: string; icon: LucideIcon }
export type NavGroup = { label?: string; items: NavItem[] }

/** Sidebar nav, grouped by analysis workflow. Also drives the router (see routes/). */
export const nav: NavGroup[] = [
  { items: [{ title: "Overview", url: "/", icon: LayoutDashboard }] },
  {
    label: "Data",
    items: [
      { title: "Load & Preview", url: "/load", icon: Upload },
      { title: "Time Series", url: "/plot", icon: Activity },
      { title: "Compare", url: "/compare", icon: GitCompare },
    ],
  },
  {
    label: "Signal Processing",
    items: [
      { title: "Filter", url: "/filter", icon: Filter },
      { title: "Spectrum", url: "/spectrum", icon: AudioWaveform },
      { title: "Correlation", url: "/correlation", icon: Grid3x3 },
    ],
  },
  {
    label: "Modelling",
    items: [
      { title: "System ID", url: "/sysid", icon: Cpu },
      { title: "Models", url: "/models", icon: Library },
      { title: "Simulation", url: "/simulate", icon: Play },
      { title: "Validation", url: "/validate", icon: ClipboardCheck },
    ],
  },
  { label: "Output", items: [{ title: "Report", url: "/report", icon: FileText }] },
]

export const navItems = nav.flatMap((g) => g.items)
export const titleFor = (pathname: string) =>
  navItems.find((i) => (i.url === "/" ? pathname === "/" : pathname.startsWith(i.url)))?.title ??
  "Data Analyzer"
