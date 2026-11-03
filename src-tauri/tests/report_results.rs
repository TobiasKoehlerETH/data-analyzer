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
