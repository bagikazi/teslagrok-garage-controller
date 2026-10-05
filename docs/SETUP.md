# Setup

## Node/API/web

Use Node.js 22+ and npm workspaces. Run `npm install`, then `npm test`, `npm run typecheck` and `npm run build`. Copy `.env.example` to `.env` for a non-Docker local API. Docker Compose is the preferred first run because it supplies PostgreSQL and Mosquitto.

## ESP-IDF

The setup scripts pin ESP-IDF `v6.0.3`, a released stable branch selected on 2026-09-20 after checking Espressif's release list. The scripts clone into the project-local `.tools/esp-idf`, install only the ESP32 targets needed by these projects, and do not require Arduino IDE.

Windows PowerShell:

```powershell
.\scripts\setup.ps1
.\.tools\esp-idf\export.ps1
```

Linux/macOS shell:

```bash
./scripts/setup.sh
source .tools/esp-idf/export.sh
```

ESP-IDF managed components are resolved by `idf.py reconfigure`/build from the project manifest. Camera dependencies are pinned by `firmware/camera-esp32cam/main/idf_component.yml`.

## Configuration

Use project-controlled `sdkconfig.defaults` or a provisioning script to inject Wi-Fi, MQTT, device ID and pin values. Never commit real credentials. The firmware projects use NVS-capable ESP-IDF configuration and do not read Arduino preferences.
