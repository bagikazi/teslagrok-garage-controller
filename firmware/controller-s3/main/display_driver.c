#include "display_driver.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <sys/lock.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_dev.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hardware_pins.h"
#include "lvgl.h"

#define DISPLAY_HOST SPI2_HOST
#define DISPLAY_WIDTH 240
#define DISPLAY_HEIGHT 240
// Hardware-verified panel settings (docs/HARDWARE.md, "Verified display settings").
#define DISPLAY_PIXEL_CLOCK_HZ (40 * 1000 * 1000)
#define DISPLAY_SPI_MODE 3 // CS-less ST7789 modules only latch data in SPI mode 3
#define DISPLAY_X_GAP 0
#define DISPLAY_Y_GAP 0
#define DISPLAY_DRAW_BUFFER_LINES 24
#define DISPLAY_CMD_BITS 8
#define DISPLAY_PARAM_BITS 8
#define DISPLAY_FRAME_BYTES (DISPLAY_WIDTH * DISPLAY_HEIGHT * sizeof(uint16_t))
#define LVGL_TICK_PERIOD_MS 2
#define LVGL_TASK_STACK_SIZE (8 * 1024)
#define LVGL_TASK_PRIORITY 2

static const char *TAG = "garage-display";
static _lock_t s_lvgl_lock;
static esp_lcd_panel_io_handle_t s_io_handle;
static esp_lcd_panel_handle_t s_panel_handle;
static lv_display_t *s_display;
static bool s_initialized;

static bool display_flush_done(esp_lcd_panel_io_handle_t panel_io,
                               esp_lcd_panel_io_event_data_t *event_data,
                               void *user_ctx)
{
    (void)panel_io;
    (void)event_data;
    lv_display_flush_ready((lv_display_t *)user_ctx);
    return false;
}

static void display_flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    esp_lcd_panel_handle_t panel = lv_display_get_user_data(display);
    const int width = area->x2 - area->x1 + 1;
    const int height = area->y2 - area->y1 + 1;

    // ST7789 expects RGB565 words in big-endian byte order on SPI.
    lv_draw_sw_rgb565_swap(pixels, width * height);
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(
        panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, pixels));
}

static void lvgl_tick(void *arg)
{
    (void)arg;
    lv_tick_inc(LVGL_TICK_PERIOD_MS);
}

static void lvgl_task(void *arg)
{
    (void)arg;
    while (true) {
        _lock_acquire(&s_lvgl_lock);
        uint32_t delay_ms = lv_timer_handler();
        _lock_release(&s_lvgl_lock);
        if (delay_ms < 1) delay_ms = 1;
        if (delay_ms > 50) delay_ms = 50;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}

static void display_hardware_color_test(void)
{
    uint8_t *frame = heap_caps_malloc(DISPLAY_FRAME_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(frame != NULL);

    // The old working TFT_eSPI project used this same visible color test. Keep
    // it before LVGL so a black screen can be separated from a UI-rendering bug.
    const uint16_t colors[] = { 0xF800, 0x07E0, 0x001F, 0xFFFF };
    for (size_t color_index = 0; color_index < sizeof(colors) / sizeof(colors[0]); ++color_index) {
        const uint16_t color = colors[color_index];
        for (size_t pixel = 0; pixel < DISPLAY_WIDTH * DISPLAY_HEIGHT; ++pixel) {
            frame[pixel * 2] = (uint8_t)(color >> 8);
            frame[pixel * 2 + 1] = (uint8_t)(color & 0xFF);
        }
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(
            s_panel_handle, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, frame));
        vTaskDelay(pdMS_TO_TICKS(350));
    }

    // Leave the final white frame visible long enough for a human observer to
    // verify the panel independently of LVGL rendering.
    vTaskDelay(pdMS_TO_TICKS(5000));

    heap_caps_free(frame);
    ESP_LOGI(TAG, "ST7789 hardware color test complete");
}

static void tft_espi_st7789_init_sequence(void)
{
    // Ported from old project/Çlaışan Kütüphane/TFT_eSPI/TFT_Drivers/ST7789_Init.h.
    // This is the initialization sequence that was known to work with this panel.
    // MADCTL 0x00: RGB order, no mirror/swap. This is the 180-degree orientation
    // (Adafruit setRotation(2)) that shows the image upright on the mounted panel.
    static const uint8_t madctl[] = { 0x00 };
    static const uint8_t b6[] = { 0x0A, 0x82 };
    static const uint8_t ramctrl[] = { 0x00, 0xE0 };
    static const uint8_t colmod[] = { 0x55 };
    static const uint8_t porctrl[] = { 0x0C, 0x0C, 0x00, 0x33, 0x33 };
    static const uint8_t gctrl[] = { 0x35 };
    static const uint8_t vcoms[] = { 0x28 };
    static const uint8_t lcmctrl[] = { 0x0C };
    static const uint8_t vdvvrhen[] = { 0x01, 0xFF };
    static const uint8_t vrhs[] = { 0x10 };
    static const uint8_t vdvset[] = { 0x20 };
    static const uint8_t frctr2[] = { 0x0F };
    static const uint8_t pwctrl1[] = { 0xA4, 0xA1 };
    static const uint8_t pvgam[] = {
        0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x32, 0x44,
        0x42, 0x06, 0x0E, 0x12, 0x14, 0x17,
    };
    static const uint8_t nvgam[] = {
        0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x31, 0x54,
        0x47, 0x0E, 0x1C, 0x17, 0x1B, 0x1E,
    };
    static const uint8_t caset[] = { 0x00, 0x00, 0x00, 0xEF };
    static const uint8_t raset[] = { 0x00, 0x00, 0x01, 0x3F };

    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x11, NULL, 0)); // SLPOUT
    vTaskDelay(pdMS_TO_TICKS(120));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x13, NULL, 0)); // NORON
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x36, madctl, sizeof(madctl)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xB6, b6, sizeof(b6)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xB0, ramctrl, sizeof(ramctrl)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x3A, colmod, sizeof(colmod)));
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xB2, porctrl, sizeof(porctrl)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xB7, gctrl, sizeof(gctrl)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xBB, vcoms, sizeof(vcoms)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xC0, lcmctrl, sizeof(lcmctrl)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xC2, vdvvrhen, sizeof(vdvvrhen)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xC3, vrhs, sizeof(vrhs)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xC4, vdvset, sizeof(vdvset)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xC6, frctr2, sizeof(frctr2)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xD0, pwctrl1, sizeof(pwctrl1)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xE0, pvgam, sizeof(pvgam)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0xE1, nvgam, sizeof(nvgam)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x21, NULL, 0)); // INVON
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x2A, caset, sizeof(caset)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x2B, raset, sizeof(raset)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(s_io_handle, 0x29, NULL, 0)); // DISPON
    vTaskDelay(pdMS_TO_TICKS(120));
}

bool garage_display_init(void)
{
    if (s_initialized) return true;

    ESP_LOGI(TAG, "Initializing ST7789 on MOSI=%d SCLK=%d DC=%d RST=%d CS=%d",
             PIN_TFT_MOSI, PIN_TFT_SCLK, PIN_TFT_DC, PIN_TFT_RST, PIN_TFT_CS);

    const spi_bus_config_t bus_config = {
        .sclk_io_num = PIN_TFT_SCLK,
        .mosi_io_num = PIN_TFT_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = DISPLAY_FRAME_BYTES,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(DISPLAY_HOST, &bus_config, SPI_DMA_CH_AUTO));

    const esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = PIN_TFT_DC,
        .cs_gpio_num = PIN_TFT_CS,
        .pclk_hz = DISPLAY_PIXEL_CLOCK_HZ,
        .lcd_cmd_bits = DISPLAY_CMD_BITS,
        .lcd_param_bits = DISPLAY_PARAM_BITS,
        .spi_mode = DISPLAY_SPI_MODE,
        .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(DISPLAY_HOST, &io_config, &s_io_handle));

    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_TFT_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(s_io_handle, &panel_config, &s_panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel_handle));

    tft_espi_st7789_init_sequence();

    // Verified orientation: no mirror, no gap (the upright window is RAM rows 0-239).
    // esp_lcd_panel_mirror() rewrites MADCTL from the driver's state, so keep it
    // consistent with the raw MADCTL above. Inversion is required for this IPS panel.
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(s_panel_handle, false));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(s_panel_handle, false, false));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(s_panel_handle, DISPLAY_X_GAP, DISPLAY_Y_GAP));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(s_panel_handle, true));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel_handle, true));

    display_hardware_color_test();

    lv_init();
    s_display = lv_display_create(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    assert(s_display != NULL);

    const size_t buffer_size = DISPLAY_WIDTH * DISPLAY_DRAW_BUFFER_LINES * sizeof(lv_color16_t);
    void *buffer_1 = heap_caps_malloc(buffer_size, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    void *buffer_2 = heap_caps_malloc(buffer_size, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(buffer_1 != NULL && buffer_2 != NULL);

    lv_display_set_buffers(s_display, buffer_1, buffer_2, buffer_size, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_user_data(s_display, s_panel_handle);
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(s_display, display_flush);

    const esp_lcd_panel_io_callbacks_t callbacks = {
        .on_color_trans_done = display_flush_done,
    };
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(s_io_handle, &callbacks, s_display));

    const esp_timer_create_args_t tick_args = {
        .callback = lvgl_tick,
        .name = "garage_lvgl_tick",
    };
    esp_timer_handle_t tick_timer = NULL;
    ESP_ERROR_CHECK(esp_timer_create(&tick_args, &tick_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(tick_timer, LVGL_TICK_PERIOD_MS * 1000));

    _lock_acquire(&s_lvgl_lock);
    display_ui_init();
    _lock_release(&s_lvgl_lock);
    xTaskCreate(lvgl_task, "garage_lvgl", LVGL_TASK_STACK_SIZE, NULL, LVGL_TASK_PRIORITY, NULL);

    s_initialized = true;
    ESP_LOGI(TAG, "ST7789 ready: 240x240, RGB565, SPI %d MHz", DISPLAY_PIXEL_CLOCK_HZ / 1000000);
    return true;
}

void garage_display_set_title(const char *title)
{
    if (!s_initialized) return;
    _lock_acquire(&s_lvgl_lock);
    display_ui_set_title(title);
    _lock_release(&s_lvgl_lock);
}

void garage_display_update(const display_ui_state_t *state)
{
    if (!s_initialized || state == NULL) return;
    _lock_acquire(&s_lvgl_lock);
    display_ui_update(state);
    _lock_release(&s_lvgl_lock);
}
