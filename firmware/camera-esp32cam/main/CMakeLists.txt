idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES esp_wifi esp_event nvs_flash esp_http_client esp_timer esp32-camera mqtt esp_websocket_client cjson EMBED_TXTFILES "../mqtt_ca.crt")
set(EXTRA_COMPONENT_DIRS "$ENV{IDF_PATH}/../managed_components/espressif__esp32-camera")
