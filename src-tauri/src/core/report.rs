//! Report generator. Renders the analysis into the A4 report template
//! (`template/ap-report-template.html`): a cover, a data page, then only what was asked for:
//! tables, one chart per page and the processing diagram. Text is kept to headings and facts.
//! Charts are inline SVG and Inter is embedded, so the HTML is one self-contained file and
//! text and charts share one font; PDF is printed with headless Edge/Chrome.

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::correlation::CorrelationPair;
use super::models::OutputMetrics;
use super::stats::StatRow;
use super::svgplot::esc;

/// The A+P report template; its stylesheet is used verbatim.
/// The report's one font. It is embedded, so text and charts look the same on every computer.
const INTER_WOFF2: &[u8] = include_bytes!("../../assets/Inter-latin.woff2");
const TEMPLATE: &str = include_str!("../../../template/ap-report-template.html");
const LOGO_PNG: &[u8] = include_bytes!("../../../src/assets/ap-logo.png");

/// Plot colours matching the template palette (red first, then text / muted tones).
pub const REPORT_PALETTE: &[&str] = &["#ff2400", "#2a78d6", "#1baf7a", "#6250d6", "#eda100", "#e87ba4", "#008300"];

/// Extra rules for data-dense content (compact tables, paired figures); same tokens as the template.
const EXTRA_CSS: &str = r#"
    table.data { font-size: 7pt; width: 100%; }
    table.data th { font-size: 6.5pt; letter-spacing: 0; padding: 1.5mm 1mm; }
    table.data td { padding: 1.5mm 1mm; }
    table.data td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    table.kv td:first-child { color: var(--red); font-weight: 700; width: 45mm; }
    /* Charts are inline SVG (so they use the page font), without a frame. */
    .report-image { border: 0; padding: 0; }
    .report-image svg { display: block; width: 100%; height: auto; max-height: 115mm; }
    .figure-pair .report-image svg { max-height: 100mm; }
    .figure-pair .report-image + .report-image { margin-top: 6mm; }
    .cover-figure svg { display: block; width: 100%; height: auto; max-height: 62mm; }
"#;

pub struct Plot {
    pub title: String,
    pub svg: String,
    pub caption: String,
}

pub struct ReportBlock {
    /// "clean", "filter" or "adjust".
    pub kind: String,
    pub title: String,
    pub params: String,
    pub effect: String,
}

pub struct FilterInfo {
    pub signal: String,
    pub description: String,
    pub source: String,
    pub blocks: Vec<ReportBlock>,
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}

/// A signal's processing as a block diagram: Source → blocks → Output, wrapped to the page width.
fn pipeline_svg(source: &str, output: &str, blocks: &[ReportBlock]) -> String {
    const W: f64 = 128.0;
    const H: f64 = 46.0;
    const GAP: f64 = 22.0;
    const ROW: f64 = H + 14.0;
    let color = |k: &str| match k {
        "clean" => "#2a78d6",
        "filter" => "#6250d6",
        "adjust" => "#1baf7a",
        "output" => "#ff2400",
        _ => "#66717d",
    };
    let file = source.split(" · ").next().unwrap_or(source);
    let mut items: Vec<(String, String, String, &str)> = vec![("Source".into(), cut(file, 22), String::new(), "source")];
    for b in blocks {
        items.push((b.title.clone(), cut(&b.params, 24), String::new(), b.kind.as_str()));
    }
    items.push(("Output".into(), cut(output, 22), String::new(), "output"));
    let per_row = 4usize;
    let rows = items.len().div_ceil(per_row);
    let width = per_row as f64 * (W + GAP) - GAP;
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {width} {h}\" width=\"100%\" role=\"img\" style=\"max-width:{width}px;font-family:Inter,Arial,sans-serif\">",
        h = rows as f64 * ROW - 14.0 + 2.0
    );
    for (i, (title, line2, line3, kind)) in items.iter().enumerate() {
        let (col, row) = (i % per_row, i / per_row);
        let (x, y) = (col as f64 * (W + GAP), row as f64 * ROW + 1.0);
        let c = color(kind);
        out.push_str(&format!(
            "<rect x=\"{x}\" y=\"{y}\" width=\"{W}\" height=\"{H}\" rx=\"6\" fill=\"#fff\" stroke=\"#d6dae0\"/><rect x=\"{x}\" y=\"{y}\" width=\"4\" height=\"{H}\" rx=\"2\" fill=\"{c}\"/>\
             <text x=\"{tx}\" y=\"{y1}\" font-size=\"11.5\" font-weight=\"600\" fill=\"#0f1216\">{t}</text>\
             <text x=\"{tx}\" y=\"{y2}\" font-size=\"9.5\" fill=\"#2c333b\">{l2}</text>\
             <text x=\"{tx}\" y=\"{y3}\" font-size=\"8.5\" fill=\"#66717d\">{l3}</text>",
            tx = x + 11.0,
            y1 = y + 19.0,
            y2 = y + 35.0,
            y3 = y + 46.0,
            t = esc(&cut(title, 20)),
            l2 = esc(line2),
            l3 = esc(line3),
        ));
        if col > 0 {
            let (x0, ym) = (x - GAP + 3.0, y + H / 2.0);
            out.push_str(&format!(
                "<line x1=\"{x0}\" y1=\"{ym}\" x2=\"{x1}\" y2=\"{ym}\" stroke=\"#a9b1ba\" stroke-width=\"1.5\"/><path d=\"M{x1} {a} L{x2} {ym} L{x1} {b} Z\" fill=\"#a9b1ba\"/>",
                x1 = x - 6.0,
                x2 = x - 1.0,
                a = ym - 3.5,
                b = ym + 3.5
            ));
        }
    }
    out.push_str("</svg>");
    out
}

pub struct ModelInfo {
    pub name: String,
    pub method: String,
    pub order: usize,
    pub input_names: Vec<String>,
    pub output_names: Vec<String>,
    pub metrics: Vec<OutputMetrics>,
}

#[derive(Clone, Serialize)]
pub struct ComparisonStat {
    pub signal: String,
    pub file_name: String,
    pub rmse: f64,
    pub max_deviation: f64,
    pub r_squared: f64,
    pub mean_error: f64,
}

#[derive(Clone, Default)]
pub struct DataSummary {
    pub file_name: String,
    pub file_type: String,
    pub n_samples: usize,
    pub n_signals: usize,
    pub sample_rate: f64,
    pub duration: f64,
}

#[derive(Default)]
pub struct ReportContent {
    pub source_file: Option<String>,
    pub summary: Option<DataSummary>,
    pub overview_plot: Option<String>,
    pub metadata: Option<Map<String, Value>>,
    pub stats: Option<Vec<StatRow>>,
    pub signal_plots: Vec<Plot>,
    pub filters: Vec<FilterInfo>,
    pub correlation_plot: Option<String>,
    pub correlation_pairs: Vec<CorrelationPair>,
    pub correlation_labels: Option<Box<dyn Fn(&str) -> String + Send>>,
    pub models: Vec<ModelInfo>,
    pub simulation_plots: Vec<Plot>,
    pub validation_plots: Vec<Plot>,
    pub comparison_plots: Vec<Plot>,
    pub comparison_stats: Vec<ComparisonStat>,
}

fn template_css() -> String {
    let start = TEMPLATE.find("<style>").map(|i| i + "<style>".len());
    let end = TEMPLATE.find("</style>");
    let raw = match (start, end) {
        (Some(s), Some(e)) if e > s => &TEMPLATE[s..e],
        _ => "",
    };
    // The template points at font files that are not shipped; the embedded font replaces them.
    let mut css = String::new();
    let mut rest = raw;
    while let Some(i) = rest.find("@font-face") {
        css.push_str(&rest[..i]);
        rest = match rest[i..].find('}') {
            Some(j) => &rest[i + j + 1..],
            None => "",
        };
    }
    css.push_str(rest);
    format!(
        "@font-face {{ font-family: Inter; font-weight: 100 900; src: url(data:font/woff2;base64,{}) format(\"woff2\"); }}\n{css}",
        base64::engine::general_purpose::STANDARD.encode(INTER_WOFF2)
    )
}

/// A chart placed straight into the page, so it uses the page's font. Ids are made unique per chart.
fn inline_svg(svg: &str, alt: &str) -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    svg.replace("id=\"c", &format!("id=\"f{n}c")).replace("url(#c", &format!("url(#f{n}c")).replacen("<svg ", &format!("<svg role=\"img\" aria-label=\"{}\" ", esc(alt)), 1)
}

fn meta_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            let items: Vec<String> = a
                .iter()
                .take(25)
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            let more = if a.len() > 25 { format!(" … (+{})", a.len() - 25) } else { String::new() };
            format!("{}{more}", items.join(", "))
        }
        other => other.to_string(),
    }
}

fn fmt_duration(s: f64) -> String {
    if !s.is_finite() {
        return "—".into();
    }
    if s >= 7200.0 {
        format!("{:.1} h", s / 3600.0)
    } else if s >= 120.0 {
        format!("{:.1} min", s / 60.0)
    } else {
        format!("{s:.1} s")
    }
}

fn fmt_num(v: f64) -> String {
    let a = v.abs();
    if !v.is_finite() {
        "—".into()
    } else if a != 0.0 && (a >= 1e6 || a < 1e-3) {
        format!("{v:.3e}")
    } else {
        format!("{v:.4}")
    }
}

/// Builds the page sequence; header/footer are added per page.
struct Doc {
    doc_id: String,
    version: String,
    pages: Vec<(String, String)>, // (section label, inner html)
    section_no: usize,
}

impl Doc {
    fn next_label(&mut self, name: &str) -> String {
        self.section_no += 1;
        format!("{:02} / {}", self.section_no, name)
    }

    fn page(&mut self, label: &str, body: String) {
        self.pages.push((label.to_string(), body));
    }

    fn render_page(&self, label: &str, body: &str, cover: bool, logo: &str) -> String {
        format!(
            r#"  <section class="page{cls}" aria-label="{aria}">
    <header class="header">
      <img class="logo" src="{logo}" alt="Angst+Pfister">
      <span class="section-label">{label}</span>
    </header>
{body}
    <footer class="footer"><span>{id}</span><span class="page-number"></span><span>{ver}</span></footer>
  </section>
"#,
            cls = if cover { " cover" } else { "" },
            aria = esc(label),
            label = esc(label),
            id = esc(&self.doc_id),
            ver = esc(&self.version),
        )
    }
}

fn figure(plot: &Plot) -> String {
    format!("    <figure class=\"report-image\">\n      {}\n    </figure>\n", inline_svg(&plot.svg, &plot.title))
}

/// One page per figure (`per_page` = 1) or two stacked figures per page.
fn figure_pages(doc: &mut Doc, name: &str, heading: &str, _intro: &str, plots: &[Plot], per_page: usize) {
    if plots.is_empty() {
        return;
    }
    let label = doc.next_label(name);
    for (i, chunk) in plots.chunks(per_page).enumerate() {
        let mut body = String::new();
        let h = if per_page == 1 { chunk[0].title.clone() } else if i == 0 { heading.to_string() } else { format!("{heading} (continued)") };
        body.push_str(&format!("    <h2>{}</h2>\n", esc(&h)));
        if per_page > 1 {
            body.push_str("    <div class=\"figure-pair\">\n");
        }
        for p in chunk {
            body.push_str(&figure(p));
        }
        if per_page > 1 {
            body.push_str("    </div>\n");
        }
        doc.page(&label, body);
    }
}

/// Splits table rows over pages (`rows_first` on the first page, `rows_next` after).
fn table_pages(doc: &mut Doc, label: &str, heading: &str, _intro: &str, class: &str, head: &str, rows: &[String], rows_first: usize, rows_next: usize) {
    let mut start = 0;
    let mut first = true;
    loop {
        let take = if first { rows_first } else { rows_next };
        let end = (start + take).min(rows.len());
        let mut body = String::new();
        body.push_str(&format!("    <h2>{}{}</h2>\n", esc(heading), if first { "" } else { " (continued)" }));
        body.push_str(&format!("    <table class=\"{class}\">\n      <thead><tr>{head}</tr></thead>\n      <tbody>\n"));
        for r in &rows[start..end] {
            body.push_str(&format!("        {r}\n"));
        }
        body.push_str("      </tbody>\n    </table>\n");
        doc.page(label, body);
        start = end;
        first = false;
        if start >= rows.len() {
            break;
        }
    }
}

fn th(cols: &[&str]) -> String {
    cols.iter().map(|c| format!("<th scope=\"col\">{}</th>", esc(c))).collect()
}

pub fn render_html(c: &ReportContent) -> String {
    let now = chrono::Local::now();
    let logo = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(LOGO_PNG));
    let mut doc = Doc {
        doc_id: format!("DA-{}", now.format("%Y%m%d-%H%M")),
        version: format!("Data Analyzer {}", env!("CARGO_PKG_VERSION")),
        pages: Vec::new(),
        section_no: 0,
    };
    let s = c.summary.clone().unwrap_or_default();
    let title = c
        .source_file
        .as_ref()
        .and_then(|p| Path::new(p).file_stem().map(|x| x.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Data analysis".into());
    let label_of = |col: &str| c.correlation_labels.as_ref().map(|f| f(col)).unwrap_or_else(|| col.to_string());

    // ---- Sections (pages after the summary) --------------------------------

    if let Some(meta) = c.metadata.as_ref().filter(|m| !m.is_empty()) {
        let label = doc.next_label("Metadata");
        let rows: Vec<String> = meta.iter().map(|(k, v)| format!("<tr><td>{}</td><td>{}</td></tr>", esc(k), esc(&meta_value(v)))).collect();
        table_pages(&mut doc, &label, "Metadata", "Header information detected in the source file.", "kv", &th(&["Key", "Value"]), &rows, 11, 14);
    }

    if let Some(stats) = c.stats.as_ref().filter(|s| !s.is_empty()) {
        let label = doc.next_label("Statistics");
        let rows: Vec<String> = stats
            .iter()
            .map(|r| {
                format!(
                    "<tr><td>{}</td><td class=\"num\">{}</td>{}</tr>",
                    esc(&r.signal),
                    r.count,
                    [r.mean, r.std, r.min, r.q1, r.median, r.q3, r.max, r.skew, r.kurtosis].iter().map(|v| format!("<td class=\"num\">{}</td>", fmt_num(*v))).collect::<String>()
                )
            })
            .collect();
        table_pages(
            &mut doc,
            &label,
            "Statistics",
            "Per-signal statistics of the loaded (and, where applied, filtered) data.",
            "data",
            &th(&["Signal", "Count", "Mean", "Std dev", "Min", "Q1", "Median", "Q3", "Max", "Skew", "Kurtosis"]),
            &rows,
            26,
            32,
        );
    }

    figure_pages(&mut doc, "Signals", "Signals", "", &c.signal_plots, 2);

    if !c.filters.is_empty() {
        let label = doc.next_label("Filters");
        let rows: Vec<String> = c
            .filters
            .iter()
            .map(|f| {
                let flow = if f.blocks.is_empty() { esc(&f.description) } else { pipeline_svg(&f.source, &f.signal, &f.blocks) };
                format!("<tr><td>{}</td><td>{flow}</td></tr>", esc(&f.signal))
            })
            .collect();
        table_pages(&mut doc, &label, "Processing", "What was applied to each signal, in order, left to right.", "", &th(&["Signal", "Steps"]), &rows, 4, 5);
    }

    if let Some(plot) = &c.correlation_plot {
        let label = doc.next_label("Correlations");
        let mut body = String::from("    <h2>Correlation</h2>\n");
        body.push_str(&figure(&Plot { title: "Correlation matrix".into(), svg: plot.clone(), caption: String::new() }));
        doc.page(&label, body);
        if !c.correlation_pairs.is_empty() {
            let rows: Vec<String> = c
                .correlation_pairs
                .iter()
                .map(|p| {
                    format!(
                        "<tr><td>{}</td><td>{}</td><td class=\"num\">{:.3}</td><td class=\"num\">{:.3}</td><td class=\"num\">{:.1}</td></tr>",
                        esc(&label_of(&p.signal_a)),
                        esc(&label_of(&p.signal_b)),
                        p.pearson_r.abs(),
                        p.spearman_r,
                        p.lag_seconds
                    )
                })
                .collect();
            table_pages(&mut doc, &label, "Correlated pairs", "Ranked by absolute Pearson correlation; lag from FFT cross-correlation (±300 s).", "data", &th(&["Signal A", "Signal B", "|r|", "Spearman", "Lag (s)"]), &rows, 22, 28);
        }
    }

    if !c.models.is_empty() {
        let label = doc.next_label("Models");
        let rows: Vec<String> = c
            .models
            .iter()
            .flat_map(|m| {
                let mut v = vec![format!(
                    "<tr><td><strong>{}</strong></td><td>{} · order {}</td><td colspan=\"4\">{} → {}</td></tr>",
                    esc(&m.name),
                    esc(&m.method),
                    m.order,
                    esc(&m.input_names.join(", ")),
                    esc(&m.output_names.join(", "))
                )];
                v.extend(m.metrics.iter().map(|om| {
                    format!(
                        "<tr><td></td><td>{}</td><td class=\"num\">{:.2}</td><td class=\"num\">{:.6}</td><td class=\"num\">{:.4}</td><td class=\"num\">{:.2}</td></tr>",
                        esc(&om.name),
                        om.vaf,
                        om.rmse,
                        om.r_squared,
                        om.nrmse
                    )
                }));
                v
            })
            .collect();
        table_pages(&mut doc, &label, "Models", "Identified discrete-time models in the library with per-output fit.", "data", &th(&["Model", "Method / output", "VAF %", "RMSE", "R²", "NRMSE %"]), &rows, 26, 32);
    }

    figure_pages(&mut doc, "Simulation", "Simulation", "Measured outputs (solid) against the model simulation driven by the measured inputs (dashed).", &c.simulation_plots, 2);
    if !c.simulation_plots.is_empty() {
    }
    figure_pages(&mut doc, "Validation", "Validation", "", &c.validation_plots, 1);
    if !c.validation_plots.is_empty() {
    }

    if !c.comparison_plots.is_empty() || !c.comparison_stats.is_empty() {
        figure_pages(&mut doc, "Comparison", "Comparison", "Aligned overlays of the signals present in all compared files.", &c.comparison_plots, 2);
        if !c.comparison_stats.is_empty() {
            let label = if c.comparison_plots.is_empty() { doc.next_label("Comparison") } else { doc.pages.last().map(|p| p.0.clone()).unwrap_or_default() };
            let rows: Vec<String> = c
                .comparison_stats
                .iter()
                .map(|s| {
                    format!(
                        "<tr><td>{}</td><td>{}</td><td class=\"num\">{:.6}</td><td class=\"num\">{:.6}</td><td class=\"num\">{:.4}</td><td class=\"num\">{:.6}</td></tr>",
                        esc(&s.signal),
                        esc(&s.file_name),
                        s.rmse,
                        s.max_deviation,
                        s.r_squared,
                        s.mean_error
                    )
                })
                .collect();
            table_pages(&mut doc, &label, "Comparison", "Differences of each file to the reference file, interpolated on the reference time grid.", "data", &th(&["Signal", "File", "RMSE", "Max deviation", "R²", "Mean error"]), &rows, 24, 30);
        }
    }

    // ---- Cover and summary (built last, inserted first) ---------------------
    let mut html = String::with_capacity(1 << 20);
    html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str(&format!("  <title>{} - Data Analyzer report</title>\n  <style>", esc(&title)));
    html.push_str(&template_css());
    html.push_str(EXTRA_CSS);
    html.push_str("  </style>\n</head>\n<body>\n");

    let author = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "Data Analyzer".into());
    let cover_fig = match &c.overview_plot {
        Some(svg) => format!("    <figure class=\"spaced cover-figure\">\n      {}\n    </figure>\n", inline_svg(svg, "Signal overview")),
        None => String::new(),
    };
    let cover = format!(
        r#"    <div class="cover-band">
      <p class="eyebrow">Data analysis report</p>
      <h1>{}</h1>
    </div>
{cover_fig}    <dl class="cover-meta">
      <div><dt>Author</dt><dd>{}</dd></div>
      <div><dt>Date</dt><dd>{}</dd></div>
      <div><dt>Version</dt><dd>{}</dd></div>
    </dl>
"#,
        esc(&title),
        esc(&author),
        now.format("%d %B %Y"),
        esc(&doc.version)
    );
    html.push_str(&doc.render_page(&doc.doc_id, &cover, true, &logo));

    // Data
    let mut summary = String::from("    <h2>Data</h2>\n    <table class=\"kv\">\n      <tbody>\n");
    let file = c
        .source_file
        .as_ref()
        .map(|p| Path::new(p).file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone()))
        .unwrap_or_else(|| "Workspace".into());
    for (k, v) in [
        ("File", file),
        ("Rows", s.n_samples.to_string()),
        ("Signals", s.n_signals.to_string()),
        ("Sample rate", format!("{:.3} Hz", s.sample_rate)),
        ("Duration", fmt_duration(s.duration)),
    ] {
        summary.push_str(&format!("        <tr><td>{k}</td><td>{}</td></tr>\n", esc(&v)));
    }
    summary.push_str("      </tbody>\n    </table>\n");
    html.push_str(&doc.render_page("00 / Data", &summary, false, &logo));

    for (label, body) in &doc.pages {
        html.push_str(&doc.render_page(label, body, false, &logo));
    }
    html.push_str("</body>\n</html>\n");
    html
}

fn edge_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            v.push(Path::new(&base).join("Microsoft\\Edge\\Application\\msedge.exe"));
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            v.push(Path::new(&base).join("Google\\Chrome\\Application\\chrome.exe"));
        }
    }
    v
}

fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let enc: String = s
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '%' => "%25".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!("file:///{}", enc.trim_start_matches('/'))
}

/// Converts HTML to PDF with a headless Chromium browser (Edge ships with Windows).
fn html_to_pdf(html: &str, pdf: &Path) -> Result<(), String> {
    let browser = edge_candidates().into_iter().find(|p| p.exists()).ok_or("No Edge/Chrome installation found for PDF export")?;
    let tmp = std::env::temp_dir().join(format!("data_analyzer_report_{}.html", std::process::id()));
    std::fs::write(&tmp, html).map_err(|e| e.to_string())?;
    let profile = std::env::temp_dir().join("data_analyzer_pdf_profile");
    let mut cmd = std::process::Command::new(browser);
    cmd.arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-pdf-header-footer")
        .arg("--no-first-run")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--print-to-pdf={}", pdf.display()))
        .arg(file_url(&tmp));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = std::fs::remove_file(pdf);
    let status = cmd.status().map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&tmp);
    status?;
    if pdf.exists() && std::fs::metadata(pdf).map(|m| m.len() > 0).unwrap_or(false) {
        Ok(())
    } else {
        Err("PDF conversion produced no output".into())
    }
}

/// Writes the report; returns (final path, note). PDF falls back to HTML when conversion fails.
pub fn generate_report(path: &Path, format: &str, content: &ReportContent, progress: &dyn Fn(i32, String)) -> Result<(PathBuf, Option<String>), String> {
    progress(50, "Rendering template...".into());
    let html = render_html(content);
    if format.eq_ignore_ascii_case("pdf") {
        progress(70, "Converting to PDF...".into());
        match html_to_pdf(&html, path) {
            Ok(()) => {
                progress(100, "Report generated.".into());
                Ok((path.to_path_buf(), None))
            }
            Err(e) => {
                let html_path = path.with_extension("html");
                std::fs::write(&html_path, html).map_err(|e| format!("Cannot write {}: {e}", html_path.display()))?;
                progress(100, "PDF conversion not available, saved as HTML instead.".into());
                Ok((html_path, Some(format!("PDF conversion failed ({e}); saved as HTML instead."))))
            }
        }
    } else {
        std::fs::write(path, html).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
        progress(100, "Report generated.".into());
        Ok((path.to_path_buf(), None))
    }
}
