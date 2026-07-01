"""Report widget: section selector, format picker, generation with progress."""

from __future__ import annotations

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PySide6.QtCore import Slot, QThreadPool
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.report_generator import generate_report, render_signal_plot
from core.statistics_engine import compute_descriptive_stats
from core.workers import ReportWorker
from ui.model_manager_widget import ModelManagerWidget


class ReportWidget(QWidget):
    def __init__(self, data_manager: DataManager, model_manager_widget: ModelManagerWidget,
                 thread_pool: QThreadPool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.mm_widget = model_manager_widget
        self.thread_pool = thread_pool
        self._setup_ui()

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # Sections
        sg = QGroupBox("Report Sections")
        sg_layout = QVBoxLayout(sg)
        self.sections = {}
        for name in ["Metadata", "Statistics", "Signal Plots", "Filters Applied",
                      "Correlations", "Models", "Simulations", "Validation", "Comparison"]:
            cb = QCheckBox(name)
            cb.setChecked(True)
            sg_layout.addWidget(cb)
            self.sections[name] = cb
        layout.addWidget(sg)

        # Format
        fmt_row = QHBoxLayout()
        fmt_row.addWidget(QLabel("Format:"))
        self.format_combo = QComboBox()
        self.format_combo.setToolTip("Choose the output format for the report")
        self.format_combo.addItems(["HTML", "PDF"])
        fmt_row.addWidget(self.format_combo)
        layout.addLayout(fmt_row)

        # Output path
        path_row = QHBoxLayout()
        path_row.addWidget(QLabel("Output:"))
        self.path_edit = QLineEdit()
        self.path_edit.setPlaceholderText("Select output file...")
        self.path_edit.setToolTip("Path where the generated report will be saved")
        path_row.addWidget(self.path_edit, stretch=1)
        browse_btn = QPushButton("Browse...")
        browse_btn.setToolTip("Choose the output file location")
        browse_btn.clicked.connect(self._browse)
        path_row.addWidget(browse_btn)
        layout.addLayout(path_row)

        # Generate
        self.gen_btn = QPushButton("Generate Report")
        self.gen_btn.setToolTip("Generate the report with all selected sections")
        self.gen_btn.setStyleSheet("font-weight: bold; padding: 10px;")
        self.gen_btn.clicked.connect(self._generate)
        layout.addWidget(self.gen_btn)

        self.status_label = QLabel("")
        layout.addWidget(self.status_label)
        layout.addStretch()

    @Slot()
    def _browse(self) -> None:
        fmt = self.format_combo.currentText().lower()
        ext = "PDF Files (*.pdf)" if fmt == "pdf" else "HTML Files (*.html)"
        path, _ = QFileDialog.getSaveFileName(self, "Save Report", f"report.{fmt}", ext)
        if path:
            self.path_edit.setText(path)

    @Slot()
    def _generate(self) -> None:
        path = self.path_edit.text()
        if not path:
            QMessageBox.warning(self, "No Path", "Select an output file path.")
            return

        self.gen_btn.setEnabled(False)
        self.status_label.setText("Generating report...")

        fmt = self.format_combo.currentText().lower()
        include = {name: cb.isChecked() for name, cb in self.sections.items()}

        # Collect data
        kwargs: dict = {
            "output_path": path,
            "output_format": fmt,
        }

        if include.get("Metadata"):
            kwargs["metadata"] = self.data_manager.metadata

        if include.get("Statistics") and self.data_manager.is_loaded:
            signals = {}
            for col in self.data_manager.get_numeric_columns():
                data = self.data_manager.get_signal(col)
                if data is not None:
                    signals[col] = data
            kwargs["stats_df"] = compute_descriptive_stats(signals, self.data_manager.cache)

        if include.get("Signal Plots") and self.data_manager.is_loaded:
            time = self.data_manager.time_array
            if time is not None:
                signal_plots = []
                cols = self.data_manager.get_numeric_columns()
                # Plot in groups of 4
                for i in range(0, len(cols), 4):
                    batch = cols[i:i + 4]
                    sigs = {}
                    for c in batch:
                        d = self.data_manager.get_signal(c)
                        if d is not None:
                            info = self.data_manager.signals.get(c)
                            sigs[info.label() if info else c] = d
                    if sigs:
                        plot_data = render_signal_plot(time, sigs, title=f"Signals {i + 1}–{i + len(batch)}")
                        signal_plots.append({"title": f"Signals {i + 1}–{i + len(batch)}", "data": plot_data})
                kwargs["signal_plots"] = signal_plots

        if include.get("Models"):
            models_info = []
            for name, model in self.mm_widget.manager.models.items():
                models_info.append({
                    "name": model.name,
                    "method": model.method,
                    "order": model.order,
                    "input_names": model.input_names,
                    "output_names": model.output_names,
                    "metrics_table": model.metrics,
                })
            kwargs["models_info"] = models_info

        if include.get("Filters Applied"):
            filters_info = []
            for col in self.data_manager.get_numeric_columns():
                chain = self.data_manager.get_filter_chain(col)
                if chain is not None and chain.enabled_steps():
                    info = self.data_manager.signals.get(col)
                    signal_name = info.label() if info else col
                    descriptions = [step.describe() for step in chain.enabled_steps()]
                    filters_info.append({
                        "signal": signal_name,
                        "description": " \u2192 ".join(descriptions),
                    })
            if filters_info:
                kwargs["filters_info"] = filters_info

        if include.get("Correlations"):
            main_win = self.window()
            corr_widget = getattr(main_win, "correlation_widget", None)
            corr_result = getattr(corr_widget, "_result", None) if corr_widget else None
            if corr_result is not None:
                from core.report_generator import _fig_to_base64
                columns = corr_result.columns
                short_labels = []
                for c in columns:
                    si = self.data_manager.signals.get(c)
                    short_labels.append(si.name[:20] if si else c[:20])
                fig, ax = plt.subplots(figsize=(8, 6))
                im = ax.imshow(corr_result.pearson_matrix, cmap="RdBu_r", vmin=-1, vmax=1, aspect="auto")
                ax.set_xticks(range(len(short_labels)))
                ax.set_yticks(range(len(short_labels)))
                ax.set_xticklabels(short_labels, rotation=90, fontsize=6)
                ax.set_yticklabels(short_labels, fontsize=6)
                fig.colorbar(im, ax=ax, shrink=0.8)
                fig.tight_layout()
                kwargs["correlation_plot_data"] = _fig_to_base64(fig)
                kwargs["correlation_pairs"] = corr_result.top_pairs

        if include.get("Simulations"):
            main_win = self.window()
            sim_widget = getattr(main_win, "simulation_widget", None)
            sim_results = getattr(sim_widget, "_sim_results", []) if sim_widget else []
            if sim_results:
                from core.report_generator import _fig_to_base64
                simulation_plots = []
                for model_name, result in sim_results:
                    for out_name in result.measured:
                        info = self.data_manager.signals.get(out_name)
                        label = info.name if info else out_name
                        fig, ax = plt.subplots(figsize=(10, 3))
                        ax.plot(result.time, result.measured[out_name], linewidth=0.8, label="Measured")
                        ax.plot(result.time, result.simulated[out_name], linewidth=0.8,
                                linestyle="--", label="Simulated")
                        ax.set_ylabel(label, fontsize=8)
                        ax.set_xlabel("Time [s]")
                        ax.legend(fontsize=8)
                        ax.grid(True, alpha=0.3)
                        ax.set_title(f"{model_name}: {label}", fontsize=10)
                        fig.tight_layout()
                        simulation_plots.append({
                            "title": f"{model_name}: {label}",
                            "data": _fig_to_base64(fig),
                        })
                if simulation_plots:
                    kwargs["simulation_plots"] = simulation_plots

        if include.get("Validation"):
            main_win = self.window()
            val_widget = getattr(main_win, "validation_widget", None)
            val_result = getattr(val_widget, "_val_result", None) if val_widget else None
            if val_result is not None:
                from core.report_generator import _fig_to_base64
                validation_plots = []
                for analysis in val_result.analyses:
                    info = self.data_manager.signals.get(analysis.output_name)
                    label = info.name if info else analysis.output_name
                    m = analysis.metrics
                    fig, axes = plt.subplots(2, 1, figsize=(10, 5))
                    t = np.arange(len(analysis.residuals))
                    axes[0].plot(t, analysis.residuals, linewidth=0.5)
                    axes[0].axhline(y=0, color="gray", linestyle="--", linewidth=0.8)
                    axes[0].set_title(f"Residuals: {label}", fontsize=10)
                    axes[0].set_ylabel("Residual")
                    axes[0].grid(True, alpha=0.3)
                    axes[1].hist(analysis.residuals, bins=80, density=True, alpha=0.7, color="#1f77b4")
                    axes[1].set_xlabel("Residual")
                    axes[1].set_ylabel("Density")
                    fig.tight_layout()
                    validation_plots.append({
                        "title": f"{label} (VAF={m.vaf:.2f}%, R\u00b2={m.r_squared:.4f})",
                        "data": _fig_to_base64(fig),
                    })
                if validation_plots:
                    kwargs["validation_plots"] = validation_plots

        if include.get("Comparison"):
            main_win = self.window()
            cmp_widget = getattr(main_win, "compare_widget", None)
            cmp_mgr = getattr(cmp_widget, "manager", None) if cmp_widget else None
            if cmp_mgr is not None and len(cmp_mgr.file_order) >= 2:
                from core.report_generator import _fig_to_base64
                mapped = cmp_mgr.get_mapped_signals()
                if mapped:
                    comparison_plots = []
                    for sig_name in mapped:
                        fig, ax = plt.subplots(figsize=(10, 3))
                        for fid in cmp_mgr.file_order:
                            cf = cmp_mgr.files[fid]
                            col = cmp_mgr._resolve_column(fid, sig_name)
                            if col is None or col not in cf.signals:
                                continue
                            t = cmp_mgr.get_aligned_time(fid)
                            ax.plot(t, cf.signals[col], linewidth=0.8, label=cf.short_name, color=cf.color)
                        ax.set_ylabel(sig_name, fontsize=8)
                        ax.set_xlabel("Time [s]")
                        ax.legend(fontsize=7)
                        ax.grid(True, alpha=0.3)
                        ax.set_title(sig_name, fontsize=10)
                        fig.tight_layout()
                        comparison_plots.append({"title": sig_name, "data": _fig_to_base64(fig)})
                    if comparison_plots:
                        kwargs["comparison_plots"] = comparison_plots

                    ref_id = cmp_mgr.file_order[0]
                    comparison_stats = []
                    for sig_name in mapped:
                        for fid in cmp_mgr.file_order[1:]:
                            s = cmp_mgr.compute_statistics(sig_name, ref_id, fid)
                            if s is not None:
                                comparison_stats.append({
                                    "signal": s.signal,
                                    "file_name": s.file_name,
                                    "rmse": s.rmse,
                                    "max_deviation": s.max_deviation,
                                    "r_squared": s.r_squared,
                                    "mean_error": s.mean_error,
                                })
                    if comparison_stats:
                        kwargs["comparison_stats"] = comparison_stats

        worker = ReportWorker(**kwargs)
        worker.signals.progress.connect(self._on_progress)
        worker.signals.finished.connect(self._on_done)
        worker.signals.error.connect(self._on_error)
        self.thread_pool.start(worker)

    @Slot(int, str)
    def _on_progress(self, value: int, msg: str) -> None:
        self.status_label.setText(msg)
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(value, msg)

    @Slot()
    def _on_done(self) -> None:
        self.gen_btn.setEnabled(True)
        self.status_label.setText(f"Report saved to: {self.path_edit.text()}")
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")

    @Slot(str)
    def _on_error(self, msg: str) -> None:
        self.gen_btn.setEnabled(True)
        self.status_label.setText(f"Error: {msg}")
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")
