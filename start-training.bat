@echo off
setlocal
cd /d "%~dp0"
set "SHOGI_TRAIN_PYTHON=.venv\Scripts\python.exe"
if not exist "%SHOGI_TRAIN_PYTHON%" set "SHOGI_TRAIN_PYTHON=python"
if "%~1"=="" (
  "%SHOGI_TRAIN_PYTHON%" -m training.train --run-dir dashboard\runs\local-training --config training\config.json
) else (
  "%SHOGI_TRAIN_PYTHON%" -m training.train %*
)
if errorlevel 1 pause
