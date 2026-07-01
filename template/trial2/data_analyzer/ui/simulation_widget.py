"""Simulation widget: model selection, time range, measured vs simulated overlay."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.simulation_engine import simulate, SimulationResult
from ui.model_manager_widget import ModelManagerWidget

COLORS_MEASURED = ["#1f77b4", "#2ca02c", "#9467bd", "#8c564b"]
COLORS_SIMULATED = ["#ff7f0e", "#d62728", "#e377c2", "#bcbd22"]


class SimulationWidget(QWidget):
    def __init__(self, data_manager: DataManager, model_manager_widget: ModelManagerWidget,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.mm_widget = model_manager_widget
        self._sim_results: list[tuple[str, SimulationResult]] = []
        self._setup_ui()
        self.mm_widget.manager.models_changed.connect(self._refresh_models)
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # Controls
        ctrl = QHBoxLayout()
        ctrl.addWidget(QLabel("Model:"))
        self.model_combo = QComboBox()
        self.model_combo.setToolTip("Select the identified model to simulate")
        ctrl.addWidget(self.model_combo, stretch=1)

        ctrl.addWidget(QLabel("Start:"))
        self.start_spin = QSpinBox()
        self.start_spin.setToolTip("Starting sample index for simulation")
        self.start_spin.setRange(0, 0)
        ctrl.addWidget(self.start_spin)

        ctrl.addWidget(QLabel("End:"))
        self.end_spin = QSpinBox()
        self.end_spin.setToolTip("Ending sample index for simulation")
        self.end_spin.setRange(1, 1)
        ctrl.addWidget(self.end_spin)

        self.auto_x0 = QCheckBox("Auto x0")
        self.auto_x0.setToolTip("Automatically estimate the initial state vector from data")
        self.auto_x0.setChecked(True)
        ctrl.addWidget(self.auto_x0)

        self.sim_btn = QPushButton("Simulate")
        self.sim_btn.setToolTip("Run the state-space simulation and plot measured vs. simulated signals")
        self.sim_btn.setStyleSheet("font-weight: bold;")
        self.sim_btn.clicked.connect(self._run_simulation)
        ctrl.addWidget(self.sim_btn)

        self.add_btn = QPushButton("Add Model Overlay")
        self.add_btn.setToolTip("Overlay another model's simulation on the current plot for comparison")
        self.add_btn.clicked.connect(self._add_overlay)
        ctrl.addWidget(self.add_btn)

        self.clear_btn = QPushButton("Clear")
        self.clear_btn.setToolTip("Clear all simulation plots")
        self.clear_btn.clicked.connect(self._clear_plots)
        ctrl.addWidget(self.clear_btn)

        layout.addLayout(ctrl)

        # Plots
        self.plot_container = pg.GraphicsLayoutWidget()
        self.plot_container.setBackground("w")
        layout.addWidget(self.plot_container)

        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

    @Slot()
    def _on_data_loaded(self) -> None:
        n = self.data_manager.n_samples
        self.start_spin.setRange(0, max(0, n - 1))
        self.end_spin.setRange(1, n)
        self.end_spin.setValue(n)

    @Slot()
    def _refresh_models(self) -> None:
        current = self.model_combo.currentText()
        self.model_combo.clear()
        for name in self.mm_widget.manager.model_names:
            self.model_combo.addItem(name)
        idx = self.model_combo.findText(current)
        if idx >= 0:
            self.model_combo.setCurrentIndex(idx)

    def _get_io_data(self, model):
        input_data = {}
        output_data = {}
        for n in model.input_names:
            d = self.data_manager.get_signal(n)
            if d is None:
                return None, None
            input_data[n] = d
        for n in model.output_names:
            d = self.data_manager.get_signal(n)
            if d is None:
                return None, None
            output_data[n] = d
        return input_data, output_data

    @Slot()
    def _run_simulation(self) -> None:
        self._sim_results.clear()
        self._do_simulate()

    @Slot()
    def _add_overlay(self) -> None:
        self._do_simulate()

    def _do_simulate(self) -> None:
        name = self.model_combo.currentText()
        if not name:
            QMessageBox.warning(self, "No Model", "Select a model first.")
            return
        model = self.mm_widget.manager.get(name)
        if model is None:
            return

        input_data, output_data = self._get_io_data(model)
        if input_data is None:
            QMessageBox.warning(self, "Missing Data", "Input/output signals not found in loaded data.")
            return

        time = self.data_manager.time_array
        x0 = None if self.auto_x0.isChecked() else np.zeros(model.A.shape[0])

        try:
            result = simulate(
                model, input_data, output_data, time,
                x0=x0,
                start_idx=self.start_spin.value(),
                end_idx=self.end_spin.value(),
            )
            self._sim_results.append((name, result))
            self._draw_plots()
            self.status_label.setText(f"Simulation complete for '{name}'.")
        except Exception as e:
            self.status_label.setText(f"Error: {e}")

    def _draw_plots(self) -> None:
        self.plot_container.clear()
        if not self._sim_results:
            return

        # Collect all output names
        all_outputs = []
        for _, result in self._sim_results:
            for n in result.measured.keys():
                if n not in all_outputs:
                    all_outputs.append(n)

        first_plot = None
        for i, out_name in enumerate(all_outputs):
            plot = self.plot_container.addPlot(row=i, col=0)
            info = self.data_manager.signals.get(out_name)
            plot.setLabel("left", info.label() if info else out_name)
            plot.showGrid(x=True, y=True, alpha=0.3)
            plot.addLegend(offset=(60, 10))

            if first_plot is None:
                first_plot = plot
                plot.setLabel("bottom", "Time [s]")
            else:
                plot.setXLink(first_plot)

            for j, (model_name, result) in enumerate(self._sim_results):
                if out_name in result.measured:
                    ci_m = COLORS_MEASURED[j % len(COLORS_MEASURED)]
                    ci_s = COLORS_SIMULATED[j % len(COLORS_SIMULATED)]

                    if j == 0:  # Only plot measured once
                        plot.plot(result.time, result.measured[out_name],
                                  pen=pg.mkPen(ci_m, width=1), name="Measured")

                    plot.plot(result.time, result.simulated[out_name],
                              pen=pg.mkPen(ci_s, width=1.5, style=Qt.DashLine),
                              name=f"Sim: {model_name}")

    @Slot()
    def _clear_plots(self) -> None:
        self._sim_results.clear()
        self.plot_container.clear()
        self.status_label.setText("")
