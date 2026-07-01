"""Model library: CRUD, JSON persistence, comparison helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, Signal

from models.sysid_model import StateSpaceResult


class ModelManager(QObject):
    model_added = Signal(str)
    model_removed = Signal(str)
    models_changed = Signal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._models: dict[str, StateSpaceResult] = {}

    @property
    def models(self) -> dict[str, StateSpaceResult]:
        return self._models

    @property
    def model_names(self) -> list[str]:
        return list(self._models.keys())

    def add(self, model: StateSpaceResult) -> None:
        name = model.name
        if name in self._models:
            base = name
            i = 2
            while name in self._models:
                name = f"{base}_{i}"
                i += 1
            model.name = name
        self._models[name] = model
        self.model_added.emit(name)
        self.models_changed.emit()

    def get(self, name: str) -> StateSpaceResult | None:
        return self._models.get(name)

    def remove(self, name: str) -> None:
        if name in self._models:
            del self._models[name]
            self.model_removed.emit(name)
            self.models_changed.emit()

    def rename(self, old_name: str, new_name: str) -> bool:
        if old_name not in self._models or new_name in self._models:
            return False
        model = self._models.pop(old_name)
        model.name = new_name
        self._models[new_name] = model
        self.models_changed.emit()
        return True

    def duplicate(self, name: str) -> StateSpaceResult | None:
        original = self._models.get(name)
        if original is None:
            return None
        data = original.to_dict()
        data["name"] = f"{name}_copy"
        copy = StateSpaceResult.from_dict(data)
        self.add(copy)
        return copy

    def clear(self) -> None:
        self._models.clear()
        self.models_changed.emit()

    def save_library(self, path: str | Path) -> None:
        data = {"models": [m.to_dict() for m in self._models.values()]}
        with open(path, "w") as f:
            json.dump(data, f, indent=2)

    def load_library(self, path: str | Path) -> None:
        with open(path, "r") as f:
            data = json.load(f)
        self._models.clear()
        for md in data.get("models", []):
            model = StateSpaceResult.from_dict(md)
            self._models[model.name] = model
        self.models_changed.emit()

    def compare(self, names: list[str]) -> list[dict[str, Any]]:
        rows = []
        for name in names:
            model = self._models.get(name)
            if model is None:
                continue
            row = {
                "Name": model.name,
                "Method": model.method,
                "Order": model.order,
                "Inputs": model.n_inputs,
                "Outputs": model.n_outputs,
                "Decimation": model.decimation_factor,
                "Mean VAF": f"{model.mean_vaf:.2f}%",
                "Best VAF": f"{model.best_vaf:.2f}%",
            }
            for m in model.metrics:
                row[f"RMSE_{m.name}"] = f"{m.rmse:.4f}"
                row[f"R²_{m.name}"] = f"{m.r_squared:.4f}"
            rows.append(row)
        return rows
