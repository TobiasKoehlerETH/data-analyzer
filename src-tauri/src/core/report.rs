//! Report generator. Renders the analysis into the A+P A4 report template
//! (`template/ap-report-template.html`): cover, summary, one page per figure,
//! paginated tables and a results / next-steps page. Plots are embedded as base64
//! images so the HTML is self-contained; PDF is printed with headless Edge/Chrome.

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use super::correlation::CorrelationPair;
use super::models::OutputMetrics;
use super::stats::StatRow;
use super::svgplot::esc;

/// The A+P report template; its stylesheet is used verbatim.
const TEMPLATE: &str = include_str!("../../../template/ap-report-template.html");
const LOGO_PNG: &[u8] = include_bytes!("../../../src/assets/ap-logo.png");

/// Plot colours matching the template palette (red first, then text / muted tones).
pub const REPORT_PALETTE: &[&str] = &["#c41230", "#111419", "#5f6670", "#8b0d24", "#9aa1aa", "#e07a8c", "#3a3f47", "#c4c8ce"];

/// Extra rules for data-dense content (compact tables, paired figures); same tokens as the template.
const EXTRA_CSS: &str = r#"
    table.data { font-size: 8pt; }
    table.data th, table.data td { padding: 1.5mm 2mm; }
    table.data td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    table.kv td:first-child { color: var(--red); font-weight: 700; width: 45mm; }
    .figure-pair .report-image img { max-height: 82mm; }
    .figure-pair .report-image + .report-image { margin-top: 6mm; }
    .cover-figure img { display: block; width: 100%; max-height: 62mm; object-fit: contain; border: 1px solid var(--line); }
    .continued { color: var(--muted); font-size: 9pt; margin-top: 3mm; }
"#;

pub struct Plot {
    pub title: String,
    pub svg: String,
    pub caption: String,
}

pub struct FilterInfo {
    pub signal: String,
    pub description: String,
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
    match (start, end) {
        (Some(s), Some(e)) if e > s => TEMPLATE[s..e].to_string(),
        _ => String::new(),
    }
}

fn img_svg(svg: &str, alt: &str) -> String {
    format!(
        r#"<img src="data:image/svg+xml;base64,{}" alt="{}">"#,
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes()),
        esc(alt)
    )
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
    format!(
        "    <figure class=\"report-image\">\n      {}\n      <figcaption>{}</figcaption>\n    </figure>\n",
        img_svg(&plot.svg, &plot.title),
        esc(&plot.caption)
    )
}

/// One page per figure (`per_page` = 1) or two stacked figures per page.
fn figure_pages(doc: &mut Doc, name: &str, heading: &str, intro: &str, plots: &[Plot], per_page: usize) {
    if plots.is_empty() {
        return;
    }
    let label = doc.next_label(name);
    for (i, chunk) in plots.chunks(per_page).enumerate() {
        let mut body = String::new();
        let h = if per_page == 1 { chunk[0].title.clone() } else if i == 0 { heading.to_string() } else { format!("{heading} (continued)") };
        body.push_str(&format!("    <h2>{}</h2>\n", esc(&h)));
        if i == 0 && !intro.is_empty() {
            body.push_str(&format!("    <p class=\"intro\">{}</p>\n", esc(intro)));
        }
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
fn table_pages(doc: &mut Doc, label: &str, heading: &str, intro: &str, class: &str, head: &str, rows: &[String], rows_first: usize, rows_next: usize) {
    let mut start = 0;
    let mut first = true;
    loop {
        let take = if first { rows_first } else { rows_next };
        let end = (start + take).min(rows.len());
        let mut body = String::new();
        body.push_str(&format!("    <h2>{}{}</h2>\n", esc(heading), if first { "" } else { " (continued)" }));
        if first {
            body.push_str(&format!("    <p class=\"intro\">{}</p>\n", esc(intro)));
        }
        body.push_str(&format!("    <table class=\"{class}\">\n      <thead><tr>{head}</tr></thead>\n      <tbody>\n"));
        for r in &rows[start..end] {
            body.push_str(&format!("        {r}\n"));
        }
        body.push_str("      </tbody>\n    </table>\n");
        if end < rows.len() {
            body.push_str("    <p class=\"continued\">Continued on next page.</p>\n");
        }
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
    let best_model = c.models.iter().map(|m| {
        let mean = if m.metrics.is_empty() { 0.0 } else { m.metrics.iter().map(|x| x.vaf).sum::<f64>() / m.metrics.len() as f64 };
        (m, mean)
    }).max_by(|a, b| a.1.total_cmp(&b.1));
    let top_pair = c.correlation_pairs.first();
    let label_of = |col: &str| c.correlation_labels.as_ref().map(|f| f(col)).unwrap_or_else(|| col.to_string());

    // ---- Sections (pages after the summary) --------------------------------
    let mut results: Vec<(String, String, String)> = Vec::new();

    if let Some(meta) = c.metadata.as_ref().filter(|m| !m.is_empty()) {
        let label = doc.next_label("Metadata");
        let rows: Vec<String> = meta.iter().map(|(k, v)| format!("<tr><td>{}</td><td>{}</td></tr>", esc(k), esc(&meta_value(v)))).collect();
        table_pages(&mut doc, &label, "File metadata", "Header information detected in the source file.", "kv", &th(&["Key", "Value"]), &rows, 11, 14);
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
            "Descriptive statistics",
            "Per-signal statistics of the loaded (and, where applied, filtered) data.",
            "data",
            &th(&["Signal", "Count", "Mean", "Std", "Min", "Q1", "Median", "Q3", "Max", "Skew", "Kurt."]),
            &rows,
            26,
            32,
        );
        results.push(("Statistics".into(), format!("{} signals summarised", stats.len()), "Ranges and distributions documented".into()));
    }

    figure_pages(&mut doc, "Signals", "Signal plots", "", &c.signal_plots, 1);

    if !c.filters.is_empty() {
        let label = doc.next_label("Filters");
        let rows: Vec<String> = c.filters.iter().map(|f| format!("<tr><td>{}</td><td>{}</td></tr>", esc(&f.signal), esc(&f.description))).collect();
        table_pages(&mut doc, &label, "Applied filters", "Filter chains applied to the full data set (in order).", "", &th(&["Signal", "Filter chain"]), &rows, 11, 14);
        results.push(("Filtering".into(), format!("{} signal(s) filtered", c.filters.len()), "Later analyses use the filtered signals".into()));
    }

    if let Some(plot) = &c.correlation_plot {
        let label = doc.next_label("Correlations");
        let mut body = String::from("    <h2>Correlation analysis</h2>\n    <p class=\"intro\">Pearson correlation matrix of all signals (red = positive, grey = negative).</p>\n");
        body.push_str(&figure(&Plot { title: "Correlation matrix".into(), svg: plot.clone(), caption: "Pearson correlation coefficient r for every signal pair.".into() }));
        if let Some(p) = top_pair {
            body.push_str(&format!(
                "    <aside class=\"callout takeaway\"><strong>Strongest relation: {} ↔ {} (|r| = {:.3}).</strong></aside>\n",
                esc(&label_of(&p.signal_a)),
                esc(&label_of(&p.signal_b)),
                p.pearson_r.abs()
            ));
        }
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
            table_pages(&mut doc, &label, "Top correlated pairs", "Ranked by absolute Pearson correlation; lag from FFT cross-correlation (±300 s).", "data", &th(&["Signal A", "Signal B", "|r|", "Spearman", "Lag (s)"]), &rows, 22, 28);
        }
        if let Some(p) = top_pair {
            results.push(("Correlations".into(), format!("|r| = {:.3} for {} ↔ {}", p.pearson_r.abs(), label_of(&p.signal_a), label_of(&p.signal_b)), "Candidate cause–effect pair to investigate".into()));
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
        table_pages(&mut doc, &label, "State-space models", "Identified discrete-time models in the library with per-output fit.", "data", &th(&["Model", "Method / output", "VAF %", "RMSE", "R²", "NRMSE %"]), &rows, 26, 32);
        if let Some((m, vaf)) = best_model {
            results.push(("System identification".into(), format!("Best model {} (mean VAF {vaf:.1} %)", m.name), if vaf >= 80.0 { "Model reproduces the measured dynamics".into() } else { "Fit is limited — refine order or I/O selection".to_string() }));
        }
    }

    figure_pages(&mut doc, "Simulation", "Simulation results", "Measured outputs (solid) against the model simulation driven by the measured inputs (dashed).", &c.simulation_plots, 2);
    if !c.simulation_plots.is_empty() {
        results.push(("Simulation".into(), format!("{} output trace(s) simulated", c.simulation_plots.len()), "Visual check of model behaviour".into()));
    }
    figure_pages(&mut doc, "Validation", "Validation", "", &c.validation_plots, 1);
    if !c.validation_plots.is_empty() {
        results.push(("Validation".into(), format!("{} output(s) validated", c.validation_plots.len()), "Residual whiteness and normality checked".into()));
    }

    if !c.comparison_plots.is_empty() || !c.comparison_stats.is_empty() {
        figure_pages(&mut doc, "Comparison", "File comparison", "Aligned overlays of the signals present in all compared files.", &c.comparison_plots, 2);
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
            table_pages(&mut doc, &label, "Comparison statistics", "Differences of each file to the reference file, interpolated on the reference time grid.", "data", &th(&["Signal", "File", "RMSE", "Max dev.", "R²", "Mean error"]), &rows, 24, 30);
            let worst = c.comparison_stats.iter().max_by(|a, b| a.rmse.total_cmp(&b.rmse)).unwrap();
            results.push(("Comparison".into(), format!("Largest RMSE: {} in {}", worst.signal, worst.file_name), "Check this signal for drift between runs".into()));
        }
    }

    // ---- Results / next steps ---------------------------------------------
    if !results.is_empty() {
        let label = doc.next_label("Results");
        let mut body = String::from("    <h2>Results</h2>\n    <p class=\"intro\">Outcome of each analysis step included in this report.</p>\n    <table>\n      <thead><tr><th scope=\"col\">Item</th><th scope=\"col\">Result / status</th><th scope=\"col\">Implication</th></tr></thead>\n      <tbody>\n");
        for (item, res, imp) in results.iter().take(8) {
            body.push_str(&format!("        <tr><td>{}</td><td>{}</td><td>{}</td></tr>\n", esc(item), esc(res), esc(imp)));
        }
        body.push_str("      </tbody>\n    </table>\n");
        let mut steps: Vec<(&str, String)> = Vec::new();
        match best_model {
            Some((_, vaf)) if vaf < 80.0 => steps.push(("Refine the model", "Increase the order range or revisit the input/output selection".into())),
            Some(_) if c.validation_plots.is_empty() => steps.push(("Validate the model", "Run residual analysis on the selected model".into())),
            Some(_) => steps.push(("Confirm on new data", "Simulate the model on an independent test run".into())),
            None => steps.push(("Identify a model", "Use System ID to capture the input/output dynamics".into())),
        }
        if c.filters.is_empty() {
            steps.push(("Review filtering", "Check the auto-suggested filters for noisy signals".into()));
        } else {
            steps.push(("Document filters", "Keep the saved filter chains with this report".into()));
        }
        steps.push(("Share the findings", format!("Distribute {} to the project team", doc.doc_id)));
        if results.len() <= 5 {
            body.push_str("    <h3 class=\"spaced\">Next steps</h3>\n    <div class=\"steps\">\n");
            for (i, (a, o)) in steps.iter().take(3).enumerate() {
                body.push_str(&format!("      <div class=\"step\"><span class=\"eyebrow\">{:02}</span><h3>{}</h3><p class=\"small\">{}</p></div>\n", i + 1, esc(a), esc(o)));
            }
            body.push_str("    </div>\n");
        }
        doc.page(&label, body);
    }

    // ---- Cover and summary (built last, inserted first) ---------------------
    let mut html = String::with_capacity(1 << 20);
    html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str(&format!("  <title>{} - Data Analyzer report</title>\n  <style>", esc(&title)));
    html.push_str(&template_css());
    html.push_str(EXTRA_CSS);
    html.push_str("  </style>\n</head>\n<body>\n");

    let author = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "Data Analyzer".into());
    let subtitle = if s.n_samples > 0 {
        format!("{} · {} samples · {} signals · {:.3} Hz", s.file_type, s.n_samples, s.n_signals, s.sample_rate)
    } else {
        "Time-series analysis".into()
    };
    let cover_fig = match &c.overview_plot {
        Some(svg) => format!("    <figure class=\"spaced cover-figure\">\n      {}\n    </figure>\n", img_svg(svg, "Signal overview")),
        None => String::new(),
    };
    let cover = format!(
        r#"    <div class="cover-band">
      <p class="eyebrow">Data analysis report</p>
      <h1>{}</h1>
      <p class="cover-subtitle">{}</p>
    </div>
{cover_fig}    <dl class="cover-meta">
      <div><dt>Author</dt><dd>{}</dd></div>
      <div><dt>Date</dt><dd>{}</dd></div>
      <div><dt>Version</dt><dd>{}</dd></div>
    </dl>
"#,
        esc(&title),
        esc(&subtitle),
        esc(&author),
        now.format("%d %B %Y"),
        esc(&doc.version)
    );
    html.push_str(&doc.render_page(&doc.doc_id, &cover, true, &logo));

    // Summary
    let mut summary = String::new();
    let headline = match (best_model, top_pair) {
        (Some((m, vaf)), _) => format!("Model {} explains {vaf:.1} % of the output variance", m.name),
        (None, Some(p)) => format!("{} and {} are strongly related (|r| = {:.2})", label_of(&p.signal_a), label_of(&p.signal_b), p.pearson_r.abs()),
        _ => format!("{} signals analysed over {}", s.n_signals, fmt_duration(s.duration)),
    };
    summary.push_str(&format!("    <h2>{}</h2>\n", esc(&headline)));
    summary.push_str(&format!(
        "    <p class=\"intro\">Analysis of {} recorded with {} and processed with the Data Analyzer.</p>\n",
        esc(&c.source_file.clone().unwrap_or_else(|| "the loaded data".into())),
        esc(&s.file_type)
    ));
    let third = match best_model {
        Some((_, vaf)) => (format!("{vaf:.1} %"), "Best model mean VAF".to_string()),
        None => (format!("{:.3} Hz", s.sample_rate), "Sample rate".to_string()),
    };
    summary.push_str(&format!(
        "    <div class=\"cards\">\n      <div class=\"card\"><p class=\"metric\">{}</p><p class=\"small\">Samples</p></div>\n      <div class=\"card\"><p class=\"metric\">{}</p><p class=\"small\">Signals over {}</p></div>\n      <div class=\"card\"><p class=\"metric\">{}</p><p class=\"small\">{}</p></div>\n    </div>\n",
        s.n_samples,
        s.n_signals,
        esc(&fmt_duration(s.duration)),
        esc(&third.0),
        esc(&third.1)
    ));
    if let Some(p) = c.signal_plots.first() {
        summary.push_str(&figure(&Plot { title: p.title.clone(), svg: p.svg.clone(), caption: format!("Overview: {}", p.caption) }).replace("class=\"report-image\"", "class=\"report-image spaced\""));
    }
    let mut findings: Vec<String> = results.iter().take(3).map(|(i, r, _)| format!("{i}: {r}")).collect();
    if findings.is_empty() {
        findings.push(format!("{} signals over {}", s.n_signals, fmt_duration(s.duration)));
    }
    let sections: Vec<String> = doc.pages.iter().map(|p| p.0.clone()).fold(Vec::new(), |mut acc, l| {
        if !acc.contains(&l) {
            acc.push(l);
        }
        acc
    });
    summary.push_str(&format!(
        "    <div class=\"columns spaced\">\n      <div><h3>Key findings</h3><ul>{}</ul></div>\n      <div><h3>Contents</h3><p class=\"small\">{}</p></div>\n    </div>\n",
        findings.iter().map(|f| format!("<li>{}</li>", esc(f))).collect::<String>(),
        esc(&sections.join(" · "))
    ));
    html.push_str(&doc.render_page("00 / Summary", &summary, false, &logo));

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
