# Garage Control project brief

Garage Control is a private, server-mediated garage monitoring and control
system. The ESP32-S3 owns all physical safety decisions locally; the VPS/API
provides authenticated remote commands, persistence and browser fan-out; the
ESP32-CAM provides on-demand snapshots and live JPEG viewing through the VPS.

## Non-negotiable boundaries

- UP, DOWN, STOP and LIGHT use isolated dry relay contacts; the ESP32 never
  drives the opener's input voltage directly.
- The S3 must reject CLOSE when either closing-line sensor is BLOCKED or
  SENSOR_FAULT, and must STOP then reopen if an obstacle appears while closing.
- Missing sensor data is unsafe for closing and never means CLEAR.
- The camera is not part of collision safety and never streams while idle.
- Browsers connect only to the authenticated API/WebSocket surface, never to a
  camera LAN address.
- PostgreSQL, Redis and internal administration stay private on the VPS.
- Real credentials and SSH keys stay outside Git and deployment artifacts.

## Current implementation baseline

- Node.js/TypeScript Fastify API, PostgreSQL repository, MQTT transport and
  Next.js PWA remain the selected stack.
- Firmware targets remain native ESP-IDF projects with relay output disabled
  until exact boards and wiring are verified.
- Camera live ingest uses its own TCP port (`20000` by default), separate
  from the API port.
- The web UI uses neutral charcoal smart-home styling from `web/src/styles/tokens.css`;
  state color is semantic and the camera is always user-initiated.

## Delivery order

1. Shared safety/camera contracts and tests.
2. Fastify camera sessions, authenticated ingest and viewer relay.
3. Responsive camera/dashboard states and realtime events.
4. ESP32-S3 sensor/interlock implementation and ESP32-CAM on-demand live flow.
5. Hardware/build validation, then isolated VPS deployment.
