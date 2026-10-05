#pragma once

#include <stdbool.h>

#include "display_ui.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize the ST7789 SPI panel and the LVGL dashboard. */
bool garage_display_init(void);

/** Update the dashboard state from application code. */
void garage_display_update(const display_ui_state_t *state);

/** Replace the dashboard header title (thread-safe). */
void garage_display_set_title(const char *title);

#ifdef __cplusplus
}
#endif
