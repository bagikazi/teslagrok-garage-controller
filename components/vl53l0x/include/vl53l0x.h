#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "driver/i2c_master.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VL53L0X_DEFAULT_ADDRESS 0x29

typedef struct {
    i2c_master_dev_handle_t dev;
    uint8_t stop_variable;
    uint32_t timing_budget_us;
    esp_err_t last_error; /* first I2C error since the last check; ESP_OK if none */
    uint8_t range_status; /* device range status of the last sample; 11 = valid */
} vl53l0x_t;

/**
 * Probe and initialize the sensor on an existing I2C master bus (2V8 I/O mode,
 * default ~33 ms timing budget). On failure the device handle is released.
 */
esp_err_t vl53l0x_init(vl53l0x_t *sensor, i2c_master_bus_handle_t bus, uint8_t address);

/**
 * Switch to long-range mode (~2 m instead of ~1.2 m) and set the per-sample
 * timing budget (>= 20000 us). Call after init and before starting ranging.
 */
esp_err_t vl53l0x_set_long_range(vl53l0x_t *sensor, uint32_t timing_budget_us);

/** Select long-range (true) or default ST ranging settings; call while not ranging. */
esp_err_t vl53l0x_set_range_profile(vl53l0x_t *sensor, bool long_range, uint32_t timing_budget_us);

/**
 * Start continuous ranging: a new sample every period_ms (timed mode), or with
 * period_ms == 0 back-to-back, the next measurement starting as soon as the
 * previous one ends.
 */
esp_err_t vl53l0x_start_continuous(vl53l0x_t *sensor, uint32_t period_ms);

/** Stop continuous ranging (the laser stops pulsing). */
esp_err_t vl53l0x_stop_continuous(vl53l0x_t *sensor);

/**
 * Non-blocking read. Returns ESP_OK and the range when a new sample is ready,
 * ESP_ERR_NOT_FINISHED when no new sample is available yet, or an I2C error.
 * Out-of-range readings are reported as 8190/8191 mm by the sensor.
 */
esp_err_t vl53l0x_read_mm(vl53l0x_t *sensor, uint16_t *range_mm);

/** Release the I2C device handle. */
void vl53l0x_deinit(vl53l0x_t *sensor);

#ifdef __cplusplus
}
#endif
