"""State-space identification result dataclass."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class OutputMetrics:
    name: str
    rmse: float = 0.0
    nrmse: float = 0.0
    mae: float = 0.0
    r_squared: float = 0.0
    vaf: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "rmse": self.rmse,
            "nrmse": self.nrmse,
            "mae": self.mae,
            "r_squared": self.r_squared,
            "vaf": self.vaf,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OutputMetrics:
        return cls(**data)


@dataclass
class StateSpaceResult:
    name: str
    A: np.ndarray
    B: np.ndarray
    C: np.ndarray
    D: np.ndarray
    input_names: list[str]
    output_names: list[str]
    method: str = "N4SID"
    order: int = 0
    decimation_factor: int = 1
    dt: float = 1.0
    metrics: list[OutputMetrics] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    @property
    def n_inputs(self) -> int:
        return len(self.input_names)

    @property
    def n_outputs(self) -> int:
        return len(self.output_names)

    @property
    def best_vaf(self) -> float:
        if not self.metrics:
            return 0.0
        return max(m.vaf for m in self.metrics)

    @property
    def mean_vaf(self) -> float:
        if not self.metrics:
            return 0.0
        return float(np.mean([m.vaf for m in self.metrics]))

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "A": self.A.tolist(),
            "B": self.B.tolist(),
            "C": self.C.tolist(),
            "D": self.D.tolist(),
            "input_names": self.input_names,
            "output_names": self.output_names,
            "method": self.method,
            "order": self.order,
            "decimation_factor": self.decimation_factor,
            "dt": self.dt,
            "metrics": [m.to_dict() for m in self.metrics],
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StateSpaceResult:
        return cls(
            name=data["name"],
            A=np.array(data["A"]),
            B=np.array(data["B"]),
            C=np.array(data["C"]),
            D=np.array(data["D"]),
            input_names=data["input_names"],
            output_names=data["output_names"],
            method=data.get("method", "N4SID"),
            order=data.get("order", 0),
            decimation_factor=data.get("decimation_factor", 1),
            dt=data.get("dt", 1.0),
            metrics=[OutputMetrics.from_dict(m) for m in data.get("metrics", [])],
            timestamp=data.get("timestamp", ""),
        )

    def save_json(self, path: str | Path) -> None:
        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load_json(cls, path: str | Path) -> StateSpaceResult:
        with open(path, "r") as f:
            data = json.load(f)
        return cls.from_dict(data)
