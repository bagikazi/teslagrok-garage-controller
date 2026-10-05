# Local safety logic

## Authority

The ESP32-S3 safety controller is authoritative. Wi-Fi, MQTT, the API, the
browser and ESP32-CAM are advisory/control transport only. Losing the VPS must
not disable physical obstruction protection.

## Position sensors

| TOP_SENSOR | BOTTOM_SENSOR | State |
| --- | --- | --- |
| ON | OFF | `DOOR_OPEN` |
| OFF | ON | `DOOR_CLOSED` |
| OFF | OFF | `DOOR_OPENING`, `DOOR_CLOSING`, `DOOR_STOPPED` or `DOOR_UNKNOWN` from history |
| ON | ON | `DOOR_ERROR` |

No percentage position is calculated or displayed.

## Closing-line sensor: garage photocell (current)

The installed doorway sensor is a garage photocell on GPIO16
(`USE_DISTANCE_SENSORS 0`). Beam received = `CLEAR`; anything else (beam
broken, photocell unpowered, wire cut) = `BLOCKED`, so a failure never lets the
door close. An obstacle counts immediately; the beam must be intact for three
consecutive 200 ms samples before the doorway is `CLEAR` again. The CLOSE
interlock and the stop-and-reopen guard use this state unchanged. Calibration
is not needed and is refused with `calibration_not_needed: photocell`.

The distance-sensor beam below is kept for reference and can be re-enabled
with `USE_DISTANCE_SENSORS 1`.

## Closing-line sensors (doorway light barrier, disabled)

Both sensors are mounted sideways in front of the garage door and look across
the doorway at a fixed target on the opposite side, like a light barrier. With
the doorway empty each sensor reads its baseline distance
(`CONFIG_GARAGE_HCSR04_BASELINE_CM`, `CONFIG_GARAGE_TOF_BASELINE_CM`, default
150 cm). An object in the beam, e.g. a car nose left outside, shortens the
reading.

Per sensor, with tolerance `CONFIG_GARAGE_BEAM_TOLERANCE_CM` (default 15 cm):

| Reading | Sensor state |
| --- | --- |
| shorter than baseline − tolerance | `BLOCKED` |
| within baseline ± tolerance | `CLEAR` |
| longer than baseline + tolerance (target missing / misaligned) | `SENSOR_FAULT` |
| missing, stale (> `CONFIG_GARAGE_SENSOR_FAULT_TIMEOUT_MS`) or out of range | `SENSOR_FAULT` |

**VL53L0X presence mode.** The VL53L0X reaches about 1.5–2 m, so across a
wider doorway (e.g. 2.5 m) it never sees the far side. Calibration detects this
(no stable TOF baseline) and stores TOF baseline 0 = presence mode: the TOF is
`CLEAR` while it sees nothing within range and `BLOCKED` when its filtered
reading is at or below 150 cm; offline is `SENSOR_FAULT`. The HC-SR04 still
compares against its own baseline across the full width. TOF readings pass a
median-of-3 filter with "no target" counted as far, so one stray long-range
reading cannot flag an obstacle. Screen and web show `> 150 cm` when the TOF
runs but has no target.

A sensor that reported `BLOCKED` stays blocked until it reads at least 3 cm
above the blocking threshold (hysteresis), so noise near the threshold does
not flap the state.

Combined: either sensor `BLOCKED` → `BLOCKED`; both `CLEAR` → `CLEAR`;
anything else → `SENSOR_FAULT`. "No reading" is never clear: a dark car can
absorb the VL53L0X infrared, and the HC-SR04 (colour independent) covers that
case. The HC-SR04 uses the median of its last three echoes to reject spikes.
Use a light-coloured, flat target on the opposite side for the VL53L0X.

CLOSE is only allowed when the state is `CLEAR`; otherwise the command is acked
with `accepted: false, result: "CLOSE_BLOCKED"` and DOWN is not pulsed.

## Relay interlock

Every movement request first releases all movement relays, waits the configured
interlock delay, pulses exactly one requested dry-contact relay for the
configured duration, and releases it again. UP and DOWN can never be active at
the same time. STOP has priority over movement.

If a close request is rejected, publish `CLOSE_BLOCKED` and do not pulse DOWN.
If an obstacle appears during CLOSING, publish `OBSTACLE_DETECTED`, pulse STOP,
wait the configured reopen delay, pulse UP, and publish `STOP_AND_REOPEN`.

## Light automation

PIR (HC-SR501, GPIO6) is not a collision sensor and plays no part in the
closing interlock. Light logic runs locally, independent of the door state:

- A new motion edge switches LIGHT on in `AUTO` mode (when
  `CONFIG_GARAGE_PIR_LIGHT_ENABLED`); ongoing motion keeps extending it and
  `CONFIG_GARAGE_PIR_LIGHT_TIMEOUT_SECONDS` without motion switches it off.
- `LIGHT_ON` from the web switches it on in `MANUAL` mode, which the timer never
  switches off. `LIGHT_OFF` switches it off; auto-on then needs a new motion edge,
  so a person still standing there does not immediately re-light it.
- `PIR_MOTION` (at most one per 30 s), `LIGHT_ON` and `LIGHT_OFF` are published
  as events; state carries `pirMotion`, `lightOn` and `lightMode`.

The lamp relay is held, not pulsed, and is exempt from `SAFE_TEST_MODE`
(`LIGHT_RELAY_LIVE` in `hardware_pins.h`) because it has no motion hazard; the
door relays stay locked.
