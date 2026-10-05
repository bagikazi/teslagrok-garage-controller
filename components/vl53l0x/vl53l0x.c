// VL53L0X time-of-flight driver for ESP-IDF (i2c_master API).
//
// C port of the Pololu VL53L0X Arduino library (https://github.com/pololu/vl53l0x-arduino),
// Copyright (c) 2017-2022 Pololu Corporation, MIT license. The Pololu library is
// itself based on ST's VL53L0X API (STSW-IMG005); register sequences are kept
// identical so behaviour matches the Arduino library.

#include "vl53l0x.h"

#include <string.h>
#include "esp_timer.h"

#define I2C_TIMEOUT_MS 50
#define POLL_TIMEOUT_US (500 * 1000)

enum {
    SYSRANGE_START = 0x00,
    SYSTEM_SEQUENCE_CONFIG = 0x01,
    SYSTEM_INTERMEASUREMENT_PERIOD = 0x04,
    SYSTEM_INTERRUPT_CONFIG_GPIO = 0x0A,
    SYSTEM_INTERRUPT_CLEAR = 0x0B,
    RESULT_INTERRUPT_STATUS = 0x13,
    RESULT_RANGE_STATUS = 0x14,
    FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT = 0x44,
    FINAL_RANGE_CONFIG_VALID_PHASE_LOW = 0x47,
    FINAL_RANGE_CONFIG_VALID_PHASE_HIGH = 0x48,
    PRE_RANGE_CONFIG_VALID_PHASE_LOW = 0x56,
    PRE_RANGE_CONFIG_VALID_PHASE_HIGH = 0x57,
    GLOBAL_CONFIG_VCSEL_WIDTH = 0x32,
    ALGO_PHASECAL_CONFIG_TIMEOUT = 0x30,
    ALGO_PHASECAL_LIM = 0x30, // on register page 1
    MSRC_CONFIG_TIMEOUT_MACROP = 0x46,
    PRE_RANGE_CONFIG_VCSEL_PERIOD = 0x50,
    PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI = 0x51,
    MSRC_CONFIG_CONTROL = 0x60,
    FINAL_RANGE_CONFIG_VCSEL_PERIOD = 0x70,
    FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI = 0x71,
    GPIO_HV_MUX_ACTIVE_HIGH = 0x84,
    VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV = 0x89,
    GLOBAL_CONFIG_SPAD_ENABLES_REF_0 = 0xB0,
    GLOBAL_CONFIG_REF_EN_START_SELECT = 0xB6,
    DYNAMIC_SPAD_NUM_REQUESTED_REF_SPAD = 0x4E,
    DYNAMIC_SPAD_REF_EN_START_OFFSET = 0x4F,
    IDENTIFICATION_MODEL_ID = 0xC0,
    OSC_CALIBRATE_VAL = 0xF8,
};

#define decode_vcsel_period(reg_val) (((reg_val) + 1) << 1)
#define encode_vcsel_period(period_pclks) (((period_pclks) >> 1) - 1)
#define calc_macro_period(vcsel_period_pclks) ((((uint32_t)2304 * (vcsel_period_pclks) * 1655) + 500) / 1000)

typedef struct {
    bool tcc, msrc, dss, pre_range, final_range;
} sequence_enables_t;

typedef struct {
    uint16_t pre_range_vcsel_period_pclks, final_range_vcsel_period_pclks;
    uint16_t msrc_dss_tcc_mclks, pre_range_mclks, final_range_mclks;
    uint32_t msrc_dss_tcc_us, pre_range_us, final_range_us;
} sequence_timeouts_t;

// ---- register access: errors latch into sensor->last_error -----------------

static void note(vl53l0x_t *s, esp_err_t err)
{
    if (err != ESP_OK && s->last_error == ESP_OK) s->last_error = err;
}

static void write_multi(vl53l0x_t *s, uint8_t reg, const uint8_t *src, size_t count)
{
    uint8_t buf[8];
    buf[0] = reg;
    memcpy(&buf[1], src, count);
    note(s, i2c_master_transmit(s->dev, buf, count + 1, I2C_TIMEOUT_MS));
}

static void read_multi(vl53l0x_t *s, uint8_t reg, uint8_t *dst, size_t count)
{
    esp_err_t err = i2c_master_transmit_receive(s->dev, &reg, 1, dst, count, I2C_TIMEOUT_MS);
    if (err != ESP_OK) memset(dst, 0, count);
    note(s, err);
}

static void write_reg(vl53l0x_t *s, uint8_t reg, uint8_t value) { write_multi(s, reg, &value, 1); }

static void write_reg16(vl53l0x_t *s, uint8_t reg, uint16_t value)
{
    const uint8_t b[2] = { value >> 8, value & 0xFF };
    write_multi(s, reg, b, 2);
}

static void write_reg32(vl53l0x_t *s, uint8_t reg, uint32_t value)
{
    const uint8_t b[4] = { value >> 24, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF };
    write_multi(s, reg, b, 4);
}

static uint8_t read_reg(vl53l0x_t *s, uint8_t reg)
{
    uint8_t v;
    read_multi(s, reg, &v, 1);
    return v;
}

static uint16_t read_reg16(vl53l0x_t *s, uint8_t reg)
{
    uint8_t b[2];
    read_multi(s, reg, b, 2);
    return (uint16_t)(b[0] << 8) | b[1];
}

static bool timed_out(int64_t start_us)
{
    return esp_timer_get_time() - start_us > POLL_TIMEOUT_US;
}

// ---- timeout helpers --------------------------------------------------------

static uint16_t decode_timeout(uint16_t reg_val)
{
    return (uint16_t)((reg_val & 0x00FF) << (uint16_t)((reg_val & 0xFF00) >> 8)) + 1;
}

static uint16_t encode_timeout(uint32_t timeout_mclks)
{
    if (timeout_mclks == 0) return 0;
    uint32_t ls_byte = timeout_mclks - 1;
    uint16_t ms_byte = 0;
    while ((ls_byte & 0xFFFFFF00) > 0) {
        ls_byte >>= 1;
        ms_byte++;
    }
    return (ms_byte << 8) | (ls_byte & 0xFF);
}

static uint32_t mclks_to_us(uint16_t timeout_mclks, uint8_t vcsel_period_pclks)
{
    const uint32_t macro_period_ns = calc_macro_period(vcsel_period_pclks);
    return ((timeout_mclks * macro_period_ns) + 500) / 1000;
}

static uint32_t us_to_mclks(uint32_t timeout_us, uint8_t vcsel_period_pclks)
{
    const uint32_t macro_period_ns = calc_macro_period(vcsel_period_pclks);
    return ((timeout_us * 1000) + (macro_period_ns / 2)) / macro_period_ns;
}

static void get_sequence_enables(vl53l0x_t *s, sequence_enables_t *e)
{
    const uint8_t cfg = read_reg(s, SYSTEM_SEQUENCE_CONFIG);
    e->tcc = (cfg >> 4) & 1;
    e->dss = (cfg >> 3) & 1;
    e->msrc = (cfg >> 2) & 1;
    e->pre_range = (cfg >> 6) & 1;
    e->final_range = (cfg >> 7) & 1;
}

static void get_sequence_timeouts(vl53l0x_t *s, const sequence_enables_t *e, sequence_timeouts_t *t)
{
    t->pre_range_vcsel_period_pclks = decode_vcsel_period(read_reg(s, PRE_RANGE_CONFIG_VCSEL_PERIOD));
    t->msrc_dss_tcc_mclks = read_reg(s, MSRC_CONFIG_TIMEOUT_MACROP) + 1;
    t->msrc_dss_tcc_us = mclks_to_us(t->msrc_dss_tcc_mclks, t->pre_range_vcsel_period_pclks);
    t->pre_range_mclks = decode_timeout(read_reg16(s, PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI));
    t->pre_range_us = mclks_to_us(t->pre_range_mclks, t->pre_range_vcsel_period_pclks);
    t->final_range_vcsel_period_pclks = decode_vcsel_period(read_reg(s, FINAL_RANGE_CONFIG_VCSEL_PERIOD));
    t->final_range_mclks = decode_timeout(read_reg16(s, FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI));
    if (e->pre_range) t->final_range_mclks -= t->pre_range_mclks;
    t->final_range_us = mclks_to_us(t->final_range_mclks, t->final_range_vcsel_period_pclks);
}

// Overheads from VL53L0X_get/set_measurement_timing_budget_micro_seconds().
enum {
    START_OVERHEAD = 1910, END_OVERHEAD = 960, MSRC_OVERHEAD = 660, TCC_OVERHEAD = 590,
    DSS_OVERHEAD = 690, PRE_RANGE_OVERHEAD = 660, FINAL_RANGE_OVERHEAD = 550,
};

static uint32_t sequence_budget_us(const sequence_enables_t *e, const sequence_timeouts_t *t)
{
    uint32_t budget = START_OVERHEAD + END_OVERHEAD;
    if (e->tcc) budget += t->msrc_dss_tcc_us + TCC_OVERHEAD;
    if (e->dss) budget += 2 * (t->msrc_dss_tcc_us + DSS_OVERHEAD);
    else if (e->msrc) budget += t->msrc_dss_tcc_us + MSRC_OVERHEAD;
    if (e->pre_range) budget += t->pre_range_us + PRE_RANGE_OVERHEAD;
    return budget;
}

static uint32_t get_timing_budget(vl53l0x_t *s)
{
    sequence_enables_t e;
    sequence_timeouts_t t;
    get_sequence_enables(s, &e);
    get_sequence_timeouts(s, &e, &t);
    uint32_t budget = sequence_budget_us(&e, &t);
    if (e.final_range) budget += t.final_range_us + FINAL_RANGE_OVERHEAD;
    return budget;
}

static bool set_timing_budget(vl53l0x_t *s, uint32_t budget_us)
{
    sequence_enables_t e;
    sequence_timeouts_t t;
    get_sequence_enables(s, &e);
    get_sequence_timeouts(s, &e, &t);
    if (!e.final_range) return true;

    const uint32_t used = sequence_budget_us(&e, &t) + FINAL_RANGE_OVERHEAD;
    if (used > budget_us) return false;

    // The final range timeout includes the pre-range timeout, both in MCLKs.
    uint32_t final_mclks = us_to_mclks(budget_us - used, t.final_range_vcsel_period_pclks);
    if (e.pre_range) final_mclks += t.pre_range_mclks;
    write_reg16(s, FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI, encode_timeout(final_mclks));
    s->timing_budget_us = budget_us;
    return true;
}

static bool get_spad_info(vl53l0x_t *s, uint8_t *count, bool *type_is_aperture)
{
    write_reg(s, 0x80, 0x01);
    write_reg(s, 0xFF, 0x01);
    write_reg(s, 0x00, 0x00);
    write_reg(s, 0xFF, 0x06);
    write_reg(s, 0x83, read_reg(s, 0x83) | 0x04);
    write_reg(s, 0xFF, 0x07);
    write_reg(s, 0x81, 0x01);
    write_reg(s, 0x80, 0x01);
    write_reg(s, 0x94, 0x6b);
    write_reg(s, 0x83, 0x00);

    const int64_t start = esp_timer_get_time();
    while (read_reg(s, 0x83) == 0x00) {
        if (timed_out(start) || s->last_error != ESP_OK) return false;
    }
    write_reg(s, 0x83, 0x01);
    const uint8_t tmp = read_reg(s, 0x92);
    *count = tmp & 0x7f;
    *type_is_aperture = (tmp >> 7) & 0x01;

    write_reg(s, 0x81, 0x00);
    write_reg(s, 0xFF, 0x06);
    write_reg(s, 0x83, read_reg(s, 0x83) & ~0x04);
    write_reg(s, 0xFF, 0x01);
    write_reg(s, 0x00, 0x01);
    write_reg(s, 0xFF, 0x00);
    write_reg(s, 0x80, 0x00);
    return true;
}

static bool single_ref_calibration(vl53l0x_t *s, uint8_t vhv_init_byte)
{
    write_reg(s, SYSRANGE_START, 0x01 | vhv_init_byte);
    const int64_t start = esp_timer_get_time();
    while ((read_reg(s, RESULT_INTERRUPT_STATUS) & 0x07) == 0) {
        if (timed_out(start) || s->last_error != ESP_OK) return false;
    }
    write_reg(s, SYSTEM_INTERRUPT_CLEAR, 0x01);
    write_reg(s, SYSRANGE_START, 0x00);
    return true;
}

// DefaultTuningSettings from ST's vl53l0x_tuning.h, as {register, value} pairs.
static const uint8_t k_tuning[][2] = {
    {0xFF, 0x01}, {0x00, 0x00}, {0xFF, 0x00}, {0x09, 0x00}, {0x10, 0x00}, {0x11, 0x00},
    {0x24, 0x01}, {0x25, 0xFF}, {0x75, 0x00}, {0xFF, 0x01}, {0x4E, 0x2C}, {0x48, 0x00},
    {0x30, 0x20}, {0xFF, 0x00}, {0x30, 0x09}, {0x54, 0x00}, {0x31, 0x04}, {0x32, 0x03},
    {0x40, 0x83}, {0x46, 0x25}, {0x60, 0x00}, {0x27, 0x00}, {0x50, 0x06}, {0x51, 0x00},
    {0x52, 0x96}, {0x56, 0x08}, {0x57, 0x30}, {0x61, 0x00}, {0x62, 0x00}, {0x64, 0x00},
    {0x65, 0x00}, {0x66, 0xA0}, {0xFF, 0x01}, {0x22, 0x32}, {0x47, 0x14}, {0x49, 0xFF},
    {0x4A, 0x00}, {0xFF, 0x00}, {0x7A, 0x0A}, {0x7B, 0x00}, {0x78, 0x21}, {0xFF, 0x01},
    {0x23, 0x34}, {0x42, 0x00}, {0x44, 0xFF}, {0x45, 0x26}, {0x46, 0x05}, {0x40, 0x40},
    {0x0E, 0x06}, {0x20, 0x1A}, {0x43, 0x40}, {0xFF, 0x00}, {0x34, 0x03}, {0x35, 0x44},
    {0xFF, 0x01}, {0x31, 0x04}, {0x4B, 0x09}, {0x4C, 0x05}, {0x4D, 0x04}, {0xFF, 0x00},
    {0x44, 0x00}, {0x45, 0x20}, {0x47, 0x08}, {0x48, 0x28}, {0x67, 0x00}, {0x70, 0x04},
    {0x71, 0x01}, {0x72, 0xFE}, {0x76, 0x00}, {0x77, 0x00}, {0xFF, 0x01}, {0x0D, 0x01},
    {0xFF, 0x00}, {0x80, 0x01}, {0x01, 0xF8}, {0xFF, 0x01}, {0x8E, 0x01}, {0x00, 0x01},
    {0xFF, 0x00}, {0x80, 0x00},
};

static esp_err_t init_sequence(vl53l0x_t *s)
{
    if (read_reg(s, IDENTIFICATION_MODEL_ID) != 0xEE) {
        return s->last_error != ESP_OK ? s->last_error : ESP_ERR_NOT_FOUND;
    }

    // VL53L0X_DataInit(): 2V8 I/O mode, I2C standard mode, read stop variable.
    write_reg(s, VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV, read_reg(s, VHV_CONFIG_PAD_SCL_SDA__EXTSUP_HV) | 0x01);
    write_reg(s, 0x88, 0x00);
    write_reg(s, 0x80, 0x01);
    write_reg(s, 0xFF, 0x01);
    write_reg(s, 0x00, 0x00);
    s->stop_variable = read_reg(s, 0x91);
    write_reg(s, 0x00, 0x01);
    write_reg(s, 0xFF, 0x00);
    write_reg(s, 0x80, 0x00);

    // Disable SIGNAL_RATE_MSRC and SIGNAL_RATE_PRE_RANGE limit checks; final
    // range signal rate limit 0.25 MCPS in Q9.7.
    write_reg(s, MSRC_CONFIG_CONTROL, read_reg(s, MSRC_CONFIG_CONTROL) | 0x12);
    write_reg16(s, FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT, (uint16_t)(0.25f * (1 << 7)));
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0xFF);

    // VL53L0X_StaticInit(): reference SPADs from NVM.
    uint8_t spad_count;
    bool spad_is_aperture;
    if (!get_spad_info(s, &spad_count, &spad_is_aperture)) return ESP_ERR_TIMEOUT;

    uint8_t ref_spad_map[6];
    read_multi(s, GLOBAL_CONFIG_SPAD_ENABLES_REF_0, ref_spad_map, 6);
    write_reg(s, 0xFF, 0x01);
    write_reg(s, DYNAMIC_SPAD_REF_EN_START_OFFSET, 0x00);
    write_reg(s, DYNAMIC_SPAD_NUM_REQUESTED_REF_SPAD, 0x2C);
    write_reg(s, 0xFF, 0x00);
    write_reg(s, GLOBAL_CONFIG_REF_EN_START_SELECT, 0xB4);

    const uint8_t first_spad = spad_is_aperture ? 12 : 0;
    uint8_t spads_enabled = 0;
    for (uint8_t i = 0; i < 48; i++) {
        if (i < first_spad || spads_enabled == spad_count) {
            ref_spad_map[i / 8] &= ~(1 << (i % 8));
        } else if ((ref_spad_map[i / 8] >> (i % 8)) & 0x1) {
            spads_enabled++;
        }
    }
    write_multi(s, GLOBAL_CONFIG_SPAD_ENABLES_REF_0, ref_spad_map, 6);

    for (size_t i = 0; i < sizeof(k_tuning) / sizeof(k_tuning[0]); i++) {
        write_reg(s, k_tuning[i][0], k_tuning[i][1]);
    }

    // Interrupt on new sample ready, active low.
    write_reg(s, SYSTEM_INTERRUPT_CONFIG_GPIO, 0x04);
    write_reg(s, GPIO_HV_MUX_ACTIVE_HIGH, read_reg(s, GPIO_HV_MUX_ACTIVE_HIGH) & ~0x10);
    write_reg(s, SYSTEM_INTERRUPT_CLEAR, 0x01);

    // Disable MSRC and TCC, then recalculate the timing budget.
    s->timing_budget_us = get_timing_budget(s);
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0xE8);
    set_timing_budget(s, s->timing_budget_us);

    // VL53L0X_PerformRefCalibration(): VHV then phase calibration.
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0x01);
    if (!single_ref_calibration(s, 0x40)) return ESP_ERR_TIMEOUT;
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0x02);
    if (!single_ref_calibration(s, 0x00)) return ESP_ERR_TIMEOUT;
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0xE8);

    return s->last_error;
}

typedef enum { VCSEL_PRE_RANGE, VCSEL_FINAL_RANGE } vcsel_period_type_t;

// Based on VL53L0X_set_vcsel_pulse_period(). Valid periods: pre 12-18, final 8-14 (even).
static bool set_vcsel_pulse_period(vl53l0x_t *s, vcsel_period_type_t type, uint8_t period_pclks)
{
    const uint8_t vcsel_period_reg = encode_vcsel_period(period_pclks);
    sequence_enables_t e;
    sequence_timeouts_t t;
    get_sequence_enables(s, &e);
    get_sequence_timeouts(s, &e, &t);

    if (type == VCSEL_PRE_RANGE) {
        uint8_t phase_high;
        switch (period_pclks) {
            case 12: phase_high = 0x18; break;
            case 14: phase_high = 0x30; break;
            case 16: phase_high = 0x40; break;
            case 18: phase_high = 0x50; break;
            default: return false;
        }
        write_reg(s, PRE_RANGE_CONFIG_VALID_PHASE_HIGH, phase_high);
        write_reg(s, PRE_RANGE_CONFIG_VALID_PHASE_LOW, 0x08);
        write_reg(s, PRE_RANGE_CONFIG_VCSEL_PERIOD, vcsel_period_reg);

        const uint16_t pre_mclks = us_to_mclks(t.pre_range_us, period_pclks);
        write_reg16(s, PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI, encode_timeout(pre_mclks));
        const uint16_t msrc_mclks = us_to_mclks(t.msrc_dss_tcc_us, period_pclks);
        write_reg(s, MSRC_CONFIG_TIMEOUT_MACROP, (msrc_mclks > 256) ? 255 : (msrc_mclks - 1));
    } else {
        uint8_t phase_high, vcsel_width, phasecal_timeout, phasecal_lim;
        switch (period_pclks) {
            case 8:  phase_high = 0x10; vcsel_width = 0x02; phasecal_timeout = 0x0C; phasecal_lim = 0x30; break;
            case 10: phase_high = 0x28; vcsel_width = 0x03; phasecal_timeout = 0x09; phasecal_lim = 0x20; break;
            case 12: phase_high = 0x38; vcsel_width = 0x03; phasecal_timeout = 0x08; phasecal_lim = 0x20; break;
            case 14: phase_high = 0x48; vcsel_width = 0x03; phasecal_timeout = 0x07; phasecal_lim = 0x20; break;
            default: return false;
        }
        write_reg(s, FINAL_RANGE_CONFIG_VALID_PHASE_HIGH, phase_high);
        write_reg(s, FINAL_RANGE_CONFIG_VALID_PHASE_LOW, 0x08);
        write_reg(s, GLOBAL_CONFIG_VCSEL_WIDTH, vcsel_width);
        write_reg(s, ALGO_PHASECAL_CONFIG_TIMEOUT, phasecal_timeout);
        write_reg(s, 0xFF, 0x01);
        write_reg(s, ALGO_PHASECAL_LIM, phasecal_lim);
        write_reg(s, 0xFF, 0x00);
        write_reg(s, FINAL_RANGE_CONFIG_VCSEL_PERIOD, vcsel_period_reg);

        uint32_t final_mclks = us_to_mclks(t.final_range_us, period_pclks);
        if (e.pre_range) final_mclks += t.pre_range_mclks;
        write_reg16(s, FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI, encode_timeout(final_mclks));
    }

    // Re-apply the timing budget, then redo phase calibration for the new period.
    set_timing_budget(s, s->timing_budget_us);
    const uint8_t sequence_config = read_reg(s, SYSTEM_SEQUENCE_CONFIG);
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, 0x02);
    single_ref_calibration(s, 0x00);
    write_reg(s, SYSTEM_SEQUENCE_CONFIG, sequence_config);
    return true;
}

esp_err_t vl53l0x_set_range_profile(vl53l0x_t *s, bool long_range, uint32_t timing_budget_us)
{
    s->last_error = ESP_OK;
    // Long range = Pololu "LONG_RANGE" example: lower return-signal limit
    // (0.1 MCPS) and longer VCSEL pulses. Default = ST defaults (0.25 MCPS,
    // VCSEL 14/10 PCLKs): about 1.2 m, shorter laser pulses.
    write_reg16(s, FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT, (uint16_t)((long_range ? 0.1f : 0.25f) * (1 << 7)));
    if (!set_vcsel_pulse_period(s, VCSEL_PRE_RANGE, long_range ? 18 : 14)) return ESP_ERR_INVALID_STATE;
    if (!set_vcsel_pulse_period(s, VCSEL_FINAL_RANGE, long_range ? 14 : 10)) return ESP_ERR_INVALID_STATE;
    if (!set_timing_budget(s, timing_budget_us)) return ESP_ERR_INVALID_ARG;
    return s->last_error;
}

esp_err_t vl53l0x_set_long_range(vl53l0x_t *s, uint32_t timing_budget_us)
{
    return vl53l0x_set_range_profile(s, true, timing_budget_us);
}

esp_err_t vl53l0x_init(vl53l0x_t *sensor, i2c_master_bus_handle_t bus, uint8_t address)
{
    if (!sensor || !bus) return ESP_ERR_INVALID_ARG;
    memset(sensor, 0, sizeof(*sensor));

    esp_err_t err = i2c_master_probe(bus, address, I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;

    const i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = address,
        .scl_speed_hz = 100000,
    };
    err = i2c_master_bus_add_device(bus, &dev_cfg, &sensor->dev);
    if (err != ESP_OK) return err;

    err = init_sequence(sensor);
    if (err != ESP_OK) vl53l0x_deinit(sensor);
    return err;
}

esp_err_t vl53l0x_start_continuous(vl53l0x_t *s, uint32_t period_ms)
{
    s->last_error = ESP_OK;
    write_reg(s, 0x80, 0x01);
    write_reg(s, 0xFF, 0x01);
    write_reg(s, 0x00, 0x00);
    write_reg(s, 0x91, s->stop_variable);
    write_reg(s, 0x00, 0x01);
    write_reg(s, 0xFF, 0x00);
    write_reg(s, 0x80, 0x00);

    if (period_ms == 0) {
        write_reg(s, SYSRANGE_START, 0x02); // back-to-back: next measurement starts immediately
        return s->last_error;
    }
    const uint16_t osc_calibrate_val = read_reg16(s, OSC_CALIBRATE_VAL);
    if (osc_calibrate_val != 0) period_ms *= osc_calibrate_val;
    write_reg32(s, SYSTEM_INTERMEASUREMENT_PERIOD, period_ms);
    write_reg(s, SYSRANGE_START, 0x04); // continuous timed mode
    return s->last_error;
}

esp_err_t vl53l0x_stop_continuous(vl53l0x_t *s)
{
    s->last_error = ESP_OK;
    write_reg(s, SYSRANGE_START, 0x01); // single-shot mode: stops the ranging loop
    write_reg(s, 0xFF, 0x01);
    write_reg(s, 0x00, 0x00);
    write_reg(s, 0x91, 0x00);
    write_reg(s, 0x00, 0x01);
    write_reg(s, 0xFF, 0x00);
    return s->last_error;
}

esp_err_t vl53l0x_read_mm(vl53l0x_t *s, uint16_t *range_mm)
{
    s->last_error = ESP_OK;
    const uint8_t status = read_reg(s, RESULT_INTERRUPT_STATUS);
    if (s->last_error != ESP_OK) return s->last_error;
    if ((status & 0x07) == 0) return ESP_ERR_NOT_FINISHED;

    // One burst read of the result block: byte 0 holds the device range status
    // (bits 6:3), bytes 10-11 the range. Linearity gain 1000, no fractional ranging.
    uint8_t result[12];
    read_multi(s, RESULT_RANGE_STATUS, result, sizeof(result));
    s->range_status = (result[0] & 0x78) >> 3;
    const uint16_t range = (uint16_t)(result[10] << 8) | result[11];
    write_reg(s, SYSTEM_INTERRUPT_CLEAR, 0x01);
    if (s->last_error != ESP_OK) return s->last_error;
    *range_mm = range;
    return ESP_OK;
}

void vl53l0x_deinit(vl53l0x_t *sensor)
{
    if (sensor && sensor->dev) {
        i2c_master_bus_rm_device(sensor->dev);
        sensor->dev = NULL;
    }
}
