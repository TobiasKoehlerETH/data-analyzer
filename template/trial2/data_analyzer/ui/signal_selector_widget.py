"""Signal selector tree widget with grouped signals, checkboxes, and search."""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal, Slot
from PySide6.QtWidgets import (
    QHeaderView,
    QLineEdit,
    QPushButton,
    QHBoxLayout,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.data_manager import DataManager


class SignalSelectorWidget(QWidget):
    signals_selected = Signal(list)  # list of column names

    def __init__(self, data_manager: DataManager, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.data_manager = data_manager
        self._group_items: dict[str, QTreeWidgetItem] = {}
        self._signal_items: dict[str, QTreeWidgetItem] = {}
        self._setup_ui()
        self.data_manager.data_loaded.connect(self._populate)

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)

        # Search box
        self.search_box = QLineEdit()
        self.search_box.setPlaceholderText("Search signals...")
        self.search_box.setToolTip("Type to filter signals by name")
        self.search_box.textChanged.connect(self._filter_tree)
        layout.addWidget(self.search_box)

        # Buttons
        btn_row = QHBoxLayout()
        self.select_all_btn = QPushButton("All")
        self.select_all_btn.setToolTip("Select all visible signals for plotting")
        self.select_all_btn.clicked.connect(self._select_all)
        btn_row.addWidget(self.select_all_btn)

        self.select_none_btn = QPushButton("None")
        self.select_none_btn.setToolTip("Deselect all signals")
        self.select_none_btn.clicked.connect(self._select_none)
        btn_row.addWidget(self.select_none_btn)
        layout.addLayout(btn_row)

        # Tree
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Signal", "Unit"])
        self.tree.header().setSectionResizeMode(0, QHeaderView.Stretch)
        self.tree.header().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.tree.itemChanged.connect(self._on_item_changed)
        layout.addWidget(self.tree)

        self.count_label = QPushButton("0 selected")
        self.count_label.setFlat(True)
        self.count_label.setEnabled(False)
        layout.addWidget(self.count_label)

    @Slot()
    def _populate(self) -> None:
        self.tree.blockSignals(True)
        self.tree.clear()
        self._group_items.clear()
        self._signal_items.clear()

        groups = self.data_manager.get_signals_by_group()
        for group_name in sorted(groups.keys()):
            group_item = QTreeWidgetItem(self.tree, [group_name, ""])
            group_item.setFlags(group_item.flags() | Qt.ItemIsUserCheckable | Qt.ItemIsAutoTristate)
            group_item.setCheckState(0, Qt.Unchecked)
            group_item.setExpanded(True)
            self._group_items[group_name] = group_item

            for info in sorted(groups[group_name], key=lambda s: s.name):
                child = QTreeWidgetItem(group_item, [info.name, info.unit])
                child.setFlags(child.flags() | Qt.ItemIsUserCheckable)
                child.setCheckState(0, Qt.Unchecked)
                child.setData(0, Qt.UserRole, info.column)
                self._signal_items[info.column] = child

        self.tree.blockSignals(False)
        self._update_count()

    @Slot()
    def _on_item_changed(self, item: QTreeWidgetItem, column: int) -> None:
        self._update_count()
        self.signals_selected.emit(self.get_selected_columns())

    def get_selected_columns(self) -> list[str]:
        selected = []
        for col, item in self._signal_items.items():
            if item.checkState(0) == Qt.Checked:
                selected.append(col)
        return selected

    def _update_count(self) -> None:
        n = len(self.get_selected_columns())
        self.count_label.setText(f"{n} selected")

    @Slot()
    def _select_all(self) -> None:
        self.tree.blockSignals(True)
        for item in self._signal_items.values():
            if not item.isHidden():
                item.setCheckState(0, Qt.Checked)
        self.tree.blockSignals(False)
        self._on_item_changed(None, 0)

    @Slot()
    def _select_none(self) -> None:
        self.tree.blockSignals(True)
        for item in self._signal_items.values():
            item.setCheckState(0, Qt.Unchecked)
        self.tree.blockSignals(False)
        self._on_item_changed(None, 0)

    @Slot(str)
    def _filter_tree(self, text: str) -> None:
        text_lower = text.lower()
        for col, item in self._signal_items.items():
            match = text_lower in col.lower() if text_lower else True
            item.setHidden(not match)

        for group_name, group_item in self._group_items.items():
            any_visible = False
            for i in range(group_item.childCount()):
                if not group_item.child(i).isHidden():
                    any_visible = True
                    break
            group_item.setHidden(not any_visible)
