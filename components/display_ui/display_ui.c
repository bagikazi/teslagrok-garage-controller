#include "display_ui.h"
#include "display_icons.h"
#include <stdio.h>
#include <string.h>

#define UI_BG              lv_color_hex(0x061523)
#define UI_PANEL           lv_color_hex(0x0B2744)
#define UI_PANEL_2         lv_color_hex(0x0E3155)
#define UI_BORDER          lv_color_hex(0x17446F)
#define UI_TEXT            lv_color_hex(0xE8F2FF)
#define UI_TEXT_MUTED      lv_color_hex(0x97B1CC)
#define UI_SAFE            lv_color_hex(0x20D95A)
#define UI_WARNING         lv_color_hex(0xFFB020)
#define UI_DANGER          lv_color_hex(0xFF3B3B)
#define UI_OFFLINE         lv_color_hex(0x708090)
#define UI_ACCENT          lv_color_hex(0x2D8CFF)

/* 240x240 layout derived from the approved mockup. */
#define SCREEN_W 240
#define SCREEN_H 240

static lv_obj_t *s_root;
static lv_obj_t *s_title;
static display_garage_icon_t s_garage_icon;
static lv_obj_t *s_door_label;
static lv_obj_t *s_zone_pill;
static lv_obj_t *s_zone_label;
static lv_obj_t *s_top_value;
static lv_obj_t *s_bottom_value;
static lv_obj_t *s_hcsr_value;
static lv_obj_t *s_tof_value;
static lv_obj_t *s_hcsr_label;
static lv_obj_t *s_tof_label;
static lv_obj_t *s_wifi_dot;
static lv_obj_t *s_wifi_level;
static lv_obj_t *s_server_dot;
static lv_obj_t *s_light_dot;

static lv_style_t s_card_style;
static lv_style_t s_card_style_alt;
static lv_style_t s_pill_style;
static bool s_styles_ready;

static lv_obj_t *label_make(lv_obj_t *parent, const char *txt, const lv_font_t *font, lv_color_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, txt);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_obj_set_style_text_opa(l, LV_OPA_COVER, 0);
    return l;
}

static lv_obj_t *card_make(lv_obj_t *parent, int x, int y, int w, int h, bool alt)
{
    lv_obj_t *c = lv_obj_create(parent);
    lv_obj_set_pos(c, x, y);
    lv_obj_set_size(c, w, h);
    lv_obj_add_style(c, alt ? &s_card_style_alt : &s_card_style, 0);
    lv_obj_clear_flag(c, LV_OBJ_FLAG_SCROLLABLE);
    return c;
}

static lv_obj_t *dot_make(lv_obj_t *parent, int x, int y)
{
    lv_obj_t *d = lv_obj_create(parent);
    lv_obj_set_pos(d, x, y);
    lv_obj_set_size(d, 8, 8);
    lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(d, 0, 0);
    lv_obj_set_style_bg_color(d, UI_OFFLINE, 0);
    lv_obj_clear_flag(d, LV_OBJ_FLAG_SCROLLABLE);
    return d;
}

static void pill_set(lv_obj_t *pill, lv_obj_t *label, const char *text, lv_color_t bg)
{
    lv_obj_set_style_bg_color(pill, bg, 0);
    lv_label_set_text(label, text);
}

static void status_value_set(lv_obj_t *label, bool on)
{
    lv_label_set_text(label, on ? "ON" : "OFF");
    lv_obj_set_style_bg_color(label, on ? UI_SAFE : UI_DANGER, 0);
}

/*
 * The built-in Montserrat fonts only cover ASCII, so Turkish letters are
 * written without diacritics (AÇIK -> ACIK, SENSÖR -> SENSOR).
 */
static const char *door_text(display_door_state_t state)
{
    switch (state) {
        case DISPLAY_DOOR_OPEN: return "KAPI ACIK";
        case DISPLAY_DOOR_CLOSED: return "KAPI KAPALI";
        case DISPLAY_DOOR_OPENING: return "ACILIYOR";
        case DISPLAY_DOOR_CLOSING: return "KAPANIYOR";
        case DISPLAY_DOOR_STOPPED: return "KAPI DURDU";
        case DISPLAY_DOOR_UNKNOWN: return "BILINMIYOR";
        default: return "KAPI HATA";
    }
}

static display_garage_mode_t garage_mode(display_door_state_t state)
{
    switch (state) {
        case DISPLAY_DOOR_OPEN: return DISPLAY_GARAGE_OPEN;
        case DISPLAY_DOOR_CLOSED: return DISPLAY_GARAGE_CLOSED;
        case DISPLAY_DOOR_OPENING: return DISPLAY_GARAGE_OPENING;
        case DISPLAY_DOOR_CLOSING: return DISPLAY_GARAGE_CLOSING;
        default: return DISPLAY_GARAGE_STOPPED;
    }
}

static void setup_styles(void)
{
    if (s_styles_ready) return;

    lv_style_init(&s_card_style);
    lv_style_set_bg_color(&s_card_style, UI_PANEL);
    lv_style_set_bg_opa(&s_card_style, LV_OPA_COVER);
    lv_style_set_border_color(&s_card_style, UI_BORDER);
    lv_style_set_border_width(&s_card_style, 1);
    lv_style_set_radius(&s_card_style, 10);
    lv_style_set_pad_all(&s_card_style, 0);

    lv_style_init(&s_card_style_alt);
    lv_style_set_bg_color(&s_card_style_alt, UI_PANEL_2);
    lv_style_set_bg_opa(&s_card_style_alt, LV_OPA_COVER);
    lv_style_set_border_color(&s_card_style_alt, UI_BORDER);
    lv_style_set_border_width(&s_card_style_alt, 1);
    lv_style_set_radius(&s_card_style_alt, 10);
    lv_style_set_pad_all(&s_card_style_alt, 0);

    lv_style_init(&s_pill_style);
    lv_style_set_bg_opa(&s_pill_style, LV_OPA_COVER);
    lv_style_set_radius(&s_pill_style, 8);
    lv_style_set_border_width(&s_pill_style, 0);
    lv_style_set_pad_all(&s_pill_style, 0);

    s_styles_ready = true;
}

void display_ui_init(void)
{
    setup_styles();

    s_root = lv_scr_act();
    lv_obj_set_style_bg_color(s_root, UI_BG, 0);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    /* Header */
    lv_obj_t *header = card_make(s_root, 5, 5, 230, 28, true);
    s_title = label_make(header, "GARAGE", &lv_font_montserrat_16, UI_TEXT);
    lv_obj_center(s_title);
    display_icon_settings_create(header, 198, 1);

    /* Main card */
    lv_obj_t *main = card_make(s_root, 5, 36, 230, 72, false);
    s_garage_icon = display_icon_garage_create(main, 5, 6);

    s_door_label = label_make(main, "", &lv_font_montserrat_20, UI_TEXT);
    lv_obj_set_pos(s_door_label, 72, 8);

    s_zone_pill = lv_obj_create(main);
    lv_obj_set_pos(s_zone_pill, 72, 37);
    lv_obj_set_size(s_zone_pill, 150, 27);
    lv_obj_add_style(s_zone_pill, &s_pill_style, 0);
    lv_obj_clear_flag(s_zone_pill, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(s_zone_pill, UI_SAFE, 0);

    s_zone_label = label_make(s_zone_pill, "", &lv_font_montserrat_14, lv_color_white());
    lv_obj_center(s_zone_label);

    /* Reed card */
    lv_obj_t *reed = card_make(s_root, 5, 112, 230, 49, false);
    display_icon_magnet_create(reed, 4, 3);

    lv_obj_t *top_lbl = label_make(reed, "Ust Sensor", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(top_lbl, 43, 7);
    lv_obj_t *bottom_lbl = label_make(reed, "Alt Sensor", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(bottom_lbl, 43, 27);

    s_top_value = label_make(reed, "ON", &lv_font_montserrat_12, lv_color_white());
    lv_obj_set_pos(s_top_value, 177, 5);
    lv_obj_set_size(s_top_value, 45, 17);
    lv_obj_set_style_bg_opa(s_top_value, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_top_value, 8, 0);
    lv_obj_set_style_text_align(s_top_value, LV_TEXT_ALIGN_CENTER, 0);

    s_bottom_value = label_make(reed, "OFF", &lv_font_montserrat_12, lv_color_white());
    lv_obj_set_pos(s_bottom_value, 177, 25);
    lv_obj_set_size(s_bottom_value, 45, 17);
    lv_obj_set_style_bg_opa(s_bottom_value, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_bottom_value, 8, 0);
    lv_obj_set_style_text_align(s_bottom_value, LV_TEXT_ALIGN_CENTER, 0);

    /* Distance card */
    lv_obj_t *dist = card_make(s_root, 5, 165, 230, 42, false);
    display_icon_distance_create(dist, 4, 3);

    s_hcsr_label = label_make(dist, "HC-SR04", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(s_hcsr_label, 43, 5);
    s_tof_label = label_make(dist, "TOF", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(s_tof_label, 43, 23);

    s_hcsr_value = label_make(dist, "-- cm", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(s_hcsr_value, 170, 5);
    s_tof_value = label_make(dist, "-- cm", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(s_tof_value, 170, 23);

    /* Footer */
    lv_obj_t *footer = card_make(s_root, 5, 211, 230, 24, true);
    display_icon_wifi_create(footer, 3, 0);
    lv_obj_t *wifi_lbl = label_make(footer, "WiFi", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(wifi_lbl, 32, 4);
    /* Signal level 0-10 between the label and the connection dot. */
    s_wifi_level = label_make(footer, "--", &lv_font_montserrat_12, UI_TEXT_MUTED);
    lv_obj_set_pos(s_wifi_level, 60, 4);
    s_wifi_dot = dot_make(footer, 93, 8);

    display_icon_server_create(footer, 104, 1);
    lv_obj_t *server_lbl = label_make(footer, "Server", &lv_font_montserrat_12, UI_TEXT);
    lv_obj_set_pos(server_lbl, 132, 4);
    s_server_dot = dot_make(footer, 177, 8);

    /* Small light indicator. Kept subtle so the approved layout stays intact. */
    lv_obj_t *light_lbl = label_make(footer, "L", &lv_font_montserrat_12, UI_TEXT_MUTED);
    lv_obj_set_pos(light_lbl, 199, 4);
    s_light_dot = dot_make(footer, 213, 8);

    /* Neutral boot state until the controller publishes live sensor data. */
    display_ui_state_t initial = {
        .door_state = DISPLAY_DOOR_UNKNOWN,
        .zone_state = DISPLAY_ZONE_SENSOR_FAULT,
        .wifi_level = -1,
    };
    display_ui_update(&initial);
}

/* Round to whole centimetres so sensor noise below the displayed precision does not redraw. */
static int shown_cm(bool valid, float cm) { return valid ? (int)(cm + 0.5f) : -1; }

/*
 * Only widgets whose content changed are touched: every LVGL setter invalidates
 * its area, and redrawing unchanged areas 5 times a second makes the panel
 * visibly flicker.
 */
void display_ui_update(const display_ui_state_t *state)
{
    static display_ui_state_t last;
    static bool has_last;
    if (!state || !s_root) return;
    const bool all = !has_last;
#define CHANGED(field) (all || state->field != last.field)

    if (CHANGED(door_state)) {
        const char *door = door_text(state->door_state);
        lv_label_set_text(s_door_label, door);
        /* 150 px of room: longer strings drop to the 16 px font to stay on one line. */
        lv_obj_set_style_text_font(s_door_label, strlen(door) > 10 ? &lv_font_montserrat_16 : &lv_font_montserrat_20, 0);
        display_icon_garage_set_mode(&s_garage_icon, garage_mode(state->door_state));
    }

    if (CHANGED(zone_state)) {
        switch (state->zone_state) {
            case DISPLAY_ZONE_CLEAR:
                pill_set(s_zone_pill, s_zone_label, "ALAN TEMIZ", UI_SAFE);
                break;
            case DISPLAY_ZONE_WARNING:
                pill_set(s_zone_pill, s_zone_label, "SINIRA YAKIN", UI_WARNING);
                break;
            case DISPLAY_ZONE_BLOCKED:
                pill_set(s_zone_pill, s_zone_label, "ENGEL VAR", UI_DANGER);
                break;
            case DISPLAY_ZONE_SENSOR_FAULT:
            default:
                pill_set(s_zone_pill, s_zone_label, "SENSOR HATASI", UI_DANGER);
                break;
        }
    }

    if (CHANGED(top_reed_on)) status_value_set(s_top_value, state->top_reed_on);
    if (CHANGED(bottom_reed_on)) status_value_set(s_bottom_value, state->bottom_reed_on);

    char buf[20];
    if (state->photocell_mode) {
        /* One centred row: the photocell beam replaces the HC-SR04/TOF readings. */
        if (CHANGED(photocell_mode)) {
            lv_label_set_text(s_hcsr_label, "FOTOSEL");
            lv_obj_set_y(s_hcsr_label, 14);
            lv_obj_set_y(s_hcsr_value, 14);
            lv_obj_add_flag(s_tof_label, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s_tof_value, LV_OBJ_FLAG_HIDDEN);
        }
        if (CHANGED(photocell_mode) || CHANGED(photocell_clear)) {
            lv_label_set_text(s_hcsr_value, state->photocell_clear ? "TEMIZ" : "KESIK");
            lv_obj_set_style_text_color(s_hcsr_value, state->photocell_clear ? UI_SAFE : UI_DANGER, 0);
        }
    }

    const int hc = shown_cm(state->hcsr04_valid, state->hcsr04_cm);
    if (!state->photocell_mode && (all || hc != shown_cm(last.hcsr04_valid, last.hcsr04_cm))) {
        if (hc >= 0) snprintf(buf, sizeof(buf), "%d cm", hc); else snprintf(buf, sizeof(buf), "HATA");
        lv_label_set_text(s_hcsr_value, buf);
        lv_obj_set_style_text_color(s_hcsr_value, hc >= 0 ? UI_TEXT : UI_DANGER, 0);
    }

    /* "> 150" = sensor responding, nothing within its range; "HATA" = sensor offline. */
    const int tof = shown_cm(state->tof_valid, state->tof_cm);
    if (!state->photocell_mode && (all || tof != shown_cm(last.tof_valid, last.tof_cm) || CHANGED(tof_online) || CHANGED(tof_range_cm))) {
        if (tof >= 0) snprintf(buf, sizeof(buf), "%d cm", tof);
        else if (!state->tof_online) snprintf(buf, sizeof(buf), "HATA");
        else if (state->tof_range_cm > 0) snprintf(buf, sizeof(buf), "> %d", state->tof_range_cm);
        else snprintf(buf, sizeof(buf), "--");
        lv_label_set_text(s_tof_value, buf);
        lv_obj_set_style_text_color(s_tof_value, tof >= 0 ? UI_TEXT : (state->tof_online ? UI_TEXT_MUTED : UI_DANGER), 0);
    }

    if (CHANGED(wifi_connected)) lv_obj_set_style_bg_color(s_wifi_dot, state->wifi_connected ? UI_SAFE : UI_DANGER, 0);
    if (CHANGED(wifi_level) || CHANGED(wifi_connected)) {
        const int level = state->wifi_connected ? state->wifi_level : -1;
        if (level >= 0) snprintf(buf, sizeof(buf), "%d/10", level); else snprintf(buf, sizeof(buf), "--");
        lv_label_set_text(s_wifi_level, buf);
        lv_obj_set_style_text_color(s_wifi_level, level >= 7 ? UI_SAFE : level >= 4 ? UI_WARNING : level >= 0 ? UI_DANGER : UI_TEXT_MUTED, 0);
    }
    if (CHANGED(server_connected)) lv_obj_set_style_bg_color(s_server_dot, state->server_connected ? UI_SAFE : UI_DANGER, 0);
    if (CHANGED(light_on)) lv_obj_set_style_bg_color(s_light_dot, state->light_on ? UI_WARNING : UI_OFFLINE, 0);
#undef CHANGED

    last = *state;
    has_last = true;
}

void display_ui_set_title(const char *title)
{
    if (!s_title || !title) return;
    lv_label_set_text(s_title, title);
    lv_obj_center(s_title);
}

lv_obj_t *display_ui_root(void)
{
    return s_root;
}
