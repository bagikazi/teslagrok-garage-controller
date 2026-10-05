# ESP32-S3 hardware contract

This document and [`components/hardware/include/hardware_pins.h`](../components/hardware/include/hardware_pins.h) are the locked pin contract for the ESP32-S3-DevKitC-1 with ESP32-S3-WROOM-1 N16R8 (16 MB flash, 8 MB octal PSRAM). GPIO assignments must not be silently remapped.

## Final GPIO map

| Device/function | Signal | ESP32-S3 GPIO | Electrical notes |
| --- | --- | ---: | --- |
| ST7789 | MOSI / SDA | GPIO11 | SPI data |
| ST7789 | SCLK / SCL | GPIO12 | SPI clock |
| ST7789 | DC | GPIO13 | Data/command |
| ST7789 | RES | GPIO14 | Reset |
| ST7789 | CS | None / `-1` | The display has no CS pin; no GPIO is allocated |
| ST7789 | BLK | 3V3 | Permanently on; no GPIO is allocated |
| VL53L0X | SDA | GPIO8 | I2C |
| VL53L0X | SCL | GPIO9 | I2C |
| HC-SR04 | TRIG | GPIO7 | Output |
| HC-SR04 | ECHO | GPIO15 | Must use the divider below |
| HC-SR501 | OUT | GPIO6 | Optional PIR input |
| Garage photocell | Relay NO (COM to GND) | GPIO16 | Dry contact, internal pull-up; LOW = beam received |
| Reed switch | OPEN | GPIO4 | `INPUT_PULLUP`, active-low |
| Reed switch | CLOSED | GPIO5 | `INPUT_PULLUP`, active-low |
| Relay IN1 | UP / OPEN | GPIO39 | Centralized active-low handling |
| Relay IN2 | DOWN / CLOSE | GPIO40 | Centralized active-low handling |
| Relay IN3 | STOP | GPIO41 | Centralized active-low handling |
| Relay IN4 | LIGHT | GPIO42 | Centralized active-low handling |

Relays moved from GPIO16/17/18/21 to GPIO39–42 on 2026-09-21 so the four inputs sit side by side on the right-hand header. GPIO39–42 are the external JTAG pads (MTCK/MTDO/MTDI/MTMS); they are free because the project debugs through the built-in USB-JTAG, and they have no strapping role at boot. GPIO16 now carries the garage photocell; GPIO17, 18 and 21 are unassigned.

### Display wiring

The ST7789 physical pins are `GND`, `VCC`, `SCL`, `SDA`, `RES`, `DC`, and `BLK`. Connect `VCC` to 3V3, `GND` to common ground, `SCL` to GPIO12, `SDA` to GPIO11, `RES` to GPIO14, `DC` to GPIO13, and `BLK` directly to 3V3. There is no physical CS connection. Display drivers that require a CS value must receive `-1`.

#### Verified display settings (2026-09-21, ESP32-S3 DevKit on COM6)

Confirmed on hardware with `firmware/st7789_test` (Arduino, Adafruit ST7789 library, esp32 core 3.3.11): colors correct, image upright, all four edges visible.

| Setting | Value | Notes |
| --- | --- | --- |
| Resolution | 240×240 | Controller RAM is 240×320 |
| SPI mode | 3 | Required because the panel has no CS pin |
| SPI clock | 40 MHz | Verified; higher is untested |
| Rotation | 180° (Adafruit `setRotation(2)`) | Panel is mounted upside down; `setRotation(0)` shows the image inverted |
| MADCTL | `0x00` (no MX/MY/MV, RGB order) | What Adafruit rotation 2 writes; rotation 0 (`0xC0` + row offset 80) is upside down |
| Row offset | 0 | Upright window is RAM rows 0–239 |
| Column offset | 0 | |
| Color inversion | On (`INVON`, 0x21) | IPS panel |
| Color format | RGB565 (`COLMOD` 0x55), big-endian on the wire | |

The ESP-IDF driver `firmware/controller-s3/main/display_driver.c` uses the same values (`DISPLAY_SPI_MODE`, `DISPLAY_PIXEL_CLOCK_HZ`, `DISPLAY_X_GAP`/`DISPLAY_Y_GAP`, `LCD_RGB_ELEMENT_ORDER_RGB`, no mirror, inversion on).

Arduino build/flash: `arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc firmware/st7789_test` then `arduino-cli upload -p COM6 ...` (the CLI ships inside Arduino IDE at `C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`).

### VL53L0X wiring

Connect the single currently installed VL53L0X to 3V3 and common ground, with `SDA` on GPIO8 and `SCL` on GPIO9. `XSHUT` and `INT/GPIO1` are not connected.

**Backlight blinking and the VL53L0X:** the ST7789 backlight is wired straight to 3V3, close to the white LED's forward voltage, so a few tens of mV on the rail visibly change its brightness. In timed mode (measure 50 ms, idle 50 ms) the VL53L0X laser loads the rail on and off 10 times a second and the backlight blinked. A 100–220 µF capacitor on the sensor supply did not help, because it cannot bridge a load that changes every 50 ms. The firmware therefore ranges back-to-back (`TOF_PERIOD_MS 0`): the laser draws a steady current and the blinking is gone. Diagnosed on 2026-09-21 by switching loads one at a time: laser on → blinking, even with no I2C traffic; laser off with I2C polling → none. A 100 µF capacitor across `VIN`/`GND` may stay fitted as extra decoupling. Plug it in only with power off: a live insertion dips the rail and resets the sensor, which the firmware then re-initializes after 1 s.

### Garage photocell wiring

The doorway obstacle sensor is a standard garage photocell pair (transmitter + receiver, powered from its own 12–24 V supply). Its receiver relay is a dry contact: wire `COM` to ESP32 GND and `NO` to GPIO16; never connect the photocell supply voltage to the ESP32. With the `NO` jumper the relay is energized while the beam is received, so the contact is closed (GPIO16 LOW) when the doorway is clear. A broken beam, an unpowered photocell or a cut wire opens the contact (HIGH) and is treated as an obstacle. If a receiver behaves the other way round, flip `PHOTOCELL_CLEAR_LEVEL` in `hardware_pins.h`. Mount the pair across the doorway in the gap between the door line and the parked car, at bumper height.

The HC-SR04 and VL53L0X are disabled in firmware (`USE_DISTANCE_SENSORS 0` in `main.c`); their code, drivers and wiring notes are kept for later use.

### HC-SR501 PIR wiring

`VCC` to 5V (4.5–20 V; below that its onboard regulator drops out), `GND` to common ground, `OUT` to GPIO6 directly — the output is a 3.3 V logic level. Set the trigger jumper to `H` (repeatable) and turn the time potentiometer fully anticlockwise (~3 s); the firmware handles the lamp timeout. After power-up the sensor needs about 60 s to settle and may report false motion meanwhile.

### Light relay wiring

Relay `IN4` to GPIO42 (active-low), module `VCC` and `GND` to 5V and common ground; the lamp mains circuit goes through the relay's `COM`/`NO` contacts. On 5 V opto-isolated modules a 3.3 V "high" may not fully switch the opto LED off, so the relay can stay on or chatter; if that happens, remove the `JD-VCC` jumper, feed `JD-VCC` from 5 V and the module `VCC` from 3V3.

### HC-SR04 protection

The HC-SR04 is powered from regulated 5V and common ground. Connect `TRIG` to GPIO7. Do **not** connect the 5V `ECHO` signal directly to the ESP32-S3:

```text
HC-SR04 ECHO --- 1k resistor ---+--- GPIO15
                                |
                              2k resistor
                                |
                               GND
```

### Reed switches

Connect the OPEN reed between GPIO4 and GND, and the CLOSED reed between GPIO5 and GND. Firmware configures both as `INPUT_PULLUP` and active-low: LOW means active, HIGH means inactive. Physical reed switches are authoritative for door position; relay commands alone must never determine the position.

### Relay safety

The relay module uses an external regulated 5V supply and common ground. The centralized configuration assumes `RELAY_ACTIVE_LOW = true`; relay polarity must not be inverted separately in individual call sites. Firmware uses the centralized `relay_on()`, `relay_off()`, and `relay_pulse()` functions.

All four relay outputs are driven to the inactive level before Wi-Fi, MQTT, display, sensor, or backend initialization. `SAFE_TEST_MODE` was disabled on 2026-09-21 at the owner's request, with the opener not yet connected, so the door relays now pulse; the controller reports the lock state as `relaysLocked` and the web shows a banner while it is on. Commands are received, processed, logged, acknowledged, and reflected in status, but no physical relay is activated while this mode is enabled. Keep it enabled until the relay polarity and garage wiring are manually verified with the motor disconnected.

### Power and grounding

- 3.3V devices: ST7789 and VL53L0X.
- 5V devices: HC-SR04, HC-SR501, and relay module.
- The board's `5V` pin only carries voltage when the DevKit is powered through one of its own USB ports. When it is powered from the external FTDI adapter (COM6) the pin is dead, so the relay module and the HC-SR501 need 5 V from a board USB port, the adapter's 5 V pin or a separate supply, always with a shared GND. With only 3.3 V the relay LEDs still light (the opto side works) but the 5 V coils do not pull in.
- Relay wiring and active-low polarity were verified on 2026-09-21 with the boot-time commissioning sequence (`RELAY_COMMISSIONING` in `main.c`, keep it 0; only ever enable it with the opener disconnected).
- Use a regulated 5V supply rated for at least 2A; provide additional margin if the ESP32-CAM shares the supply.
- All ESP32-S3-connected devices must share common GND.
- Never apply a 5V signal directly to an ESP32-S3 GPIO.

## Reserved GPIOs

Do not assign project peripherals to GPIO0, GPIO3, GPIO19, GPIO20, GPIO35, GPIO36, GPIO37, GPIO43, GPIO44, GPIO45, GPIO46, or GPIO48. These remain free for boot strapping, native USB, octal flash/PSRAM, UART/debug, special-purpose pins, or the onboard RGB LED as applicable to the N16R8 board.

## ESP32-CAM separation

The ESP32-CAM is a separate Wi-Fi device. It has no physical UART, SPI, I2C, or GPIO connection to the ESP32-S3 and is not part of this GPIO map. The ESP32-S3 must continue operating if the camera is offline.

## Sensor truth table

| CLOSED reed | OPEN reed | Derived state |
| --- | --- | --- |
| active | inactive | CLOSED |
| inactive | active | OPEN |
| inactive | inactive | UNKNOWN / motion-derived state |
| active | active | ERROR |
