"""Filter widget: auto-suggestions, filter chain builder, live preview."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot, QThreadPool
from PySide6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
    QCheckBox,
)

from core.data_manager import DataManager
from core.filter_engine import apply_chain, suggest_filters
from models.filter_model import FilterChain, FilterStep, FilterSuggestion, FilterType

PREVIEW_POINTS = 5000


class FilterWidget(QWidget):
    def __init__(self, data_manager: DataManager, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self._chain = FilterChain()
        self._suggestions: list[FilterSuggestion] = []
        self._setup_ui()
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # Signal selector
        sig_row = QHBoxLayout()
        sig_row.addWidget(QLabel("Signal:"))
        self.signal_combo = QComboBox()
        self.signal_combo.setToolTip("Select the signal to apply filters to")
        self.signal_combo.currentTextChanged.connect(self._on_signal_changed)
        sig_row.addWidget(self.signal_combo, stretch=1)
        layout.addLayout(sig_row)

        splitter = QSplitter(Qt.Horizontal)

        # Left: suggestions + add filter
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)

        # Auto-suggestions
        sg = QGroupBox("Auto-Suggestions")
        sg_layout = QVBoxLayout(sg)
        self.suggest_btn = QPushButton("Analyze && Suggest")
        self.suggest_btn.setToolTip("Analyze the signal spectrum and suggest appropriate filters")
        self.suggest_btn.clicked.connect(self._run_suggest)
        sg_layout.addWidget(self.suggest_btn)
        self.suggestion_list = QListWidget()
        self.suggestion_list.setToolTip("Double-click a suggestion to add it to the filter chain")
        self.suggestion_list.itemDoubleClicked.connect(self._add_suggestion)
        sg_layout.addWidget(self.suggestion_list)
        left_layout.addWidget(sg)

        # Manual add
        mg = QGroupBox("Add Filter Manually")
        mg_layout = QVBoxLayout(mg)
        self.type_combo = QComboBox()
        self.type_combo.setToolTip("Select the type of filter to add manually")
        for ft in FilterType:
            self.type_combo.addItem(ft.value.replace("_", " ").title(), ft)
        self.type_combo.currentIndexChanged.connect(self._on_type_changed)
        mg_layout.addWidget(self.type_combo)

        self.param_widgets: dict[str, QWidget] = {}
        self.param_container = QVBoxLayout()
        mg_layout.addLayout(self.param_container)

        add_btn = QPushButton("Add to Chain")
        add_btn.clicked.connect(self._add_manual)
        mg_layout.addWidget(add_btn)
        left_layout.addWidget(mg)
        splitter.addWidget(left)

        # Center: chain list
        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(0, 0, 0, 0)

        cg = QGroupBox("Filter Chain")
        cg_layout = QVBoxLayout(cg)
        self.chain_list = QListWidget()
        self.chain_list.setDragDropMode(QListWidget.InternalMove)
        self.chain_list.model().rowsMoved.connect(self._on_chain_reordered)
        cg_layout.addWidget(self.chain_list)

        chain_btns = QHBoxLayout()
        self.remove_btn = QPushButton("Remove")
        self.remove_btn.clicked.connect(self._remove_step)
        chain_btns.addWidget(self.remove_btn)
        self.clear_btn = QPushButton("Clear All")
        self.clear_btn.clicked.connect(self._clear_chain)
        chain_btns.addWidget(self.clear_btn)
        cg_layout.addLayout(chain_btns)

        chain_io = QHBoxLayout()
        save_btn = QPushButton("Save Chain")
        save_btn.clicked.connect(self._save_chain)
        chain_io.addWidget(save_btn)
        load_btn = QPushButton("Load Chain")
        load_btn.clicked.connect(self._load_chain)
        chain_io.addWidget(load_btn)
        cg_layout.addLayout(chain_io)

        center_layout.addWidget(cg)

        apply_btn = QPushButton("Apply to Full Data")
        apply_btn.setStyleSheet("font-weight: bold; padding: 8px;")
        apply_btn.clicked.connect(self._apply_full)
        center_layout.addWidget(apply_btn)

        self.clear_filter_btn = QPushButton("Clear Filtered Data")
        self.clear_filter_btn.clicked.connect(self._clear_filtered)
        center_layout.addWidget(self.clear_filter_btn)
        splitter.addWidget(center)

        # Right: preview plot
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)

        self.preview_plot = pg.PlotWidget(background="w")
        self.preview_plot.setLabel("left", "Value")
        self.preview_plot.setLabel("bottom", "Time [s]")
        self.preview_plot.showGrid(x=True, y=True, alpha=0.3)
        self.preview_plot.addLegend()
        self._original_curve = self.preview_plot.plot([], [], pen=pg.mkPen("#1f77b4", width=1), name="Original")
        self._filtered_curve = self.preview_plot.plot([], [], pen=pg.mkPen("#d62728", width=1.5), name="Filtered")
        right_layout.addWidget(self.preview_plot)
        splitter.addWidget(right)

        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 2)
        layout.addWidget(splitter)

        self._build_param_ui()

    def _build_param_ui(self) -> None:
        self._clear_params()
        ft = self.type_combo.currentData()
        if ft in (FilterType.LOWPASS, FilterType.HIGHPASS):
            self._add_param_float("cutoff", "Cutoff [Hz]", 0.0001, 10.0, 0.05)
            self._add_param_int("order", "Order", 1, 10, 4)
        elif ft in (FilterType.BANDPASS, FilterType.BANDSTOP):
            self._add_param_float("low", "Low [Hz]", 0.0001, 10.0, 0.01)
            self._add_param_float("high", "High [Hz]", 0.0001, 10.0, 0.1)
            self._add_param_int("order", "Order", 1, 10, 4)
        elif ft == FilterType.SAVGOL:
            self._add_param_int("window", "Window", 3, 1001, 51)
            self._add_param_int("polyorder", "Poly Order", 1, 10, 3)
        elif ft in (FilterType.MOVING_AVERAGE, FilterType.MEDIAN):
            self._add_param_int("window", "Window", 3, 1001, 21)
        elif ft == FilterType.EXP_MOVING_AVERAGE:
            self._add_param_float("alpha", "Alpha", 0.001, 1.0, 0.1)
        elif ft == FilterType.NOTCH:
            self._add_param_float("freq", "Frequency [Hz]", 0.0001, 10.0, 0.05)
            self._add_param_float("Q", "Q Factor", 1.0, 200.0, 30.0)

    def _clear_params(self) -> None:
        for w in self.param_widgets.values():
            w.setParent(None)
            w.deleteLater()
        self.param_widgets.clear()

    def _add_param_float(self, key: str, label: str, min_v: float, max_v: float, default: float) -> None:
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(QLabel(label))
        spin = QDoubleSpinBox()
        spin.setDecimals(6)
        spin.setRange(min_v, max_v)
        spin.setValue(default)
        spin.setSingleStep((max_v - min_v) / 100)
        spin.valueChanged.connect(self._update_preview)
        rl.addWidget(spin)
        self.param_container.addWidget(row)
        self.param_widgets[key] = spin

    def _add_param_int(self, key: str, label: str, min_v: int, max_v: int, default: int) -> None:
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(QLabel(label))
        spin = QSpinBox()
        spin.setRange(min_v, max_v)
        spin.setValue(default)
        spin.valueChanged.connect(self._update_preview)
        rl.addWidget(spin)
        self.param_container.addWidget(row)
        self.param_widgets[key] = spin

    @Slot()
    def _on_type_changed(self) -> None:
        self._build_param_ui()

    @Slot()
    def _on_data_loaded(self) -> None:
        self.signal_combo.clear()
        for col in self.data_manager.get_numeric_columns():
            info = self.data_manager.signals.get(col)
            label = info.label() if info else col
            self.signal_combo.addItem(label, col)

    @Slot()
    def _on_signal_changed(self) -> None:
        self._chain = FilterChain()
        self.chain_list.clear()
        self.suggestion_list.clear()
        self._suggestions.clear()
        self._update_preview()

    def _get_current_signal(self) -> tuple[str | None, np.ndarray | None, np.ndarray | None]:
        col = self.signal_combo.currentData()
        if not col or not self.data_manager.is_loaded:
            return None, None, None
        raw = self.data_manager.get_raw_signal(col)
        time = self.data_manager.time_array
        return col, raw, time

    def _downsample(self, time: np.ndarray, data: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if len(data) <= PREVIEW_POINTS:
            return time, data
        step = max(1, len(data) // PREVIEW_POINTS)
        return time[::step], data[::step]

    @Slot()
    def _run_suggest(self) -> None:
        col, raw, _ = self._get_current_signal()
        if raw is None:
            return
        fs = self.data_manager.sample_rate
        self._suggestions = suggest_filters(raw, fs, self.data_manager.cache, col)
        self.suggestion_list.clear()
        for s in self._suggestions:
            item = QListWidgetItem(s.reason)
            item.setToolTip(f"Type: {s.filter_type.value}, Params: {s.params}")
            self.suggestion_list.addItem(item)

    @Slot(QListWidgetItem)
    def _add_suggestion(self, item: QListWidgetItem) -> None:
        idx = self.suggestion_list.row(item)
        if 0 <= idx < len(self._suggestions):
            step = self._suggestions[idx].to_step()
            self._chain.add(step)
            self._refresh_chain_list()
            self._update_preview()

    @Slot()
    def _add_manual(self) -> None:
        ft = self.type_combo.currentData()
        params = {}
        for key, widget in self.param_widgets.items():
            if isinstance(widget, QDoubleSpinBox):
                params[key] = widget.value()
            elif isinstance(widget, QSpinBox):
                params[key] = widget.value()
        step = FilterStep(filter_type=ft, params=params)
        self._chain.add(step)
        self._refresh_chain_list()
        self._update_preview()

    def _refresh_chain_list(self) -> None:
        self.chain_list.clear()
        for i, step in enumerate(self._chain.steps):
            desc = step.describe()
            prefix = "✓" if step.enabled else "✗"
            item = QListWidgetItem(f"{prefix} {i + 1}. {desc}")
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked if step.enabled else Qt.Unchecked)
            self.chain_list.addItem(item)
        self.chain_list.itemChanged.connect(self._on_chain_check_changed)

    @Slot(QListWidgetItem)
    def _on_chain_check_changed(self, item: QListWidgetItem) -> None:
        idx = self.chain_list.row(item)
        if 0 <= idx < len(self._chain.steps):
            self._chain.steps[idx].enabled = item.checkState() == Qt.Checked
            self._update_preview()

    @Slot()
    def _on_chain_reordered(self) -> None:
        self._update_preview()

    @Slot()
    def _remove_step(self) -> None:
        row = self.chain_list.currentRow()
        if row >= 0:
            self._chain.remove(row)
            self._refresh_chain_list()
            self._update_preview()

    @Slot()
    def _clear_chain(self) -> None:
        self._chain = FilterChain()
        self._refresh_chain_list()
        self._update_preview()

    @Slot()
    def _update_preview(self) -> None:
        col, raw, time = self._get_current_signal()
        if raw is None or time is None:
            self._original_curve.setData([], [])
            self._filtered_curve.setData([], [])
            return

        t_ds, raw_ds = self._downsample(time, raw)
        self._original_curve.setData(t_ds, raw_ds)

        if self._chain.enabled_steps():
            fs = self.data_manager.sample_rate
            filtered_ds = apply_chain(raw_ds, self._chain, fs)
            self._filtered_curve.setData(t_ds, filtered_ds)
        else:
            self._filtered_curve.setData([], [])

    @Slot()
    def _apply_full(self) -> None:
        col, raw, _ = self._get_current_signal()
        if raw is None or not self._chain.enabled_steps():
            return
        fs = self.data_manager.sample_rate
        filtered = apply_chain(raw, self._chain, fs)
        self.data_manager.set_filtered_signal(col, filtered)
        self.data_manager.set_filter_chain(col, self._chain)
        main_win = self.window()
        if hasattr(main_win, "show_status"):
            main_win.show_status(f"Filter applied to {col}")

    @Slot()
    def _clear_filtered(self) -> None:
        col = self.signal_combo.currentData()
        if col:
            self.data_manager.clear_filtered_signal(col)

    @Slot()
    def _save_chain(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "Save Filter Chain", "", "JSON (*.json)")
        if path:
            self._chain.save_json(path)

    @Slot()
    def _load_chain(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Load Filter Chain", "", "JSON (*.json)")
        if path:
            self._chain = FilterChain.load_json(path)
            self._refresh_chain_list()
            self._update_preview()
