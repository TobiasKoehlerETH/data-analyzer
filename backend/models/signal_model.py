"""Signal metadata dataclass."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SignalMetadata:
    name: str
    unit: str
    group: str
    column: str
    index: int

    def label(self) -> str:
        if self.unit:
            return f"{self.name} [{self.unit}]"
        return self.name
