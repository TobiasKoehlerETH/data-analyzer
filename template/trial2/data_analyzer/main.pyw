"""Windowless launcher — same as main.py but .pyw hides the console on double-click."""

import sys
import os
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
warnings.filterwarnings("ignore", category=DeprecationWarning)

# Import pandas/numpy/dateutil/matplotlib BEFORE PySide6 to avoid six/shiboken import conflict
import six.moves  # noqa: F401
import dateutil.rrule  # noqa: F401
import pandas  # noqa: F401
import numpy   # noqa: F401
import matplotlib  # noqa: F401
import matplotlib.pyplot  # noqa: F401

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from ui.main_window import MainWindow


def main():
    QApplication.setAttribute(Qt.AA_ShareOpenGLContexts)
    app = QApplication(sys.argv)
    app.setApplicationName("Data Analyzer")
    app.setOrganizationName("DataAnalyzer")

    style_path = os.path.join(os.path.dirname(__file__), "ui", "styles.qss")
    if os.path.exists(style_path):
        with open(style_path, "r") as f:
            app.setStyleSheet(f.read())

    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
