"""Tests for filter engine: filter correctness, chain, auto-suggest."""

import numpy as np
import pytest

from core.filter_engine import (
    apply_lowpass, apply_highpass, apply_median, apply_savgol,
    apply_moving_average, apply_chain, suggest_filters,
)
from models.filter_model import FilterChain, FilterStep, FilterType


class TestIndividualFilters:
    def test_lowpass_removes_high_freq(self):
        fs = 100.0
        t = np.arange(0, 10, 1 / fs)
        signal = np.sin(2 * np.pi * 1.0 * t) + 0.5 * np.sin(2 * np.pi * 40.0 * t)
        filtered = apply_lowpass(signal, fs, cutoff=5.0, order=4)
        # High-freq component should be attenuated
        assert np.std(filtered) < np.std(signal)

    def test_highpass_removes_low_freq(self):
        fs = 100.0
        t = np.arange(0, 10, 1 / fs)
        signal = np.sin(2 * np.pi * 0.1 * t) + np.sin(2 * np.pi * 20.0 * t)
        filtered = apply_highpass(signal, fs, cutoff=5.0, order=4)
        assert np.std(filtered) < np.std(signal)

    def test_median_removes_spikes(self):
        signal = np.zeros(100)
        signal[50] = 100.0  # spike
        filtered = apply_median(signal, window=5)
        assert filtered[50] < 1.0

    def test_savgol_smooths(self):
        np.random.seed(42)
        signal = np.sin(np.linspace(0, 4 * np.pi, 200)) + np.random.normal(0, 0.3, 200)
        filtered = apply_savgol(signal, window=21, polyorder=3)
        assert np.std(signal - filtered) > 0.1

    def test_moving_average(self):
        signal = np.ones(100)
        signal[50] = 10.0
        filtered = apply_moving_average(signal, window=5)
        assert filtered[50] < 10.0


class TestFilterChain:
    def test_chain_applies_sequentially(self):
        fs = 100.0
        t = np.arange(0, 5, 1 / fs)
        signal = np.sin(2 * np.pi * 1.0 * t) + np.random.normal(0, 0.5, len(t))
        chain = FilterChain(steps=[
            FilterStep(FilterType.LOWPASS, {"cutoff": 5.0, "order": 4}),
            FilterStep(FilterType.SAVGOL, {"window": 21, "polyorder": 3}),
        ])
        filtered = apply_chain(signal, chain, fs)
        assert np.std(filtered) < np.std(signal)

    def test_disabled_steps_skipped(self):
        fs = 100.0
        signal = np.ones(100)
        chain = FilterChain(steps=[
            FilterStep(FilterType.LOWPASS, {"cutoff": 5.0, "order": 4}, enabled=False),
        ])
        filtered = apply_chain(signal, chain, fs)
        np.testing.assert_array_equal(signal, filtered)


class TestAutoSuggest:
    def test_suggest_on_noisy_signal(self):
        np.random.seed(42)
        fs = 10.0
        t = np.arange(0, 100, 1 / fs)
        signal = np.sin(2 * np.pi * 0.1 * t) + np.random.normal(0, 1.0, len(t))
        suggestions = suggest_filters(signal, fs)
        assert len(suggestions) > 0
        types = [s.filter_type for s in suggestions]
        assert FilterType.LOWPASS in types or FilterType.MEDIAN in types
