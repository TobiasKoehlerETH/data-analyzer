"""Compare widget: multi-file time-series comparison with alignment and statistics."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.compare_manager import CompareManager


class CompareWidget(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.manager = CompareManager(self)
        self._align_mode = "manual"  # manual, click, trigger
        self._click_align_pending: dict[str, float | None] = {}
        self._setup_ui()
        self._connect_signals()

    def _setup_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Horizontal)

        # === Left panel ===
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 8, 8, 8)

        # File list
        file_group = QGroupBox("Files")
        file_layout = QVBoxLayout(file_group)
        self.file_list = QListWidget()
        self.file_list.setToolTip("Loaded files for comparison. First file is the reference.")
        file_layout.addWidget(self.file_list)

        btn_row = QHBoxLayout()
        self.add_btn = QPushButton("Add Files...")
        self.add_btn.setToolTip("Browse and add CSV files to compare")
        self.add_btn.clicked.connect(self._add_files)
        btn_row.addWidget(self.add_btn)

        self.remove_btn = QPushButton("Remove")
        self.remove_btn.setToolTip("Remove selected file from comparison")
        self.remove_btn.clicked.connect(self._remove_file)
        btn_row.addWidget(self.remove_btn)

        self.clear_btn = QPushButton("Clear All")
        self.clear_btn.clicked.connect(self._clear_all)
        btn_row.addWidget(self.clear_btn)
        file_layout.addLayout(btn_row)
        left_layout.addWidget(file_group)

        # Signal selector
        sig_group = QGroupBox("Signals")
        sig_layout = QVBoxLayout(sig_group)
        self.signal_list = QListWidget()
        self.signal_list.setToolTip("Check signals to display in the comparison plot")
        sig_layout.addWidget(self.signal_list)
        left_layout.addWidget(sig_group)

        # Alignment
        align_group = QGroupBox("Alignment")
        align_layout = QVBoxLayout(align_group)

        mode_row = QHBoxLayout()
        self.radio_manual = QRadioButton("Manual")
        self.radio_manual.setChecked(True)
        self.radio_manual.toggled.connect(lambda c: self._set_align_mode("manual") if c else None)
        mode_row.addWidget(self.radio_manual)

        self.radio_click = QRadioButton("Click")
        self.radio_click.toggled.connect(lambda c: self._set_align_mode("click") if c else None)
        mode_row.addWidget(self.radio_click)

        self.radio_trigger = QRadioButton("Trigger")
        self.radio_trigger.toggled.connect(lambda c: self._set_align_mode("trigger") if c else None)
        mode_row.addWidget(self.radio_trigger)
        align_layout.addLayout(mode_row)

        # Manual offset area
        self.offset_container = QWidget()
        self.offset_layout = QVBoxLayout(self.offset_container)
        self.offset_layout.setContentsMargins(0, 0, 0, 0)
        align_layout.addWidget(self.offset_container)

        # Trigger config
        self.trigger_container = QWidget()
        trig_layout = QVBoxLayout(self.trigger_container)
        trig_layout.setContentsMargins(0, 4, 0, 0)

        trig_row1 = QHBoxLayout()
        trig_row1.addWidget(QLabel("Signal:"))
        self.trigger_signal_combo = QComboBox()
        self.trigger_signal_combo.setMinimumWidth(120)
        trig_row1.addWidget(self.trigger_signal_combo)
        trig_layout.addLayout(trig_row1)

        trig_row2 = QHBoxLayout()
        trig_row2.addWidget(QLabel("Threshold:"))
        self.trigger_threshold = QDoubleSpinBox()
        self.trigger_threshold.setRange(-1e9, 1e9)
        self.trigger_threshold.setDecimals(4)
        trig_row2.addWidget(self.trigger_threshold)
        trig_layout.addLayout(trig_row2)

        trig_row3 = QHBoxLayout()
        self.trigger_rising = QRadioButton("Rising")
        self.trigger_rising.setChecked(True)
        self.trigger_falling = QRadioButton("Falling")
        trig_row3.addWidget(self.trigger_rising)
        trig_row3.addWidget(self.trigger_falling)
        trig_layout.addLayout(trig_row3)

        self.trigger_apply_btn = QPushButton("Apply Trigger Alignment")
        self.trigger_apply_btn.clicked.connect(self._apply_trigger)
        trig_layout.addWidget(self.trigger_apply_btn)

        self.trigger_container.setVisible(False)
        align_layout.addWidget(self.trigger_container)

        self.click_label = QLabel("Click on each file's trace to set alignment point.")
        self.click_label.setWordWrap(True)
        self.click_label.setVisible(False)
        align_layout.addWidget(self.click_label)

        left_layout.addWidget(align_group)

        # View options
        view_group = QGroupBox("View")
        view_layout = QVBoxLayout(view_group)

        view_row = QHBoxLayout()
        self.radio_overlay = QRadioButton("Overlay")
        self.radio_overlay.setChecked(True)
        self.radio_overlay.toggled.connect(self._refresh_plots)
        view_row.addWidget(self.radio_overlay)
        self.radio_sidebyside = QRadioButton("Side-by-side")
        self.radio_sidebyside.toggled.connect(self._refresh_plots)
        view_row.addWidget(self.radio_sidebyside)
        view_layout.addLayout(view_row)

        self.show_diff_cb = QCheckBox("Show difference trace")
        self.show_diff_cb.toggled.connect(self._refresh_plots)
        view_layout.addWidget(self.show_diff_cb)

        self.show_stats_cb = QCheckBox("Show statistics")
        self.show_stats_cb.setChecked(True)
        self.show_stats_cb.toggled.connect(self._toggle_stats)
        view_layout.addWidget(self.show_stats_cb)

        left_layout.addWidget(view_group)
        left_layout.addStretch()

        splitter.addWidget(left)

        # === Right panel ===
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(2)

        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground("w")
        right_layout.addWidget(self.plot_widget, stretch=4)

        self.diff_plot_widget = pg.GraphicsLayoutWidget()
        self.diff_plot_widget.setBackground("w")
        self.diff_plot_widget.setMinimumHeight(120)
        self.diff_plot_widget.hide()
        right_layout.addWidget(self.diff_plot_widget, stretch=2)

        # Statistics table
        self.stats_table = QTableWidget()
        self.stats_table.setColumnCount(6)
        self.stats_table.setHorizontalHeaderLabels(
            ["Signal", "File", "RMSE", "Max Dev", "R\u00b2", "Mean Error"]
        )
        self.stats_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.stats_table.setMinimumHeight(80)
        right_layout.addWidget(self.stats_table, stretch=1)

        splitter.addWidget(right)
        splitter.setSizes([300, 900])
        layout.addWidget(splitter)

    def _connect_signals(self) -> None:
        self.manager.files_changed.connect(self._on_files_changed)
        self.manager.alignment_changed.connect(self._refresh_plots)
        self.manager.mappings_changed.connect(self._update_signal_list)
        self.signal_list.itemChanged.connect(self._refresh_plots)

    @Slot()
    def _add_files(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Add CSV Files", "", "CSV Files (*.csv *.txt *.tsv);;All Files (*)"
        )
        for path in paths:
            try:
                self.manager.add_file(path)
            except Exception as e:
                QMessageBox.warning(self, "Load Error", f"Could not load {path}:\n{e}")

    @Slot()
    def _remove_file(self) -> None:
        row = self.file_list.currentRow()
        if row < 0:
            return
        file_id = self.file_list.item(row).data(Qt.UserRole)
        if file_id:
            self.manager.remove_file(file_id)

    @Slot()
    def _clear_all(self) -> None:
        self.manager.clear()

    @Slot()
    def _on_files_changed(self) -> None:
        self.file_list.clear()
        for i, fid in enumerate(self.manager.file_order):
            cf = self.manager.files[fid]
            prefix = "\u2605 " if i == 0 else "  "
            item = QListWidgetItem(f"{prefix}{cf.short_name}")
            item.setData(Qt.UserRole, fid)
            item.setForeground(pg.mkColor(cf.color))
            self.file_list.addItem(item)

        self._update_offset_controls()
        self._update_signal_list()
        self._update_trigger_signals()
        self._refresh_plots()

    @Slot()
    def _update_signal_list(self) -> None:
        self.signal_list.blockSignals(True)
        self.signal_list.clear()
        for name in self.manager.get_mapped_signals():
            item = QListWidgetItem(name)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Unchecked)
            self.signal_list.addItem(item)
        self.signal_list.blockSignals(False)

    def _get_checked_signals(self) -> list[str]:
        checked = []
        for i in range(self.signal_list.count()):
            item = self.signal_list.item(i)
            if item.checkState() == Qt.Checked:
                checked.append(item.text())
        return checked

    def _update_offset_controls(self) -> None:
        while self.offset_layout.count():
            item = self.offset_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        for fid in self.manager.file_order:
            cf = self.manager.files[fid]
            row = QWidget()
            rl = QHBoxLayout(row)
            rl.setContentsMargins(0, 0, 0, 0)
            lbl = QLabel(cf.short_name[:20])
            lbl.setStyleSheet(f"color: {cf.color};")
            rl.addWidget(lbl)
            spin = QDoubleSpinBox()
            spin.setRange(-1e6, 1e6)
            spin.setDecimals(4)
            spin.setSuffix(" s")
            spin.setValue(cf.offset)
            spin.valueChanged.connect(lambda v, f=fid: self.manager.set_offset(f, v))
            rl.addWidget(spin)
            self.offset_layout.addWidget(row)

    def _update_trigger_signals(self) -> None:
        self.trigger_signal_combo.clear()
        for name in self.manager.get_mapped_signals():
            self.trigger_signal_combo.addItem(name)

    def _set_align_mode(self, mode: str) -> None:
        self._align_mode = mode
        self.offset_container.setVisible(mode == "manual")
        self.trigger_container.setVisible(mode == "trigger")
        self.click_label.setVisible(mode == "click")
        if mode == "click":
            self._click_align_pending = {fid: None for fid in self.manager.file_order}

    @Slot()
    def _apply_trigger(self) -> None:
        signal = self.trigger_signal_combo.currentText()
        if not signal:
            return
        threshold = self.trigger_threshold.value()
        rising = self.trigger_rising.isChecked()
        self.manager.align_by_trigger(signal, threshold, rising)
        self._update_offset_controls()

    @Slot()
    def _refresh_plots(self) -> None:
        self.plot_widget.clear()
        self.diff_plot_widget.clear()

        checked = self._get_checked_signals()
        if not checked or not self.manager.file_order:
            return

        overlay = self.radio_overlay.isChecked()
        show_diff = self.show_diff_cb.isChecked()

        if overlay:
            self._draw_overlay(checked)
        else:
            self._draw_side_by_side(checked)

        if show_diff:
            self._draw_difference(checked)
            self.diff_plot_widget.show()
        else:
            self.diff_plot_widget.hide()

        if self.show_stats_cb.isChecked():
            self._update_stats(checked)

    def _draw_overlay(self, signals: list[str]) -> None:
        for row_idx, sig_name in enumerate(signals):
            plot = self.plot_widget.addPlot(row=row_idx, col=0)
            plot.setLabel("left", sig_name)
            plot.showGrid(x=True, y=True, alpha=0.3)
            plot.setDownsampling(auto=True, mode="peak")
            plot.setClipToView(True)
            if row_idx == len(signals) - 1:
                plot.setLabel("bottom", "Time [s]")
            plot.addLegend(offset=(30, 10))

            for fid in self.manager.file_order:
                cf = self.manager.files[fid]
                col = self.manager._resolve_column(fid, sig_name)
                if col is None or col not in cf.signals:
                    continue
                time = self.manager.get_aligned_time(fid)
                data = cf.signals[col]
                plot.plot(time, data, pen=pg.mkPen(cf.color, width=1.5), name=cf.short_name)

            if self._align_mode == "click":
                plot.scene().sigMouseClicked.connect(
                    lambda evt, p=plot, s=sig_name: self._on_plot_clicked(evt, p, s)
                )

    def _draw_side_by_side(self, signals: list[str]) -> None:
        for row_idx, sig_name in enumerate(signals):
            for col_idx, fid in enumerate(self.manager.file_order):
                cf = self.manager.files[fid]
                col = self.manager._resolve_column(fid, sig_name)
                if col is None or col not in cf.signals:
                    continue

                plot = self.plot_widget.addPlot(row=row_idx, col=col_idx)
                plot.setTitle(f"{cf.short_name}", size="8pt")
                plot.setLabel("left", sig_name)
                plot.showGrid(x=True, y=True, alpha=0.3)
                plot.setDownsampling(auto=True, mode="peak")
                plot.setClipToView(True)

                time = self.manager.get_aligned_time(fid)
                data = cf.signals[col]
                plot.plot(time, data, pen=pg.mkPen(cf.color, width=1.5))

                if row_idx == len(signals) - 1:
                    plot.setLabel("bottom", "Time [s]")

    def _draw_difference(self, signals: list[str]) -> None:
        if len(self.manager.file_order) < 2:
            return

        ref_id = self.manager.file_order[0]
        diff_colors = ["#e74c3c", "#8e44ad", "#f39c12", "#16a085", "#2c3e50"]

        for row_idx, sig_name in enumerate(signals):
            plot = self.diff_plot_widget.addPlot(row=row_idx, col=0)
            plot.setLabel("left", f"\u0394 {sig_name}")
            plot.showGrid(x=True, y=True, alpha=0.3)
            plot.addLegend(offset=(30, 10))
            if row_idx == len(signals) - 1:
                plot.setLabel("bottom", "Time [s]")
            plot.addLine(y=0, pen=pg.mkPen("gray", width=1, style=Qt.DashLine))

            for i, fid in enumerate(self.manager.file_order[1:]):
                result = self.manager.compute_difference(sig_name, ref_id, fid)
                if result is None:
                    continue
                t, diff = result
                cf = self.manager.files[fid]
                color = diff_colors[i % len(diff_colors)]
                plot.plot(t, diff, pen=pg.mkPen(color, width=1.2), name=cf.short_name)

    def _update_stats(self, signals: list[str]) -> None:
        if len(self.manager.file_order) < 2:
            self.stats_table.setRowCount(0)
            return

        ref_id = self.manager.file_order[0]
        rows = []
        for sig_name in signals:
            for fid in self.manager.file_order[1:]:
                stats = self.manager.compute_statistics(sig_name, ref_id, fid)
                if stats is not None:
                    rows.append(stats)

        self.stats_table.setRowCount(len(rows))
        for r, s in enumerate(rows):
            self.stats_table.setItem(r, 0, QTableWidgetItem(s.signal))
            self.stats_table.setItem(r, 1, QTableWidgetItem(s.file_name))
            self.stats_table.setItem(r, 2, QTableWidgetItem(f"{s.rmse:.6f}"))
            self.stats_table.setItem(r, 3, QTableWidgetItem(f"{s.max_deviation:.6f}"))
            self.stats_table.setItem(r, 4, QTableWidgetItem(f"{s.r_squared:.4f}"))
            self.stats_table.setItem(r, 5, QTableWidgetItem(f"{s.mean_error:.6f}"))

    @Slot()
    def _toggle_stats(self) -> None:
        self.stats_table.setVisible(self.show_stats_cb.isChecked())
        if self.show_stats_cb.isChecked():
            self._refresh_plots()

    def _on_plot_clicked(self, evt, plot, sig_name) -> None:
        """Handle click-to-align: record click position for alignment."""
        if self._align_mode != "click":
            return
        pos = evt.scenePos()
        vb = plot.vb
        if not plot.sceneBoundingRect().contains(pos):
            return

        mouse_point = vb.mapSceneToView(pos)
        click_time = mouse_point.x()

        # Find which file this click is closest to
        best_fid = None
        best_dist = float("inf")
        for fid in self.manager.file_order:
            cf = self.manager.files[fid]
            col = self.manager._resolve_column(fid, sig_name)
            if col is None:
                continue
            aligned_time = self.manager.get_aligned_time(fid)
            if aligned_time is None:
                continue
            idx = int(np.searchsorted(aligned_time, click_time))
            idx = max(0, min(idx, len(aligned_time) - 1))
            data = cf.signals[col]
            y_val = data[idx]
            y_click = mouse_point.y()
            dist = abs(y_val - y_click)
            if dist < best_dist:
                best_dist = dist
                best_fid = fid

        if best_fid is None:
            return

        self._click_align_pending[best_fid] = click_time

        # Check if all files have been clicked
        if all(v is not None for v in self._click_align_pending.values()):
            # Align relative to first file
            ref_id = self.manager.file_order[0]
            ref_click = self._click_align_pending[ref_id]
            for fid, t in self._click_align_pending.items():
                offset = ref_click - t
                self.manager._files[fid].offset = offset
            self.manager.alignment_changed.emit()
            self._update_offset_controls()
            self._click_align_pending = {fid: None for fid in self.manager.file_order}
