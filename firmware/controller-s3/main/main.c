#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "board_config.h"
#include "cJSON.h"
#include "display_driver.h"
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_netif_sntp.h"
#include "esp_rom_sys.h"
#include "mqtt_client.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "safety_logic.h"
#include "vl53l0x.h"

static const char *TAG = "garage-s3";
static EventGroupHandle_t wifi_events;
static esp_mqtt_client_handle_t mqtt_client;
static uint32_t sequence;
static char boot_id[17];
static char last_command_id[40];
static char availability_topic[96];
static char command_topic[96];
static SemaphoreHandle_t s_relay_lock;
extern const uint8_t mqtt_ca_crt_start[] asm("_binary_mqtt_ca_crt_start");

#define STATUS_PERIOD_MS 200
#define STATE_PUBLISH_PERIOD_MS 2000
#define RSSI_POLL_MS 2000
#define TELEMETRY_PERIOD_MS 10000
#define REED_DEBOUNCE_SAMPLES 3
#define DOOR_TRAVEL_TIMEOUT_MS 30000
#define HCSR04_MIN_CM 2.0f
#define HCSR04_MAX_CM 400.0f
// Back-to-back ranging (period 0): the laser draws a steady current. Timed mode
// (measure 50 ms, idle 50 ms) modulated the shared 3V3 rail at 10 Hz, and the
// ST7789 backlight, wired straight to 3V3 near its LED forward voltage, blinked
// visibly; a bulk capacitor cannot smooth a load that changes every 50 ms.
#define TOF_PERIOD_MS 0
#define TOF_TIMING_BUDGET_US 50000
#define TOF_RETRY_MS 5000
// No new sample for this long means the sensor reset (e.g. a supply dip) and stopped ranging.
#define TOF_STALL_MS 1000
#define BEAM_HYSTERESIS_CM 3.0f
#define TOF_MIN_CM 3.0f
#define TOF_MAX_CM 200.0f
// Presence mode: TOF readings at or below this count as an object in the beam.
#define TOF_PRESENCE_MAX_CM 150.0f
// Median-window value for a sample with no target in range.
#define TOF_NO_TARGET_CM 100000.0f

// Calibration samples the empty doorway for CALIBRATION_MS and stores the
// median of each sensor as its baseline. It needs enough readings and at least
// CALIBRATION_STABLE_PCT of them within CALIBRATION_SPREAD_CM of the median.
#define CALIBRATION_MS 3000
#define CALIBRATION_MAX_SAMPLES 32
#define CALIBRATION_MIN_HC 10
#define CALIBRATION_MIN_TOF 6
#define CALIBRATION_SPREAD_CM 5.0f
#define CALIBRATION_STABLE_PCT 70
#define NVS_NAMESPACE "garage"

// Doorway obstacle source. 1 = HC-SR04 + VL53L0X distance beam (code kept for
// later); 0 = garage photocell on PIN_PHOTOCELL, the installed setup.
#define USE_DISTANCE_SENSORS 0
// Photocell: an obstacle counts immediately; the beam must stay intact for this
// many consecutive samples (x STATUS_PERIOD_MS) before the doorway is clear again.
#define PHOTOCELL_CLEAR_SAMPLES 3

// Temporary backlight-flicker diagnosis: every FLICKER_DIAG_STEP_MS switch off
// another load on the 3.3 V rail and show the active step in the header.
#define FLICKER_DIAG 0
#define FLICKER_DIAG_STEP_MS 15000
#if FLICKER_DIAG
static const char *const k_diag_titles[] = { "TEST A: NORMAL", "TEST B: OKUMA YOK", "TEST C: LAZER YOK", "TEST D: KISA MENZIL" };
#endif

// Written only by status_task; read by the MQTT handler (aligned reads are atomic).
static volatile garage_door_state_t s_door = GARAGE_DOOR_UNKNOWN;
static volatile bool s_mqtt_connected;
// Written by status_task; read by the MQTT handler to interlock CLOSE. Fault until proven clear.
static volatile garage_obstacle_state_t s_obstacle = GARAGE_OBSTACLE_SENSOR_FAULT;
// Set by the MQTT task, consumed by status_task (which owns all sensor/publish state).
static volatile bool s_publish_now;
static volatile bool s_calibrate_requested;
static char s_calibrate_command_id[40];
// Web light command for status_task: 0 none, 1 on, 2 off.
static volatile int s_light_request;
static char s_light_command_id[40];

#define PIR_EVENT_MIN_INTERVAL_MS 30000 // at most one PIR_MOTION activity entry per 30 s

typedef enum { LIGHT_OFF = 0, LIGHT_AUTO, LIGHT_MANUAL } light_mode_t;
static const char *light_mode_name(light_mode_t mode) { return mode == LIGHT_AUTO ? "AUTO" : mode == LIGHT_MANUAL ? "MANUAL" : "OFF"; }

typedef struct {
    bool open_reed, closed_reed, pir, light_on;
    light_mode_t light_mode;
    bool hc_fresh, tof_fresh, tof_online;
    bool photocell_clear;
    float hc_cm, tof_cm;
    float hc_baseline_cm, tof_baseline_cm, tolerance_cm;
} sensor_snapshot_t;

static bool pin_is_active(int pin) { return pin >= 0 && gpio_get_level(pin) == GARAGE_SENSOR_ACTIVE_LEVEL; }
static const char *door_state(void) { return garage_door_state_name(s_door); }
static void utc_now(char *out, size_t length) { time_t now; struct tm utc; time(&now); gmtime_r(&now, &utc); strftime(out, length, "%Y-%m-%dT%H:%M:%SZ", &utc); }
static void publish_topic(const char *kind, const char *payload, int qos, bool retain) { char topic[96]; snprintf(topic, sizeof(topic), "garage/%s/%s", CONFIG_GARAGE_DEVICE_ID, kind); esp_mqtt_client_publish(mqtt_client, topic, payload, 0, qos, retain); }

static void publish_availability(bool online) { if (mqtt_client) esp_mqtt_client_publish(mqtt_client, availability_topic, online ? "{\"online\":true}" : "{\"online\":false}", 0, 1, true); }

static void add_distance(cJSON *obj, const char *key, bool valid, float cm) {
    if (valid) cJSON_AddNumberToObject(obj, key, (double)((int)(cm * 10.0f + 0.5f)) / 10.0);
    else cJSON_AddNullToObject(obj, key);
}

// Called only from status_task.
static void publish_state(const sensor_snapshot_t *snap) {
    if (!mqtt_client || !s_mqtt_connected) return;
    char timestamp[32]; utc_now(timestamp, sizeof(timestamp));
    cJSON *root = cJSON_CreateObject(); cJSON *sensors = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId", CONFIG_GARAGE_DEVICE_ID); cJSON_AddStringToObject(root, "timestamp", timestamp); cJSON_AddNumberToObject(root, "sequence", sequence++); cJSON_AddStringToObject(root, "bootId", boot_id); cJSON_AddStringToObject(root, "firmwareVersion", CONFIG_GARAGE_FIRMWARE_VERSION); cJSON_AddStringToObject(root, "state", door_state());
    const garage_obstacle_state_t obstacle = s_obstacle;
    cJSON_AddBoolToObject(sensors, "closed", snap->closed_reed);
    cJSON_AddBoolToObject(sensors, "open", snap->open_reed);
    cJSON_AddBoolToObject(sensors, "top", snap->open_reed);
    cJSON_AddBoolToObject(sensors, "bottom", snap->closed_reed);
    cJSON_AddBoolToObject(sensors, "obstruction", obstacle == GARAGE_OBSTACLE_BLOCKED);
    cJSON_AddStringToObject(sensors, "obstacleState", garage_obstacle_state_name(obstacle));
#if USE_DISTANCE_SENSORS
    cJSON_AddStringToObject(sensors, "beamSource", "distance");
    add_distance(sensors, "hcSr04DistanceCm", snap->hc_fresh, snap->hc_cm);
    add_distance(sensors, "tofDistanceCm", snap->tof_fresh, snap->tof_cm);
    cJSON_AddBoolToObject(sensors, "hcSr04Healthy", snap->hc_fresh);
    cJSON_AddBoolToObject(sensors, "tofHealthy", snap->tof_fresh);
    add_distance(sensors, "hcSr04BaselineCm", true, snap->hc_baseline_cm);
    add_distance(sensors, "tofBaselineCm", snap->tof_baseline_cm > 0.0f, snap->tof_baseline_cm);
    cJSON_AddBoolToObject(sensors, "tofOnline", snap->tof_online);
    cJSON_AddNumberToObject(sensors, "tofRangeCm", TOF_PRESENCE_MAX_CM);
    add_distance(sensors, "beamToleranceCm", true, snap->tolerance_cm);
#else
    cJSON_AddStringToObject(sensors, "beamSource", "photocell");
    cJSON_AddBoolToObject(sensors, "photocellClear", snap->photocell_clear);
#endif
    cJSON_AddBoolToObject(sensors, "relaysLocked", SAFE_TEST_MODE != 0);
    cJSON_AddBoolToObject(sensors, "pirMotion", snap->pir);
    cJSON_AddBoolToObject(sensors, "lightOn", snap->light_on);
    cJSON_AddStringToObject(sensors, "lightMode", light_mode_name(snap->light_mode));
    cJSON_AddItemToObject(root, "sensors", sensors);
    char *payload = cJSON_PrintUnformatted(root); publish_topic("state", payload, 1, true); free(payload); cJSON_Delete(root);
}

// Safety events (OBSTACLE_DETECTED, STOP_AND_REOPEN, ERROR) for the activity log.
static void publish_event(const char *type, const char *detail) {
    ESP_LOGW(TAG, "Event %s: %s", type, detail);
    if (!mqtt_client || !s_mqtt_connected) return;
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId", CONFIG_GARAGE_DEVICE_ID);
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddStringToObject(root, "detail", detail);
    char *payload = cJSON_PrintUnformatted(root); publish_topic("event", payload, 1, false); free(payload); cJSON_Delete(root);
}

/*
 * Wi-Fi link diagnostics for the web activity log. Every failed connection
 * attempt is counted by its disconnect reason. The counters live in NVS, so
 * attempts made in the garage without a link survive a power cycle, and they
 * are published as one WIFI_REPORT event once MQTT is connected again.
 */
#define WIFI_DIAG_REASONS 6
#define WIFI_DIAG_SAVE_MS 30000
#define WIFI_DIAG_NVS_KEY "wifi_diag"
typedef struct { uint8_t reason; uint16_t count; } wifi_reason_count_t;
typedef struct {
    uint32_t offline_s;  // offline time of earlier boots that did not report
    uint16_t attempts;   // failed connection attempts since the last report
    uint16_t boots;      // boots that ended before their report went out
    uint16_t brownouts;  // brownout resets since the last report
    int8_t last_rssi;    // 0 = no reading
    int8_t best_rssi;
    wifi_reason_count_t reasons[WIFI_DIAG_REASONS];
} wifi_diag_t;
static wifi_diag_t s_wifi_diag;
static SemaphoreHandle_t s_wifi_diag_lock;
static int64_t s_wifi_offline_since_ms;       // boot counts as offline
static int64_t s_wifi_diag_saved_ms = -WIFI_DIAG_SAVE_MS;
static bool s_wifi_link_up, s_wifi_report_pending = true, s_wifi_first_report = true;

static const char *wifi_reason_name(uint8_t reason) {
    switch (reason) {
        case WIFI_REASON_AUTH_EXPIRE: return "kimlik zaman aşımı";
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: case WIFI_REASON_HANDSHAKE_TIMEOUT: return "el sıkışma";
        case WIFI_REASON_BEACON_TIMEOUT: return "beacon kaybı";
        case WIFI_REASON_NO_AP_FOUND: return "AP yok";
        case WIFI_REASON_AUTH_FAIL: return "kimlik/şifre";
        case WIFI_REASON_ASSOC_FAIL: return "ilişkilendirme";
        case WIFI_REASON_CONNECTION_FAIL: return "bağlantı hatası";
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "güvenlik uyumsuz";
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD: return "güvenlik eşiği";
        default: return "kod";
    }
}

static const char *reset_reason_name(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "güç verildi";
        case ESP_RST_BROWNOUT: return "düşük voltaj";
        case ESP_RST_PANIC: return "çökme";
        case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: return "watchdog";
        case ESP_RST_SW: return "yazılım";
        case ESP_RST_EXT: return "reset pini";
        case ESP_RST_USB: return "USB";
        default: return "diğer";
    }
}

static void wifi_diag_save_locked(int64_t now_ms) {
    wifi_diag_t stored = s_wifi_diag;
    if (!s_wifi_link_up) stored.offline_s += (uint32_t)((now_ms - s_wifi_offline_since_ms) / 1000);
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) return;
    if (nvs_set_blob(nvs, WIFI_DIAG_NVS_KEY, &stored, sizeof(stored)) == ESP_OK) nvs_commit(nvs);
    nvs_close(nvs);
    s_wifi_diag_saved_ms = now_ms;
}

// Called once at boot, after nvs_flash_init().
static void wifi_diag_load(void) {
    s_wifi_diag_lock = xSemaphoreCreateMutex();
    nvs_handle_t nvs; size_t size = sizeof(s_wifi_diag); bool pending = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        pending = nvs_get_blob(nvs, WIFI_DIAG_NVS_KEY, &s_wifi_diag, &size) == ESP_OK && size == sizeof(s_wifi_diag);
        nvs_close(nvs);
    }
    if (!pending) memset(&s_wifi_diag, 0, sizeof(s_wifi_diag));
    if (pending) s_wifi_diag.boots++;
    if (esp_reset_reason() == ESP_RST_BROWNOUT) s_wifi_diag.brownouts++;
    if (pending || s_wifi_diag.brownouts > 0) wifi_diag_save_locked(0);
}

static void wifi_diag_record_disconnect(const wifi_event_sta_disconnected_t *disc) {
    const int64_t now_ms = esp_timer_get_time() / 1000;
    xSemaphoreTake(s_wifi_diag_lock, portMAX_DELAY);
    if (s_wifi_link_up) { s_wifi_link_up = false; s_wifi_offline_since_ms = now_ms; s_wifi_report_pending = true; }
    if (s_wifi_diag.attempts < UINT16_MAX) s_wifi_diag.attempts++;
    for (int i = 0; i < WIFI_DIAG_REASONS; i++) {
        wifi_reason_count_t *slot = &s_wifi_diag.reasons[i];
        if (slot->count != 0 && slot->reason != disc->reason) continue;
        slot->reason = disc->reason;
        if (slot->count < UINT16_MAX) slot->count++;
        break;
    }
    if (disc->rssi < 0 && disc->rssi > -120) {
        s_wifi_diag.last_rssi = disc->rssi;
        if (s_wifi_diag.best_rssi == 0 || disc->rssi > s_wifi_diag.best_rssi) s_wifi_diag.best_rssi = disc->rssi;
    }
    ESP_LOGW(TAG, "[WIFI] Disconnected: reason %u (%s), rssi %d", disc->reason, wifi_reason_name(disc->reason), disc->rssi);
    if (now_ms - s_wifi_diag_saved_ms >= WIFI_DIAG_SAVE_MS) wifi_diag_save_locked(now_ms);
    xSemaphoreGive(s_wifi_diag_lock);
}

static void wifi_diag_link_up(void) {
    xSemaphoreTake(s_wifi_diag_lock, portMAX_DELAY);
    s_wifi_link_up = true;
    xSemaphoreGive(s_wifi_diag_lock);
}

// On MQTT connect: publish the summary since the last report, then clear it.
static void wifi_diag_report(void) {
    const int64_t now_ms = esp_timer_get_time() / 1000;
    xSemaphoreTake(s_wifi_diag_lock, portMAX_DELAY);
    if (!s_wifi_report_pending) { xSemaphoreGive(s_wifi_diag_lock); return; }
    wifi_diag_t *d = &s_wifi_diag;
    const unsigned long offline_s = d->offline_s + (unsigned long)((now_ms - s_wifi_offline_since_ms) / 1000);
    char detail[200]; size_t n = 0;
    n += snprintf(detail + n, sizeof(detail) - n, "%s %lu sn, %u hata", s_wifi_first_report ? "Açılıştan bağlantıya" : "Kopukluk", offline_s, d->attempts);
    // Up to three reasons, most frequent first.
    bool used[WIFI_DIAG_REASONS] = {0};
    for (int k = 0; k < 3; k++) {
        int best = -1;
        for (int i = 0; i < WIFI_DIAG_REASONS; i++) if (!used[i] && d->reasons[i].count > 0 && (best < 0 || d->reasons[i].count > d->reasons[best].count)) best = i;
        if (best < 0) break;
        used[best] = true;
        if (n < sizeof(detail)) n += snprintf(detail + n, sizeof(detail) - n, "%s%u %s ×%u", k == 0 ? " · " : ", ", d->reasons[best].reason, wifi_reason_name(d->reasons[best].reason), d->reasons[best].count);
    }
    if (d->last_rssi != 0 && n < sizeof(detail)) n += snprintf(detail + n, sizeof(detail) - n, " · son %d, en iyi %d dBm", d->last_rssi, d->best_rssi);
    if (d->boots > 0 && n < sizeof(detail)) n += snprintf(detail + n, sizeof(detail) - n, " · %u yeniden açılış", d->boots);
    if (d->brownouts > 0 && n < sizeof(detail)) n += snprintf(detail + n, sizeof(detail) - n, " · %u düşük voltaj reseti", d->brownouts);
    if (s_wifi_first_report && n < sizeof(detail)) snprintf(detail + n, sizeof(detail) - n, " · açılış: %s", reset_reason_name(esp_reset_reason()));
    publish_event("WIFI_REPORT", detail);
    memset(d, 0, sizeof(*d));
    s_wifi_report_pending = false; s_wifi_first_report = false;
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) { nvs_erase_key(nvs, WIFI_DIAG_NVS_KEY); nvs_commit(nvs); nvs_close(nvs); }
    xSemaphoreGive(s_wifi_diag_lock);
}

static int relay_inactive_level(void) { return RELAY_ACTIVE_LOW ? 1 : 0; }
static int relay_active_level(void) { return RELAY_ACTIVE_LOW ? 0 : 1; }

static void relay_off(gpio_num_t pin) {
    if (pin >= 0) gpio_set_level(pin, relay_inactive_level());
}

static void relay_on(gpio_num_t pin) {
    if (pin >= 0) gpio_set_level(pin, relay_active_level());
}

// The lamp relay is held (not pulsed). Exempt from SAFE_TEST_MODE via LIGHT_RELAY_LIVE.
static void light_relay_set(bool on) {
#if LIGHT_RELAY_LIVE
    if (on) relay_on(PIN_RELAY_LIGHT); else relay_off(PIN_RELAY_LIGHT);
#else
    ESP_LOGW(TAG, "Light relay locked: would switch %s", on ? "ON" : "OFF");
#endif
}

// Serialized: the MQTT task and the closing guard in status_task may both pulse.
static void relay_pulse(gpio_num_t pin) {
    if (pin < 0) return;
    xSemaphoreTake(s_relay_lock, portMAX_DELAY);
#if SAFE_TEST_MODE
    ESP_LOGW(TAG, "SAFE_TEST_MODE: relay pulse suppressed on GPIO%d", pin);
#else
    relay_on(pin);
    vTaskDelay(pdMS_TO_TICKS(CONFIG_GARAGE_RELAY_PULSE_MS));
    relay_off(pin);
#endif
    xSemaphoreGive(s_relay_lock);
}

/*
 * Relay commissioning: with the garage opener DISCONNECTED, click IN1..IN4 in
 * turn at boot (bypassing SAFE_TEST_MODE) and name each relay on the display,
 * to verify wiring and active-low polarity. Must be 0 once the opener is wired.
 */
#define RELAY_COMMISSIONING 0
#define RELAY_COMMISSIONING_CYCLES 3
#if RELAY_COMMISSIONING
static void relay_commissioning(void) {
    const struct { gpio_num_t pin; const char *title; } relays[] = {
        { PIN_RELAY_UP, "ROLE 1: YUKARI" }, { PIN_RELAY_DOWN, "ROLE 2: ASAGI" },
        { PIN_RELAY_STOP, "ROLE 3: DUR" }, { PIN_RELAY_LIGHT, "ROLE 4: LAMBA" },
    };
    for (int cycle = 0; cycle < RELAY_COMMISSIONING_CYCLES; cycle++) {
        for (size_t i = 0; i < sizeof(relays) / sizeof(relays[0]); i++) {
            garage_display_set_title(relays[i].title);
            ESP_LOGW(TAG, "Commissioning: %s (GPIO%d) ON", relays[i].title, relays[i].pin);
            relay_on(relays[i].pin);
            vTaskDelay(pdMS_TO_TICKS(1000));
            relay_off(relays[i].pin);
            vTaskDelay(pdMS_TO_TICKS(700));
        }
    }
    garage_display_set_title("GARAGE");
}
#endif

static void configure_relay_outputs_safe(void) {
    const gpio_num_t relay_pins[] = { PIN_RELAY_UP, PIN_RELAY_DOWN, PIN_RELAY_STOP, PIN_RELAY_LIGHT };
    for (size_t index = 0; index < sizeof(relay_pins) / sizeof(relay_pins[0]); index++) {
        const gpio_num_t pin = relay_pins[index];
        // Set the output latch before selecting output mode so an active-low
        // relay never sees the active level during the direction transition.
        relay_off(pin);
        gpio_config_t config = {
            .pin_bit_mask = 1ULL << pin,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE
        };
        ESP_ERROR_CHECK(gpio_config(&config));
        relay_off(pin);
    }
}

static void configure_sensor_inputs(void) {
    const gpio_config_t reed_config = {
        .pin_bit_mask = (1ULL << PIN_REED_OPEN) | (1ULL << PIN_REED_CLOSED),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    ESP_ERROR_CHECK(gpio_config(&reed_config));

    const gpio_config_t sensor_config = {
        .pin_bit_mask = 1ULL << PIN_HCSR04_ECHO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    ESP_ERROR_CHECK(gpio_config(&sensor_config));

    // Pull-down: an unplugged or not-yet-fitted PIR must read "no motion"
    // instead of floating and switching the lamp on at random.
    const gpio_config_t pir_config = {
        .pin_bit_mask = 1ULL << PIN_PIR,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    ESP_ERROR_CHECK(gpio_config(&pir_config));

    // Photocell relay contact to GND: pull-up so an open contact reads HIGH (obstacle).
    const gpio_config_t photocell_config = {
        .pin_bit_mask = 1ULL << PIN_PHOTOCELL,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    ESP_ERROR_CHECK(gpio_config(&photocell_config));

    const gpio_config_t trigger_config = {
        .pin_bit_mask = 1ULL << PIN_HCSR04_TRIG,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    ESP_ERROR_CHECK(gpio_config(&trigger_config));
    gpio_set_level(PIN_HCSR04_TRIG, 0);
}

static gpio_num_t relay_for_action(const char *action) {
    if (strcmp(action, "OPEN") == 0) return PIN_RELAY_UP;
    if (strcmp(action, "CLOSE") == 0) return PIN_RELAY_DOWN;
    if (strcmp(action, "STOP") == 0) return PIN_RELAY_STOP;
    return GPIO_NUM_NC;
}

static void publish_ack(const char *command_id, bool accepted, const char *result) {
    char payload[256]; snprintf(payload, sizeof(payload), "{\"commandId\":\"%s\",\"accepted\":%s,\"result\":\"%s\",\"currentState\":\"%s\"}", command_id, accepted ? "true" : "false", result, door_state()); publish_topic("ack", payload, 1, false);
}

static void mqtt_command_handler(const char *data, int length) {
    cJSON *root = cJSON_ParseWithLength(data, length); if (!root) return;
    cJSON *id = cJSON_GetObjectItem(root, "commandId"), *action = cJSON_GetObjectItem(root, "action");
    if (!cJSON_IsString(id) || !cJSON_IsString(action)) { cJSON_Delete(root); return; }
    if (strncmp(last_command_id, id->valuestring, sizeof(last_command_id)) == 0) { cJSON_Delete(root); return; }
    strlcpy(last_command_id, id->valuestring, sizeof(last_command_id));

    // Calibration runs in status_task, which owns the sensors; it acks when done.
    if (strcmp(action->valuestring, "CALIBRATE") == 0) {
        if (!USE_DISTANCE_SENSORS) {
            publish_ack(id->valuestring, false, "calibration_not_needed: photocell");
        } else if (s_calibrate_requested) {
            publish_ack(id->valuestring, false, "calibration_busy");
        } else {
            strlcpy(s_calibrate_command_id, id->valuestring, sizeof(s_calibrate_command_id));
            s_calibrate_requested = true;
        }
        cJSON_Delete(root);
        return;
    }

    // Light switching runs in status_task, which owns the light state; it acks.
    const bool light_on_cmd = strcmp(action->valuestring, "LIGHT_ON") == 0;
    if (light_on_cmd || strcmp(action->valuestring, "LIGHT_OFF") == 0) {
        strlcpy(s_light_command_id, id->valuestring, sizeof(s_light_command_id));
        s_light_request = light_on_cmd ? 1 : 2;
        cJSON_Delete(root);
        return;
    }

    const char *state = door_state();
    // Local interlock: CLOSE is refused unless the doorway beam is confirmed clear.
    const garage_obstacle_state_t obstacle = s_obstacle;
    if (strcmp(action->valuestring, "CLOSE") == 0 && !garage_close_is_safe(obstacle)) {
        publish_ack(id->valuestring, false, "CLOSE_BLOCKED");
        ESP_LOGW(TAG, "Command %s CLOSE blocked: %s", id->valuestring, garage_obstacle_state_name(obstacle));
        cJSON_Delete(root);
        return;
    }
    // STOP is the kill switch: it always fires, whatever the tracked state, and
    // first releases the UP/DOWN relays in case a pulse is still being held.
    const bool is_stop = strcmp(action->valuestring, "STOP") == 0;
    bool should_pulse = is_stop || (strcmp(action->valuestring, "OPEN") == 0 && strcmp(state, "OPEN") != 0) || (strcmp(action->valuestring, "CLOSE") == 0 && strcmp(state, "CLOSED") != 0);
    if (is_stop) { relay_off(PIN_RELAY_UP); relay_off(PIN_RELAY_DOWN); }
    if (should_pulse) relay_pulse(relay_for_action(action->valuestring));
    publish_ack(id->valuestring, true, should_pulse ? (SAFE_TEST_MODE ? "safe_test_mode" : "pulse_triggered") : "already_reached");
    ESP_LOGI(TAG, "Command %s accepted=%s state=%s", id->valuestring, should_pulse ? "true" : "false", state);
    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)handler_args; (void)base; esp_mqtt_event_handle_t event = event_data;
    if (event_id == MQTT_EVENT_CONNECTED) {
        s_mqtt_connected = true;
        ESP_LOGI(TAG, "MQTT connected");
        esp_mqtt_client_subscribe(mqtt_client, command_topic, 1);
        publish_availability(true);
        s_publish_now = true;
        wifi_diag_report();
    }
    if (event_id == MQTT_EVENT_DATA && event->topic_len == (int)strlen(command_topic) && strncmp(event->topic, command_topic, event->topic_len) == 0) mqtt_command_handler(event->data, event->data_len);
    if (event_id == MQTT_EVENT_DISCONNECTED) { s_mqtt_connected = false; ESP_LOGW(TAG, "MQTT disconnected; local opener remains independent"); }
}

/*
 * Reed switches only mark the end stops. When the door leaves an end stop the
 * direction follows from which one it left; without reaching the other end
 * within DOOR_TRAVEL_TIMEOUT_MS it is reported as STOPPED.
 */
static garage_door_state_t track_door(bool open_on, bool closed_on, garage_door_state_t previous, int64_t *motion_start_ms, int64_t now_ms) {
    if (open_on && closed_on) return GARAGE_DOOR_ERROR;
    if (open_on) return GARAGE_DOOR_OPEN;
    if (closed_on) return GARAGE_DOOR_CLOSED;
    if (previous == GARAGE_DOOR_OPEN) { *motion_start_ms = now_ms; return GARAGE_DOOR_CLOSING; }
    if (previous == GARAGE_DOOR_CLOSED) { *motion_start_ms = now_ms; return GARAGE_DOOR_OPENING; }
    if ((previous == GARAGE_DOOR_OPENING || previous == GARAGE_DOOR_CLOSING) && now_ms - *motion_start_ms > DOOR_TRAVEL_TIMEOUT_MS) return GARAGE_DOOR_STOPPED;
    if (previous == GARAGE_DOOR_ERROR) return GARAGE_DOOR_UNKNOWN;
    return previous;
}

static bool hcsr04_read_cm(float *cm) {
    gpio_set_level(PIN_HCSR04_TRIG, 0); esp_rom_delay_us(2);
    gpio_set_level(PIN_HCSR04_TRIG, 1); esp_rom_delay_us(10);
    gpio_set_level(PIN_HCSR04_TRIG, 0);
    const int64_t trigger_us = esp_timer_get_time();
    while (gpio_get_level(PIN_HCSR04_ECHO) == 0) { if (esp_timer_get_time() - trigger_us > 5000) return false; }
    const int64_t echo_start_us = esp_timer_get_time();
    while (gpio_get_level(PIN_HCSR04_ECHO) == 1) { if (esp_timer_get_time() - echo_start_us > 25000) return false; }
    *cm = (float)(esp_timer_get_time() - echo_start_us) / 58.0f;
    return *cm >= HCSR04_MIN_CM && *cm <= HCSR04_MAX_CM;
}

// VL53L0X on its own I2C bus (SDA=GPIO8, SCL=GPIO9). XSHUT/INT are not
// connected, so the sensor stays at the default address and is polled.
typedef struct {
    i2c_master_bus_handle_t bus;
    vl53l0x_t sensor;
    bool ready;
    int64_t next_attempt_ms;
    int64_t last_sample_ms;
} tof_t;

static void tof_try_init(tof_t *tof, int64_t now_ms) {
    if (tof->ready || now_ms < tof->next_attempt_ms) return;
    tof->next_attempt_ms = now_ms + TOF_RETRY_MS;
    if (!tof->bus) {
        const i2c_master_bus_config_t bus_cfg = {
            .i2c_port = I2C_NUM_0, .sda_io_num = PIN_TOF_SDA, .scl_io_num = PIN_TOF_SCL,
            .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
            .flags.enable_internal_pullup = true,
        };
        if (i2c_new_master_bus(&bus_cfg, &tof->bus) != ESP_OK) { ESP_LOGE(TAG, "TOF: I2C bus init failed"); return; }
    }
    esp_err_t err = vl53l0x_init(&tof->sensor, tof->bus, VL53L0X_DEFAULT_ADDRESS);
    if (err == ESP_OK) err = vl53l0x_set_long_range(&tof->sensor, TOF_TIMING_BUDGET_US);
    if (err == ESP_OK) err = vl53l0x_start_continuous(&tof->sensor, TOF_PERIOD_MS);
    if (err != ESP_OK) { ESP_LOGW(TAG, "TOF: VL53L0X not ready (%s); retrying in %d s", esp_err_to_name(err), TOF_RETRY_MS / 1000); vl53l0x_deinit(&tof->sensor); return; }
    tof->ready = true;
    tof->last_sample_ms = now_ms;
    ESP_LOGI(TAG, "TOF: VL53L0X ready on SDA=%d SCL=%d", PIN_TOF_SDA, PIN_TOF_SCL);
}

static void tof_reset(tof_t *tof, int64_t now_ms) {
    vl53l0x_deinit(&tof->sensor);
    tof->ready = false;
    tof->next_attempt_ms = now_ms; // re-init on the next cycle
}

// Returns true when a new sample arrived; *cm is the raw distance, which may be
// out of range (819 cm = no target). Re-initializes the sensor on I2C errors
// and when it silently stops ranging: a brown-out reset leaves it answering on
// I2C but idle, which would otherwise never be noticed.
static bool tof_poll(tof_t *tof, float *cm, int64_t now_ms) {
    if (!tof->ready) return false;
    uint16_t mm;
    const esp_err_t err = vl53l0x_read_mm(&tof->sensor, &mm);
    if (err == ESP_ERR_NOT_FINISHED) {
        if (now_ms - tof->last_sample_ms > TOF_STALL_MS) { ESP_LOGW(TAG, "TOF: no sample for %d ms; re-initializing", TOF_STALL_MS); tof_reset(tof, now_ms); }
        return false;
    }
    if (err != ESP_OK) { ESP_LOGW(TAG, "TOF: read failed (%s); re-initializing", esp_err_to_name(err)); tof_reset(tof, now_ms); return false; }
    tof->last_sample_ms = now_ms;
    *cm = mm / 10.0f;
    return true;
}

static bool tof_in_range(float cm) { return cm >= TOF_MIN_CM && cm <= TOF_MAX_CM; }

// Same scale as wifiLevelFromRssi() in packages/shared-types: -90 dBm or
// weaker is 0, -40 dBm or stronger is 10, one step per 5 dB.
static int8_t wifi_level_from_rssi(int rssi) {
    const int level = (rssi + 90 + 2) / 5;
    return (int8_t)(level < 0 ? 0 : level > 10 ? 10 : level);
}

static float median3(float a, float b, float c) {
    if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
    if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
    return c;
}

// ---- doorway calibration ----------------------------------------------------

typedef struct {
    bool active;
    int64_t end_ms;
    char command_id[40];
    float hc[CALIBRATION_MAX_SAMPLES];
    float tof[CALIBRATION_MAX_SAMPLES];
    int hc_n, tof_n;
} calibration_t;

static int compare_float(const void *a, const void *b) {
    const float x = *(const float *)a, y = *(const float *)b;
    return (x > y) - (x < y);
}

// Median of the samples if there are enough and they agree; otherwise explains why not.
static bool calibration_baseline(float *samples, int n, int min_n, float min_cm, float max_cm,
                                 const char *name, float *out, char *why, size_t why_len) {
    if (n < min_n) { snprintf(why, why_len, "%s: %d/%d readings", name, n, min_n); return false; }
    qsort(samples, n, sizeof(float), compare_float);
    const float median = samples[n / 2];
    int stable = 0;
    for (int i = 0; i < n; i++) if (samples[i] >= median - CALIBRATION_SPREAD_CM && samples[i] <= median + CALIBRATION_SPREAD_CM) stable++;
    if (stable * 100 < n * CALIBRATION_STABLE_PCT) { snprintf(why, why_len, "%s unstable: %d/%d within %.0fcm", name, stable, n, CALIBRATION_SPREAD_CM); return false; }
    if (median < min_cm || median > max_cm) { snprintf(why, why_len, "%s %.1fcm outside %.0f-%.0fcm", name, median, min_cm, max_cm); return false; }
    *out = median;
    return true;
}

static void baseline_load(garage_safety_config_t *safety) {
    nvs_handle_t nvs;
    uint16_t hc_mm = 0, tof_mm = 0;
    bool calibrated = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        if (nvs_get_u16(nvs, "hc_base_mm", &hc_mm) == ESP_OK && hc_mm > 0) { safety->hc_sr04_baseline_cm = hc_mm / 10.0f; calibrated = true; }
        // A stored 0 is meaningful: calibration chose TOF presence mode.
        if (nvs_get_u16(nvs, "tof_base_mm", &tof_mm) == ESP_OK) safety->tof_baseline_cm = tof_mm / 10.0f;
        nvs_close(nvs);
    }
    if (safety->tof_baseline_cm > 0.0f) {
        ESP_LOGI(TAG, "Doorway baseline: HC-SR04 %.1f cm, TOF %.1f cm (%s)", safety->hc_sr04_baseline_cm, safety->tof_baseline_cm, calibrated ? "calibrated" : "defaults");
    } else {
        ESP_LOGI(TAG, "Doorway baseline: HC-SR04 %.1f cm, TOF presence <= %.0f cm (%s)", safety->hc_sr04_baseline_cm, safety->tof_presence_max_cm, calibrated ? "calibrated" : "defaults");
    }
}

static esp_err_t baseline_save(float hc_cm, float tof_cm) {
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_u16(nvs, "hc_base_mm", (uint16_t)(hc_cm * 10.0f + 0.5f));
    if (err == ESP_OK) err = nvs_set_u16(nvs, "tof_base_mm", (uint16_t)(tof_cm * 10.0f + 0.5f));
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static void calibration_finish(calibration_t *cal, garage_safety_config_t *safety) {
    cal->active = false;
    char why[96] = "", tof_why[96] = "", result[128];
    float hc_cm, tof_cm;
    const bool ok = calibration_baseline(cal->hc, cal->hc_n, CALIBRATION_MIN_HC, 20.0f, HCSR04_MAX_CM, "HC-SR04", &hc_cm, why, sizeof(why));
    // TOF: a stable far-side target gives a baseline; otherwise the far side is
    // out of TOF range and the sensor works in presence mode (baseline 0).
    if (!calibration_baseline(cal->tof, cal->tof_n, CALIBRATION_MIN_TOF, 20.0f, TOF_MAX_CM, "TOF", &tof_cm, tof_why, sizeof(tof_why))) {
        tof_cm = 0.0f;
        ESP_LOGI(TAG, "Calibration: TOF presence mode (%s)", tof_why);
    }
    if (!ok) {
        snprintf(result, sizeof(result), "calibration_failed: %s", why);
        ESP_LOGW(TAG, "%s", result);
        publish_ack(cal->command_id, false, result);
        return;
    }
    const esp_err_t err = baseline_save(hc_cm, tof_cm);
    if (err != ESP_OK) {
        snprintf(result, sizeof(result), "calibration_failed: NVS %s", esp_err_to_name(err));
        publish_ack(cal->command_id, false, result);
        return;
    }
    safety->hc_sr04_baseline_cm = hc_cm;
    safety->tof_baseline_cm = tof_cm;
    if (tof_cm > 0.0f) snprintf(result, sizeof(result), "calibrated hc=%.1fcm tof=%.1fcm", hc_cm, tof_cm);
    else snprintf(result, sizeof(result), "calibrated hc=%.1fcm tof=presence<=%.0fcm", hc_cm, safety->tof_presence_max_cm);
    ESP_LOGI(TAG, "Doorway %s", result);
    publish_ack(cal->command_id, true, result);
}

// ---- display mapping ----------------------------------------------------------

static display_door_state_t display_door(garage_door_state_t state) {
    switch (state) {
        case GARAGE_DOOR_OPEN: return DISPLAY_DOOR_OPEN;
        case GARAGE_DOOR_CLOSED: return DISPLAY_DOOR_CLOSED;
        case GARAGE_DOOR_OPENING: return DISPLAY_DOOR_OPENING;
        case GARAGE_DOOR_CLOSING: return DISPLAY_DOOR_CLOSING;
        case GARAGE_DOOR_STOPPED: return DISPLAY_DOOR_STOPPED;
        case GARAGE_DOOR_ERROR: return DISPLAY_DOOR_ERROR;
        default: return DISPLAY_DOOR_UNKNOWN;
    }
}

static display_zone_state_t display_zone(garage_obstacle_state_t state) {
    switch (state) {
        case GARAGE_OBSTACLE_CLEAR: return DISPLAY_ZONE_CLEAR;
        case GARAGE_OBSTACLE_WARNING: return DISPLAY_ZONE_WARNING;
        case GARAGE_OBSTACLE_BLOCKED: return DISPLAY_ZONE_BLOCKED;
        default: return DISPLAY_ZONE_SENSOR_FAULT;
    }
}

/*
 * Closing guard: while the door is CLOSING, an object in the beam stops the
 * door and reopens it; an unreliable beam (SENSOR_FAULT) stops it. Fires once
 * per closing movement.
 */
static void closing_guard(garage_obstacle_state_t obstacle, bool *fired) {
    if (s_door != GARAGE_DOOR_CLOSING) { *fired = false; return; }
    if (*fired || garage_close_is_safe(obstacle)) return;
    *fired = true;
    relay_pulse(PIN_RELAY_STOP);
    if (obstacle == GARAGE_OBSTACLE_BLOCKED) {
        publish_event("OBSTACLE_DETECTED", "Kapanirken kapi hattinda engel algilandi");
        vTaskDelay(pdMS_TO_TICKS(CONFIG_GARAGE_REOPEN_DELAY_MS));
        relay_pulse(PIN_RELAY_UP);
        publish_event("STOP_AND_REOPEN", "Kapi durduruldu ve yeniden aciliyor");
    } else {
        publish_event("ERROR", "Kapanirken sensor verisi guvenilmez; kapi durduruldu");
    }
}

// Samples sensors at 5 Hz, tracks the door state, guards closing, runs
// calibration and drives the display and MQTT state. Runs independently of
// Wi-Fi/MQTT so the local screen and safety logic work offline.
static void status_task(void *arg) {
    (void)arg;
    garage_safety_config_t safety = {
        .hc_sr04_baseline_cm = CONFIG_GARAGE_HCSR04_BASELINE_CM, .tof_baseline_cm = CONFIG_GARAGE_TOF_BASELINE_CM,
        .tolerance_cm = CONFIG_GARAGE_BEAM_TOLERANCE_CM,
        .hc_sr04_valid_min_cm = HCSR04_MIN_CM, .hc_sr04_valid_max_cm = HCSR04_MAX_CM,
        .tof_valid_min_cm = TOF_MIN_CM, .tof_valid_max_cm = TOF_MAX_CM,
        .sensor_fault_timeout_ms = CONFIG_GARAGE_SENSOR_FAULT_TIMEOUT_MS,
        .hysteresis_cm = BEAM_HYSTERESIS_CM,
        .tof_presence_max_cm = TOF_PRESENCE_MAX_CM,
    };
    baseline_load(&safety);
    garage_beam_latch_t beam_latch = {0};

    bool open_stable = pin_is_active(PIN_REED_OPEN), closed_stable = pin_is_active(PIN_REED_CLOSED);
    int open_count = 0, closed_count = 0;
    int64_t motion_start_ms = 0, hc_last_ok_ms = 0, tof_last_sample_ms = 0, last_publish_ms = 0;
    float tof_window[3] = { TOF_NO_TARGET_CM, TOF_NO_TARGET_CM, TOF_NO_TARGET_CM };
    int tof_window_n = 0;
    bool tof_valid = false;
    float hc_cm = 0, tof_cm = 0;
    float hc_window[3] = {0};
    int hc_window_n = 0;
    bool guard_fired = false;
    tof_t tof = {0};
    calibration_t cal = {0};
    light_mode_t light_mode = LIGHT_OFF;
    bool pir_last = false;
    int64_t last_motion_ms = 0, last_pir_event_ms = -PIR_EVENT_MIN_INTERVAL_MS;
    int8_t wifi_level = -1;
    int64_t last_rssi_ms = 0;
    int diag = 0, last_diag = -1;
    int photocell_ok_count = 0;
    bool photocell_clear = false;

    while (true) {
        const int64_t now_ms = esp_timer_get_time() / 1000;

        // Debounce: a reed change must persist for REED_DEBOUNCE_SAMPLES periods.
        const bool open_raw = pin_is_active(PIN_REED_OPEN), closed_raw = pin_is_active(PIN_REED_CLOSED);
        open_count = open_raw != open_stable ? open_count + 1 : 0;
        closed_count = closed_raw != closed_stable ? closed_count + 1 : 0;
        bool changed = false;
        if (open_count >= REED_DEBOUNCE_SAMPLES) { open_stable = open_raw; open_count = 0; changed = true; }
        if (closed_count >= REED_DEBOUNCE_SAMPLES) { closed_stable = closed_raw; closed_count = 0; changed = true; }

        const garage_door_state_t previous = s_door;
        s_door = track_door(open_stable, closed_stable, previous, &motion_start_ms, now_ms);
        if (s_door != previous) {
            ESP_LOGI(TAG, "Door %s -> %s", garage_door_state_name(previous), garage_door_state_name(s_door));
            changed = true;
        }

#if FLICKER_DIAG
        // Steps: A normal; B laser on, no I2C reads; C laser off, I2C reads go on;
        // D short-range laser profile. Separates laser current from I2C traffic.
        diag = (int)((now_ms / FLICKER_DIAG_STEP_MS) % 4);
        if (diag != last_diag && tof.ready) {
            vl53l0x_stop_continuous(&tof.sensor);
            vl53l0x_set_range_profile(&tof.sensor, diag != 3, TOF_TIMING_BUDGET_US);
            if (diag != 2) vl53l0x_start_continuous(&tof.sensor, TOF_PERIOD_MS);
            tof.last_sample_ms = now_ms;
        }
        if (diag != last_diag) {
            garage_display_set_title(k_diag_titles[diag]);
            ESP_LOGW(TAG, "Flicker diag: %s", k_diag_titles[diag]);
            last_diag = diag;
        }
#endif
        const bool hc_enabled = USE_DISTANCE_SENSORS;
        const bool tof_enabled = USE_DISTANCE_SENSORS && diag != 1 && diag != 2;
        if (diag == 2 && tof.ready) { uint16_t ignored; vl53l0x_read_mm(&tof.sensor, &ignored); } // I2C traffic only

        float cm;
        // HC-SR04: median of the last 3 good echoes rejects single-sample spikes.
        if (hc_enabled && hcsr04_read_cm(&cm)) {
            hc_window[hc_window_n++ % 3] = cm;
            hc_cm = hc_window_n < 3 ? cm : median3(hc_window[0], hc_window[1], hc_window[2]);
            hc_last_ok_ms = now_ms;
            if (cal.active && cal.hc_n < CALIBRATION_MAX_SAMPLES) cal.hc[cal.hc_n++] = cm;
        }
        if (tof_enabled) tof_try_init(&tof, now_ms);
        // TOF: median of the last 3 samples, "no target" counting as far away,
        // so one stray reading at long range cannot flag an obstacle.
        if (tof_enabled && tof_poll(&tof, &cm, now_ms)) {
            tof_window[tof_window_n++ % 3] = tof_in_range(cm) ? cm : TOF_NO_TARGET_CM;
            const float median = median3(tof_window[0], tof_window[1], tof_window[2]);
            tof_valid = median < TOF_NO_TARGET_CM;
            if (tof_valid) tof_cm = median;
            tof_last_sample_ms = now_ms;
            if (tof_in_range(cm) && cal.active && cal.tof_n < CALIBRATION_MAX_SAMPLES) cal.tof[cal.tof_n++] = cm;
        }
        const bool tof_online = tof.ready && tof_last_sample_ms > 0 && now_ms - tof_last_sample_ms <= CONFIG_GARAGE_SENSOR_FAULT_TIMEOUT_MS;

        const garage_safety_sample_t sample = {
            .hc_sr04_valid = hc_last_ok_ms > 0, .hc_sr04_cm = hc_cm, .hc_sr04_age_ms = (uint32_t)(now_ms - hc_last_ok_ms),
            .tof_valid = tof_valid, .tof_cm = tof_cm, .tof_age_ms = (uint32_t)(now_ms - tof_last_sample_ms),
            .tof_online = tof_online,
        };
#if USE_DISTANCE_SENSORS
        const garage_obstacle_state_t obstacle = garage_obstacle_state_latched(&safety, &sample, &beam_latch);
#else
        // Photocell: a broken beam, an unpowered photocell or a cut wire all open
        // the contact, so anything but a steadily closed contact is an obstacle.
        const bool beam_received = gpio_get_level(PIN_PHOTOCELL) == PHOTOCELL_CLEAR_LEVEL;
        photocell_ok_count = beam_received ? photocell_ok_count + 1 : 0;
        photocell_clear = photocell_ok_count >= PHOTOCELL_CLEAR_SAMPLES;
        const garage_obstacle_state_t obstacle = photocell_clear ? GARAGE_OBSTACLE_CLEAR : GARAGE_OBSTACLE_BLOCKED;
        (void)beam_latch;
#endif
        if (obstacle != s_obstacle) {
            ESP_LOGI(TAG, "Doorway %s -> %s (hc=%.1f tof=%.1f)", garage_obstacle_state_name(s_obstacle), garage_obstacle_state_name(obstacle), hc_cm, tof_cm);
            changed = true;
        }
        s_obstacle = obstacle;
        closing_guard(obstacle, &guard_fired);

        // Calibration: start on request, finish after CALIBRATION_MS of sampling.
        if (s_calibrate_requested && !cal.active) {
            strlcpy(cal.command_id, s_calibrate_command_id, sizeof(cal.command_id));
            if (s_door == GARAGE_DOOR_OPENING || s_door == GARAGE_DOOR_CLOSING) {
                publish_ack(cal.command_id, false, "calibration_failed: door moving");
            } else {
                cal.active = true; cal.hc_n = cal.tof_n = 0; cal.end_ms = now_ms + CALIBRATION_MS;
                ESP_LOGI(TAG, "Doorway calibration started");
            }
            s_calibrate_requested = false;
        }
        if (cal.active && now_ms >= cal.end_ms) { calibration_finish(&cal, &safety); changed = true; }

        // PIR (HC-SR501, active high) and lamp. Auto-on only on a new motion edge,
        // so switching the lamp off from the web is not undone while someone is
        // still standing there; auto-off after the configured quiet time.
        const bool pir = gpio_get_level(PIN_PIR) == 1;
        const light_mode_t light_before = light_mode;
        if (pir) last_motion_ms = now_ms;
        if (pir && !pir_last) {
            changed = true;
            if (now_ms - last_pir_event_ms >= PIR_EVENT_MIN_INTERVAL_MS) { publish_event("PIR_MOTION", "Hareket algilandi"); last_pir_event_ms = now_ms; }
#if CONFIG_GARAGE_PIR_LIGHT_ENABLED
            if (light_mode == LIGHT_OFF) { light_mode = LIGHT_AUTO; publish_event("LIGHT_ON", "Hareket algilandi; lamba otomatik yandi"); }
#endif
        }
        if (!pir && pir_last) changed = true;
        pir_last = pir;
        if (light_mode == LIGHT_AUTO && !pir && now_ms - last_motion_ms >= CONFIG_GARAGE_PIR_LIGHT_TIMEOUT_SECONDS * 1000LL) {
            light_mode = LIGHT_OFF;
            publish_event("LIGHT_OFF", "Hareket yok; lamba otomatik sondu");
        }
        if (s_light_request) {
            const bool on = s_light_request == 1;
            char command_id[40];
            strlcpy(command_id, s_light_command_id, sizeof(command_id));
            s_light_request = 0;
            light_mode = on ? LIGHT_MANUAL : LIGHT_OFF;
            publish_event(on ? "LIGHT_ON" : "LIGHT_OFF", on ? "Lamba webden yakildi" : "Lamba webden sonduruldu");
            publish_ack(command_id, true, LIGHT_RELAY_LIVE ? (on ? "light_on" : "light_off") : "light_relay_locked");
        }
        if ((light_mode != LIGHT_OFF) != (light_before != LIGHT_OFF)) light_relay_set(light_mode != LIGHT_OFF);
        if (light_mode != light_before) changed = true;

        const sensor_snapshot_t snap = {
            .open_reed = open_stable, .closed_reed = closed_stable, .pir = pir,
            .light_on = light_mode != LIGHT_OFF, .light_mode = light_mode,
            .hc_fresh = sample.hc_sr04_valid && sample.hc_sr04_age_ms <= safety.sensor_fault_timeout_ms,
            .tof_fresh = sample.tof_valid && sample.tof_age_ms <= safety.sensor_fault_timeout_ms,
            .tof_online = tof_online,
            .hc_cm = hc_cm, .tof_cm = tof_cm,
            .hc_baseline_cm = safety.hc_sr04_baseline_cm, .tof_baseline_cm = safety.tof_baseline_cm,
            .tolerance_cm = safety.tolerance_cm,
            .photocell_clear = photocell_clear,
        };
        if (s_mqtt_connected && (changed || s_publish_now || now_ms - last_publish_ms >= STATE_PUBLISH_PERIOD_MS)) {
            s_publish_now = false;
            last_publish_ms = now_ms;
            publish_state(&snap);
        }

        const bool wifi_up = wifi_events != NULL && (xEventGroupGetBits(wifi_events) & BIT0) != 0;
        if (!wifi_up) {
            wifi_level = -1;
        } else if (now_ms - last_rssi_ms >= RSSI_POLL_MS) {
            wifi_ap_record_t ap = {0};
            if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) wifi_level = wifi_level_from_rssi(ap.rssi);
            last_rssi_ms = now_ms;
        }

        const display_ui_state_t ui = {
            .door_state = display_door(s_door),
            .zone_state = display_zone(obstacle),
            .top_reed_on = open_stable,
            .bottom_reed_on = closed_stable,
            .hcsr04_valid = snap.hc_fresh,
            .hcsr04_cm = hc_cm,
            .tof_valid = snap.tof_fresh,
            .tof_online = tof_online,
            .tof_range_cm = (int16_t)TOF_PRESENCE_MAX_CM,
            .tof_cm = tof_cm,
            .wifi_connected = wifi_up,
            .wifi_level = wifi_level,
            .server_connected = s_mqtt_connected,
            .pir_motion = snap.pir,
            .light_on = snap.light_on,
            .photocell_mode = !USE_DISTANCE_SENSORS,
            .photocell_clear = photocell_clear,
        };
        garage_display_update(&ui);
        vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
    }
}

// Longer listening per channel while searching for the access point (defaults:
// active 0-120 ms, passive 360 ms). The driver accepts this only once started.
static void wifi_set_scan_parameters(void) {
    const wifi_scan_default_params_t scan_params = { .scan_time = { .active = { .min = 120, .max = 300 }, .passive = 500 }, .home_chan_dwell_time = 30 };
    const esp_err_t err = esp_wifi_set_scan_parameters(&scan_params);
    if (err != ESP_OK) ESP_LOGW(TAG, "[WIFI] Scan parameters not set: %s", esp_err_to_name(err));
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) { (void)arg; if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) { wifi_set_scan_parameters(); esp_wifi_connect(); } if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { wifi_diag_record_disconnect((const wifi_event_sta_disconnected_t *)data); esp_wifi_connect(); xEventGroupClearBits(wifi_events, BIT0); } if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) { wifi_diag_link_up(); xEventGroupSetBits(wifi_events, BIT0); } }
static void wifi_init(void) { wifi_events = xEventGroupCreate(); ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default()); esp_netif_create_default_wifi_sta(); wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&cfg)); ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL)); ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL)); wifi_config_t wifi_config = { .sta = { .scan_method = WIFI_ALL_CHANNEL_SCAN, .sort_method = WIFI_CONNECT_AP_BY_SIGNAL, .failure_retry_cnt = 3 } }; strlcpy((char *)wifi_config.sta.ssid, CONFIG_GARAGE_WIFI_SSID, sizeof(wifi_config.sta.ssid)); strlcpy((char *)wifi_config.sta.password, CONFIG_GARAGE_WIFI_PASSWORD, sizeof(wifi_config.sta.password)); ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    // b/g/n and no explicit auth threshold, as on the ESP32-CAM that does reach
    // the garage. The protocol is set explicitly because the driver keeps the
    // earlier b/g-only setting in NVS otherwise.
    ESP_ERROR_CHECK(esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N));
    // Turkey allows channels 1-13 and the access point sits on 13. The IDF
    // default country only probes 1-11 actively and waits passively for a
    // beacon on 12-13, which a weak link easily misses.
    ESP_ERROR_CHECK(esp_wifi_set_country_code("TR", false));
    // 20 MHz only: a 40 MHz channel spreads the same power over twice the noise.
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW20));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config)); ESP_ERROR_CHECK(esp_wifi_start());
    // Weak-signal hardening:
    // - scan every channel and join the strongest access point with this SSID
    //   (the default fast scan takes the first one it hears);
    // - no modem sleep, which drops beacons and reconnects on a marginal link;
    // - maximum allowed transmit power (80 x 0.25 = 20 dBm);
    // - tolerate 15 s without beacons before declaring the link lost (default 6 s),
    //   so short fades do not force a full reconnect.
    esp_wifi_set_ps(WIFI_PS_NONE);
    esp_wifi_set_max_tx_power(80);
    esp_wifi_set_inactive_time(WIFI_IF_STA, 15); }

void app_main(void) {
    // Keep all relay outputs inactive before any network, display, sensor or
    // backend initialization. SAFE_TEST_MODE also suppresses physical pulses.
    configure_relay_outputs_safe();
    configure_sensor_inputs();
    s_relay_lock = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(nvs_flash_init()); // before status_task: it loads the doorway baseline
    wifi_diag_load();
#if !CONFIG_GARAGE_WIFI_PROBE
    ESP_ERROR_CHECK(garage_display_init() ? ESP_OK : ESP_FAIL);
#if RELAY_COMMISSIONING
    relay_commissioning();
#endif
#endif
    uint8_t mac[6]; ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA)); snprintf(boot_id, sizeof(boot_id), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]); snprintf(availability_topic, sizeof(availability_topic), "garage/%s/availability", CONFIG_GARAGE_DEVICE_ID); snprintf(command_topic, sizeof(command_topic), "garage/%s/command", CONFIG_GARAGE_DEVICE_ID);
    // The spare probe board has no display or sensors: Wi-Fi, MQTT and telemetry only.
#if !CONFIG_GARAGE_WIFI_PROBE
    xTaskCreate(status_task, "garage_status", 6144, NULL, 3, NULL);
#else
    (void)status_task;
#endif
    wifi_init(); xEventGroupWaitBits(wifi_events, BIT0, pdFALSE, pdTRUE, portMAX_DELAY);
    // Real timestamps for MQTT messages; until synced the API substitutes its receive time.
    esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_netif_sntp_init(&sntp_cfg);
    // MQTT on a weak link: 20 s for slow TLS/network operations instead of 10 s,
    // and retry the broker 2 s after a drop instead of 10 s. Keepalive 60 s lets
    // the broker publish the offline last will after ~90 s of silence, so short
    // Wi-Fi fades do not show the controller as offline.
    esp_mqtt_client_config_t mqtt_cfg = { .network.timeout_ms = 20000, .network.reconnect_timeout_ms = 2000, .session.keepalive = 60, .broker.address.uri = CONFIG_GARAGE_MQTT_URI, .broker.verification.certificate = (const char *)mqtt_ca_crt_start, .credentials.username = CONFIG_GARAGE_MQTT_USERNAME, .credentials.authentication.password = CONFIG_GARAGE_MQTT_PASSWORD, .session.last_will.topic = availability_topic, .session.last_will.msg = "{\"online\":false}", .session.last_will.msg_len = 16, .session.last_will.qos = 1, .session.last_will.retain = true };
    mqtt_client = esp_mqtt_client_init(&mqtt_cfg); ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL)); ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt_client));
    while (true) { if (s_mqtt_connected) { wifi_ap_record_t ap = {0}; int rssi = 0; if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) rssi = ap.rssi; char timestamp[32], telemetry[320]; utc_now(timestamp, sizeof(timestamp)); snprintf(telemetry, sizeof(telemetry), "{\"deviceId\":\"%s\",\"timestamp\":\"%s\",\"sequence\":%lu,\"bootId\":\"%s\",\"firmwareVersion\":\"%s\",\"rssi\":%d,\"uptimeSeconds\":%llu}", CONFIG_GARAGE_DEVICE_ID, timestamp, (unsigned long)sequence++, boot_id, CONFIG_GARAGE_FIRMWARE_VERSION, rssi, (unsigned long long)(esp_timer_get_time() / 1000000)); publish_topic("telemetry", telemetry, 0, false); } vTaskDelay(pdMS_TO_TICKS(TELEMETRY_PERIOD_MS)); }
}
