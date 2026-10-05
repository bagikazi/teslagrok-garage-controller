idf_component_register(
    SRCS "main.c" "safety_logic.c" "display_driver.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_wifi
        esp_event
        nvs_flash
        mqtt
        esp_driver_gpio
        esp_driver_spi
        esp_lcd
        driver
        esp_timer
        cjson
        hardware
        display_ui
        vl53l0x
        esp_driver_i2c
    EMBED_TXTFILES "../mqtt_ca.crt"
)
