"""Fast interactive time-series plot widget using pyqtgraph."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QPalette, QColor
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from ui.signal_selector_widget import SignalSelectorWidget

pg.setConfigOptions(antialias=False, useOpenGL=True)

COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
    "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5",
]
MAX_PLOTS = 8


class PlotWidget(QWidget):
    def __init__(self, data_manager: DataManager, signal_selector: SignalSelectorWidget, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.signal_selector = signal_selector
        self._plots: dict[str, pg.PlotItem] = {}
        self._curves: dict[str, pg.PlotDataItem] = {}
        self._selected_signals: list[str] = []
        self._signal_groups: dict[str, int] = {}  # col -> plot group number
        self._group_spinboxes: dict[str, QSpinBox] = {}
        self._setup_ui()
        self.data_manager.data_changed.connect(self._on_data_changed)
        self.signal_selector.signals_selected.connect(self.update_selected_signals)

    def _setup_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # Splitter: signal selector on left, plot area on right
        self._splitter = QSplitter(Qt.Horizontal)
        self._splitter.addWidget(self.signal_selector)

        # Right side: plot content
        plot_container = QWidget()
        plot_layout = QVBoxLayout(plot_container)
        plot_layout.setContentsMargins(0, 0, 0, 0)

        self.info_label = QLabel("Select signals from the panel on the left to plot.")
        self.info_label.setAlignment(Qt.AlignCenter)
        plot_layout.addWidget(self.info_label)

        # Group assignment bar
        self._group_scroll = QScrollArea()
        self._group_scroll.setWidgetResizable(True)
        self._group_scroll.setFixedHeight(48)
        self._group_scroll.setVisible(False)
        self._group_scroll.setStyleSheet(
            "QScrollArea { background-color: #eaf2f8; border: 1px solid #bdc3c7; border-radius: 3px; }"
        )
        self._group_container = QWidget()
        # Use palette for background so it does NOT cascade into child widgets
        pal = self._group_container.palette()
        pal.setColor(QPalette.Window, QColor("#eaf2f8"))
        self._group_container.setPalette(pal)
        self._group_container.setAutoFillBackground(True)
        self._group_layout = QHBoxLayout(self._group_container)
        self._group_layout.setContentsMargins(8, 4, 8, 4)
        self._group_layout.setSpacing(8)
        self._group_scroll.setWidget(self._group_container)
        plot_layout.addWidget(self._group_scroll)

        self.graphics_widget = pg.GraphicsLayoutWidget()
        self.graphics_widget.setBackground("w")
        plot_layout.addWidget(self.graphics_widget)

        self.coord_label = QLabel("")
        self.coord_label.setStyleSheet("padding: 2px; font-family: monospace;")
        plot_layout.addWidget(self.coord_label)

        self._splitter.addWidget(plot_container)
        self._splitter.setSizes([250, 1000])
        layout.addWidget(self._splitter)

        self._proxy = None

    @Slot(list)
    def update_selected_signals(self, columns: list[str]) -> None:
        if len(columns) > MAX_PLOTS:
            QMessageBox.warning(
                self, "Too Many Signals",
                f"Max {MAX_PLOTS} plots at once for performance. Showing first {MAX_PLOTS}.",
            )
            columns = columns[:MAX_PLOTS]

        self._selected_signals = columns
        # Assign default groups for new signals (auto-increment)
        next_group = max(self._signal_groups.values(), default=0) + 1
        for col in columns:
            if col not in self._signal_groups:
                self._signal_groups[col] = next_group
                next_group += 1
        # Remove groups for deselected signals
        self._signal_groups = {c: g for c, g in self._signal_groups.items() if c in columns}
        self._update_group_bar()
        self._rebuild_plots()

    def _update_group_bar(self) -> None:
        # Clear existing widgets
        while self._group_layout.count():
            item = self._group_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self._group_spinboxes.clear()

        if not self._selected_signals:
            self._group_scroll.setVisible(False)
            return

        self._group_scroll.setVisible(True)
        lbl = QLabel("Plot#:")
        lbl.setStyleSheet("font-weight: bold; color: #1a5276; background: transparent;")
        self._group_layout.addWidget(lbl)

        for col in self._selected_signals:
            info = self.data_manager.signals.get(col)
            name = info.name[:18] if info else col[:18]
            label = QLabel(name)
            label.setStyleSheet("color: #2f3640; background: transparent;")
            label.setToolTip(f"Assign '{info.name if info else col}' to a plot group")

            spin = QSpinBox()
            spin.setRange(1, MAX_PLOTS)
            spin.setValue(self._signal_groups.get(col, 1))
            spin.setFixedWidth(50)
            spin.setStyleSheet(
                "QSpinBox { background-color: #ffffff; color: #2f3640;"
                "  border: 1px solid #5a6c7d; border-radius: 3px; padding: 2px; }"
                "QSpinBox::up-button { background-color: #dfe6e9; border-left: 1px solid #5a6c7d;"
                "  width: 16px; subcontrol-origin: border; subcontrol-position: top right; }"
                "QSpinBox::down-button { background-color: #dfe6e9; border-left: 1px solid #5a6c7d;"
                "  width: 16px; subcontrol-origin: border; subcontrol-position: bottom right; }"
                "QSpinBox::up-button:hover, QSpinBox::down-button:hover { background-color: #b2bec3; }"
                "QSpinBox::up-arrow { width: 7px; height: 7px; }"
                "QSpinBox::down-arrow { width: 7px; height: 7px; }"
            )
            spin.setToolTip("Signals with the same plot number are overlaid on the same subplot")
            spin.valueChanged.connect(lambda v, c=col: self._on_group_changed(c, v))

            self._group_layout.addWidget(label)
            self._group_layout.addWidget(spin)
            self._group_spinboxes[col] = spin

        self._group_layout.addStretch()

    def _on_group_changed(self, col: str, value: int) -> None:
        self._signal_groups[col] = value
        self._rebuild_plots()

    def _rebuild_plots(self) -> None:
        self.graphics_widget.clear()
        self._plots.clear()
        self._curves.clear()

        if not self._selected_signals or not self.data_manager.is_loaded:
            self.info_label.setVisible(True)
            return
        self.info_label.setVisible(False)

        time = self.data_manager.time_array
        if time is None:
            return

        # Group signals by their plot group number
        from collections import OrderedDict
        groups: OrderedDict[int, list[str]] = OrderedDict()
        for col in self._selected_signals:
            g = self._signal_groups.get(col, 1)
            groups.setdefault(g, []).append(col)

        first_plot: pg.PlotItem | None = None
        color_idx = 0

        for row_idx, (group_num, cols) in enumerate(groups.items()):
            plot = self.graphics_widget.addPlot(row=row_idx, col=0)
            plot.showGrid(x=True, y=True, alpha=0.3)
            plot.setDownsampling(auto=True, mode="peak")
            plot.setClipToView(True)

            if first_plot is None:
                first_plot = plot
                plot.setLabel("bottom", "Time [s]")
            else:
                plot.setXLink(first_plot)
                plot.getAxis("bottom").setStyle(showValues=False)

            # If only one signal in the group, use its label as the Y-axis label
            if len(cols) == 1:
                info = self.data_manager.signals.get(cols[0])
                plot.setLabel("left", info.label() if info else cols[0])
            else:
                plot.addLegend(offset=(30, 10))

            for col in cols:
                data = self.data_manager.get_signal(col)
                if data is None:
                    continue
                info = self.data_manager.signals.get(col)
                label = info.label() if info else col
                color = COLORS[color_idx % len(COLORS)]
                color_idx += 1

                curve = plot.plot(time, data, pen=pg.mkPen(color, width=1.5), name=label)
                self._plots[col] = plot
                self._curves[col] = curve

        # Crosshair on first plot
        if first_plot is not None:
            self._vline = pg.InfiniteLine(angle=90, movable=False, pen=pg.mkPen("gray", width=1, style=Qt.DashLine))
            first_plot.addItem(self._vline, ignoreBounds=True)
            self._proxy = pg.SignalProxy(first_plot.scene().sigMouseMoved, rateLimit=60, slot=self._on_mouse_moved)

    def _on_mouse_moved(self, evt) -> None:
        pos = evt[0]
        first_col = self._selected_signals[0] if self._selected_signals else None
        if first_col is None or first_col not in self._plots:
            return
        plot = self._plots[first_col]
        vb = plot.vb
        if plot.sceneBoundingRect().contains(pos):
            mouse_point = vb.mapSceneToView(pos)
            x = mouse_point.x()
            self._vline.setPos(x)

            parts = [f"t={x:.2f}s"]
            time = self.data_manager.time_array
            if time is not None and len(time) > 0:
                idx = int(np.searchsorted(time, x))
                idx = max(0, min(idx, len(time) - 1))
                for col in self._selected_signals:
                    data = self.data_manager.get_signal(col)
                    if data is not None and idx < len(data):
                        info = self.data_manager.signals.get(col)
                        name = info.name if info else col
                        parts.append(f"{name}={data[idx]:.4f}")
            self.coord_label.setText("  |  ".join(parts))

    @Slot(str)
    def _on_data_changed(self, col: str) -> None:
        if col in self._curves:
            data = self.data_manager.get_signal(col)
            time = self.data_manager.time_array
            if data is not None and time is not None:
                self._curves[col].setData(time, data)
