#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    GARAGE_OBSTACLE_CLEAR = 0,
    GARAGE_OBSTACLE_WARNING,
    GARAGE_OBSTACLE_BLOCKED,
    GARAGE_OBSTACLE_SENSOR_FAULT
} garage_obstacle_state_t;

typedef enum {
    GARAGE_DOOR_OPEN = 0,
    GARAGE_DOOR_CLOSED,
    GARAGE_DOOR_OPENING,
    GARAGE_DOOR_CLOSING,
    GARAGE_DOOR_STOPPED,
    GARAGE_DOOR_UNKNOWN,
    GARAGE_DOOR_ERROR
} garage_door_state_t;

/*
 * Both sensors look sideways across the doorway at a fixed target (a light
 * barrier). With the doorway empty each one reads its baseline distance; an
 * object in the beam shortens the reading. Only "both sensors read their
 * baseline" counts as CLEAR: a missing, stale or too-long reading (for example
 * a dark car absorbing the TOF's infrared) is a SENSOR_FAULT, never clear.
 */
typedef struct {
    float hc_sr04_baseline_cm;
    float tof_baseline_cm;
    float tolerance_cm;
    float hc_sr04_valid_min_cm;
    float hc_sr04_valid_max_cm;
    float tof_valid_min_cm;
    float tof_valid_max_cm;
    uint32_t sensor_fault_timeout_ms;
    /* A sensor that reported BLOCKED must read this much above the blocking
     * threshold before it counts as clear again, so noise around the threshold
     * does not flap the state. */
    float hysteresis_cm;
    /* tof_baseline_cm <= 0 selects TOF presence mode: the far side is beyond
     * the VL53L0X range, so "no target" means clear and any reading at or
     * below tof_presence_max_cm means something is in the beam. */
    float tof_presence_max_cm;
} garage_safety_config_t;

/* Per-sensor BLOCKED memory for the hysteresis; zero-initialize once. */
typedef struct {
    bool hc_sr04_blocked;
    bool tof_blocked;
} garage_beam_latch_t;

typedef struct {
    bool hc_sr04_valid;
    float hc_sr04_cm;
    uint32_t hc_sr04_age_ms;
    bool tof_valid;
    float tof_cm;
    uint32_t tof_age_ms;
    bool tof_online; /* sensor initialized and still producing samples, with or without a target */
} garage_safety_sample_t;

garage_obstacle_state_t garage_obstacle_state(const garage_safety_config_t *config, const garage_safety_sample_t *sample);
/* Same as garage_obstacle_state, with hysteresis carried in latch (may be NULL). */
garage_obstacle_state_t garage_obstacle_state_latched(const garage_safety_config_t *config, const garage_safety_sample_t *sample, garage_beam_latch_t *latch);
bool garage_close_is_safe(garage_obstacle_state_t state);
garage_door_state_t garage_door_state_from_reeds(bool top_on, bool bottom_on, garage_door_state_t previous, bool movement_active);
const char *garage_obstacle_state_name(garage_obstacle_state_t state);
const char *garage_door_state_name(garage_door_state_t state);
