use data_analyzer_lib::core::report::{render_html, ReportContent, ResultEntry};

#[test]
fn results_section_lists_every_row_under_its_group() {
    let row = |group: &str, name: &str, value: f64| ResultEntry { group: group.into(), name: name.into(), signal: "Force [N]".into(), value, unit: "N".into(), source: "Cycles".into() };
    let content = ReportContent { results: vec![row("Cycles of Force", "Max · mean of 6", 200.123456), row("Cycles of Force", "Max · std dev of 6", 0.00001234)], ..Default::default() };
    let html = render_html(&content);
    assert!(html.contains("<h2>Results</h2>"));
    assert_eq!(html.matches("Cycles of Force").count(), 1, "one group heading");
    assert!(html.contains(">200.123<"), "six significant digits");
    assert!(html.contains("1.2340e-5"), "small values in exponent form");
}

#[test]
fn notes_section_lists_ranges_and_moments() {
    let content = ReportContent { notes: vec![(12.0, 20.5, "Valve stuck <here>".into()), (30.0, 30.0, "Restart".into())], ..Default::default() };
    let html = render_html(&content);
    assert!(html.contains("<h2>Notes</h2>"));
    assert!(html.contains("12 – 20.5 s") && html.contains("8.5 s"));
    assert!(html.contains("Valve stuck &lt;here&gt;"), "note text is escaped");
    assert!(html.contains(">30 s<"));
}
