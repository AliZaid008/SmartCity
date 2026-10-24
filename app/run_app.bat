@echo off
rem Baghdad digital twin - one-click start on Windows.
rem The first run creates a local Python environment (.venv) and installs the requirements,
rem which needs internet once. Later runs start straight away. Extra arguments go to Streamlit.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up the Python environment, this takes a minute...
  python -m venv .venv || (echo Python 3.10 or newer is needed: https://www.python.org/downloads/ & pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (pause & exit /b 1)
)
".venv\Scripts\python.exe" -m streamlit run app.py %*
