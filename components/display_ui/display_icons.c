#include "display_icons.h"

#define C_WHITE   lv_color_hex(0xDCEBFF)
#define C_MUTED   lv_color_hex(0x8EABC9)
#define C_GREEN   lv_color_hex(0x20D95A)
#define C_PANEL   lv_color_hex(0x0C2744)

static void no_scroll(lv_obj_t *o)
{
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
}

static lv_obj_t *line_make(lv_obj_t *parent, const lv_point_precise_t *pts, uint32_t count, lv_color_t color, lv_coord_t width)
{
    lv_obj_t *line = lv_line_create(parent);
    lv_line_set_points(line, pts, count);
    lv_obj_set_style_line_color(line, color, 0);
    lv_obj_set_style_line_width(line, width, 0);
    lv_obj_set_style_line_rounded(line, true, 0);
    no_scroll(line);
    return line;
}

#define GARAGE_W          62
#define GARAGE_H          58
#define OPENING_X         9
#define OPENING_Y         9
#define OPENING_W         44
#define OPENING_H         44
#define DOOR_ROLLED_H     8
#define DOOR_HALF_H       22
#define ARROW_H           18
#define ARROW_TRAVEL_MS   900

#define C_ROOF    lv_color_hex(0xC9D6E3)
#define C_PILLAR  lv_color_hex(0xAFC0D2)
#define C_FLOOR   lv_color_hex(0x5E7690)
#define C_INSIDE  lv_color_hex(0x04101C)
#define C_DOOR    lv_color_hex(0xC4D2E0)
#define C_SLAT    lv_color_hex(0x8FA3B8)
#define C_AMBER   lv_color_hex(0xFFB020)

static lv_obj_t *block_make(lv_obj_t *parent, int x, int y, int w, int h, lv_color_t color, int radius)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, color, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(o, 0, 0);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_set_style_pad_all(o, 0, 0);
    no_scroll(o);
    return o;
}

display_garage_icon_t display_icon_garage_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    display_garage_icon_t out = { .mode = -1 };
    lv_obj_t *root = lv_obj_create(parent);
    out.root = root;
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, GARAGE_W, GARAGE_H);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    no_scroll(root);

    /* Building: flat roof slab on two pillars, dark interior, floor strip. */
    block_make(root, 0, 2, GARAGE_W, 7, C_ROOF, 2);
    block_make(root, 3, OPENING_Y, 6, OPENING_H, C_PILLAR, 0);
    block_make(root, GARAGE_W - 9, OPENING_Y, 6, OPENING_H, C_PILLAR, 0);
    block_make(root, 0, OPENING_Y + OPENING_H, GARAGE_W, 4, C_FLOOR, 2);

    /* The opening clips its children, so the arrow slides in and out of view. */
    out.opening = block_make(root, OPENING_X, OPENING_Y, OPENING_W, OPENING_H, C_INSIDE, 0);

    lv_obj_t *door = block_make(out.opening, 0, 0, OPENING_W, OPENING_H, C_DOOR, 0);
    out.door_panel = door;
    for (int i = 0; i < 7; ++i) {
        block_make(door, 2, 4 + i * 6, OPENING_W - 4, 2, C_SLAT, 0);
    }

    lv_obj_t *arrow = lv_label_create(out.opening);
    out.arrow = arrow;
    lv_obj_set_width(arrow, OPENING_W);
    lv_obj_set_style_text_align(arrow, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(arrow, &lv_font_montserrat_16, 0);
    lv_label_set_text(arrow, LV_SYMBOL_UP);

    display_icon_garage_set_mode(&out, DISPLAY_GARAGE_CLOSED);
    return out;
}

static void arrow_y_cb(void *obj, int32_t y)
{
    lv_obj_set_y((lv_obj_t *)obj, y);
}

static void arrow_loop(lv_obj_t *arrow, int32_t from, int32_t to)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, arrow);
    lv_anim_set_exec_cb(&a, arrow_y_cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_duration(&a, ARROW_TRAVEL_MS);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_linear);
    lv_anim_start(&a);
}

void display_icon_garage_set_mode(display_garage_icon_t *icon, display_garage_mode_t mode)
{
    if (!icon || !icon->door_panel || icon->mode == (int)mode) return;
    icon->mode = (int)mode;

    lv_anim_delete(icon->arrow, arrow_y_cb);
    lv_obj_add_flag(icon->arrow, LV_OBJ_FLAG_HIDDEN);

    switch (mode) {
        case DISPLAY_GARAGE_OPEN:
            lv_obj_set_height(icon->door_panel, DOOR_ROLLED_H);
            lv_label_set_text(icon->arrow, LV_SYMBOL_UP);
            lv_obj_set_style_text_color(icon->arrow, C_GREEN, 0);
            lv_obj_set_y(icon->arrow, OPENING_H - ARROW_H - 4);
            lv_obj_clear_flag(icon->arrow, LV_OBJ_FLAG_HIDDEN);
            break;
        case DISPLAY_GARAGE_OPENING:
            lv_obj_set_height(icon->door_panel, DOOR_ROLLED_H);
            lv_label_set_text(icon->arrow, LV_SYMBOL_UP);
            lv_obj_set_style_text_color(icon->arrow, C_GREEN, 0);
            lv_obj_clear_flag(icon->arrow, LV_OBJ_FLAG_HIDDEN);
            arrow_loop(icon->arrow, OPENING_H, DOOR_ROLLED_H - ARROW_H);
            break;
        case DISPLAY_GARAGE_CLOSING:
            lv_obj_set_height(icon->door_panel, DOOR_ROLLED_H);
            lv_label_set_text(icon->arrow, LV_SYMBOL_DOWN);
            lv_obj_set_style_text_color(icon->arrow, C_AMBER, 0);
            lv_obj_clear_flag(icon->arrow, LV_OBJ_FLAG_HIDDEN);
            arrow_loop(icon->arrow, DOOR_ROLLED_H - ARROW_H, OPENING_H);
            break;
        case DISPLAY_GARAGE_STOPPED:
            lv_obj_set_height(icon->door_panel, DOOR_HALF_H);
            break;
        case DISPLAY_GARAGE_CLOSED:
        default:
            lv_obj_set_height(icon->door_panel, OPENING_H);
            break;
    }
}

lv_obj_t *display_icon_magnet_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, 34, 42);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    no_scroll(root);

    lv_obj_t *left = lv_obj_create(root);
    lv_obj_set_pos(left, 5, 4);
    lv_obj_set_size(left, 8, 29);
    lv_obj_set_style_bg_color(left, C_WHITE, 0);
    lv_obj_set_style_border_width(left, 0, 0);
    lv_obj_set_style_radius(left, 5, 0);
    no_scroll(left);

    lv_obj_t *right = lv_obj_create(root);
    lv_obj_set_pos(right, 21, 4);
    lv_obj_set_size(right, 8, 29);
    lv_obj_set_style_bg_color(right, C_WHITE, 0);
    lv_obj_set_style_border_width(right, 0, 0);
    lv_obj_set_style_radius(right, 5, 0);
    no_scroll(right);

    lv_obj_t *bridge = lv_obj_create(root);
    lv_obj_set_pos(bridge, 8, 25);
    lv_obj_set_size(bridge, 18, 8);
    lv_obj_set_style_bg_color(bridge, C_WHITE, 0);
    lv_obj_set_style_border_width(bridge, 0, 0);
    lv_obj_set_style_radius(bridge, 4, 0);
    no_scroll(bridge);
    return root;
}

lv_obj_t *display_icon_distance_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, 36, 36);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    no_scroll(root);

    lv_obj_t *dot = lv_obj_create(root);
    lv_obj_set_pos(dot, 15, 15);
    lv_obj_set_size(dot, 6, 6);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(dot, C_WHITE, 0);
    lv_obj_set_style_border_width(dot, 0, 0);
    no_scroll(dot);

    for (int i = 0; i < 2; ++i) {
        lv_obj_t *arc = lv_arc_create(root);
        lv_obj_set_size(arc, 18 + i * 12, 18 + i * 12);
        lv_obj_center(arc);
        lv_arc_set_bg_angles(arc, 215, 325);
        lv_arc_set_value(arc, 0);
        lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
        lv_obj_set_style_arc_width(arc, 2, LV_PART_MAIN);
        lv_obj_set_style_arc_color(arc, C_WHITE, LV_PART_MAIN);
        no_scroll(arc);
    }
    return root;
}

lv_obj_t *display_icon_wifi_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, 28, 22);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    no_scroll(root);

    for (int i = 0; i < 2; ++i) {
        lv_obj_t *arc = lv_arc_create(root);
        lv_obj_set_size(arc, 18 + i * 9, 18 + i * 9);
        lv_obj_align(arc, LV_ALIGN_BOTTOM_MID, 0, 4 + i * 4);
        lv_arc_set_bg_angles(arc, 215, 325);
        lv_arc_set_value(arc, 0);
        lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
        lv_obj_set_style_arc_width(arc, 2, LV_PART_MAIN);
        lv_obj_set_style_arc_color(arc, C_WHITE, LV_PART_MAIN);
        no_scroll(arc);
    }

    lv_obj_t *dot = lv_obj_create(root);
    lv_obj_set_size(dot, 5, 5);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(dot, C_WHITE, 0);
    lv_obj_set_style_border_width(dot, 0, 0);
    lv_obj_align(dot, LV_ALIGN_BOTTOM_MID, 0, 0);
    return root;
}

lv_obj_t *display_icon_server_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, 28, 22);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    no_scroll(root);

    lv_obj_t *body = lv_obj_create(root);
    lv_obj_set_pos(body, 2, 8);
    lv_obj_set_size(body, 24, 12);
    lv_obj_set_style_bg_opa(body, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_color(body, C_WHITE, 0);
    lv_obj_set_style_border_width(body, 2, 0);
    lv_obj_set_style_radius(body, 7, 0);
    no_scroll(body);

    lv_obj_t *cloud = lv_obj_create(root);
    lv_obj_set_pos(cloud, 7, 3);
    lv_obj_set_size(cloud, 11, 11);
    lv_obj_set_style_bg_color(cloud, C_PANEL, 0);
    lv_obj_set_style_border_color(cloud, C_WHITE, 0);
    lv_obj_set_style_border_width(cloud, 2, 0);
    lv_obj_set_style_radius(cloud, LV_RADIUS_CIRCLE, 0);
    no_scroll(cloud);
    return root;
}

lv_obj_t *display_icon_settings_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y)
{
    lv_obj_t *root = lv_obj_create(parent);
    lv_obj_set_pos(root, x, y);
    lv_obj_set_size(root, 26, 26);
    lv_obj_set_style_bg_opa(root, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    no_scroll(root);

    lv_obj_t *outer = lv_obj_create(root);
    lv_obj_set_size(outer, 20, 20);
    lv_obj_center(outer);
    lv_obj_set_style_radius(outer, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(outer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_color(outer, C_WHITE, 0);
    lv_obj_set_style_border_width(outer, 3, 0);
    no_scroll(outer);

    lv_obj_t *inner = lv_obj_create(root);
    lv_obj_set_size(inner, 6, 6);
    lv_obj_center(inner);
    lv_obj_set_style_radius(inner, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(inner, C_WHITE, 0);
    lv_obj_set_style_border_width(inner, 0, 0);
    no_scroll(inner);
    return root;
}
