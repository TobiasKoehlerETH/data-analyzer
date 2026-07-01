from pathlib import Path

from jinja2 import Template

from backend.core.report_generator import DEFAULT_TEMPLATE, load_report_template


ROOT_TEMPLATE = Path(__file__).resolve().parents[2] / "template.html"


def test_load_report_template_reads_valid_local_file(tmp_path):
    local = tmp_path / "template.html"
    local.write_text("<h1>{{ generated_at }}</h1>", encoding="utf-8")

    assert load_report_template(local) == "<h1>{{ generated_at }}</h1>"


def test_load_report_template_falls_back_when_file_is_missing(tmp_path):
    assert load_report_template(tmp_path / "missing.html") == DEFAULT_TEMPLATE


def test_load_report_template_falls_back_when_jinja_is_invalid(tmp_path):
    local = tmp_path / "template.html"
    local.write_text("{% if broken %}", encoding="utf-8")

    assert load_report_template(local) == DEFAULT_TEMPLATE


def test_local_template_is_generic_logo_free_and_renderable():
    text = ROOT_TEMPLATE.read_text(encoding="utf-8")
    lower = text.lower()

    for prohibited in (
        "apsoparts",
        "angst+pfister",
        "tobias",
        "logo",
        'src="http',
        "src='http",
    ):
        assert prohibited not in lower

    for variable in ("generated_at", "metadata", "stats_html", "plots"):
        assert variable in text

    Template(text)
