# API

All timestamps are stored in UTC and rendered in local browser time.

## Authentication

- `POST /api/auth/login` with `{ email, password }` returns a short-lived access token and sets HttpOnly access/refresh cookies.
- `POST /api/auth/refresh` rotates the access cookie using the HttpOnly refresh cookie.
- Future Expo apps use the returned access token in `Authorization: Bearer …` and the same refresh endpoint.

## Garage

- `GET /api/garage/status` — latest state, sensors and controller telemetry.
- `GET /api/garage/events?limit=20` — recent activity.
- `POST /api/garage/open`, `/close`, `/stop` — authenticated desired actions. Body may include a client-generated `commandId`; the server generates one otherwise.

An already-reached endpoint returns `200` with `result: already_reached`. A newly published command returns `202`. Reusing a command ID returns the existing command without another MQTT publish.

## Camera/system

- `GET /api/camera/status`
- `GET /api/camera/latest`
- `POST /api/camera/snapshot` is reserved for the camera command integration.
- `GET /api/system/health` is a public process health check.
- `GET /ws` emits `garage.status`, `activity.created` and `camera.latest` messages.
