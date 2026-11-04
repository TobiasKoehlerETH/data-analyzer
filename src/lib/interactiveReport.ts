/**
 * An interactive report: one HTML file with the charts still zoomable (Plotly is embedded) and
 * tables you can filter and sort. It needs no internet and no app, so it can be emailed.
 */
import { decimate } from "./chart";
import { summarize } from "./analysis";
import type { DatasetInfo, Note, WorkspaceView } from "./api";
import type { ResultRow } from "./store";

export interface InteractiveInput {
  title: string;
  dataset: DatasetInfo;
  view: WorkspaceView;
  /** Dataset rows: time and every signal column (possibly thinned). */
  time: (number | null)[];
  columns: Record<string, (number | null)[]>;
  /** Every `step`-th row was read (1 = all). */
  step: number;
  results: ResultRow[];
  notes: Note[];
  sections: string[];
  plotlyJs: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: number | null | undefined, d = 6) => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(Number(v.toPrecision(d))));
/** JSON safe inside a <script> element. */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const PALETTE = ["#ff2400", "#2a78d6", "#1baf7a", "#6250d6", "#eda100", "#e87ba4", "#008300"];
const PER_FIGURE = 8;
const POINTS = 3000;

function table(id: string, head: string[], rows: (string | number)[][], numeric: boolean[]): string {
  const th = head.map((h, i) => `<th data-col="${i}" class="${numeric[i] ? "num" : ""}">${esc(h)}<span class="sort"></span></th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? "num" : ""}">${esc(String(c))}</td>`).join("")}</tr>`).join("\n");
  return `<div class="tools"><input class="filter" data-table="${id}" placeholder="Filter…" aria-label="Filter rows"><span class="count" data-for="${id}"></span></div>
<div class="scroll"><table id="${id}" class="data"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function buildInteractiveReport(inp: InteractiveInput): string {
  const { dataset, view } = inp;
  const has = (s: string) => inp.sections.includes(s);
  const signals = dataset.signals;
  const date = new Date();
  const parts: string[] = [];
  const nav: [string, string][] = [];

  // Signals: stacked figures sharing the time axis, with notes as amber spans.
  const figures: { id: string; data: unknown[]; layout: Record<string, unknown> }[] = [];
  if (has("Signal Plots")) {
    for (let f = 0; f * PER_FIGURE < signals.length; f++) {
      const group = signals.slice(f * PER_FIGURE, (f + 1) * PER_FIGURE);
      const n = group.length;
      const gap = 0.03;
      const h = (1 - gap * (n - 1)) / n;
      const data: unknown[] = [];
      const layout: Record<string, unknown> = {
        showlegend: false,
        margin: { l: 70, r: 20, t: 10, b: 40 },
        hovermode: "x unified",
        font: { family: "Inter, Segoe UI, system-ui, sans-serif", size: 12, color: "#0f1216" },
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        shapes: [] as unknown[],
        annotations: [] as unknown[],
      };
      group.forEach((sg, i) => {
        const id = i === 0 ? "" : String(i + 1);
        const y0 = 1 - (i + 1) * h - i * gap;
        const d = decimate(inp.time, inp.columns[sg.column] ?? [], POINTS);
        data.push({ type: "scatter", mode: "lines", name: sg.label, x: d.x, y: d.y, xaxis: `x${id}`, yaxis: `y${id}`, line: { color: PALETTE[i % PALETTE.length], width: 1.4 }, hovertemplate: "%{y:.5~g}<extra>" + esc(sg.label) + "</extra>" });
        layout[`xaxis${id}`] = { anchor: `y${id}`, matches: i ? "x" : undefined, showticklabels: i === n - 1, gridcolor: "#eceef2", zeroline: false, title: i === n - 1 ? { text: "Time [s]" } : undefined };
        layout[`yaxis${id}`] = { domain: [Math.max(0, y0), y0 + h], gridcolor: "#eceef2", zeroline: false, title: { text: sg.label.length > 28 ? sg.label.slice(0, 27) + "…" : sg.label, font: { size: 11 } } };
      });
      for (const note of inp.notes) {
        const span = note.end > note.start;
        (layout.shapes as unknown[]).push(
          span
            ? { type: "rect", xref: "x", yref: "paper", x0: note.start, x1: note.end, y0: 0, y1: 1, fillcolor: "rgba(237,161,0,0.13)", line: { color: "rgba(237,161,0,0.55)", width: 1 }, layer: "below" }
            : { type: "line", xref: "x", yref: "paper", x0: note.start, x1: note.start, y0: 0, y1: 1, line: { color: "#eda100", width: 1.5 } },
        );
        (layout.annotations as unknown[]).push({ text: esc(note.text), xref: "x", yref: "paper", x: note.start, y: 1, xanchor: "left", yanchor: "top", showarrow: false, bgcolor: "rgba(255,247,224,0.95)", bordercolor: "rgba(237,161,0,0.6)", font: { size: 11, color: "#7a5200" } });
      }
      figures.push({ id: `fig${f}`, data, layout });
    }
    nav.push(["signals", "Signals"]);
    parts.push(`<section id="signals"><h2>Signals</h2><p class="hint">Drag to zoom, double-click to reset, scroll to zoom. All charts in a figure share the time axis.</p>
${figures.map((f) => `<div class="figure" id="${f.id}" style="height:${Math.max(260, (f.data.length || 1) * 170)}px"></div>`).join("\n")}</section>`);
  }

  if (has("Statistics")) {
    const rows = signals.map((sg) => {
      const s = summarize(inp.columns[sg.column] ?? []);
      return [sg.label, sg.unit, s.count, num(s.mean), num(s.std), num(s.min), num(s.median), num(s.max)];
    });
    nav.push(["statistics", "Statistics"]);
    parts.push(`<section id="statistics"><h2>Statistics</h2>${inp.step > 1 ? `<p class="hint">From every ${inp.step}. row.</p>` : ""}
${table("t-stats", ["Signal", "Unit", "n", "Mean", "Std dev", "Min", "Median", "Max"], rows, [false, false, true, true, true, true, true, true])}</section>`);
  }

  if (has("Results") && inp.results.length) {
    nav.push(["results", "Results"]);
    parts.push(`<section id="results"><h2>Results</h2>
${table("t-results", ["Group", "Result", "Signal", "Value", "Unit", "From"], inp.results.map((r) => [r.group, r.name, r.signal, num(r.value), r.unit, r.source]), [false, false, false, true, false, false])}</section>`);
  }

  if (has("Notes") && inp.notes.length) {
    nav.push(["notes", "Notes"]);
    parts.push(`<section id="notes"><h2>Notes</h2>
${table("t-notes", ["From [s]", "To [s]", "Duration [s]", "Note"], inp.notes.map((n) => [num(n.start), num(n.end), n.end > n.start ? num(n.end - n.start) : "", n.text]), [true, true, true, false])}</section>`);
  }

  if (has("Filters Applied")) {
    const edited = view.variables.filter((v) => v.edits.length);
    if (edited.length) {
      nav.push(["processing", "Processing"]);
      parts.push(`<section id="processing"><h2>Processing</h2>
${table("t-proc", ["Signal", "Step", "What it did"], edited.flatMap((v) => v.edits.map((e, i) => [v.name, i + 1, e])), [false, true, false])}</section>`);
    }
  }

  if (has("Metadata")) {
    nav.push(["files", "Files"]);
    parts.push(`<section id="files"><h2>Files</h2>
${table("t-files", ["File", "Rows", "Sample rate [Hz]", "Path"], view.sources.map((s) => [s.name, s.rows, num(s.sample_rate, 4), s.path]), [false, true, true, false])}</section>`);
  }

  const css = `
:root{--red:#ff2400;--ink:#0f1216;--muted:#5b6672;--line:#e4e7ec;--bg:#f3f4f7}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 Inter,"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line);padding:20px 32px}header h1{margin:0;font-size:22px}header p{margin:4px 0 0;color:var(--muted);font-size:13px}
nav{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding:8px 32px;background:rgba(255,255,255,.92);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
nav a{padding:5px 12px;border-radius:8px;color:var(--muted);text-decoration:none;font-size:13px}nav a:hover{background:#eff1f4;color:var(--ink)}
main{max-width:1280px;margin:0 auto;padding:24px 32px 64px}section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 24px;margin-bottom:20px}
h2{margin:0 0 12px;font-size:16px}.hint{margin:-6px 0 12px;color:var(--muted);font-size:12.5px}.figure{width:100%}
.tools{display:flex;align-items:center;gap:12px;margin-bottom:8px}.filter{height:32px;width:260px;border:1px solid #d6dae0;border-radius:8px;padding:0 10px;font:inherit}
.filter:focus{outline:2px solid rgba(255,36,0,.25);border-color:var(--red)}.count{color:var(--muted);font-size:12.5px}
.scroll{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:8px}table.data{width:100%;border-collapse:collapse;font-size:13px}
th{position:sticky;top:0;background:#fafbfc;text-align:left;font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--red)}td{padding:6px 10px;border-bottom:1px solid #f0f1f4}tr:hover td{background:#f7f8fa}.num{text-align:right;font-variant-numeric:tabular-nums}
.sort{display:inline-block;width:12px;color:var(--red)}footer{color:var(--muted);font-size:12px;text-align:center;padding:16px}
@media print{nav{display:none}.scroll{max-height:none}section{break-inside:avoid}}`;

  const script = `
const FIGS=${json(figures)};
for(const f of FIGS){Plotly.newPlot(f.id,f.data,f.layout,{responsive:true,displaylogo:false,scrollZoom:true,modeBarButtonsToRemove:["lasso2d","select2d"]});}
document.querySelectorAll("input.filter").forEach(inp=>{const t=document.getElementById(inp.dataset.table);const c=document.querySelector('.count[data-for="'+inp.dataset.table+'"]');
const upd=()=>{const q=inp.value.toLowerCase().split(/\\s+/).filter(Boolean);let n=0;t.tBodies[0].querySelectorAll("tr").forEach(r=>{const s=r.textContent.toLowerCase();const ok=q.every(w=>s.includes(w));r.style.display=ok?"":"none";if(ok)n++;});c.textContent=n+" of "+t.tBodies[0].rows.length+" rows";};inp.addEventListener("input",upd);upd();});
document.querySelectorAll("table.data th").forEach(th=>th.addEventListener("click",()=>{const t=th.closest("table");const i=+th.dataset.col;const asc=th.dataset.dir!=="asc";
t.querySelectorAll("th").forEach(h=>{h.dataset.dir="";h.querySelector(".sort").textContent="";});th.dataset.dir=asc?"asc":"desc";th.querySelector(".sort").textContent=asc?"▲":"▼";
const rows=[...t.tBodies[0].rows];const val=r=>{const s=r.cells[i].textContent;const n=parseFloat(s);return s!==""&&!isNaN(n)&&th.classList.contains("num")?n:s.toLowerCase();};
rows.sort((a,b)=>{const x=val(a),y=val(b);return (x<y?-1:x>y?1:0)*(asc?1:-1);});rows.forEach(r=>t.tBodies[0].appendChild(r));}));`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(inp.title)} – report</title><style>${css}</style>
<script>${inp.plotlyJs.replace(/<\/script/gi, "<\\/script")}</script></head>
<body><header><h1>${esc(inp.title)}</h1><p>${esc(date.toLocaleString())} · ${view.sources.length} file${view.sources.length === 1 ? "" : "s"} · ${signals.length} signals · ${num(dataset.duration, 5)} s</p></header>
<nav>${nav.map(([id, t]) => `<a href="#${id}">${esc(t)}</a>`).join("")}</nav>
<main>${parts.join("\n")}</main>
<footer>Data Analyzer · interactive report</footer>
<script>${script}</script></body></html>`;
}
