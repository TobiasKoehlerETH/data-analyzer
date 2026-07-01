"""Spectrum visualization: FFT/PSD with interactive cutoff lines and peak annotations."""

from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.spectrum_engine import compute_fft, compute_psd, detect_peaks


class SpectrumWidget(QWidget):
    def __init__(self, data_manager: DataManager, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self._peak_items: list = []
        self._setup_ui()
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # Controls
        ctrl = QHBoxLayout()
        ctrl.addWidget(QLabel("Signal:"))
        self.signal_combo = QComboBox()
        self.signal_combo.setToolTip("Select the signal to compute the frequency spectrum for")
        self.signal_combo.currentTextChanged.connect(self._update_plots)
        ctrl.addWidget(self.signal_combo, stretch=1)

        ctrl.addWidget(QLabel("PSD nperseg:"))
        self.nperseg_spin = QSpinBox()
        self.nperseg_spin.setToolTip("Number of samples per Welch segment. Higher = smoother PSD, lower = more detail")
        self.nperseg_spin.setRange(64, 65536)
        self.nperseg_spin.setValue(4096)
        self.nperseg_spin.setSingleStep(256)
        self.nperseg_spin.valueChanged.connect(self._update_plots)
        ctrl.addWidget(self.nperseg_spin)
        layout.addLayout(ctrl)

        # FFT plot
        self.fft_plot = pg.PlotWidget(background="w", title="FFT Magnitude Spectrum")
        self.fft_plot.setLabel("left", "Magnitude")
        self.fft_plot.setLabel("bottom", "Frequency [Hz]")
        self.fft_plot.showGrid(x=True, y=True, alpha=0.3)
        self.fft_plot.setLogMode(x=False, y=True)
        self._fft_curve = self.fft_plot.plot([], [], pen=pg.mkPen("#1f77b4", width=1))
        layout.addWidget(self.fft_plot)

        # PSD plot
        self.psd_plot = pg.PlotWidget(background="w", title="Power Spectral Density (Welch)")
        self.psd_plot.setLabel("left", "PSD")
        self.psd_plot.setLabel("bottom", "Frequency [Hz]")
        self.psd_plot.showGrid(x=True, y=True, alpha=0.3)
        self.psd_plot.setLogMode(x=False, y=True)
        self._psd_original = self.psd_plot.plot([], [], pen=pg.mkPen("#1f77b4", width=1.5), name="Original")
        self._psd_filtered = self.psd_plot.plot([], [], pen=pg.mkPen("#d62728", width=1.5, style=Qt.DashLine), name="Filtered")
        self.psd_plot.addLegend()
        layout.addWidget(self.psd_plot)

        # Draggable cutoff line
        self.cutoff_line = pg.InfiniteLine(
            pos=0.1, angle=90, movable=True,
            pen=pg.mkPen("#ff7f0e", width=2, style=Qt.DashLine),
            label="Cutoff={value:.4f} Hz",
            labelOpts={"position": 0.9, "color": "#ff7f0e"},
        )
        self.cutoff_line.setToolTip("Drag to set the cutoff frequency for filtering")
        self.psd_plot.addItem(self.cutoff_line)
        self.cutoff_line.sigPositionChangeFinished.connect(self._on_cutoff_changed)

        # Info label
        self.info_label = QLabel("")
        layout.addWidget(self.info_label)

    @Slot()
    def _on_data_loaded(self) -> None:
        self.signal_combo.clear()
        for col in self.data_manager.get_numeric_columns():
            info = self.data_manager.signals.get(col)
            label = info.label() if info else col
            self.signal_combo.addItem(label, col)

    @Slot()
    def _update_plots(self) -> None:
        col = self.signal_combo.currentData()
        if not col or not self.data_manager.is_loaded:
            return

        raw = self.data_manager.get_raw_signal(col)
        if raw is None:
            return

        fs = self.data_manager.sample_rate
        nperseg = self.nperseg_spin.value()
        cache = self.data_manager.cache

        # FFT
        fft_result = compute_fft(raw, fs, cache=cache, signal_name=col)
        self._fft_curve.setData(fft_result.freqs[1:], fft_result.magnitude[1:])

        # PSD original
        psd_result = compute_psd(raw, fs, nperseg=nperseg, cache=cache, signal_name=col)
        self._psd_original.setData(psd_result.freqs[1:], psd_result.psd[1:])

        # PSD filtered (if exists)
        filtered = self.data_manager.get_signal(col, filtered=True)
        if self.data_manager.has_filtered(col) and filtered is not None:
            psd_filt = compute_psd(filtered, fs, nperseg=nperseg, signal_name="")
            self._psd_filtered.setData(psd_filt.freqs[1:], psd_filt.psd[1:])
        else:
            self._psd_filtered.setData([], [])

        # Peak annotations
        for item in self._peak_items:
            self.fft_plot.removeItem(item)
        self._peak_items.clear()

        peaks = detect_peaks(psd_result, prominence_factor=8.0)
        for peak in peaks[:5]:
            vline = pg.InfiniteLine(
                pos=peak.frequency, angle=90, movable=False,
                pen=pg.mkPen("#2ca02c", width=1, style=Qt.DotLine),
                label=f"{peak.frequency:.4f} Hz",
                labelOpts={"position": 0.85, "color": "#2ca02c"},
            )
            self.fft_plot.addItem(vline)
            self._peak_items.append(vline)

        n_peaks = len(peaks)
        self.info_label.setText(f"Detected {n_peaks} significant frequency peaks. Drag orange line to set cutoff.")

    @Slot()
    def _on_cutoff_changed(self) -> None:
        freq = self.cutoff_line.value()
        self.info_label.setText(f"Cutoff frequency: {freq:.4f} Hz")
