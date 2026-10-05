param([ValidateSet("controller-s3", "camera-esp32cam")][string]$Target = "controller-s3")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "firmware\$Target"
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) { throw "idf.py is not on PATH. Run .\.tools\esp-idf\export.ps1 in this shell first." }
Push-Location $project
try { if ($Target -eq "controller-s3") { idf.py set-target esp32s3 } else { idf.py set-target esp32 }; idf.py build } finally { Pop-Location }
