import sys
import os
import re
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
warnings.filterwarnings("ignore", category=DeprecationWarning)

# Import pandas/numpy/dateutil/matplotlib BEFORE PySide6 to avoid six/shiboken import conflict
import six.moves  # noqa: F401
import dateutil.rrule  # noqa: F401
import pandas  # noqa: F401
import numpy  # noqa: F401
import matplotlib  # noqa: F401
import matplotlib.pyplot  # noqa: F401

from PySide6.QtWidgets import QApplication, QFileDialog
from PySide6.QtCore import Qt
from ui.main_window import MainWindow


def _patch_pyqtgraph_native_dialog():
    """Patch pyqtgraph exporters to use the native OS file dialog."""
    try:
        import importlib
        exporter_module = importlib.import_module("pyqtgraph.exporters.Exporter")
        ExporterClass = exporter_module.Exporter

        def fileSaveDialog(self, filter=None, opts=None):
            if opts is None:
                opts = {}
            if filter is None:
                name_filter = "All Files (*)"
            elif isinstance(filter, list):
                name_filter = ";;".join(filter)
            else:
                name_filter = filter

            start_dir = exporter_module.LastExportDirectory or ""
            options = QFileDialog.Options()
            options &= ~QFileDialog.Option.DontUseNativeDialog
            parent = QApplication.activeWindow()

            fileName, selectedFilter = QFileDialog.getSaveFileName(
                parent, "Export", start_dir, name_filter, options=options
            )
            if fileName:
                exporter_module.LastExportDirectory = os.path.split(fileName)[0]
                ext = os.path.splitext(fileName)[1].lower().lstrip('.')
                selected_ext = re.search(r'\*\.(\w+)\b', selectedFilter or "")
                if selected_ext is not None:
                    selected_ext = selected_ext.groups()[0].lower()
                    if ext != selected_ext:
                        fileName = fileName + '.' + selected_ext.lstrip('.')
                self.export(fileName=fileName, **opts)

        ExporterClass.fileSaveDialog = fileSaveDialog
    except Exception:
        pass


def main():
    QApplication.setAttribute(Qt.AA_ShareOpenGLContexts)
    QApplication.setAttribute(Qt.AA_DontUseNativeDialogs, False)
    app = QApplication(sys.argv)
    app.setApplicationName("Data Analyzer")
    app.setOrganizationName("DataAnalyzer")

    style_path = os.path.join(os.path.dirname(__file__), "ui", "styles.qss")
    if os.path.exists(style_path):
        with open(style_path, "r") as f:
            app.setStyleSheet(f.read())

    _patch_pyqtgraph_native_dialog()

    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
