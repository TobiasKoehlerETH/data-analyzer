"""Model manager widget: table of saved models, CRUD, compare, JSON persistence."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

import numpy as np
from core.data_manager import DataManager
from core.model_manager import ModelManager


class ModelManagerWidget(QWidget):
    def __init__(self, data_manager: DataManager, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self.manager = ModelManager(self)
        self._setup_ui()
        self.manager.models_changed.connect(self._refresh_table)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)

        # Buttons
        btn_row = QHBoxLayout()
        self.dup_btn = QPushButton("Duplicate")
        self.dup_btn.setToolTip("Create a copy of the selected model(s)")
        self.dup_btn.clicked.connect(self._duplicate)
        btn_row.addWidget(self.dup_btn)

        self.rename_btn = QPushButton("Rename")
        self.rename_btn.setToolTip("Rename the selected model")
        self.rename_btn.clicked.connect(self._rename)
        btn_row.addWidget(self.rename_btn)

        self.delete_btn = QPushButton("Delete")
        self.delete_btn.setToolTip("Delete the selected model(s) from the library")
        self.delete_btn.clicked.connect(self._delete)
        btn_row.addWidget(self.delete_btn)

        self.compare_btn = QPushButton("Compare Selected")
        self.compare_btn.setToolTip("Compare metrics of two or more selected models side by side")
        self.compare_btn.clicked.connect(self._compare)
        btn_row.addWidget(self.compare_btn)

        btn_row.addStretch()

        self.save_btn = QPushButton("Save Library")
        self.save_btn.setToolTip("Save all models to a JSON file")
        self.save_btn.clicked.connect(lambda: self.save_library())
        btn_row.addWidget(self.save_btn)

        self.load_btn = QPushButton("Load Library")
        self.load_btn.setToolTip("Load models from a previously saved JSON file")
        self.load_btn.clicked.connect(lambda: self.load_library())
        btn_row.addWidget(self.load_btn)

        layout.addLayout(btn_row)

        splitter = QSplitter(Qt.Vertical)

        # Table
        self.table = QTableWidget()
        self.table.setToolTip("Double-click a model to view and edit its state-space matrices")
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels([
            "Name", "Method", "Order", "Inputs", "Outputs", "Decimation", "Mean VAF%", "Timestamp"
        ])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.doubleClicked.connect(self._on_double_click)
        splitter.addWidget(self.table)

        # Details
        dg = QGroupBox("Model Details")
        dg_layout = QVBoxLayout(dg)

        # Text area for comparison output
        self.details_text = QTextEdit()
        self.details_text.setReadOnly(True)
        self.details_text.setMaximumHeight(120)
        self.details_text.setVisible(False)
        dg_layout.addWidget(self.details_text)

        # Scrollable matrix editing area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        scroll_layout.setContentsMargins(4, 4, 4, 4)

        self.model_info_label = QLabel("Double-click a model to view and edit its matrices.")
        self.model_info_label.setWordWrap(True)
        self.model_info_label.setStyleSheet(
            "background-color: #eaf2f8; color: #2f3640; padding: 8px; border-radius: 3px;"
        )
        scroll_layout.addWidget(self.model_info_label)

        self._matrix_tables: dict[str, QTableWidget] = {}
        self._matrix_labels: dict[str, QLabel] = {}
        for mname in ["A", "B", "C", "D"]:
            lbl = QLabel(f"Matrix {mname}:")
            lbl.setStyleSheet("font-weight: bold; margin-top: 6px; color: #1a5276; font-size: 13px;")
            lbl.setVisible(False)
            scroll_layout.addWidget(lbl)
            self._matrix_labels[mname] = lbl

            mtable = QTableWidget()
            mtable.setAlternatingRowColors(True)
            mtable.setVisible(False)
            mtable.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
            scroll_layout.addWidget(mtable)
            self._matrix_tables[mname] = mtable

        save_row = QHBoxLayout()
        save_row.addStretch()
        self.save_matrices_btn = QPushButton("Save Changes")
        self.save_matrices_btn.setToolTip("Save edited matrix values back to the model in the library")
        self.save_matrices_btn.setStyleSheet(
            "QPushButton { background-color: #27ae60; color: white; font-weight: bold; padding: 8px 16px; }"
            "QPushButton:hover { background-color: #219a52; }"
        )
        self.save_matrices_btn.setVisible(False)
        self.save_matrices_btn.clicked.connect(self._save_matrices)
        save_row.addWidget(self.save_matrices_btn)
        scroll_layout.addLayout(save_row)

        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        dg_layout.addWidget(scroll)
        splitter.addWidget(dg)

        self._editing_model_name: str | None = None

        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 1)
        layout.addWidget(splitter)

    @Slot()
    def _refresh_table(self) -> None:
        models = self.manager.models
        self.table.setRowCount(len(models))
        for i, (name, model) in enumerate(models.items()):
            self.table.setItem(i, 0, QTableWidgetItem(model.name))
            self.table.setItem(i, 1, QTableWidgetItem(model.method))
            self.table.setItem(i, 2, QTableWidgetItem(str(model.order)))
            self.table.setItem(i, 3, QTableWidgetItem(str(model.n_inputs)))
            self.table.setItem(i, 4, QTableWidgetItem(str(model.n_outputs)))
            self.table.setItem(i, 5, QTableWidgetItem(str(model.decimation_factor)))
            self.table.setItem(i, 6, QTableWidgetItem(f"{model.mean_vaf:.2f}"))
            self.table.setItem(i, 7, QTableWidgetItem(model.timestamp[:19]))

    def _get_selected_names(self) -> list[str]:
        rows = set(idx.row() for idx in self.table.selectedIndexes())
        names = []
        for row in sorted(rows):
            item = self.table.item(row, 0)
            if item:
                names.append(item.text())
        return names

    @Slot()
    def _duplicate(self) -> None:
        names = self._get_selected_names()
        for name in names:
            self.manager.duplicate(name)

    @Slot()
    def _rename(self) -> None:
        names = self._get_selected_names()
        if len(names) != 1:
            QMessageBox.information(self, "Rename", "Select exactly one model to rename.")
            return
        new_name, ok = QInputDialog.getText(self, "Rename Model", "New name:", text=names[0])
        if ok and new_name:
            if not self.manager.rename(names[0], new_name):
                QMessageBox.warning(self, "Rename Failed", "Name already exists.")

    @Slot()
    def _delete(self) -> None:
        names = self._get_selected_names()
        if not names:
            return
        reply = QMessageBox.question(
            self, "Delete Models", f"Delete {len(names)} model(s)?",
            QMessageBox.Yes | QMessageBox.No
        )
        if reply == QMessageBox.Yes:
            for name in names:
                self.manager.remove(name)

    @Slot()
    def _compare(self) -> None:
        names = self._get_selected_names()
        if len(names) < 2:
            QMessageBox.information(self, "Compare", "Select at least 2 models to compare.")
            return
        rows = self.manager.compare(names)
        lines = []
        for row in rows:
            lines.append(" | ".join(f"{k}: {v}" for k, v in row.items()))
        self.details_text.setPlainText("\n\n".join(lines))
        self.details_text.setVisible(True)

    def _fill_matrix_table(self, table: QTableWidget, matrix: np.ndarray) -> None:
        rows, cols = matrix.shape
        table.setRowCount(rows)
        table.setColumnCount(cols)
        for r in range(rows):
            for c in range(cols):
                item = QTableWidgetItem(f"{matrix[r, c]:.6g}")
                table.setItem(r, c, item)
        table.setVisible(True)

    def _read_matrix_table(self, table: QTableWidget) -> np.ndarray:
        rows = table.rowCount()
        cols = table.columnCount()
        matrix = np.zeros((rows, cols))
        for r in range(rows):
            for c in range(cols):
                item = table.item(r, c)
                try:
                    matrix[r, c] = float(item.text()) if item else 0.0
                except ValueError:
                    matrix[r, c] = 0.0
        return matrix

    @Slot()
    def _on_double_click(self) -> None:
        names = self._get_selected_names()
        if not names:
            return
        model = self.manager.get(names[0])
        if model is None:
            return

        self._editing_model_name = names[0]
        self.details_text.setVisible(False)

        info_lines = [
            f"<b>Name:</b> {model.name} &nbsp; <b>Method:</b> {model.method} &nbsp; "
            f"<b>Order:</b> {model.order} &nbsp; <b>dt:</b> {model.dt:.4f}s",
            f"<b>Inputs:</b> {', '.join(model.input_names)}",
            f"<b>Outputs:</b> {', '.join(model.output_names)}",
        ]
        if model.metrics:
            info_lines.append("<b>Metrics:</b> " + " | ".join(
                f"{m.name}: VAF={m.vaf:.2f}%" for m in model.metrics
            ))
        self.model_info_label.setText("<br>".join(info_lines))

        for mname, mat in [("A", model.A), ("B", model.B), ("C", model.C), ("D", model.D)]:
            self._matrix_labels[mname].setText(f"Matrix {mname} ({mat.shape[0]}\u00d7{mat.shape[1]}):")
            self._matrix_labels[mname].setVisible(True)
            self._fill_matrix_table(self._matrix_tables[mname], mat)

        self.save_matrices_btn.setVisible(True)

    @Slot()
    def _save_matrices(self) -> None:
        if self._editing_model_name is None:
            return
        model = self.manager.get(self._editing_model_name)
        if model is None:
            QMessageBox.warning(self, "Save Failed", "Model no longer exists.")
            return

        model.A = self._read_matrix_table(self._matrix_tables["A"])
        model.B = self._read_matrix_table(self._matrix_tables["B"])
        model.C = self._read_matrix_table(self._matrix_tables["C"])
        model.D = self._read_matrix_table(self._matrix_tables["D"])
        self.manager.models_changed.emit()
        QMessageBox.information(self, "Saved", f"Matrices for '{self._editing_model_name}' updated.")

    def save_library(self, path: str | None = None) -> None:
        if path is None:
            path, _ = QFileDialog.getSaveFileName(self, "Save Model Library", "", "JSON (*.json)")
        if path:
            self.manager.save_library(path)

    def load_library(self, path: str | None = None) -> None:
        if path is None:
            path, _ = QFileDialog.getOpenFileName(self, "Load Model Library", "", "JSON (*.json)")
        if path:
            self.manager.load_library(path)
