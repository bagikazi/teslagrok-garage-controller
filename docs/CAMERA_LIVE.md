# Camera live protocol

The camera is idle by default. It maintains Wi-Fi/MQTT control connectivity but
captures and uploads frames only after an authenticated user starts a live
session or requests a snapshot.

## Session flow

1. Authenticated browser calls `POST /api/camera/live/start`.
2. API creates a short-lived session and random stream token, then publishes
   `START_LIVE` on `camera/{cameraId}/command`.
3. Camera opens an outbound WebSocket to the isolated camera ingest listener on
   the API's configured host and port (`CAMERA_INGEST_HOST` and
   `CAMERA_INGEST_PORT`, default 20000), authenticating with its separate device credential
   and the short-lived stream token. The API listener remains on port 4000.
4. JPEG binary frames are validated, size/rate limited, and relayed only to
   authenticated viewers. Frames are never written to PostgreSQL or disk.
5. `POST /api/camera/live/stop`, viewer timeout, session expiry or API shutdown
   sends `STOP_LIVE` and closes the relay.

## Limits

The default target is 320x240 at 3-5 fps. The API rejects oversized/non-JPEG
frames and drops frames that exceed the configured rate. Sessions have a hard
maximum duration and an idle viewer timeout. The camera device token is
separate from the admin password, JWT and SSH key.

The API
process binds the isolated listener on port 20000; production deployment must
publish only that port and allow it through the VPS firewall. Prefer placing
TLS termination in front of it and set the firmware WebSocket scheme to `wss`.
