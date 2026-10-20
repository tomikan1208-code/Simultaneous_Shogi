$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:UV_CACHE_DIR = Join-Path (Get-Location) '.cache\uv'
$env:PIP_CACHE_DIR = Join-Path (Get-Location) '.cache\pip'
$trainingPython = Join-Path (Get-Location) '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $trainingPython)) {
    $basePython = $null
    $pythonFolder = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $pythonFolder) {
        $basePython = Get-ChildItem -LiteralPath $pythonFolder -Filter python.exe -Recurse -File |
            Where-Object { $_.FullName -notmatch '\\Lib\\|\\Scripts\\' } |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $basePython) {
        $command = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($command) { $basePython = $command.Source }
    }
    if (-not $basePython) { throw 'Install Python 3.10-3.14 first.' }
    & $basePython -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the project Python environment.' }
}
$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($uv) {
    & $uv.Source pip install --python $trainingPython 'numpy>=1.26,<3'
    if ($LASTEXITCODE -ne 0) { throw 'NumPy install failed.' }
    & $uv.Source pip install --python $trainingPython 'torch==2.11.0+cu128' --index-url https://download.pytorch.org/whl/cu128
} else {
    & $trainingPython -m pip install 'numpy>=1.26,<3'
    if ($LASTEXITCODE -ne 0) { throw 'NumPy install failed.' }
    & $trainingPython -m pip install 'torch==2.11.0+cu128' --index-url https://download.pytorch.org/whl/cu128
}
if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch install failed.' }
& $trainingPython -c "from training.runtime import inspect; import json; r=inspect(); print(json.dumps(r,indent=2)); raise SystemExit(0 if r['cuda_available'] else 1)"
if ($LASTEXITCODE -ne 0) { throw 'CUDA is unavailable. Check the NVIDIA GPU driver.' }
Write-Host 'GPU ready. Open dashboard\start.bat to train.'
