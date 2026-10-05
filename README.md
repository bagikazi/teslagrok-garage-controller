# Garage Control

Garage Control is a security-first monorepo for a remote garage door controller, a separate ESP32-CAM security node, and the web/API infrastructure that connects them. The first client is a responsive PWA; future Android and iOS clients use the same REST, WebSocket, authentication, and device layers.

## Architecture

`ESP32-S3 controller → MQTT over TLS → Mosquitto → Fastify API → PostgreSQL → WebSocket → Next.js PWA`

A voice assistant such as Grok can control the door through the API's built-in MCP endpoint (`/api/mcp`); see `docs/GROK_MCP.md`.

The camera is independent: it publishes events over MQTT and uploads JPEGs over HTTPS. Browsers never connect to MQTT and never control a relay directly.

## Repository layout

- `server/api` — Fastify + TypeScript API, MQTT adapter, WebSocket fan-out and domain logic.
- `web` — Next.js responsive PWA dashboard.
- `packages/shared-types` — Zod schemas and TypeScript contracts shared by API, web and future mobile apps.
- `tools/mock-device` — MQTT simulator for a controller moving between CLOSED/OPENING/OPEN/CLOSING/CLOSED.
- `firmware/controller-s3` — native ESP-IDF diagnostic/controller project.
- `firmware/camera-esp32cam` — separate native ESP-IDF camera project.
- `infra` — Docker Compose, Mosquitto and PostgreSQL schema.
- `docs` — architecture, hardware, MQTT, API, Grok/MCP, security, setup and flashing runbooks.

## Quick start

1. Install Node.js 22+ and Docker Desktop.
2. Copy `.env.example` to `.env` and replace every placeholder secret.
3. Start the local stack:

   ```powershell
   docker compose -f infra/docker-compose.yml up --build
   ```

4. In another terminal, create the local owner account (the password is never stored in this repository):

   ```powershell
   $env:DATABASE_URL='postgres://garage:change-me-local-only@localhost:5432/garage'
   $env:OWNER_PASSWORD='use-a-local-password-at-least-12-chars'
   node scripts/seed-owner.mjs
   ```

5. Open [http://localhost:3000](http://localhost:3000). The API health endpoint is [http://localhost:4000/api/system/health](http://localhost:4000/api/system/health).

## Mock device

The local Compose broker listens on `mqtt://localhost:1883` for development only. With the API running, start the simulator from the repository root:

```powershell
$env:MQTT_URL='mqtt://localhost:1883'
npm run dev:mock
```

Log in to the PWA, press Open garage, and watch the mock device publish OPENING then OPEN. MQTT messages are translated into API state and WebSocket events; no one-second REST polling is used.

## Development commands

```powershell
npm install
npm test
npm run typecheck
npm run build
```

## Firmware configuration

Nothing personal is committed. Before building, set your own values with `idf.py menuconfig` (menu "Garage controller") or in a local, git-ignored `sdkconfig`:

- Wi-Fi SSID and password
- MQTT broker URI (`mqtts://your-broker:8883`), username and password
- Device ID

Replace `firmware/*/mqtt_ca.crt` with the CA certificate of your own broker; the committed files are placeholders.

Firmware setup/build/flash commands are documented in `docs/SETUP.md` and `docs/FLASHING.md`. `scripts/flash-controller.ps1` always performs chip and flash identification before building/flashing diagnostic firmware; no physical flash was claimed in this environment because no board was connected or detected.

## Hardware safety

The controller ships with relay and sensor GPIOs set to `-1` and relay control disabled. Do not change those values until the exact ESP32-S3 board and opener wiring are documented in `docs/HARDWARE.md`. The existing wall control and opener safety mechanisms must remain independently usable if the network or controller fails.

## Security notes

- Production MQTT is TLS-only with per-device credentials and a password file.
- Access tokens are returned for mobile compatibility and also stored in HttpOnly, SameSite cookies for the PWA; refresh tokens are HttpOnly.
- Control routes are authenticated, rate-limited and idempotent by `commandId`.
- Runtime secrets are environment/configuration inputs, never committed source values.
- Camera uploads require a device token and must be served behind HTTPS in production.

See `docs/SECURITY.md` before exposing the service to the internet.

## License

MIT, see `LICENSE`.
