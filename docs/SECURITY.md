# Security

This service controls physical equipment. Treat every deployment as safety-critical.

## Required controls

- Terminate HTTPS at the reverse proxy; use MQTT over TLS with certificate validation.
- Create an individual MQTT identity per device. Do not use anonymous production MQTT.
- Keep MQTT, PostgreSQL and camera storage on private networks where possible.
- Store `JWT_SECRET`, database credentials, MQTT credentials and camera tokens outside Git. Rotate the development placeholders before any internet exposure.
- Keep the PWA on HttpOnly SameSite cookies; do not put long-lived refresh tokens in localStorage.
- Keep login and control routes rate-limited. Log user, command ID, action, result and time without logging passwords/tokens.
- Validate every API and MQTT payload with schemas. Use parameterized SQL only.
- Limit JPEG upload size/type and serve image objects with a controlled path, never an arbitrary filesystem path.
- Configure Content-Security-Policy, HSTS and a restrictive CORS origin in production.

## Physical safety

The server must never expose relay ON/OFF. A device interprets OPEN/CLOSE/STOP against local sensors and pulses for a bounded duration. Preserve existing opener obstruction and manual controls. Test with the motor disconnected before applying power.

## Before production

Run dependency audit, secret scan, TLS verification, backup/restore test, rate-limit test, duplicate command test, offline recovery test and obstruction-sensor test. The default development broker intentionally permits anonymous plaintext access only on a local Docker network and must not be reused in production.
