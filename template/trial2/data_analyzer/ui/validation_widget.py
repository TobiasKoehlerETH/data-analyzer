"""Validation widget: residual analysis, metrics, ACF, histograms."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.simulation_engine import simulate
from core.validation_engine import validate, ValidationResult
from ui.model_manager_widget import ModelManagerWidget


class ValidationWidget(QWidget):
    def __init__(self, data_manager: DataManager, model_manager_widget: ModelManagerWidget,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.mm_widget = model_manager_widget
        self._val_result: ValidationResult | None = None
        self._setup_ui()
        self.mm_widget.manager.models_changed.connect(self._refresh_models)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        ctrl = QHBoxLayout()
        ctrl.addWidget(QLabel("Model:"))
        self.model_combo = QComboBox()
        self.model_combo.setToolTip("Select the model to validate against measured data")
        ctrl.addWidget(self.model_combo, stretch=1)

        ctrl.addWidget(QLabel("Output:"))
        self.output_combo = QComboBox()
        self.output_combo.setMinimumWidth(200)
        self.output_combo.setToolTip("Select which output signal to display validation details for")
        self.output_combo.currentTextChanged.connect(self._update_views)
        ctrl.addWidget(self.output_combo)

        self.validate_btn = QPushButton("Validate")
        self.validate_btn.setToolTip("Run simulation and compute residual metrics, ACF, and histogram")
        self.validate_btn.setStyleSheet("font-weight: bold;")
        self.validate_btn.clicked.connect(self._run_validation)
        ctrl.addWidget(self.validate_btn)
        layout.addLayout(ctrl)

        # Tabs for different views
        self.view_tabs = QTabWidget()

        # Residual time series
        self.residual_plot = pg.PlotWidget(background="w", title="Residuals over Time")
        self.residual_plot.setLabel("left", "Residual")
        self.residual_plot.setLabel("bottom", "Time [s]")
        self.residual_plot.showGrid(x=True, y=True, alpha=0.3)
        self.view_tabs.addTab(self.residual_plot, "Residuals")

        # Histogram
        hist_widget = QWidget()
        hist_layout = QVBoxLayout(hist_widget)
        self.hist_figure = Figure(figsize=(6, 4))
        self.hist_canvas = FigureCanvasQTAgg(self.hist_figure)
        hist_layout.addWidget(self.hist_canvas)
        self.view_tabs.addTab(hist_widget, "Histogram")

        # ACF
        self.acf_plot = pg.PlotWidget(background="w", title="Residual Autocorrelation")
        self.acf_plot.setLabel("left", "ACF")
        self.acf_plot.setLabel("bottom", "Lag")
        self.acf_plot.showGrid(x=True, y=True, alpha=0.3)
        self.view_tabs.addTab(self.acf_plot, "ACF")

        # Input-Residual cross-correlation
        self.xcorr_plot = pg.PlotWidget(background="w", title="Input-Residual Cross-Correlation")
        self.xcorr_plot.setLabel("left", "Cross-Corr")
        self.xcorr_plot.setLabel("bottom", "Lag")
        self.xcorr_plot.showGrid(x=True, y=True, alpha=0.3)
        self.xcorr_plot.addLegend()
        self.view_tabs.addTab(self.xcorr_plot, "Input-Residual XCorr")

        # Metrics table
        metrics_widget = QWidget()
        metrics_layout = QVBoxLayout(metrics_widget)
        self.metrics_table = QTableWidget()
        self.metrics_table.setColumnCount(6)
        self.metrics_table.setHorizontalHeaderLabels(["Output", "RMSE", "NRMSE%", "MAE", "R²", "VAF%"])
        self.metrics_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        metrics_layout.addWidget(self.metrics_table)

        # Fit bar chart
        self.fit_figure = Figure(figsize=(6, 3))
        self.fit_canvas = FigureCanvasQTAgg(self.fit_figure)
        metrics_layout.addWidget(self.fit_canvas)
        self.view_tabs.addTab(metrics_widget, "Metrics")

        layout.addWidget(self.view_tabs)

        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

    @Slot()
    def _refresh_models(self) -> None:
        current = self.model_combo.currentText()
        self.model_combo.clear()
        for name in self.mm_widget.manager.model_names:
            self.model_combo.addItem(name)
        idx = self.model_combo.findText(current)
        if idx >= 0:
            self.model_combo.setCurrentIndex(idx)

    @Slot()
    def _run_validation(self) -> None:
        name = self.model_combo.currentText()
        if not name:
            QMessageBox.warning(self, "No Model", "Select a model first.")
            return
        model = self.mm_widget.manager.get(name)
        if model is None:
            return

        # Get I/O data
        input_data = {}
        output_data = {}
        for n in model.input_names:
            d = self.data_manager.get_signal(n)
            if d is None:
                QMessageBox.warning(self, "Missing Data", f"Signal '{n}' not found.")
                return
            input_data[n] = d
        for n in model.output_names:
            d = self.data_manager.get_signal(n)
            if d is None:
                QMessageBox.warning(self, "Missing Data", f"Signal '{n}' not found.")
                return
            output_data[n] = d

        time = self.data_manager.time_array

        try:
            sim_result = simulate(model, input_data, output_data, time)
            # Slice input data to match simulation length
            dec = model.decimation_factor
            sliced_input = {}
            for n, d in input_data.items():
                if dec > 1:
                    from scipy.signal import decimate as sp_dec
                    sliced_input[n] = sp_dec(d - np.mean(d), dec, zero_phase=True)
                else:
                    sliced_input[n] = d - np.mean(d)

            self._val_result = validate(sim_result, input_data=sliced_input)

            # Populate output combo
            self.output_combo.clear()
            for a in self._val_result.analyses:
                self.output_combo.addItem(a.output_name)

            self._fill_metrics_table()
            self._update_views()
            self.status_label.setText(f"Validation complete for '{name}'.")
        except Exception as e:
            self.status_label.setText(f"Error: {e}")

    @Slot()
    def _update_views(self) -> None:
        if self._val_result is None:
            return

        out_name = self.output_combo.currentText()
        analysis = None
        for a in self._val_result.analyses:
            if a.output_name == out_name:
                analysis = a
                break
        if analysis is None:
            return

        # Residual plot
        self.residual_plot.clear()
        t = np.arange(len(analysis.residuals))
        self.residual_plot.plot(t, analysis.residuals, pen=pg.mkPen("#1f77b4", width=1))
        self.residual_plot.addLine(y=0, pen=pg.mkPen("gray", width=1, style=Qt.DashLine))

        # Histogram
        self.hist_figure.clear()
        ax = self.hist_figure.add_subplot(111)
        ax.hist(analysis.residuals, bins=80, density=True, alpha=0.7, color="#1f77b4", label="Residuals")
        # Normal fit overlay
        mu, sigma = np.mean(analysis.residuals), np.std(analysis.residuals)
        x = np.linspace(mu - 4 * sigma, mu + 4 * sigma, 200)
        from scipy.stats import norm
        ax.plot(x, norm.pdf(x, mu, sigma), "r-", linewidth=2, label=f"Normal (p={analysis.shapiro_p:.4f})")
        ax.legend(fontsize=8)
        ax.set_xlabel("Residual")
        ax.set_ylabel("Density")
        ax.grid(True, alpha=0.3)
        self.hist_figure.tight_layout()
        self.hist_canvas.draw()

        # ACF
        self.acf_plot.clear()
        bar_item = pg.BarGraphItem(x=analysis.acf_lags[1:], height=analysis.acf[1:], width=0.8,
                                    brush="#1f77b4")
        self.acf_plot.addItem(bar_item)
        self.acf_plot.addLine(y=analysis.acf_confidence, pen=pg.mkPen("r", width=1, style=Qt.DashLine))
        self.acf_plot.addLine(y=-analysis.acf_confidence, pen=pg.mkPen("r", width=1, style=Qt.DashLine))

        # Input-Residual XCorr
        self.xcorr_plot.clear()
        colors = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"]
        if out_name in self._val_result.input_residual_xcorr:
            for i, (in_name, xcorr) in enumerate(self._val_result.input_residual_xcorr[out_name].items()):
                info = self.data_manager.signals.get(in_name)
                label = info.name if info else in_name
                lags = np.arange(len(xcorr)) - len(xcorr) // 2
                self.xcorr_plot.plot(lags, xcorr, pen=pg.mkPen(colors[i % len(colors)], width=1.5),
                                     name=label[:20])

    def _fill_metrics_table(self) -> None:
        if self._val_result is None:
            return
        analyses = self._val_result.analyses
        self.metrics_table.setRowCount(len(analyses))
        names = []
        vafs = []
        for i, a in enumerate(analyses):
            m = a.metrics
            info = self.data_manager.signals.get(m.name)
            label = info.name if info else m.name
            self.metrics_table.setItem(i, 0, QTableWidgetItem(label))
            self.metrics_table.setItem(i, 1, QTableWidgetItem(f"{m.rmse:.6f}"))
            self.metrics_table.setItem(i, 2, QTableWidgetItem(f"{m.nrmse:.2f}"))
            self.metrics_table.setItem(i, 3, QTableWidgetItem(f"{m.mae:.6f}"))
            self.metrics_table.setItem(i, 4, QTableWidgetItem(f"{m.r_squared:.4f}"))
            self.metrics_table.setItem(i, 5, QTableWidgetItem(f"{m.vaf:.2f}"))
            names.append(label[:15])
            vafs.append(m.vaf)

        # Fit bar chart
        self.fit_figure.clear()
        if names:
            ax = self.fit_figure.add_subplot(111)
            bars = ax.bar(range(len(names)), vafs, color="#2ca02c", alpha=0.8)
            ax.set_xticks(range(len(names)))
            ax.set_xticklabels(names, rotation=45, fontsize=7)
            ax.set_ylabel("VAF [%]")
            ax.set_ylim(0, 105)
            for bar, v in zip(bars, vafs):
                ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1,
                        f"{v:.1f}%", ha="center", fontsize=7)
            self.fit_figure.tight_layout()
        self.fit_canvas.draw()
