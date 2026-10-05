#include "safety_logic.h"

#include <math.h>

static bool valid_distance(float value, float minimum, float maximum)
{
    return isfinite(value) && value >= minimum && value <= maximum;
}

static garage_obstacle_state_t beam_state(bool valid, uint32_t age_ms, float cm, float min_cm, float max_cm,
                                          float baseline_cm, float tolerance_cm, uint32_t timeout_ms,
                                          float hysteresis_cm, bool *blocked)
{
    if (!valid || age_ms > timeout_ms || !valid_distance(cm, min_cm, max_cm)) return GARAGE_OBSTACLE_SENSOR_FAULT;
    const float threshold = baseline_cm - tolerance_cm + (blocked && *blocked ? hysteresis_cm : 0.0f);
    if (blocked) *blocked = cm < threshold;
    if (cm < threshold) return GARAGE_OBSTACLE_BLOCKED;
    if (cm <= baseline_cm + tolerance_cm) return GARAGE_OBSTACLE_CLEAR;
    return GARAGE_OBSTACLE_SENSOR_FAULT; // longer than the fixed target: misaligned or target missing
}

garage_obstacle_state_t garage_obstacle_state(const garage_safety_config_t *config, const garage_safety_sample_t *sample)
{
    return garage_obstacle_state_latched(config, sample, NULL);
}

static garage_obstacle_state_t presence_state(const garage_safety_config_t *config, const garage_safety_sample_t *sample, bool *blocked)
{
    if (!sample->tof_online) return GARAGE_OBSTACLE_SENSOR_FAULT;
    const bool fresh = sample->tof_valid && sample->tof_age_ms <= config->sensor_fault_timeout_ms;
    const float limit = config->tof_presence_max_cm + (blocked && *blocked ? config->hysteresis_cm : 0.0f);
    const bool near = fresh && sample->tof_cm <= limit;
    if (blocked) *blocked = near;
    return near ? GARAGE_OBSTACLE_BLOCKED : GARAGE_OBSTACLE_CLEAR;
}

garage_obstacle_state_t garage_obstacle_state_latched(const garage_safety_config_t *config, const garage_safety_sample_t *sample, garage_beam_latch_t *latch)
{
    if (!config || !sample) return GARAGE_OBSTACLE_SENSOR_FAULT;
    const garage_obstacle_state_t hc = beam_state(sample->hc_sr04_valid, sample->hc_sr04_age_ms, sample->hc_sr04_cm,
        config->hc_sr04_valid_min_cm, config->hc_sr04_valid_max_cm, config->hc_sr04_baseline_cm,
        config->tolerance_cm, config->sensor_fault_timeout_ms, config->hysteresis_cm, latch ? &latch->hc_sr04_blocked : NULL);
    const garage_obstacle_state_t tof = config->tof_baseline_cm <= 0.0f
        ? presence_state(config, sample, latch ? &latch->tof_blocked : NULL)
        : beam_state(sample->tof_valid, sample->tof_age_ms, sample->tof_cm,
            config->tof_valid_min_cm, config->tof_valid_max_cm, config->tof_baseline_cm,
            config->tolerance_cm, config->sensor_fault_timeout_ms, config->hysteresis_cm, latch ? &latch->tof_blocked : NULL);
    // Any sensor seeing an object wins; otherwise both must confirm the empty doorway.
    if (hc == GARAGE_OBSTACLE_BLOCKED || tof == GARAGE_OBSTACLE_BLOCKED) return GARAGE_OBSTACLE_BLOCKED;
    if (hc == GARAGE_OBSTACLE_CLEAR && tof == GARAGE_OBSTACLE_CLEAR) return GARAGE_OBSTACLE_CLEAR;
    return GARAGE_OBSTACLE_SENSOR_FAULT;
}

bool garage_close_is_safe(garage_obstacle_state_t state)
{
    return state == GARAGE_OBSTACLE_CLEAR || state == GARAGE_OBSTACLE_WARNING;
}

garage_door_state_t garage_door_state_from_reeds(bool top_on, bool bottom_on, garage_door_state_t previous, bool movement_active)
{
    if (top_on && bottom_on) return GARAGE_DOOR_ERROR;
    if (top_on) return GARAGE_DOOR_OPEN;
    if (bottom_on) return GARAGE_DOOR_CLOSED;
    if (movement_active && (previous == GARAGE_DOOR_OPENING || previous == GARAGE_DOOR_CLOSING)) return previous;
    return GARAGE_DOOR_STOPPED;
}

const char *garage_obstacle_state_name(garage_obstacle_state_t state)
{
    switch (state) {
        case GARAGE_OBSTACLE_CLEAR: return "CLEAR";
        case GARAGE_OBSTACLE_WARNING: return "WARNING";
        case GARAGE_OBSTACLE_BLOCKED: return "BLOCKED";
        case GARAGE_OBSTACLE_SENSOR_FAULT: return "SENSOR_FAULT";
        default: return "SENSOR_FAULT";
    }
}

const char *garage_door_state_name(garage_door_state_t state)
{
    switch (state) {
        case GARAGE_DOOR_OPEN: return "OPEN";
        case GARAGE_DOOR_CLOSED: return "CLOSED";
        case GARAGE_DOOR_OPENING: return "OPENING";
        case GARAGE_DOOR_CLOSING: return "CLOSING";
        case GARAGE_DOOR_STOPPED: return "STOPPED";
        case GARAGE_DOOR_ERROR: return "ERROR";
        default: return "UNKNOWN";
    }
}
