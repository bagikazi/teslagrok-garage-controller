param([Parameter(Mandatory=$true)][string]$Port, [switch]$Monitor)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Write-Host "Inspecting chip on $Port before camera flashing..."
if (Get-Command esptool.py -ErrorAction SilentlyContinue) { esptool.py --port $Port chip_id; esptool.py --port $Port flash_id } else { esptool --port $Port chip-id; esptool --port $Port flash-id }
Push-Location (Join-Path $root "firmware\camera-esp32cam")
try { idf.py set-target esp32; idf.py build; idf.py -p $Port flash; if ($Monitor) { idf.py -p $Port monitor } } finally { Pop-Location }
