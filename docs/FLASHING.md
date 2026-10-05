# Build and flashing

1. Run `scripts/detect-esp32.ps1` and identify a real serial port.
2. Pass that port explicitly to a flash script. The script runs `chip_id` and `flash_id` before flashing; a COM number is never treated as a board identity.
3. Flash the controller diagnostic firmware first. It has `CONFIG_GARAGE_ENABLE_RELAY=n` and the board config uses `-1` GPIOs by default.
4. Watch serial output with `scripts/monitor.ps1` or the `-Monitor` switch.
5. Only after board, GPIO and network validation, create a hardware-specific `board_config.h`, set the relay option and repeat a disconnected-relay test.

```powershell
.\scripts\build-firmware.ps1 -Target controller-s3
.\scripts\flash-controller.ps1 -Port COM7 -Monitor
.\scripts\build-firmware.ps1 -Target camera-esp32cam
.\scripts\flash-camera.ps1 -Port COM8 -Monitor
```

No physical ESP32 was accessible/detected during this implementation session, so no flash, serial, Wi-Fi or MQTT hardware success is claimed. If a board is absent, the exact next command is the build command above after `idf.py` is installed; flashing requires a user-provided serial port.
