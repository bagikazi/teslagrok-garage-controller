# display_ui

240x240 ST7789 garage dashboard component for ESP-IDF + LVGL.

## Files

- `display_ui.c` — approved dashboard layout and live state rendering
- `display_icons.c` — vector-like LVGL icons, no external image/font files required
- `include/display_ui.h` — public UI state API
- `include/display_icons.h` — icon API

## Integration

1. Initialize ST7789 + LVGL first.
2. Call `display_ui_init()` after LVGL display registration.
3. Update the UI from a periodic/UI-safe task using `display_ui_update(&state)`.

Example:

```c
display_ui_state_t state = {
    .door_state = GARAGE_DOOR_OPEN,
    .zone_state = GARAGE_ZONE_CLEAR,
    .top_reed_on = true,
    .bottom_reed_on = false,
    .hcsr04_valid = true,
    .hcsr04_cm = 18.0f,
    .tof_valid = true,
    .tof_cm = 16.0f,
    .wifi_connected = true,
    .server_connected = true,
    .light_on = false,
};

display_ui_init();
display_ui_update(&state);
```

## Important

The UI uses Turkish UTF-8 strings. Ensure the LVGL font configured in the final firmware contains Turkish glyphs. Do not replace the approved labels with ASCII-only approximations.
