"""Filter dataclasses: FilterStep, FilterChain, FilterSuggestion."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class FilterType(Enum):
    LOWPASS = "lowpass"
    HIGHPASS = "highpass"
    BANDPASS = "bandpass"
    BANDSTOP = "bandstop"
    SAVGOL = "savgol"
    MOVING_AVERAGE = "moving_average"
    EXP_MOVING_AVERAGE = "exp_moving_average"
    MEDIAN = "median"
    NOTCH = "notch"


@dataclass
class FilterStep:
    filter_type: FilterType
    params: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "filter_type": self.filter_type.value,
            "params": self.params,
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FilterStep:
        return cls(
            filter_type=FilterType(data["filter_type"]),
            params=data.get("params", {}),
            enabled=data.get("enabled", True),
        )

    def describe(self) -> str:
        ft = self.filter_type.value.replace("_", " ").title()
        parts = [ft]
        if "cutoff" in self.params:
            parts.append(f"fc={self.params['cutoff']:.4f} Hz")
        if "order" in self.params:
            parts.append(f"order={self.params['order']}")
        if "window" in self.params:
            parts.append(f"win={self.params['window']}")
        if "freq" in self.params:
            parts.append(f"f0={self.params['freq']:.4f} Hz")
        return ", ".join(parts)


@dataclass
class FilterChain:
    steps: list[FilterStep] = field(default_factory=list)

    def add(self, step: FilterStep) -> None:
        self.steps.append(step)

    def remove(self, index: int) -> None:
        if 0 <= index < len(self.steps):
            self.steps.pop(index)

    def move(self, from_idx: int, to_idx: int) -> None:
        if 0 <= from_idx < len(self.steps) and 0 <= to_idx < len(self.steps):
            step = self.steps.pop(from_idx)
            self.steps.insert(to_idx, step)

    def enabled_steps(self) -> list[FilterStep]:
        return [s for s in self.steps if s.enabled]

    def to_dict(self) -> dict[str, Any]:
        return {"steps": [s.to_dict() for s in self.steps]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FilterChain:
        steps = [FilterStep.from_dict(s) for s in data.get("steps", [])]
        return cls(steps=steps)

    def save_json(self, path: str | Path) -> None:
        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load_json(cls, path: str | Path) -> FilterChain:
        with open(path, "r") as f:
            data = json.load(f)
        return cls.from_dict(data)


@dataclass
class FilterSuggestion:
    filter_type: FilterType
    params: dict[str, Any]
    reason: str
    estimated_improvement: float = 0.0

    def to_step(self) -> FilterStep:
        return FilterStep(filter_type=self.filter_type, params=self.params)
