"""Cache manager for computed results (PSD, stats, correlations, filter suggestions).

Dict-based cache keyed by (signal_name, operation, params_hash).
Invalidation per-signal or global on data reload.
"""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any


def _make_params_hash(params: dict | None) -> str:
    if not params:
        return "default"
    raw = json.dumps(params, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()[:12]


class CacheManager:

    def __init__(self) -> None:
        self._store: dict[tuple[str, str, str], Any] = {}
        self._lock = threading.Lock()

    def make_key(self, signal_name: str, operation: str, params: dict | None = None) -> tuple[str, str, str]:
        return (signal_name, operation, _make_params_hash(params))

    def get(self, key: tuple[str, str, str]) -> Any | None:
        with self._lock:
            return self._store.get(key)

    def set(self, key: tuple[str, str, str], value: Any) -> None:
        with self._lock:
            self._store[key] = value

    def has(self, key: tuple[str, str, str]) -> bool:
        with self._lock:
            return key in self._store

    def invalidate_signal(self, signal_name: str) -> None:
        with self._lock:
            to_remove = [k for k in self._store if k[0] == signal_name]
            for k in to_remove:
                del self._store[k]

    def invalidate_operation(self, operation: str) -> None:
        with self._lock:
            to_remove = [k for k in self._store if k[1] == operation]
            for k in to_remove:
                del self._store[k]

    def invalidate_all(self) -> None:
        with self._lock:
            self._store.clear()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._store)
