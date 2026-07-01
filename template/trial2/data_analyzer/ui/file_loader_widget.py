"""File loader widget with CSV preview, metadata display, and background loading."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QThreadPool, Slot
from PySide6.QtWidgets import (
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager
from core.workers import CsvLoadWorker


class FileLoaderWidget(QWidget):
    def __init__(self, data_manager: DataManager, thread_pool: QThreadPool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.thread_pool = thread_pool
        self._current_path: str | None = None
        self._setup_ui()

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # File selection row
        file_row = QHBoxLayout()
        self.path_label = QLabel("No file selected")
        self.path_label.setStyleSheet("font-weight: bold; padding: 4px;")
        file_row.addWidget(self.path_label, stretch=1)

        self.browse_btn = QPushButton("Browse...")
        self.browse_btn.setToolTip("Browse for a CSV, TSV, or TXT data file to load")
        self.browse_btn.clicked.connect(self._browse)
        file_row.addWidget(self.browse_btn)

        self.load_btn = QPushButton("Load File")
        self.load_btn.setToolTip("Parse and load the selected file into memory for analysis")
        self.load_btn.setEnabled(False)
        self.load_btn.clicked.connect(self._do_load)
        file_row.addWidget(self.load_btn)
        layout.addLayout(file_row)

        # Splitter: preview table + metadata
        splitter = QSplitter(Qt.Vertical)

        # CSV preview table
        preview_group = QGroupBox("CSV Preview (first 100 rows)")
        preview_layout = QVBoxLayout(preview_group)
        self.preview_table = QTableWidget()
        self.preview_table.setToolTip("Preview of the first 100 rows of the selected CSV file")
        self.preview_table.setAlternatingRowColors(True)
        self.preview_table.setEditTriggers(QTableWidget.NoEditTriggers)
        preview_layout.addWidget(self.preview_table)
        splitter.addWidget(preview_group)

        # Metadata display
        meta_group = QGroupBox("Detected Metadata")
        meta_layout = QVBoxLayout(meta_group)
        self.meta_text = QTextEdit()
        self.meta_text.setReadOnly(True)
        self.meta_text.setMaximumHeight(200)
        meta_layout.addWidget(self.meta_text)
        splitter.addWidget(meta_group)

        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        layout.addWidget(splitter)

        # Status
        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

    def _browse(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Open CSV File", "", "CSV Files (*.csv *.txt *.tsv);;All Files (*)"
        )
        if path:
            self._current_path = path
            self.path_label.setText(path)
            self.load_btn.setEnabled(True)
            self._preview_file(path)

    def _preview_file(self, path: str) -> None:
        try:
            from core.csv_parser import detect_encoding, _read_head_lines, _detect_raser_format, _detect_delimiter, _find_header_row
            import pandas as pd

            encoding = detect_encoding(path)
            head_lines = _read_head_lines(path, encoding, n=40)
            is_raser, metadata = _detect_raser_format(head_lines)
            delimiter = _detect_delimiter(head_lines, is_raser, head_lines)
            header_row = _find_header_row(head_lines, delimiter)

            df = pd.read_csv(
                path, sep=delimiter, header=header_row,
                encoding=encoding, nrows=100, on_bad_lines="warn",
            )
            df = df.dropna(axis=1, how="all")

            # Fill preview table
            self.preview_table.setRowCount(len(df))
            self.preview_table.setColumnCount(len(df.columns))
            self.preview_table.setHorizontalHeaderLabels([str(c).strip() for c in df.columns])

            for r in range(len(df)):
                for c in range(len(df.columns)):
                    val = df.iloc[r, c]
                    item = QTableWidgetItem(str(val) if not pd.isna(val) else "")
                    self.preview_table.setItem(r, c, item)

            self.preview_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)

            # Fill metadata
            meta_lines = []
            if is_raser:
                meta_lines.append("Format: Raser DataLog")
            meta_lines.append(f"Encoding: {encoding}")
            meta_lines.append(f"Delimiter: '{delimiter}'")
            meta_lines.append(f"Header row: {header_row}")
            meta_lines.append(f"Columns: {len(df.columns)}")
            for k, v in metadata.items():
                meta_lines.append(f"{k}: {v}")
            self.meta_text.setPlainText("\n".join(meta_lines))

            self.status_label.setText(f"Preview loaded. Click 'Load File' to load all data.")
        except Exception as e:
            self.status_label.setText(f"Preview error: {e}")

    def load_file(self, path: str) -> None:
        self._current_path = path
        self.path_label.setText(path)
        self.load_btn.setEnabled(True)
        self._preview_file(path)
        self._do_load()

    def _do_load(self) -> None:
        if not self._current_path:
            return
        self.load_btn.setEnabled(False)
        self.status_label.setText("Loading...")

        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(10, "Loading CSV...")

        worker = CsvLoadWorker(self._current_path, self.data_manager)
        worker.signals.progress.connect(self._on_progress)
        worker.signals.finished.connect(self._on_loaded)
        worker.signals.error.connect(self._on_error)
        self.thread_pool.start(worker)

    @Slot(int, str)
    def _on_progress(self, value: int, msg: str) -> None:
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(value, msg)
        self.status_label.setText(msg)

    @Slot()
    def _on_loaded(self) -> None:
        n = self.data_manager.n_samples
        ns = len(self.data_manager.signals)
        self.status_label.setText(f"Loaded {n:,} samples, {ns} signals.")
        self.load_btn.setEnabled(True)
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")

    @Slot(str)
    def _on_error(self, msg: str) -> None:
        self.status_label.setText(f"Error: {msg}")
        self.load_btn.setEnabled(True)
        main_win = self.window()
        if hasattr(main_win, "show_progress"):
            main_win.show_progress(100, "")
        QMessageBox.critical(self, "Load Error", msg)
