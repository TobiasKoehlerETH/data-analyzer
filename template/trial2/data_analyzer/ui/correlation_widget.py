"""Correlation widget: heatmap, scatter plot, auto-suggestions, lag plot."""

from __future__ import annotations

import numpy as np
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot, QThreadPool
from PySide6.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.correlation_engine import (
    compute_correlation_matrix,
    compute_cross_correlation,
    compute_lagged_correlations,
    CorrelationPair,
    CorrelationResult,
)


class CorrelationWidget(QWidget):
    def __init__(self, data_manager: DataManager, thread_pool: QThreadPool,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.thread_pool = thread_pool
        self._result: CorrelationResult | None = None
        self._setup_ui()
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        ctrl = QHBoxLayout()
        self.compute_btn = QPushButton("Compute Correlations")
        self.compute_btn.setToolTip("Compute the full correlation matrix for all numeric signals")
        self.compute_btn.clicked.connect(self._compute)
        ctrl.addWidget(self.compute_btn)

        ctrl.addWidget(QLabel("Method:"))
        self.method_combo = QComboBox()
        self.method_combo.setToolTip("Pearson measures linear correlation; Spearman measures monotonic relationships")
        self.method_combo.addItems(["Pearson", "Spearman"])
        ctrl.addWidget(self.method_combo)
        ctrl.addStretch()
        layout.addLayout(ctrl)

        splitter = QSplitter(Qt.Horizontal)

        # Left: heatmap
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        self.heatmap_figure = Figure(figsize=(6, 5))
        self.heatmap_canvas = FigureCanvasQTAgg(self.heatmap_figure)
        self.heatmap_canvas.setToolTip("Click on a cell to analyse that signal pair")
        left_layout.addWidget(self.heatmap_canvas)
        splitter.addWidget(left)

        # Center: suggestions
        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(0, 0, 0, 0)

        sg = QGroupBox("Top Correlated Pairs")
        sg_layout = QVBoxLayout(sg)
        self.suggestion_list = QListWidget()
        self.suggestion_list.setToolTip("Click a pair to view its scatter plot and cross-correlation")
        self.suggestion_list.currentRowChanged.connect(self._on_pair_selected)
        sg_layout.addWidget(self.suggestion_list)
        center_layout.addWidget(sg)

        # Manual pair selection
        mg = QGroupBox("Custom Pair Selection")
        mg_layout = QVBoxLayout(mg)
        mg_layout.addWidget(QLabel("Signal A:"))
        self.signal_a_combo = QComboBox()
        self.signal_a_combo.setToolTip("Select the first signal of the pair to analyse")
        mg_layout.addWidget(self.signal_a_combo)
        mg_layout.addWidget(QLabel("Signal B:"))
        self.signal_b_combo = QComboBox()
        self.signal_b_combo.setToolTip("Select the second signal of the pair to analyse")
        mg_layout.addWidget(self.signal_b_combo)
        self.analyse_pair_btn = QPushButton("Analyse Pair")
        self.analyse_pair_btn.setToolTip("Show scatter plot and cross-correlation for the selected pair")
        self.analyse_pair_btn.clicked.connect(self._analyse_custom_pair)
        mg_layout.addWidget(self.analyse_pair_btn)
        center_layout.addWidget(mg)

        self.lag_btn = QPushButton("Compute Lag Analysis")
        self.lag_btn.setToolTip("Compute optimal lag for each top pair using cross-correlation")
        self.lag_btn.clicked.connect(self._compute_lags)
        center_layout.addWidget(self.lag_btn)
        splitter.addWidget(center)

        # Right: scatter + lag plot
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)

        self.scatter_plot = pg.PlotWidget(background="w", title="Scatter Plot")
        self.scatter_plot.showGrid(x=True, y=True, alpha=0.3)
        right_layout.addWidget(self.scatter_plot)

        self.lag_plot = pg.PlotWidget(background="w", title="Cross-Correlation (lag)")
        self.lag_plot.setLabel("bottom", "Lag [samples]")
        self.lag_plot.setLabel("left", "Correlation")
        self.lag_plot.showGrid(x=True, y=True, alpha=0.3)
        right_layout.addWidget(self.lag_plot)
        splitter.addWidget(right)

        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 2)
        layout.addWidget(splitter)

    @Slot()
    def _on_data_loaded(self) -> None:
        self._result = None
        self.suggestion_list.clear()
        self.heatmap_figure.clear()
        self.heatmap_canvas.draw()
        self._populate_combos()

    def _populate_combos(self) -> None:
        self.signal_a_combo.clear()
        self.signal_b_combo.clear()
        if not self.data_manager.is_loaded:
            return
        for col in self.data_manager.get_numeric_columns():
            info = self.data_manager.signals.get(col)
            label = info.label() if info else col
            self.signal_a_combo.addItem(label, col)
            self.signal_b_combo.addItem(label, col)

    @Slot()
    def _compute(self) -> None:
        if not self.data_manager.is_loaded:
            return

        signals = {}
        for col in self.data_manager.get_numeric_columns():
            data = self.data_manager.get_signal(col)
            if data is not None:
                signals[col] = data

        self._result = compute_correlation_matrix(signals, cache=self.data_manager.cache)
        self._draw_heatmap()
        self._populate_suggestions()
        self._populate_combos()

    def _draw_heatmap(self) -> None:
        if self._result is None:
            return

        use_spearman = self.method_combo.currentText() == "Spearman"
        matrix = self._result.spearman_matrix if use_spearman else self._result.pearson_matrix
        columns = self._result.columns

        self.heatmap_figure.clear()
        ax = self.heatmap_figure.add_subplot(111)

        # Shorten labels
        short = []
        for c in columns:
            info = self.data_manager.signals.get(c)
            short.append(info.name[:20] if info else c[:20])

        im = ax.imshow(matrix, cmap="RdBu_r", vmin=-1, vmax=1, aspect="auto")
        ax.set_xticks(range(len(short)))
        ax.set_yticks(range(len(short)))
        ax.set_xticklabels(short, rotation=90, fontsize=6)
        ax.set_yticklabels(short, fontsize=6)
        self.heatmap_figure.colorbar(im, ax=ax, shrink=0.8)
        self.heatmap_figure.tight_layout()
        self.heatmap_canvas.draw()
        self.heatmap_canvas.mpl_connect("button_press_event", self._on_heatmap_click)

    def _on_heatmap_click(self, event) -> None:
        if event.inaxes is None or self._result is None:
            return
        columns = self._result.columns
        x_idx = int(round(event.xdata))
        y_idx = int(round(event.ydata))
        if not (0 <= x_idx < len(columns) and 0 <= y_idx < len(columns)):
            return
        if x_idx == y_idx:
            return
        col_a = columns[y_idx]
        col_b = columns[x_idx]
        self._show_pair(col_a, col_b)

    def _populate_suggestions(self) -> None:
        self.suggestion_list.clear()
        if self._result is None:
            return
        for pair in self._result.top_pairs:
            info_a = self.data_manager.signals.get(pair.signal_a)
            info_b = self.data_manager.signals.get(pair.signal_b)
            na = info_a.name if info_a else pair.signal_a
            nb = info_b.name if info_b else pair.signal_b
            lag_str = f", lag={pair.lag_seconds:.1f}s" if pair.lag_seconds != 0 else ""
            text = f"|r|={abs(pair.pearson_r):.3f}: {na} ↔ {nb}{lag_str}"
            item = QListWidgetItem(text)
            item.setData(Qt.UserRole, pair)
            self.suggestion_list.addItem(item)

    @Slot(int)
    def _on_pair_selected(self, row: int) -> None:
        if row < 0 or self._result is None:
            return
        item = self.suggestion_list.item(row)
        pair = item.data(Qt.UserRole)
        self._show_pair(pair.signal_a, pair.signal_b)

    @Slot()
    def _analyse_custom_pair(self) -> None:
        col_a = self.signal_a_combo.currentData()
        col_b = self.signal_b_combo.currentData()
        if not col_a or not col_b or col_a == col_b:
            return
        self._show_pair(col_a, col_b)

    def _show_pair(self, col_a: str, col_b: str) -> None:
        a = self.data_manager.get_signal(col_a)
        b = self.data_manager.get_signal(col_b)
        if a is None or b is None:
            return

        # Scatter (subsample for speed)
        n = len(a)
        if n > 5000:
            idx = np.linspace(0, n - 1, 5000, dtype=int)
            a_s, b_s = a[idx], b[idx]
        else:
            a_s, b_s = a, b

        info_a = self.data_manager.signals.get(col_a)
        info_b = self.data_manager.signals.get(col_b)

        self.scatter_plot.clear()
        self.scatter_plot.setLabel("bottom", info_a.label() if info_a else col_a)
        self.scatter_plot.setLabel("left", info_b.label() if info_b else col_b)
        self.scatter_plot.plot(a_s, b_s, pen=None, symbol="o", symbolSize=2,
                               symbolBrush=pg.mkBrush("#1f77b4"))

        # Lag plot
        max_lag = min(len(a) // 2, int(self.data_manager.sample_rate * 300))
        lags, corr = compute_cross_correlation(a, b, max_lag=max_lag)
        self.lag_plot.clear()
        self.lag_plot.plot(lags, corr, pen=pg.mkPen("#1f77b4", width=1.5))

    @Slot()
    def _compute_lags(self) -> None:
        if self._result is None:
            return
        signals = {}
        for col in self.data_manager.get_numeric_columns():
            data = self.data_manager.get_signal(col)
            if data is not None:
                signals[col] = data

        fs = self.data_manager.sample_rate
        compute_lagged_correlations(signals, self._result.top_pairs, fs)
        self._populate_suggestions()
