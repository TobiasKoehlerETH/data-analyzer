"""Report generator: collect content into Jinja2 HTML, export to PDF/HTML."""

from __future__ import annotations

import base64
import io
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from jinja2 import Template, TemplateError


DEFAULT_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Data Analyzer Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
h1 { color: #1a5276; border-bottom: 2px solid #1a5276; padding-bottom: 10px; }
h2 { color: #2c3e50; margin-top: 30px; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background-color: #1a5276; color: white; }
tr:nth-child(even) { background-color: #f2f2f2; }
img { max-width: 100%; margin: 10px 0; }
.metadata { background: #eaf2f8; padding: 15px; border-radius: 5px; }
.metric-good { color: #27ae60; font-weight: bold; }
.metric-bad { color: #e74c3c; }
</style></head><body>
<h1>Data Analyzer Report</h1>
<p>Generated: {{ generated_at }}</p>

{% if metadata %}
<div class="metadata">
<h2>File Metadata</h2>
{% for key, value in metadata.items() %}
<p><strong>{{ key }}:</strong> {{ value }}</p>
{% endfor %}
</div>
{% endif %}

{% if stats_html %}
<h2>Descriptive Statistics</h2>
{{ stats_html }}
{% endif %}

{% if plots %}
<h2>Signal Plots</h2>
{% for plot in plots %}
<h3>{{ plot.title }}</h3>
<img src="data:image/png;base64,{{ plot.data }}" />
{% endfor %}
{% endif %}

{% if filters %}
<h2>Applied Filters</h2>
{% for f in filters %}
<p><strong>{{ f.signal }}:</strong> {{ f.description }}</p>
{% endfor %}
{% endif %}

{% if correlation_plot %}
<h2>Correlation Analysis</h2>
<img src="data:image/png;base64,{{ correlation_plot }}" />
{% if correlation_pairs %}
<table><tr><th>Signal A</th><th>Signal B</th><th>|r|</th><th>Lag (s)</th></tr>
{% for p in correlation_pairs %}
<tr><td>{{ p.signal_a }}</td><td>{{ p.signal_b }}</td>
<td>{{ "%.3f"|format(p.pearson_r|abs) }}</td><td>{{ "%.1f"|format(p.lag_seconds) }}</td></tr>
{% endfor %}
</table>
{% endif %}
{% endif %}

{% if models %}
<h2>State-Space Models</h2>
{% for model in models %}
<h3>{{ model.name }} ({{ model.method }}, order={{ model.order }})</h3>
<p>Inputs: {{ model.input_names | join(', ') }}</p>
<p>Outputs: {{ model.output_names | join(', ') }}</p>
{% if model.metrics_table %}
<table><tr><th>Output</th><th>VAF%</th><th>RMSE</th><th>R²</th></tr>
{% for m in model.metrics_table %}
<tr><td>{{ m.name }}</td><td>{{ "%.2f"|format(m.vaf) }}</td>
<td>{{ "%.6f"|format(m.rmse) }}</td><td>{{ "%.4f"|format(m.r_squared) }}</td></tr>
{% endfor %}
</table>
{% endif %}
{% endfor %}
{% endif %}

{% if simulation_plots %}
<h2>Simulation Results</h2>
{% for plot in simulation_plots %}
<h3>{{ plot.title }}</h3>
<img src="data:image/png;base64,{{ plot.data }}" />
{% endfor %}
{% endif %}

{% if validation_plots %}
<h2>Validation</h2>
{% for plot in validation_plots %}
<h3>{{ plot.title }}</h3>
<img src="data:image/png;base64,{{ plot.data }}" />
{% endfor %}
{% endif %}

{% if comparison_plots or comparison_stats %}
<h2>File Comparison</h2>
{% for plot in comparison_plots %}
<h3>{{ plot.title }}</h3>
<img src="data:image/png;base64,{{ plot.data }}" />
{% endfor %}
{% if comparison_stats %}
<h3>Comparison Statistics (vs Reference)</h3>
<table><tr><th>Signal</th><th>File</th><th>RMSE</th><th>Max Dev</th><th>R&sup2;</th><th>Mean Error</th></tr>
{% for s in comparison_stats %}
<tr><td>{{ s.signal }}</td><td>{{ s.file_name }}</td>
<td>{{ "%.6f"|format(s.rmse) }}</td><td>{{ "%.6f"|format(s.max_deviation) }}</td>
<td>{{ "%.4f"|format(s.r_squared) }}</td><td>{{ "%.6f"|format(s.mean_error) }}</td></tr>
{% endfor %}
</table>
{% endif %}
{% endif %}

</body></html>"""


def load_report_template(path: str | Path | None = None) -> str:
    """Load the local report template, falling back to the built-in template."""
    template_path = (
        Path(path)
        if path is not None
        else Path(__file__).resolve().parents[2] / "template.html"
    )
    try:
        text = template_path.read_text(encoding="utf-8")
        Template(text)
        return text
    except (OSError, UnicodeError, TemplateError):
        return DEFAULT_TEMPLATE


def _fig_to_base64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    buf.seek(0)
    data = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return data


def render_signal_plot(time: np.ndarray, signals: dict[str, np.ndarray],
                       title: str = "Signals") -> str:
    fig, axes = plt.subplots(len(signals), 1, figsize=(12, 2.5 * len(signals)), sharex=True)
    if len(signals) == 1:
        axes = [axes]
    for ax, (name, data) in zip(axes, signals.items()):
        ax.plot(time[:len(data)], data, linewidth=0.5)
        ax.set_ylabel(name, fontsize=8)
        ax.grid(True, alpha=0.3)
    axes[-1].set_xlabel("Time [s]")
    fig.suptitle(title, fontsize=12)
    fig.tight_layout()
    return _fig_to_base64(fig)


def generate_report(
    output_path: str | Path,
    output_format: str = "html",
    metadata: dict[str, Any] | None = None,
    stats_df=None,
    signal_plots: list[dict] | None = None,
    filters_info: list[dict] | None = None,
    correlation_plot_data: str | None = None,
    correlation_pairs: list | None = None,
    models_info: list[dict] | None = None,
    simulation_plots: list[dict] | None = None,
    validation_plots: list[dict] | None = None,
    comparison_plots: list[dict] | None = None,
    comparison_stats: list | None = None,
    progress_callback=None,
) -> str:
    if progress_callback:
        progress_callback(10, "Preparing report content...")

    template = Template(load_report_template())

    context = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "metadata": metadata or {},
        "stats_html": stats_df.to_html(index=False, float_format="%.4f") if stats_df is not None else None,
        "plots": signal_plots or [],
        "filters": filters_info or [],
        "correlation_plot": correlation_plot_data,
        "correlation_pairs": correlation_pairs or [],
        "models": models_info or [],
        "simulation_plots": simulation_plots or [],
        "validation_plots": validation_plots or [],
        "comparison_plots": comparison_plots or [],
        "comparison_stats": comparison_stats or [],
    }

    if progress_callback:
        progress_callback(50, "Rendering template...")

    html_content = template.render(**context)
    output_path = Path(output_path)

    if output_format.lower() == "pdf":
        if progress_callback:
            progress_callback(70, "Converting to PDF...")
        try:
            from weasyprint import HTML
            HTML(string=html_content).write_pdf(str(output_path))
        except ImportError:
            html_path = output_path.with_suffix(".html")
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(html_content)
            if progress_callback:
                progress_callback(90, "weasyprint not available, saved as HTML instead.")
            return str(html_path)
    else:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(html_content)

    if progress_callback:
        progress_callback(100, "Report generated.")

    return str(output_path)
