# Task ledger

## Done

- [x] Establish an npm workspace monorepo and shared TypeScript contract.
- [x] Add initial architecture, security, hardware, MQTT, API, setup and flashing documentation.
- [x] Add PostgreSQL schema and Docker Compose development stack.
- [x] Add tested door-state domain logic and authenticated Fastify API.
- [x] Add MQTT adapter, WebSocket event fan-out and mock-device CLI.
- [x] Add responsive PWA dashboard with live WebSocket updates.
- [x] Add native ESP-IDF controller and camera project skeletons with safe defaults.
- [x] Add camera upload/snapshot API path, OpenAPI description and first Playwright smoke tests.
- [x] Add tested camera live-session manager with short-lived tokens, viewer timeout, frame validation, rate limiting and MQTT start/stop commands.
- [x] Add authenticated backend camera ingest/view WebSocket routes and explicit web start/stop/renew flow.
- [x] Restyle the web dashboard to the neutral smart-home product direction and document it in `docs/WEB_UI_SPEC.md`.
- [x] Add project brief, safety logic, camera live and ST7789 UI specifications.

## Verify on the target machine

- [ ] Copy `.env.example` to `.env` and rotate every development secret.
- [ ] Start Docker Desktop and run `docker compose -f infra/docker-compose.yml up --build`.
- [ ] Run the mock-device flow and execute the documented API/PWA smoke test.
- [ ] Install ESP-IDF v6.0.3 with `scripts/setup.ps1`, then build both firmware targets.
- [ ] Identify the exact ESP32-S3 and ESP32-CAM board variants before selecting GPIO/RF profiles.
- [ ] Flash diagnostic firmware before enabling any relay wiring.
- [ ] Perform physical relay and obstruction-safety validation with power isolated.
- [ ] Validate camera upload and motion-detection tuning on the confirmed ESP32-CAM board.
- [ ] Replace the controller diagnostic relay path with the full four-relay local interlock/sensor implementation and compile on ESP-IDF.
- [ ] Wire and validate the ESP32-CAM WebSocket live transport on the confirmed board.
- [ ] Deploy the isolated camera ingest service behind TLS on port `20000`.
- [ ] Add production device provisioning, certificate rotation and native mobile clients.
