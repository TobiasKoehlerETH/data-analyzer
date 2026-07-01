"""Tests for spectrum engine: FFT, PSD, peak detection."""

import numpy as np
import pytest

from core.spectrum_engine import compute_fft, compute_psd, detect_peaks


class TestFFT:
    def test_single_frequency(self):
        fs = 100.0
        t = np.arange(0, 10, 1 / fs)
        signal = np.sin(2 * np.pi * 5.0 * t)
        result = compute_fft(signal, fs)
        peak_idx = np.argmax(result.magnitude[1:]) + 1
        peak_freq = result.freqs[peak_idx]
        assert abs(peak_freq - 5.0) < 0.5


class TestPSD:
    def test_psd_shape(self):
        signal = np.random.randn(1000)
        result = compute_psd(signal, fs=10.0)
        assert len(result.freqs) == len(result.psd)
        assert len(result.freqs) > 0


class TestPeakDetection:
    def test_detect_sinusoid_peak(self):
        fs = 100.0
        t = np.arange(0, 10, 1 / fs)
        signal = np.sin(2 * np.pi * 10.0 * t) + 0.1 * np.random.randn(len(t))
        psd = compute_psd(signal, fs)
        peaks = detect_peaks(psd, prominence_factor=3.0)
        assert len(peaks) > 0
        assert abs(peaks[0].frequency - 10.0) < 2.0
