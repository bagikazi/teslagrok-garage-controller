#pragma once

#include <stdbool.h>
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    DISPLAY_GARAGE_OPEN = 0,  /* door rolled up, static up arrow */
    DISPLAY_GARAGE_CLOSED,    /* door fully down */
    DISPLAY_GARAGE_OPENING,   /* door rolled up, arrow travels upward in a loop */
    DISPLAY_GARAGE_CLOSING,   /* door rolled up, arrow travels downward in a loop */
    DISPLAY_GARAGE_STOPPED    /* door half way, no arrow */
} display_garage_mode_t;

typedef struct {
    lv_obj_t *root;
    lv_obj_t *opening;
    lv_obj_t *door_panel;
    lv_obj_t *arrow;
    int mode; /* current display_garage_mode_t, -1 before the first set */
} display_garage_icon_t;

display_garage_icon_t display_icon_garage_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);
/* Cheap to call repeatedly: animations restart only when the mode changes. */
void display_icon_garage_set_mode(display_garage_icon_t *icon, display_garage_mode_t mode);

lv_obj_t *display_icon_magnet_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);
lv_obj_t *display_icon_distance_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);
lv_obj_t *display_icon_wifi_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);
lv_obj_t *display_icon_server_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);
lv_obj_t *display_icon_settings_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y);

#ifdef __cplusplus
}
#endif
