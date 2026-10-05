param([Parameter(Mandatory=$true)][string]$Port, [switch]$Monitor)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command esptool.py -ErrorAction SilentlyContinue) -and -not (Get-Command esptool -ErrorAction SilentlyContinue)) { throw "esptool is not on PATH. Run ESP-IDF export.ps1 first." }
Write-Host "Inspecting chip on $Port before flashing..."
if (Get-Command esptool.py -ErrorAction SilentlyContinue) { esptool.py --port $Port chip_id; esptool.py --port $Port flash_id } else { esptool --port $Port chip-id; esptool --port $Port flash-id }
Write-Host "Building and flashing SAFE diagnostic firmware only. Relay is disabled by default."
Push-Location (Join-Path $root "firmware\controller-s3")
try { idf.py set-target esp32s3; idf.py build; idf.py -p $Port flash; if ($Monitor) { idf.py -p $Port monitor } } finally { Pop-Location }
