"""Background workers for heavy computations. All use QRunnable + signal bridge."""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QObject, QRunnable, Signal, Slot


class WorkerSignals(QObject):
    progress = Signal(int, str)  # percentage, message
    finished = Signal()
    error = Signal(str)
    result = Signal(object)


class CsvLoadWorker(QRunnable):
    def __init__(self, file_path: str, data_manager) -> None:
        super().__init__()
        self.file_path = file_path
        self.data_manager = data_manager
        self.signals = WorkerSignals()
        self.setAutoDelete(True)

    @Slot()
    def run(self) -> None:
        try:
            self.signals.progress.emit(20, "Parsing CSV...")
            from core.csv_parser import parse_csv
            result = parse_csv(self.file_path)

            self.signals.progress.emit(60, "Loading into memory...")
            self.data_manager.load_dataframe(result.dataframe, result.metadata)

            # Pre-compute stats + correlation matrix
            self.signals.progress.emit(80, "Pre-computing statistics...")
            from core.statistics_engine import compute_descriptive_stats
            signals = {}
            for col in self.data_manager.get_numeric_columns():
                data = self.data_manager.get_signal(col)
                if data is not None:
                    signals[col] = data
            if signals:
                compute_descriptive_stats(signals, self.data_manager.cache)

            self.signals.progress.emit(90, "Pre-computing correlations...")
            from core.correlation_engine import compute_correlation_matrix
            if signals:
                compute_correlation_matrix(signals, self.data_manager.cache)

            self.signals.progress.emit(100, "Done.")
            self.signals.finished.emit()
        except Exception as e:
            self.signals.error.emit(str(e))


class SysIdWorker(QRunnable):
    def __init__(self, input_data: dict, output_data: dict, fs: float,
                 name: str, method: str, order_min: int, order_max: int,
                 decimation_factor: int, start_idx: int, end_idx: int) -> None:
        super().__init__()
        self.input_data = input_data
        self.output_data = output_data
        self.fs = fs
        self.name = name
        self.method = method
        self.order_min = order_min
        self.order_max = order_max
        self.decimation_factor = decimation_factor
        self.start_idx = start_idx
        self.end_idx = end_idx
        self.signals = WorkerSignals()
        self.setAutoDelete(True)
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled

    @Slot()
    def run(self) -> None:
        try:
            from core.sysid_engine import identify_model
            results = identify_model(
                input_data=self.input_data,
                output_data=self.output_data,
                fs=self.fs,
                name=self.name,
                method=self.method,
                order_min=self.order_min,
                order_max=self.order_max,
                decimation_factor=self.decimation_factor,
                start_idx=self.start_idx,
                end_idx=self.end_idx,
                progress_callback=lambda v, m: self.signals.progress.emit(v, m),
                cancelled_callback=lambda: self._cancelled,
            )
            if self._cancelled:
                self.signals.error.emit("Identification cancelled.")
            else:
                self.signals.result.emit(results)
                self.signals.finished.emit()
        except Exception as e:
            self.signals.error.emit(str(e))


class ReportWorker(QRunnable):
    def __init__(self, **kwargs) -> None:
        super().__init__()
        self.kwargs = kwargs
        self.signals = WorkerSignals()
        self.setAutoDelete(True)

    @Slot()
    def run(self) -> None:
        try:
            from core.report_generator import generate_report
            path = generate_report(
                progress_callback=lambda v, m: self.signals.progress.emit(v, m),
                **self.kwargs,
            )
            self.signals.result.emit(path)
            self.signals.finished.emit()
        except Exception as e:
            self.signals.error.emit(str(e))
