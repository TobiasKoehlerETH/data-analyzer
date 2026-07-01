"""System identification widget: I/O selection, decimation, order sweep, results."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot, QThreadPool
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.sysid_engine import estimate_decimation_factor, estimate_time, identify_model
from core.workers import SysIdWorker


class SysIdWidget(QWidget):
    def __init__(self, data_manager: DataManager, thread_pool: QThreadPool,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.thread_pool = thread_pool
        self._results = []
        self._current_worker: SysIdWorker | None = None
        self._setup_ui()
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)
        splitter = QSplitter(Qt.Horizontal)

        # Left: I/O selection
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)

        ig = QGroupBox("Input Signals (u)")
        ig.setToolTip("Check signals that are system inputs (setpoints, commands)")
        ig_layout = QVBoxLayout(ig)
        self.input_list = QListWidget()
        ig_layout.addWidget(self.input_list)
        left_layout.addWidget(ig)

        og = QGroupBox("Output Signals (y)")
        og.setToolTip("Check signals that are system outputs (measurements, responses)")
        og_layout = QVBoxLayout(og)
        self.output_list = QListWidget()
        og_layout.addWidget(self.output_list)
        left_layout.addWidget(og)

        auto_btn = QPushButton("Auto-Suggest I/O")
        auto_btn.setToolTip("Automatically assign input/output signals based on naming patterns")
        auto_btn.clicked.connect(self._auto_suggest_io)
        left_layout.addWidget(auto_btn)
        splitter.addWidget(left)

        # Center: parameters
        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(0, 0, 0, 0)

        pg_ = QGroupBox("Parameters")
        pg_layout = QVBoxLayout(pg_)

        row1 = QHBoxLayout()
        row1.addWidget(QLabel("Model Name:"))
        self.name_edit = QLineEdit("Model")
        row1.addWidget(self.name_edit)
        pg_layout.addLayout(row1)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("Method:"))
        self.method_combo = QComboBox()
        self.method_combo.setToolTip("System identification algorithm: N4SID, MOESP, or CVA")
        self.method_combo.addItems(["N4SID", "MOESP", "CVA"])
        row2.addWidget(self.method_combo)
        pg_layout.addLayout(row2)

        row3 = QHBoxLayout()
        row3.addWidget(QLabel("Order min:"))
        self.order_min_spin = QSpinBox()
        self.order_min_spin.setToolTip("Minimum model order to try in the sweep")
        self.order_min_spin.setRange(1, 50)
        self.order_min_spin.setValue(1)
        self.order_min_spin.valueChanged.connect(self._update_estimate)
        row3.addWidget(self.order_min_spin)
        row3.addWidget(QLabel("max:"))
        self.order_max_spin = QSpinBox()
        self.order_max_spin.setToolTip("Maximum model order to try in the sweep")
        self.order_max_spin.setRange(1, 50)
        self.order_max_spin.setValue(10)
        self.order_max_spin.valueChanged.connect(self._update_estimate)
        row3.addWidget(self.order_max_spin)
        pg_layout.addLayout(row3)

        row4 = QHBoxLayout()
        row4.addWidget(QLabel("Decimation:"))
        self.decim_spin = QSpinBox()
        self.decim_spin.setToolTip("Decimation factor: downsample data to speed up identification")
        self.decim_spin.setRange(1, 1000)
        self.decim_spin.setValue(1)
        self.decim_spin.valueChanged.connect(self._update_estimate)
        row4.addWidget(self.decim_spin)
        self.auto_decim_btn = QPushButton("Auto")
        self.auto_decim_btn.setToolTip("Automatically estimate optimal decimation factor from signal spectra")
        self.auto_decim_btn.clicked.connect(self._auto_decimate)
        row4.addWidget(self.auto_decim_btn)
        pg_layout.addLayout(row4)

        row5 = QHBoxLayout()
        row5.addWidget(QLabel("Window start:"))
        self.start_spin = QSpinBox()
        self.start_spin.setRange(0, 0)
        self.start_spin.valueChanged.connect(self._update_estimate)
        row5.addWidget(self.start_spin)
        row5.addWidget(QLabel("end:"))
        self.end_spin = QSpinBox()
        self.end_spin.setRange(0, 0)
        self.end_spin.valueChanged.connect(self._update_estimate)
        row5.addWidget(self.end_spin)
        pg_layout.addLayout(row5)

        self.time_label = QLabel("Estimated time: —")
        self.time_label.setStyleSheet("font-style: italic;")
        pg_layout.addWidget(self.time_label)

        center_layout.addWidget(pg_)

        self.identify_btn = QPushButton("Identify")
        self.identify_btn.setToolTip("Run state-space identification across the selected order range")
        self.identify_btn.setStyleSheet("font-weight: bold; padding: 10px;")
        self.identify_btn.clicked.connect(self._run_identify)
        center_layout.addWidget(self.identify_btn)

        self.stop_btn = QPushButton("Stop")
        self.stop_btn.setToolTip("Cancel the ongoing identification process")
        self.stop_btn.setStyleSheet("font-weight: bold; padding: 10px; color: #d62728;")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self._stop_identify)
        center_layout.addWidget(self.stop_btn)

        self.status_label = QLabel("")
        center_layout.addWidget(self.status_label)
        center_layout.addStretch()
        splitter.addWidget(center)

        # Right: results
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)

        rg = QGroupBox("Results (VAF by order)")
        rg_layout = QVBoxLayout(rg)
        self.results_table = QTableWidget()
        self.results_table.setColumnCount(4)
        self.results_table.setHorizontalHeaderLabels(["Order", "Mean VAF%", "Best VAF%", "Save"])
        self.results_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        rg_layout.addWidget(self.results_table)
        right_layout.addWidget(rg)

        self.vaf_plot = pg.PlotWidget(background="w", title="VAF vs Model Order")
        self.vaf_plot.setLabel("left", "VAF [%]")
        self.vaf_plot.setLabel("bottom", "Model Order")
        self.vaf_plot.showGrid(x=True, y=True, alpha=0.3)
        right_layout.addWidget(self.vaf_plot)
        splitter.addWidget(right)

        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 2)
        layout.addWidget(splitter)

    @Slot()
    def _on_data_loaded(self) -> None:
        self.input_list.clear()
        self.output_list.clear()

        groups = self.data_manager.get_signals_by_group()
        for col, info in self.data_manager.signals.items():
            # Inputs
            item_in = QListWidgetItem(info.label())
            item_in.setFlags(item_in.flags() | Qt.ItemIsUserCheckable)
            item_in.setCheckState(Qt.Unchecked)
            item_in.setData(Qt.UserRole, col)
            self.input_list.addItem(item_in)

            # Outputs
            item_out = QListWidgetItem(info.label())
            item_out.setFlags(item_out.flags() | Qt.ItemIsUserCheckable)
            item_out.setCheckState(Qt.Unchecked)
            item_out.setData(Qt.UserRole, col)
            self.output_list.addItem(item_out)

        n = self.data_manager.n_samples
        self.start_spin.setRange(0, max(0, n - 1))
        self.end_spin.setRange(1, n)
        self.end_spin.setValue(n)

    @Slot()
    def _auto_suggest_io(self) -> None:
        setpoint_keywords = ["setpoint", "set_point"]
        command_keywords = ["heater", "water_valve"]

        for i in range(self.input_list.count()):
            item = self.input_list.item(i)
            col = item.data(Qt.UserRole)
            col_lower = col.lower()
            is_input = any(kw in col_lower for kw in setpoint_keywords + command_keywords)
            item.setCheckState(Qt.Checked if is_input else Qt.Unchecked)

        output_keywords = ["measured", "t_left", "t_right", "leakage", "pressure", "vibration"]
        exclude = ["max_", "min_", "setpoint", "heater", "water_valve"]
        for i in range(self.output_list.count()):
            item = self.output_list.item(i)
            col = item.data(Qt.UserRole)
            col_lower = col.lower()
            is_output = (any(kw in col_lower for kw in output_keywords) and
                         not any(ex in col_lower for ex in exclude))
            item.setCheckState(Qt.Checked if is_output else Qt.Unchecked)

    def _get_checked(self, list_widget: QListWidget) -> list[str]:
        cols = []
        for i in range(list_widget.count()):
            item = list_widget.item(i)
            if item.checkState() == Qt.Checked:
                cols.append(item.data(Qt.UserRole))
        return cols

    @Slot()
    def _auto_decimate(self) -> None:
        input_cols = self._get_checked(self.input_list)
        output_cols = self._get_checked(self.output_list)
        all_cols = input_cols + output_cols
        if not all_cols:
            return
        signals = {c: self.data_manager.get_signal(c) for c in all_cols
                    if self.data_manager.get_signal(c) is not None}
        fs = self.data_manager.sample_rate
        factor = estimate_decimation_factor(signals, fs, self.data_manager.cache)
        self.decim_spin.setValue(max(1, factor))

    @Slot()
    def _update_estimate(self) -> None:
        input_cols = self._get_checked(self.input_list)
        output_cols = self._get_checked(self.output_list)
        n_in = max(1, len(input_cols))
        n_out = max(1, len(output_cols))
        n_samples = (self.end_spin.value() - self.start_spin.value())
        decim = self.decim_spin.value()
        n_samples = max(1, n_samples // decim)
        est = estimate_time(n_samples, n_in, n_out,
                            self.order_min_spin.value(), self.order_max_spin.value())
        self.time_label.setText(f"Estimated time: ~{est:.1f}s ({n_samples} samples after decimation)")

    @Slot()
    def _run_identify(self) -> None:
        input_cols = self._get_checked(self.input_list)
        output_cols = self._get_checked(self.output_list)
        if not input_cols or not output_cols:
            QMessageBox.warning(self, "Selection Required", "Select at least one input and one output signal.")
            return

        input_data = {c: self.data_manager.get_signal(c) for c in input_cols}
        output_data = {c: self.data_manager.get_signal(c) for c in output_cols}

        if any(v is None for v in input_data.values()) or any(v is None for v in output_data.values()):
            return

        self.identify_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.status_label.setText("Identifying...")

        worker = SysIdWorker(
            input_data=input_data,
            output_data=output_data,
            fs=self.data_manager.sample_rate,
            name=self.name_edit.text(),
            method=self.method_combo.currentText(),
            order_min=self.order_min_spin.value(),
            order_max=self.order_max_spin.value(),
            decimation_factor=self.decim_spin.value(),
            start_idx=self.start_spin.value(),
            end_idx=self.end_spin.value(),
        )
        worker.signals.progress.connect(self._on_progress)
        worker.signals.result.connect(self._on_results)
        worker.signals.error.connect(self._on_error)
        self._current_worker = worker
        self.thread_pool.start(worker)

    @Slot(int, str)
    def _on_progress(self, value: int, msg: str) -> None:
        self.status_label.setText(msg)
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(value, msg)

    @Slot(object)
    def _on_results(self, results: list) -> None:
        self._results = results
        self.identify_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self._current_worker = None
        self.status_label.setText(f"Done — {len(results)} models identified.")
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")
        self._show_results()

    @Slot(str)
    def _on_error(self, msg: str) -> None:
        self.identify_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self._current_worker = None
        self.status_label.setText(f"Error: {msg}")
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")

    def _stop_identify(self) -> None:
        if self._current_worker is not None:
            self._current_worker.cancel()
            self.stop_btn.setEnabled(False)
            self.status_label.setText("Cancelling...")

    def _show_results(self) -> None:
        self.results_table.setRowCount(len(self._results))
        orders = []
        vafs = []
        for i, model in enumerate(self._results):
            self.results_table.setItem(i, 0, QTableWidgetItem(str(model.order)))
            self.results_table.setItem(i, 1, QTableWidgetItem(f"{model.mean_vaf:.2f}"))
            self.results_table.setItem(i, 2, QTableWidgetItem(f"{model.best_vaf:.2f}"))

            save_btn = QPushButton("Save")
            save_btn.clicked.connect(lambda checked, m=model: self._save_model(m))
            self.results_table.setCellWidget(i, 3, save_btn)

            orders.append(model.order)
            vafs.append(model.mean_vaf)

        # VAF plot
        self.vaf_plot.clear()
        if orders:
            self.vaf_plot.plot(orders, vafs, pen=pg.mkPen("#1f77b4", width=2),
                               symbol="o", symbolBrush="#1f77b4")

    def _save_model(self, model) -> None:
        main_win = self.window()
        if hasattr(main_win, "model_manager_widget"):
            main_win.model_manager_widget.manager.add(model)
            self.status_label.setText(f"Model '{model.name}' saved to library.")
