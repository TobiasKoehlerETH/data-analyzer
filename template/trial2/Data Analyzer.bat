@echo off
title Data Analyzer
cd /d "%~dp0data_analyzer"
pythonw main.pyw 2>nul
if %errorlevel% neq 0 (
	python main.py
	if %errorlevel% neq 0 (
		echo.
		echo ERROR: Python not found or dependencies missing.
		echo Run: pip install -r requirements.txt
		pause
	)
)
