# Architecture

## Boundaries

The controller, camera, API and web client are independent deployables. Firmware owns physical I/O and safety-local behavior. The API owns user authentication, command authorization, command history, event persistence and browser fan-out. The web client never subscribes to MQTT.

## Runtime flow

1. The controller connects to Wi-Fi and MQTT, publishes retained availability and state, and sends telemetry every 25 seconds.
2. The API validates MQTT envelopes, persists the latest state/event and broadcasts a typed WebSocket message.
3. A user action is validated as OPEN/CLOSE/STOP, deduplicated by UUID, recorded and published once to the device command topic.
4. The controller interprets the desired action against its local sensor state and emits an acknowledgement/state update. It never exposes a raw relay ON/OFF operation to users.
5. Door transitions can trigger a camera snapshot request/event. The camera uploads a JPEG over HTTPS and reports metadata for the activity feed.
6. An authenticated user can create a short-lived live session. The API sends
   `START_LIVE` over MQTT, accepts an outbound camera WebSocket on the
   configured ingest boundary, and relays bounded JPEG frames only to
   authenticated viewers. Idle/expired sessions publish `STOP_LIVE`.

## Failure behavior

- A disconnected API cannot make the opener unsafe; the physical opener remains usable independently.
- A disconnected device is represented as OFFLINE after MQTT Last Will/availability is received.
- An already-reached OPEN/CLOSED action is acknowledged without a pulse.
- A duplicate `commandId` returns the original command record and cannot pulse again.
- Two active position sensors are `ERROR`; neither firmware nor API should infer a safe endpoint from that reading.

## Production deployment

Put the API and web app behind a reverse proxy with HTTPS. Keep PostgreSQL on the private Docker network. Expose only HTTPS and the Mosquitto TLS listener needed by devices. Use a managed backup/retention policy for PostgreSQL and camera storage.
