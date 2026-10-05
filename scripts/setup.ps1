param([string]$EspIdfVersion = "v6.0.3")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot ".tools"
$idfRoot = Join-Path $toolsRoot "esp-idf"
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
if (-not (Test-Path (Join-Path $idfRoot ".git"))) { git clone --branch $EspIdfVersion --depth 1 --recursive https://github.com/espressif/esp-idf.git $idfRoot } else { git -C $idfRoot fetch --tags; git -C $idfRoot checkout $EspIdfVersion; git -C $idfRoot submodule update --init --recursive }
Push-Location $idfRoot
try { & .\install.ps1 esp32s3; & .\install.ps1 esp32 } finally { Pop-Location }
Write-Host "ESP-IDF $EspIdfVersion installed. Open a new shell, then run: .\.tools\esp-idf\export.ps1"
