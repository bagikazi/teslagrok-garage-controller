#pragma once

#include "driver/gpio.h"

// ESP32-S3-DevKitC-1, ESP32-S3-WROOM-1 N16R8 final project contract.
// Keep all physical GPIO assignments in this file. Do not silently remap.

// ST7789 240x240 SPI display. BLK is permanently connected to 3V3.
#define PIN_TFT_MOSI GPIO_NUM_11
#define PIN_TFT_SCLK GPIO_NUM_12
#define PIN_TFT_DC   GPIO_NUM_13
#define PIN_TFT_RST  GPIO_NUM_14
#define PIN_TFT_CS   (-1) // The display has no CS pin; never allocate a GPIO.

// VL53L0X I2C. XSHUT and INT/GPIO1 are not connected.
#define PIN_TOF_SDA GPIO_NUM_8
#define PIN_TOF_SCL GPIO_NUM_9

// HC-SR501 PIR.
#define PIN_PIR GPIO_NUM_6

// Garage photocell (safety beam) receiver relay, a dry contact wired COM to GND
// and NO to this pin (internal pull-up). With the NO contact, the relay holds it
// closed while the beam is received, so LOW = clear; a broken beam, an unpowered
// photocell or a cut wire all read HIGH = obstacle. If the receiver works the
// other way round, flip PHOTOCELL_CLEAR_LEVEL.
#define PIN_PHOTOCELL GPIO_NUM_16
#define PHOTOCELL_CLEAR_LEVEL 0

// HC-SR04. ECHO reaches the ESP32-S3 through the specified voltage divider.
#define PIN_HCSR04_TRIG GPIO_NUM_7
#define PIN_HCSR04_ECHO GPIO_NUM_15

// Reed switches. Both inputs are active-low with internal pull-ups.
#define PIN_REED_OPEN GPIO_NUM_4
#define PIN_REED_CLOSED GPIO_NUM_5

// Relay module inputs: four adjacent header pins with no boot/strapping role.
// GPIO39-42 double as the external JTAG pads, which this project never uses
// (debugging goes through the built-in USB-JTAG).
#define PIN_RELAY_UP GPIO_NUM_39
#define PIN_RELAY_DOWN GPIO_NUM_40
#define PIN_RELAY_STOP GPIO_NUM_41
#define PIN_RELAY_LIGHT GPIO_NUM_42

// Relay polarity and commissioning guard are centralized here.
#define RELAY_ACTIVE_LOW 1
// Locks the door relays (UP/DOWN/STOP): commands are processed but never pulse.
// Unlocked on 2026-09-21 at the owner's request with the opener NOT connected,
// to hear the relays click. Set back to 1 before wiring the opener unless the
// reed switches are fitted and the first runs are supervised at the door.
#define SAFE_TEST_MODE 0
// The light relay only switches a lamp (no motion hazard), so it is exempt from
// SAFE_TEST_MODE. Set to 0 to lock it together with the door relays.
#define LIGHT_RELAY_LIVE 1

// Reserved on ESP32-S3-DevKitC-1 N16R8; do not assign project peripherals.
// GPIO0, 3, 19, 20, 35, 36, 37, 43, 44, 45, 46 and 48 remain unused.
