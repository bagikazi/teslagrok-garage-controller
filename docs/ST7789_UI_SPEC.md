# ST7789 UI specification

The approved design source is `assets/st7789/reference.png`. It must never be
overwritten and is not used as a static full-screen image.

## Canvas and coordinates

- Canvas: 240x240 pixels, origin `(0,0)` at the top-left.
- Background: `#061523`.
- Header: `(12,8)` to `(228,32)`.
- Main status panel: `(12,38)` to `(228,100)`.
- Safety badge: `(24,84)` to `(216,108)`.
- Magnetic panel: `(12,114)` to `(112,174)`.
- Distance panel: `(120,114)` to `(228,174)`.
- Connectivity footer: `(12,182)` to `(228,228)`.

Panels use dark blue `#0B2744` / `#0E3155`, border `#17446F`, white text
`#E8F2FF`, muted text `#97B1CC`, safe green `#20D95A`, warning amber
`#FFB020`, danger red `#FF3B3B` and offline gray `#708090`.

## Dynamic content

The built-in LVGL Montserrat fonts are ASCII-only, so Turkish letters are
written without diacritics (approved by the owner on 2026-09-21).

The header shows `GARAGE` and the settings icon. The main panel shows the
garage illustration and one of `KAPI ACIK`, `KAPI KAPALI`, `ACILIYOR`,
`KAPANIYOR`, `KAPI DURDU`, `BILINMIYOR` or `KAPI HATA`. The safety badge shows
`ALAN TEMIZ`, `SINIRA YAKIN`, `ENGEL VAR` or `SENSOR HATASI`.

Garage illustration: flat roof on two pillars with a dark opening.
- OPEN: door rolled up at the top, static green up arrow.
- CLOSED: door fully down, no arrow.
- OPENING: door rolled up, green up arrow travels bottom-to-top in a loop.
- CLOSING: door rolled up, amber down arrow travels top-to-bottom in a loop.
- STOPPED / UNKNOWN / ERROR: door half way, no arrow.

The magnetic panel shows `Ust Sensor` (OPEN reed) and `Alt Sensor` (CLOSED
reed) with ON/OFF pills. The distance panel shows `HC-SR04` and `TOF` live
values or `HATA`. The footer shows WiFi, Server and a small light indicator.

`status_task` in `firmware/controller-s3/main/main.c` samples at 5 Hz and
pushes every update; LVGL only redraws what changed.
