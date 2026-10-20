//! Minimal static SVG chart renderer for reports. Matches the in-app chart theme
//! (src/lib/chart.ts): hairline recessive grid and axes, 2px lines, ink-coloured text,
//! the validated red-first palette and a blue ↔ gray ↔ red diverging scale.

use super::downsample::minmax;
use super::report::REPORT_PALETTE;

/// The same stack as the report's text, so charts and text match.
const FONT: &str = "Inter,Arial,sans-serif";
const AXIS: &str = "#c3c2b7";
const GRID: &str = "#e1e0d9";
const MUTED: &str = "#898781";
const INK: &str = "#0b0b0b";
const SECONDARY: &str = "#52514e";
/// Bars never exceed this thickness; the rest of the band stays empty.
const MAX_BAR: f64 = 24.0;

pub struct Series {
    pub label: String,
    pub color: String,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub dashed: bool,
    pub width: f64,
}

impl Series {
    pub fn line(label: impl Into<String>, color: &str, x: Vec<f64>, y: Vec<f64>) -> Self {
        Series { label: label.into(), color: color.into(), x, y, dashed: false, width: 2.0 }
    }
    pub fn dashed(mut self) -> Self {
        self.dashed = true;
        self
    }
}

#[derive(Default)]
pub struct Panel {
    pub series: Vec<Series>,
    pub ylabel: String,
    pub title: Option<String>,
    /// Horizontal reference lines, drawn as solid hairlines.
    pub hlines: Vec<f64>,
    pub legend: bool,
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn nice_step(range: f64, target: usize) -> f64 {
    if !(range.is_finite()) || range <= 0.0 {
        return 1.0;
    }
    let raw = range / target.max(1) as f64;
    let mag = 10f64.powf(raw.log10().floor());
    let norm = raw / mag;
    let nice = if norm < 1.5 {
        1.0
    } else if norm < 3.0 {
        2.0
    } else if norm < 7.0 {
        5.0
    } else {
        10.0
    };
    nice * mag
}

pub fn ticks(lo: f64, hi: f64, target: usize) -> Vec<f64> {
    let step = nice_step(hi - lo, target);
    let start = (lo / step).ceil() * step;
    let mut out = Vec::new();
    let mut v = start;
    while v <= hi + step * 1e-9 && out.len() < 50 {
        out.push(if v.abs() < step * 1e-9 { 0.0 } else { v });
        v += step;
    }
    out
}

pub fn fmt_tick(v: f64, step: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if a >= 1e5 || a < 1e-3 {
        return format!("{v:.1e}");
    }
    let decimals = if step >= 1.0 { 0 } else { (-step.log10()).ceil().max(0.0) as usize };
    format!("{v:.decimals$}")
}

fn bounds(vals: impl Iterator<Item = f64>) -> Option<(f64, f64)> {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in vals.filter(|v| v.is_finite()) {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    if lo.is_finite() {
        if hi - lo < 1e-12 * lo.abs().max(1.0) {
            let pad = lo.abs().max(1.0) * 0.05;
            return Some((lo - pad, hi + pad));
        }
        Some((lo, hi))
    } else {
        None
    }
}

fn path_d(xs: &[f64], ys: &[f64], sx: &dyn Fn(f64) -> f64, sy: &dyn Fn(f64) -> f64) -> String {
    let mut d = String::with_capacity(xs.len() * 14);
    let mut pen_down = false;
    for (x, y) in xs.iter().zip(ys) {
        if !x.is_finite() || !y.is_finite() {
            pen_down = false;
            continue;
        }
        d.push_str(if pen_down { "L" } else { "M" });
        d.push_str(&format!("{:.1},{:.1}", sx(*x), sy(*y)));
        pen_down = true;
    }
    d
}

struct Frame {
    left: f64,
    top: f64,
    w: f64,
    h: f64,
}

fn axes(out: &mut String, fr: &Frame, xr: (f64, f64), yr: (f64, f64), show_x_labels: bool) {
    let sx = |x: f64| fr.left + (x - xr.0) / (xr.1 - xr.0) * fr.w;
    let sy = |y: f64| fr.top + fr.h - (y - yr.0) / (yr.1 - yr.0) * fr.h;
    let xt = ticks(xr.0, xr.1, 8);
    let yt = ticks(yr.0, yr.1, 4);
    let xstep = nice_step(xr.1 - xr.0, 8);
    let ystep = nice_step(yr.1 - yr.0, 4);
    for t in &xt {
        let x = sx(*t);
        out.push_str(&format!(r##"<line x1="{x:.1}" y1="{:.1}" x2="{x:.1}" y2="{:.1}" stroke="{GRID}" stroke-width="1"/>"##, fr.top, fr.top + fr.h));
        if show_x_labels {
            out.push_str(&format!(
                r##"<text x="{x:.1}" y="{:.1}" font-size="10" text-anchor="middle" fill="{MUTED}">{}</text>"##,
                fr.top + fr.h + 13.0,
                fmt_tick(*t, xstep)
            ));
        }
    }
    for t in &yt {
        let y = sy(*t);
        out.push_str(&format!(r##"<line x1="{:.1}" y1="{y:.1}" x2="{:.1}" y2="{y:.1}" stroke="{GRID}" stroke-width="1"/>"##, fr.left, fr.left + fr.w));
        out.push_str(&format!(
            r##"<text x="{:.1}" y="{:.1}" font-size="10" text-anchor="end" fill="{MUTED}">{}</text>"##,
            fr.left - 5.0,
            y + 3.5,
            fmt_tick(*t, ystep)
        ));
    }
    out.push_str(&format!(
        r##"<path d="M{:.1},{:.1}V{:.1}H{:.1}" fill="none" stroke="{AXIS}" stroke-width="1"/>"##,
        fr.left,
        fr.top,
        fr.top + fr.h,
        fr.left + fr.w
    ));
}

fn legend(out: &mut String, fr: &Frame, items: &[(&str, &str, bool)]) {
    let mut x = fr.left + 8.0;
    let y = fr.top + 10.0;
    let width: f64 = items.iter().map(|(l, _, _)| 30.0 + l.chars().count() as f64 * 5.6).sum();
    // A surface-coloured plate keeps the legend legible over the data.
    out.push_str(&format!(r##"<rect x="{:.1}" y="{:.1}" width="{width:.1}" height="16" fill="#fff" fill-opacity="0.9"/>"##, x - 4.0, y - 8.0));
    for (label, color, dashed) in items {
        let dash = if *dashed { r##" stroke-dasharray="4 3""## } else { "" };
        out.push_str(&format!(r##"<line x1="{x:.1}" y1="{y:.1}" x2="{:.1}" y2="{y:.1}" stroke="{color}" stroke-width="2"{dash}/>"##, x + 16.0));
        out.push_str(&format!(r##"<text x="{:.1}" y="{:.1}" font-size="10" fill="{SECONDARY}">{}</text>"##, x + 20.0, y + 3.5, esc(label)));
        x += 30.0 + label.chars().count() as f64 * 5.6;
    }
}

fn svg_open(w: f64, h: f64) -> String {
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0}" height="{h:.0}" viewBox="0 0 {w:.0} {h:.0}" font-family="{FONT}" fill="{INK}"><rect width="100%" height="100%" fill="#fff"/>"##
    )
}

/// Vertically stacked line panels sharing the x axis.
pub fn stacked_lines(panels: &[Panel], xlabel: &str, title: Option<&str>, width: f64, panel_h: f64) -> String {
    let title_h = if title.is_some() {
        26.0
    } else if panels.first().is_some_and(|p| p.title.is_some()) {
        18.0
    } else {
        6.0
    };
    let gap = 14.0;
    let bottom = 34.0;
    let left = 78.0;
    let right = 16.0;
    let height = title_h + panels.len() as f64 * (panel_h + gap) + bottom;
    let mut out = svg_open(width, height);
    if let Some(t) = title {
        out.push_str(&format!(r##"<text x="{left}" y="18" font-size="14" fill="{INK}">{}</text>"##, esc(t)));
    }
    let xr = bounds(panels.iter().flat_map(|p| p.series.iter().flat_map(|s| s.x.iter().copied()))).unwrap_or((0.0, 1.0));
    for (i, p) in panels.iter().enumerate() {
        let fr = Frame { left, top: title_h + i as f64 * (panel_h + gap), w: width - left - right, h: panel_h };
        let yr = bounds(
            p.series.iter().flat_map(|s| s.y.iter().copied()).chain(p.hlines.iter().copied()),
        )
        .unwrap_or((0.0, 1.0));
        let last = i + 1 == panels.len();
        axes(&mut out, &fr, xr, yr, last);
        let sx = |x: f64| fr.left + (x - xr.0) / (xr.1 - xr.0) * fr.w;
        let sy = |y: f64| fr.top + fr.h - (y - yr.0) / (yr.1 - yr.0) * fr.h;
        for y in &p.hlines {
            out.push_str(&format!(
                r##"<line x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}" stroke="{AXIS}" stroke-width="1"/>"##,
                fr.left,
                sy(*y),
                fr.left + fr.w,
                sy(*y)
            ));
        }
        out.push_str(&format!(r##"<clipPath id="c{i}"><rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}"/></clipPath><g clip-path="url(#c{i})">"##, fr.left, fr.top, fr.w, fr.h));
        for s in &p.series {
            let n = s.x.len().min(s.y.len());
            let (xs, ys) = minmax(&s.x, &s.y, 0, n, 2400);
            let dash = if s.dashed { r##" stroke-dasharray="5 3""## } else { "" };
            out.push_str(&format!(
                r##"<path d="{}" fill="none" stroke="{}" stroke-width="{}" stroke-linejoin="round" stroke-linecap="round"{dash}/>"##,
                path_d(&xs, &ys, &sx, &sy),
                s.color,
                s.width
            ));
        }
        out.push_str("</g>");
        if let Some(t) = &p.title {
            out.push_str(&format!(r##"<text x="{:.1}" y="{:.1}" font-size="11" text-anchor="end" fill="{SECONDARY}">{}</text>"##, fr.left + fr.w, fr.top - 3.0, esc(t)));
        }
        let yl = esc(&p.ylabel.chars().take(34).collect::<String>());
        out.push_str(&format!(
            r##"<text transform="translate(14 {:.1}) rotate(-90)" font-size="10" text-anchor="middle" fill="{SECONDARY}">{yl}</text>"##,
            fr.top + fr.h / 2.0
        ));
        if (p.legend || p.series.len() > 1) && !p.series.is_empty() {
            let items: Vec<(&str, &str, bool)> = p.series.iter().map(|s| (s.label.as_str(), s.color.as_str(), s.dashed)).collect();
            legend(&mut out, &fr, &items);
        }
    }
    out.push_str(&format!(
        r##"<text x="{:.1}" y="{:.1}" font-size="11" text-anchor="middle" fill="{SECONDARY}">{}</text>"##,
        left + (width - left - right) / 2.0,
        height - 6.0,
        esc(xlabel)
    ));
    out.push_str("</svg>");
    out
}

/// Density histogram with an optional overlay curve.
pub fn histogram(values: &[f64], bins: usize, curve: Option<(&[f64], &[f64], &str)>, xlabel: &str, title: Option<&str>, width: f64, height: f64) -> String {
    let (lo, hi) = bounds(values.iter().copied()).unwrap_or((0.0, 1.0));
    let bw = (hi - lo) / bins as f64;
    let mut counts = vec![0usize; bins];
    let mut n = 0;
    for v in values.iter().filter(|v| v.is_finite()) {
        let b = (((v - lo) / bw) as usize).min(bins - 1);
        counts[b] += 1;
        n += 1;
    }
    let dens: Vec<f64> = counts.iter().map(|c| *c as f64 / (n.max(1) as f64 * bw)).collect();
    let xr = match curve {
        Some((cx, _, _)) => bounds(cx.iter().copied().chain([lo, hi])).unwrap(),
        None => (lo, hi),
    };
    let ymax = dens.iter().copied().chain(curve.map(|c| c.1.to_vec()).unwrap_or_default()).fold(0.0, f64::max) * 1.05;
    let title_h = if title.is_some() { 26.0 } else { 8.0 };
    let fr = Frame { left: 70.0, top: title_h, w: width - 86.0, h: height - title_h - 36.0 };
    let mut out = svg_open(width, height);
    if let Some(t) = title {
        out.push_str(&format!(r##"<text x="70" y="18" font-size="14" fill="{INK}">{}</text>"##, esc(t)));
    }
    axes(&mut out, &fr, xr, (0.0, ymax.max(1e-300)), true);
    let sx = |x: f64| fr.left + (x - xr.0) / (xr.1 - xr.0) * fr.w;
    let sy = |y: f64| fr.top + fr.h - y / ymax.max(1e-300) * fr.h;
    for (i, d) in dens.iter().enumerate() {
        let x0 = sx(lo + i as f64 * bw);
        let x1 = sx(lo + (i + 1) as f64 * bw);
        out.push_str(&format!(
            r##"<rect x="{x0:.1}" y="{:.1}" width="{:.2}" height="{:.1}" fill="{}"/>"##,
            sy(*d),
            (x1 - x0 - 2.0).max(0.5),
            fr.top + fr.h - sy(*d),
            REPORT_PALETTE[0]
        ));
    }
    if let Some((cx, cy, label)) = curve {
        out.push_str(&format!(r##"<path d="{}" fill="none" stroke="{}" stroke-width="2"/>"##, path_d(cx, cy, &sx, &sy), REPORT_PALETTE[1]));
        legend(&mut out, &fr, &[("Residuals", REPORT_PALETTE[0], false), (label, REPORT_PALETTE[1], false)]);
    }
    out.push_str(&format!(r##"<text x="{:.1}" y="{:.1}" font-size="11" text-anchor="middle">{}</text>"##, fr.left + fr.w / 2.0, height - 6.0, esc(xlabel)));
    out.push_str(&format!(r##"<text transform="translate(14 {:.1}) rotate(-90)" font-size="10" text-anchor="middle">Density</text>"##, fr.top + fr.h / 2.0));
    out.push_str("</svg>");
    out
}

/// Diverging colour for r ∈ [-1, 1]: blue → neutral gray → red, equal steps per arm.
pub fn diverging(v: f64) -> String {
    if !v.is_finite() {
        return "#ffffff".into();
    }
    let v = v.clamp(-1.0, 1.0);
    let (r0, g0, b0) = (240.0, 239.0, 236.0);
    let (r1, g1, b1) = if v >= 0.0 { (184.0, 49.0, 47.0) } else { (28.0, 92.0, 171.0) };
    let t = v.abs();
    format!("#{:02x}{:02x}{:02x}", (r0 + (r1 - r0) * t) as u8, (g0 + (g1 - g0) * t) as u8, (b0 + (b1 - b0) * t) as u8)
}

pub fn heatmap(matrix: &[Vec<f64>], labels: &[String], title: Option<&str>) -> String {
    let n = matrix.len().max(1);
    let label_w = 130.0;
    let cell = (520.0 / n as f64).clamp(8.0, 40.0);
    let grid = cell * n as f64;
    let title_h = if title.is_some() { 26.0 } else { 6.0 };
    let width = label_w + grid + 90.0;
    let height = title_h + grid + label_w;
    let mut out = svg_open(width, height);
    if let Some(t) = title {
        out.push_str(&format!(r##"<text x="{label_w}" y="18" font-size="14" fill="{INK}">{}</text>"##, esc(t)));
    }
    let fs = (cell * 0.6).clamp(6.0, 10.0);
    for (i, row) in matrix.iter().enumerate() {
        for (j, v) in row.iter().enumerate() {
            // A 2px surface gap separates neighbouring cells.
            out.push_str(&format!(
                r##"<rect x="{:.1}" y="{:.1}" width="{:.2}" height="{:.2}" fill="{}"/>"##,
                label_w + j as f64 * cell + 1.0,
                title_h + i as f64 * cell + 1.0,
                (cell - 2.0).max(1.0),
                (cell - 2.0).max(1.0),
                diverging(*v)
            ));
        }
    }
    for (i, l) in labels.iter().enumerate() {
        let l = esc(&l.chars().take(20).collect::<String>());
        out.push_str(&format!(
            r##"<text x="{:.1}" y="{:.1}" font-size="{fs:.1}" text-anchor="end">{l}</text>"##,
            label_w - 4.0,
            title_h + (i as f64 + 0.5) * cell + fs * 0.35
        ));
        let x = label_w + (i as f64 + 0.5) * cell + fs * 0.35;
        let y = title_h + grid + 4.0;
        out.push_str(&format!(r##"<text transform="translate({x:.1} {y:.1}) rotate(-90)" font-size="{fs:.1}" text-anchor="end">{l}</text>"##));
    }
    // Colour bar
    let bx = label_w + grid + 22.0;
    for k in 0..100 {
        let v = 1.0 - k as f64 / 50.0;
        out.push_str(&format!(r##"<rect x="{bx:.1}" y="{:.2}" width="14" height="{:.2}" fill="{}"/>"##, title_h + k as f64 * grid / 100.0, grid / 100.0 + 0.3, diverging(v)));
    }
    for (v, lbl) in [(1.0, "1"), (0.0, "0"), (-1.0, "-1")] {
        let y = title_h + (1.0 - v) / 2.0 * grid;
        out.push_str(&format!(r##"<text x="{:.1}" y="{:.1}" font-size="10" fill="{MUTED}">{lbl}</text>"##, bx + 18.0, y + 3.5));
    }
    out.push_str("</svg>");
    out
}

pub fn bar_chart(labels: &[String], values: &[f64], ylabel: &str, ymax: f64, width: f64, height: f64) -> String {
    let fr = Frame { left: 60.0, top: 12.0, w: width - 76.0, h: height - 90.0 };
    let mut out = svg_open(width, height);
    axes(&mut out, &Frame { ..fr }, (0.0, labels.len().max(1) as f64), (0.0, ymax), false);
    let n = labels.len().max(1) as f64;
    let bw = fr.w / n;
    for (i, (l, v)) in labels.iter().zip(values).enumerate() {
        let h = (v / ymax).clamp(0.0, 1.0) * fr.h;
        let w = (bw * 0.7).min(MAX_BAR);
        let x = fr.left + i as f64 * bw + (bw - w) / 2.0;
        let base = fr.top + fr.h;
        let top = base - h;
        let r = 4f64.min(h).min(w / 2.0);
        // 4px rounded data end, square at the baseline.
        out.push_str(&format!(
            r##"<path d="M{x:.1},{base:.1}V{:.1}Q{x:.1},{top:.1} {:.1},{top:.1}H{:.1}Q{:.1},{top:.1} {:.1},{:.1}V{base:.1}Z" fill="{}"/>"##,
            top + r,
            x + r,
            x + w - r,
            x + w,
            x + w,
            top + r,
            REPORT_PALETTE[0]
        ));
        out.push_str(&format!(r##"<text x="{:.1}" y="{:.1}" font-size="9" text-anchor="middle">{v:.1}%</text>"##, x + w / 2.0, top - 3.0));
        let lx = x + w / 2.0;
        let ly = fr.top + fr.h + 10.0;
        out.push_str(&format!(r##"<text transform="translate({lx:.1} {ly:.1}) rotate(-40)" font-size="9" text-anchor="end">{}</text>"##, esc(l)));
    }
    out.push_str(&format!(r##"<text transform="translate(14 {:.1}) rotate(-90)" font-size="10" text-anchor="middle">{}</text>"##, fr.top + fr.h / 2.0, esc(ylabel)));
    out.push_str("</svg>");
    out
}
