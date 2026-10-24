#!/usr/bin/env sh
# Baghdad digital twin - start on macOS / Linux:  sh run_app.sh
# The first run creates a local Python environment (.venv) and installs the requirements.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up the Python environment, this takes a minute..."
  python3 -m venv .venv || { echo "Python 3.10 or newer is needed"; exit 1; }
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt || exit 1
fi
exec .venv/bin/python -m streamlit run app.py "$@"
