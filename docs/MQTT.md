# MQTT contract

## Topics

`garage/{deviceId}/state`, `telemetry`, `event`, `command`, `ack`, `availability`

`camera/{cameraId}/state`, `event`, `command`, `availability`

The browser does not receive MQTT credentials. The API is the only control-plane client exposed to the browser.

## Envelopes

Important messages contain `deviceId`, UTC `timestamp`, monotonic `sequence`, `bootId` and `firmwareVersion`. Commands additionally contain UUID `commandId`, `action` and `timestamp`. Acknowledgements contain `commandId`, `accepted`, `result` and `currentState`.

## Reliability

- Use QoS 1 for commands, state and availability; retained state/availability is appropriate.
- Use Last Will `{ "online": false }` on the availability topic.
- Devices reconnect with exponential backoff and publish a fresh boot ID.
- The controller stores recently accepted command IDs and ignores duplicates.
- The server stores command IDs with a unique constraint and publishes once.

## Example

```json
{
  "deviceId": "controller-s3-001",
  "timestamp": "2026-09-20T12:00:00.000Z",
  "sequence": 42,
  "bootId": "boot-abc",
  "firmwareVersion": "0.1.0",
  "state": "OPEN",
  "sensors": { "closed": false, "open": true }
}
```
