#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Prefixed DISPLAY_ so this header can be included next to safety_logic.h. */
typedef enum {
    DISPLAY_DOOR_OPEN = 0,
    DISPLAY_DOOR_CLOSED,
    DISPLAY_DOOR_OPENING,
    DISPLAY_DOOR_CLOSING,
    DISPLAY_DOOR_STOPPED,
    DISPLAY_DOOR_UNKNOWN,
    DISPLAY_DOOR_ERROR
} display_door_state_t;

typedef enum {
    DISPLAY_ZONE_CLEAR = 0,
    DISPLAY_ZONE_WARNING,
    DISPLAY_ZONE_BLOCKED,
    DISPLAY_ZONE_SENSOR_FAULT
} display_zone_state_t;

typedef struct {
    display_door_state_t door_state;
    display_zone_state_t zone_state;

    bool top_reed_on;
    bool bottom_reed_on;

    bool hcsr04_valid;
    float hcsr04_cm;

    bool tof_valid;
    bool tof_online; /* sensor responding; !tof_valid && tof_online means no target in range */
    int16_t tof_range_cm; /* shown as "> N" when online without a target; 0 shows "--" */

    /* Photocell mode: the distance card shows the beam instead of HC-SR04/TOF. */
    bool photocell_mode;
    bool photocell_clear;
    float tof_cm;

    bool wifi_connected;
    int8_t wifi_level; /* 0-10 signal level, -1 when unknown */
    bool server_connected;

    bool light_on;
    bool pir_motion;
} display_ui_state_t;

/**
 * Build the 240x240 garage dashboard on the currently active LVGL screen.
 * The ST7789 driver and LVGL display registration must already be initialized.
 */
void display_ui_init(void);

/** Update the screen. Safe to call repeatedly; only dynamic labels/colors change. */
void display_ui_update(const display_ui_state_t *state);

/** Replace the header title (default "GARAGE"). */
void display_ui_set_title(const char *title);

/** Convenience access to the root object for integration/tests. */
lv_obj_t *display_ui_root(void);

#ifdef __cplusplus
}
#endif
