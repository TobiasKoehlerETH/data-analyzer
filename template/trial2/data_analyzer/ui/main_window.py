"""Main application window with tabbed workspace, signal tree, and status bar."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QThreadPool, Slot
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from core.csv_parser import parse_csv
from core.data_manager import DataManager
from core.workers import CsvLoadWorker
from ui.signal_selector_widget import SignalSelectorWidget
from ui.file_loader_widget import FileLoaderWidget
from ui.plot_widget import PlotWidget
from ui.filter_widget import FilterWidget
from ui.spectrum_widget import SpectrumWidget
from ui.correlation_widget import CorrelationWidget
from ui.sysid_widget import SysIdWidget
from ui.model_manager_widget import ModelManagerWidget
from ui.simulation_widget import SimulationWidget
from ui.validation_widget import ValidationWidget
from ui.report_widget import ReportWidget
from ui.compare_widget import CompareWidget


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Data Analyzer")
        self.resize(1600, 900)

        self.data_manager = DataManager(self)
        self.thread_pool = QThreadPool.globalInstance()
        self.thread_pool.setMaxThreadCount(4)

        self._setup_statusbar()
        self._setup_menus()
        self.signal_selector = SignalSelectorWidget(self.data_manager)
        self._setup_tabs()
        self._connect_signals()

    def _setup_statusbar(self) -> None:
        self.statusbar = QStatusBar()
        self.setStatusBar(self.statusbar)

        self.progress_bar = QProgressBar()
        self.progress_bar.setFixedWidth(250)
        self.progress_bar.setVisible(False)
        self.statusbar.addPermanentWidget(self.progress_bar)

        self.eta_label = QLabel("")
        self.statusbar.addPermanentWidget(self.eta_label)

        self.status_label = QLabel("Ready")
        self.statusbar.addWidget(self.status_label)

    def _setup_menus(self) -> None:
        menubar = self.menuBar()

        file_menu = menubar.addMenu("&File")
        file_menu.addAction("&Open CSV...", self._open_file, "Ctrl+O")
        file_menu.addSeparator()
        file_menu.addAction("Save &Models...", self._save_models, "Ctrl+S")
        file_menu.addAction("&Load Models...", self._load_models, "Ctrl+L")
        file_menu.addSeparator()
        file_menu.addAction("E&xit", self.close, "Ctrl+Q")

    def _setup_tabs(self) -> None:
        self.tabs = QTabWidget()
        self.tabs.setTabPosition(QTabWidget.North)
        self.tabs.setMovable(True)
        self.setCentralWidget(self.tabs)

        self.file_loader = FileLoaderWidget(self.data_manager, self.thread_pool, self)
        self.plot_widget = PlotWidget(self.data_manager, self.signal_selector, self)
        self.compare_widget = CompareWidget(self)
        self.filter_widget = FilterWidget(self.data_manager, self)
        self.spectrum_widget = SpectrumWidget(self.data_manager, self)
        self.correlation_widget = CorrelationWidget(self.data_manager, self.thread_pool, self)
        self.sysid_widget = SysIdWidget(self.data_manager, self.thread_pool, self)
        self.model_manager_widget = ModelManagerWidget(self.data_manager, self)
        self.simulation_widget = SimulationWidget(self.data_manager, self.model_manager_widget, self)
        self.validation_widget = ValidationWidget(self.data_manager, self.model_manager_widget, self)
        self.report_widget = ReportWidget(self.data_manager, self.model_manager_widget, self.thread_pool, self)

        self.tabs.addTab(self.file_loader, "📂 File")
        self.tabs.addTab(self.plot_widget, "📈 Time Series")
        self.tabs.addTab(self.compare_widget, "⚖ Compare")
        self.tabs.addTab(self.filter_widget, "🔧 Filtering")
        self.tabs.addTab(self.spectrum_widget, "📊 Spectrum")
        self.tabs.addTab(self.correlation_widget, "🔗 Correlations")
        self.tabs.addTab(self.sysid_widget, "🧮 System ID")
        self.tabs.addTab(self.model_manager_widget, "📋 Models")
        self.tabs.addTab(self.simulation_widget, "▶ Simulation")
        self.tabs.addTab(self.validation_widget, "✓ Validation")
        self.tabs.addTab(self.report_widget, "📄 Reports")

    def _connect_signals(self) -> None:
        self.data_manager.data_loaded.connect(self._on_data_loaded)

    def _open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Open CSV File", "", "CSV Files (*.csv *.txt *.tsv);;All Files (*)"
        )
        if path:
            self.file_loader.load_file(path)
            self.tabs.setCurrentWidget(self.file_loader)

    def _save_models(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "Save Model Library", "", "JSON Files (*.json);;All Files (*)"
        )
        if path:
            self.model_manager_widget.save_library(path)
            self.statusbar.showMessage(f"Models saved to {path}", 3000)

    def _load_models(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Load Model Library", "", "JSON Files (*.json);;All Files (*)"
        )
        if path:
            self.model_manager_widget.load_library(path)
            self.statusbar.showMessage(f"Models loaded from {path}", 3000)

    @Slot()
    def _on_data_loaded(self) -> None:
        n = self.data_manager.n_samples
        ns = len(self.data_manager.signals)
        fs = self.data_manager.sample_rate
        self.status_label.setText(f"Loaded: {n:,} samples, {ns} signals, {fs:.2f} Hz")

    def show_progress(self, value: int, eta_text: str = "") -> None:
        self.progress_bar.setVisible(value < 100)
        self.progress_bar.setValue(value)
        self.eta_label.setText(eta_text)
        if value >= 100:
            self.eta_label.setText("")

    def show_status(self, text: str, timeout: int = 3000) -> None:
        self.statusbar.showMessage(text, timeout)
