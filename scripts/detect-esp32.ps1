$ErrorActionPreference = "Stop"
Write-Host "Serial ports visible to Windows:"
Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,PNPDeviceID,Description
Write-Host "Pass a selected DeviceID to flash-controller.ps1 or flash-camera.ps1; the script reads chip_id and flash_id first."
