#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "board_config.h"
#include "cJSON.h"
#include "esp_camera.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "mqtt_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"

static const char *TAG = "garage-camera";
static esp_mqtt_client_handle_t mqtt;
static EventGroupHandle_t wifi_events;
static volatile bool snapshot_requested;
static volatile bool live_start_requested;
static volatile bool live_stop_requested;
static volatile bool live_connected;
static bool camera_ready;
static char camera_state[16] = "CONNECTING";
static char camera_session_id[64];
static char last_error[128];
static char snapshot_reason[24] = "MANUAL";
static char live_session_id[64];
static char live_stream_token[96];
static char live_ingest_host[96];
static int live_ingest_port;
static int64_t last_status_us;

extern const uint8_t mqtt_ca_crt_start[] asm("_binary_mqtt_ca_crt_start");

static void utc_now(char *out, size_t length)
{
    time_t now;
    struct tm utc;
    time(&now);
    gmtime_r(&now, &utc);
    strftime(out, length, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

static void publish_topic(const char *kind, const char *payload, int qos, bool retain)
{
    if (!mqtt) return;
    char topic[128];
    snprintf(topic, sizeof(topic), "camera/%s/%s", CONFIG_GARAGE_CAMERA_ID, kind);
    esp_mqtt_client_publish(mqtt, topic, payload, 0, qos, retain);
}

static void publish_availability(bool online)
{
    char timestamp[32];
    char payload[256];
    utc_now(timestamp, sizeof(timestamp));
    snprintf(payload, sizeof(payload), "{\"deviceId\":\"%s\",\"garageId\":\"%s\",\"timestamp\":\"%s\",\"online\":%s}", CONFIG_GARAGE_CAMERA_ID, CONFIG_GARAGE_CAMERA_GARAGE_ID, timestamp, online ? "true" : "false");
    publish_topic("availability", payload, 1, true);
}

static void publish_camera_state(const char *state, const char *session_id, const char *error)
{
    strlcpy(camera_state, state, sizeof(camera_state));
    strlcpy(camera_session_id, session_id ? session_id : "", sizeof(camera_session_id));
    strlcpy(last_error, error ? error : "", sizeof(last_error));
    if (!mqtt) return;

    char timestamp[32];
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    wifi_ap_record_t ap = {0};
    const int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : -127;
    cJSON_AddStringToObject(root, "deviceId", CONFIG_GARAGE_CAMERA_ID);
    cJSON_AddStringToObject(root, "garageId", CONFIG_GARAGE_CAMERA_GARAGE_ID);
    utc_now(timestamp, sizeof(timestamp));
    cJSON_AddStringToObject(root, "timestamp", timestamp);
    cJSON_AddNumberToObject(root, "sequence", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddStringToObject(root, "bootId", CONFIG_GARAGE_CAMERA_ID);
    cJSON_AddStringToObject(root, "firmwareVersion", CONFIG_GARAGE_CAMERA_FIRMWARE_VERSION);
    cJSON_AddStringToObject(root, "cameraState", camera_state);
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddNumberToObject(root, "uptimeSeconds", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddNumberToObject(root, "freeHeap", (double)esp_get_free_heap_size());
    if (last_error[0] == '\0') cJSON_AddNullToObject(root, "lastError"); else cJSON_AddStringToObject(root, "lastError", last_error);
    if (camera_session_id[0] == '\0') cJSON_AddNullToObject(root, "sessionId"); else cJSON_AddStringToObject(root, "sessionId", camera_session_id);
    char *payload = cJSON_PrintUnformatted(root);
    if (payload) { publish_topic("state", payload, 1, true); free(payload); }
    cJSON_Delete(root);
}

static esp_err_t init_camera(void)
{
    if (camera_ready) return ESP_OK;
    const bool has_psram = heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0;
    camera_config_t config = {
        .ledc_channel = LEDC_CHANNEL_0, .ledc_timer = LEDC_TIMER_0,
        .pin_d0 = CAM_PIN_D0, .pin_d1 = CAM_PIN_D1, .pin_d2 = CAM_PIN_D2, .pin_d3 = CAM_PIN_D3,
        .pin_d4 = CAM_PIN_D4, .pin_d5 = CAM_PIN_D5, .pin_d6 = CAM_PIN_D6, .pin_d7 = CAM_PIN_D7,
        .pin_xclk = CAM_PIN_XCLK, .pin_pclk = CAM_PIN_PCLK, .pin_vsync = CAM_PIN_VSYNC, .pin_href = CAM_PIN_HREF,
        .pin_sccb_sda = CAM_PIN_SIOD, .pin_sccb_scl = CAM_PIN_SIOC, .pin_pwdn = CAM_PIN_PWDN, .pin_reset = CAM_PIN_RESET,
        .xclk_freq_hz = 20000000, .pixel_format = PIXFORMAT_JPEG, .frame_size = FRAMESIZE_QVGA,
        // This board has no PSRAM. QVGA with a slightly smaller JPEG keeps
        // frame delivery reliable over TLS without exhausting DRAM.
        .jpeg_quality = 18, .fb_count = has_psram ? 2 : 1,
        .fb_location = has_psram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM,
        // The former working firmware used WHEN_EMPTY. With one DRAM buffer
        // this avoids replacing a frame while the TLS sender still owns it.
        .grab_mode = CAMERA_GRAB_WHEN_EMPTY
    };
    const esp_err_t result = esp_camera_init(&config);
    if (result == ESP_OK) {
        camera_ready = true;
        ESP_LOGI(TAG, "[CAMERA] Initialized PSRAM=%s", has_psram ? "yes" : "no");
    }
    return result;
}

/*
 * Without PSRAM the frame buffer and DMA descriptors must come from fragmented
 * internal DRAM; after many init/deinit cycles the driver can no longer
 * allocate them and only a reboot recovers. Report the real error, give MQTT a
 * moment to deliver it, then restart.
 */
static void camera_init_failed(esp_err_t err, const char *session_id)
{
    char reason[64];
    snprintf(reason, sizeof(reason), "camera_init_failed:%s", esp_err_to_name(err));
    ESP_LOGE(TAG, "[CAMERA] %s (free=%u largest=%u); restarting", reason,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    publish_camera_state("ERROR", session_id, reason);
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
}

static void deinit_camera(void)
{
    if (!camera_ready) return;
    esp_camera_deinit();
    camera_ready = false;
}

static bool upload_snapshot(camera_fb_t *frame)
{
    if (!frame || frame->len == 0) return false;
    esp_http_client_config_t config = { .url = CONFIG_GARAGE_CAMERA_UPLOAD_URL, .timeout_ms = 10000, .crt_bundle_attach = esp_crt_bundle_attach };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return false;
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "image/jpeg");
    esp_http_client_set_header(client, "X-Device-Id", CONFIG_GARAGE_CAMERA_ID);
    esp_http_client_set_header(client, "X-Camera-Reason", snapshot_reason);
    esp_http_client_set_header(client, "X-Device-Token", CONFIG_GARAGE_CAMERA_UPLOAD_TOKEN);
    esp_http_client_set_post_field(client, (const char *)frame->buf, frame->len);
    const esp_err_t error = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    ESP_LOGI(TAG, "Snapshot upload bytes=%u status=%d result=%s", (unsigned)frame->len, status, esp_err_to_name(error));
    esp_http_client_cleanup(client);
    return error == ESP_OK && status >= 200 && status < 300;
}

static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    (void)event_data;
    if (event_id == WEBSOCKET_EVENT_CONNECTED) {
        live_connected = true;
        ESP_LOGI(TAG, "[STREAM] WebSocket connected");
    } else if (event_id == WEBSOCKET_EVENT_DISCONNECTED) {
        live_connected = false;
        ESP_LOGW(TAG, "[STREAM] WebSocket disconnected");
    } else if (event_id == WEBSOCKET_EVENT_ERROR) {
        live_connected = false;
        ESP_LOGE(TAG, "[STREAM] WebSocket error");
    }
}

static void stream_live(void)
{
    if (live_session_id[0] == '\0' || live_stream_token[0] == '\0' || live_ingest_host[0] == '\0' || live_ingest_port < 1) return;
    publish_camera_state("STARTING", live_session_id, NULL);
    const esp_err_t init_err = init_camera();
    if (init_err != ESP_OK) camera_init_failed(init_err, live_session_id);
    char uri[320];
    snprintf(uri, sizeof(uri), "%s://%s:%d/api/camera/live/ingest?sessionId=%s&token=%s", CONFIG_GARAGE_CAMERA_INGEST_SCHEME, live_ingest_host, live_ingest_port, live_session_id, live_stream_token);
    char headers[192];
    snprintf(headers, sizeof(headers), "X-Camera-Device-Token: %s\r\n", CONFIG_GARAGE_CAMERA_DEVICE_TOKEN);
    const size_t websocket_buffer_size = heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0 ? 64 * 1024 : 16 * 1024;
    esp_websocket_client_config_t config = {
        .uri = uri,
        .headers = headers,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = websocket_buffer_size,
        .network_timeout_ms = 10000,
        .reconnect_timeout_ms = 10000
    };
    // Set this before start(). esp_websocket_client_start() can complete the
    // TLS handshake quickly enough for CONNECTED to arrive during start().
    // Resetting the flag after start() would then lose that event and make a
    // healthy stream look like stream_connect_failed.
    live_connected = false;
    esp_websocket_client_handle_t client = esp_websocket_client_init(&config);
    if (!client || esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, websocket_event_handler, NULL) != ESP_OK || esp_websocket_client_start(client) != ESP_OK) {
        if (client) esp_websocket_client_destroy(client);
        deinit_camera();
        publish_camera_state("ERROR", live_session_id, "stream_connect_failed");
        return;
    }
    for (int wait_ms = 0; wait_ms < 10000 && !live_connected && !live_stop_requested; wait_ms += 100) vTaskDelay(pdMS_TO_TICKS(100));
    const char *stream_error = NULL;
    if (live_connected) publish_camera_state("LIVE", live_session_id, NULL);
    else if (!live_stop_requested) stream_error = "stream_connect_failed";
    while (live_connected && !live_stop_requested) {
        camera_fb_t *frame = esp_camera_fb_get();
        if (!frame) {
            ESP_LOGW(TAG, "[CAMERA] Frame capture failed");
            stream_error = "frame_capture_failed";
            break;
        }
        // esp_websocket_client_send_bin returns the number of bytes sent,
        // not an esp_err_t. Comparing it with ESP_OK made every successful
        // frame look like an error, so the stream stopped after frame one.
        const size_t expected_len = frame->len;
        const int sent = esp_websocket_client_send_bin(client, (const char *)frame->buf, expected_len, 1000);
        esp_camera_fb_return(frame);
        if (sent < 0 || sent != (int)expected_len) {
            ESP_LOGW(TAG, "[CAMERA] Stream send failed sent=%d expected=%u", sent, (unsigned)expected_len);
            stream_error = "stream_send_failed";
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    if (!stream_error && !live_stop_requested && !live_connected) stream_error = "stream_disconnected";
    live_connected = false;
    esp_websocket_client_stop(client);
    esp_websocket_client_destroy(client);
    deinit_camera();
    live_stop_requested = false;
    if (stream_error) {
        publish_camera_state("ERROR", live_session_id, stream_error);
        ESP_LOGW(TAG, "[CAMERA] Stream ended with error=%s", stream_error);
    } else {
        publish_camera_state("STANDBY", NULL, NULL);
        ESP_LOGI(TAG, "[CAMERA] Standby");
    }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;
    if (event_id == MQTT_EVENT_CONNECTED) {
        char topic[128];
        snprintf(topic, sizeof(topic), "camera/%s/command", CONFIG_GARAGE_CAMERA_ID);
        esp_mqtt_client_subscribe(mqtt, topic, 1);
        publish_availability(true);
        publish_camera_state("STANDBY", NULL, NULL);
        ESP_LOGI(TAG, "[BACKEND] Connected; [CAMERA] Standby");
        return;
    }
    if (event_id == MQTT_EVENT_DISCONNECTED) {
        live_connected = false;
        ESP_LOGW(TAG, "[BACKEND] MQTT disconnected; retrying");
        return;
    }
    if (event_id != MQTT_EVENT_DATA || event->data_len <= 0) return;
    cJSON *root = cJSON_ParseWithLength(event->data, event->data_len);
    if (!root) return;
    cJSON *action = cJSON_GetObjectItem(root, "action");
    if (cJSON_IsString(action) && strcmp(action->valuestring, "SNAPSHOT") == 0) {
        cJSON *reason = cJSON_GetObjectItem(root, "reason");
        strlcpy(snapshot_reason, cJSON_IsString(reason) ? reason->valuestring : "MANUAL", sizeof(snapshot_reason));
        snapshot_requested = true;
    } else if (cJSON_IsString(action) && strcmp(action->valuestring, "START_LIVE") == 0) {
        cJSON *session = cJSON_GetObjectItem(root, "sessionId");
        cJSON *token = cJSON_GetObjectItem(root, "streamToken");
        cJSON *host = cJSON_GetObjectItem(root, "ingestHost");
        cJSON *port = cJSON_GetObjectItem(root, "ingestPort");
        if (cJSON_IsString(session) && cJSON_IsString(token) && cJSON_IsString(host) && cJSON_IsNumber(port) && port->valueint > 0 && port->valueint <= 65535) {
            strlcpy(live_session_id, session->valuestring, sizeof(live_session_id));
            strlcpy(live_stream_token, token->valuestring, sizeof(live_stream_token));
            strlcpy(live_ingest_host, host->valuestring, sizeof(live_ingest_host));
            live_ingest_port = port->valueint;
            live_stop_requested = false;
            live_start_requested = true;
        }
    } else if (cJSON_IsString(action) && strcmp(action->valuestring, "STOP_LIVE") == 0) {
        cJSON *session = cJSON_GetObjectItem(root, "sessionId");
        if (!cJSON_IsString(session) || strcmp(session->valuestring, live_session_id) == 0) live_stop_requested = true;
    }
    cJSON_Delete(root);
}

static void init_mqtt(void)
{
    esp_mqtt_client_config_t config = {
        .broker.address.uri = CONFIG_GARAGE_CAMERA_MQTT_URI,
        .broker.verification.certificate = (const char *)mqtt_ca_crt_start,
        .credentials.username = CONFIG_GARAGE_CAMERA_MQTT_USERNAME,
        .credentials.authentication.password = CONFIG_GARAGE_CAMERA_MQTT_PASSWORD,
        .session.last_will.topic = "camera/" CONFIG_GARAGE_CAMERA_ID "/availability",
        .session.last_will.msg = "{\"deviceId\":\"" CONFIG_GARAGE_CAMERA_ID "\",\"garageId\":\"" CONFIG_GARAGE_CAMERA_GARAGE_ID "\",\"timestamp\":\"1970-01-01T00:00:00Z\",\"online\":false}",
        .session.last_will.qos = 1,
        .session.last_will.retain = true
    };
    mqtt = esp_mqtt_client_init(&config);
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt));
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(wifi_events, BIT0);
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { xEventGroupClearBits(wifi_events, BIT0); esp_wifi_connect(); }
}

static void init_wifi(void)
{
    wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    wifi_config_t wifi = { 0 };
    strlcpy((char *)wifi.sta.ssid, CONFIG_GARAGE_CAMERA_WIFI_SSID, sizeof(wifi.sta.ssid));
    strlcpy((char *)wifi.sta.password, CONFIG_GARAGE_CAMERA_WIFI_PASSWORD, sizeof(wifi.sta.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
    // The old stable camera firmware disabled modem sleep for streaming. It
    // reduces latency/jitter and prevents long idle gaps on the TLS socket.
    const esp_err_t power_save_result = esp_wifi_set_ps(WIFI_PS_NONE);
    if (power_save_result != ESP_OK) ESP_LOGW(TAG, "[WIFI] Could not disable power save: %s", esp_err_to_name(power_save_result));
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_LOGI(TAG, "[BOOT] ESP32-CAM starting");
    init_wifi();
    ESP_LOGI(TAG, "[WIFI] Connecting");
    xEventGroupWaitBits(wifi_events, BIT0, pdFALSE, pdTRUE, portMAX_DELAY);
    ESP_LOGI(TAG, "[WIFI] Connected");
    init_mqtt();
    while (true) {
        if (mqtt && esp_timer_get_time() - last_status_us >= 30000000) {
            publish_availability(true);
            publish_camera_state(camera_state, camera_session_id[0] == '\0' ? NULL : camera_session_id, last_error[0] == '\0' ? NULL : last_error);
            last_status_us = esp_timer_get_time();
        }
        if (live_start_requested) { live_start_requested = false; stream_live(); continue; }
        if (snapshot_requested) {
            snapshot_requested = false;
            publish_camera_state("STARTING", NULL, NULL);
            const esp_err_t init_err = init_camera();
            if (init_err == ESP_OK) {
                camera_fb_t *frame = esp_camera_fb_get();
                const bool uploaded = upload_snapshot(frame);
                if (frame) esp_camera_fb_return(frame);
                deinit_camera();
                publish_camera_state(uploaded ? "STANDBY" : "ERROR", NULL, uploaded ? NULL : "snapshot_upload_failed");
            } else {
                camera_init_failed(init_err, NULL);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
