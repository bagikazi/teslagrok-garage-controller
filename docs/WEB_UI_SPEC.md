# Web UI specification

## Product intent

Garage is a calm, product-oriented smart-home control interface. It prioritizes
garage state, local safety and clear actions over decorative dashboard density.
The backend and WebSocket remain the source of truth; the browser never talks
directly to the camera.

## Visual system

The design tokens live in `web/src/styles/tokens.css`. The page is dark first
(warm charcoal `--bg #131210`, surfaces `#1e1c1a` / `#272522`) and follows the
system light setting (`--bg #f2efea`, white surfaces). Semantic colours keep one
meaning everywhere:

| Token | Meaning |
| --- | --- |
| `--safe` | closed, clear, online |
| `--warn` | open, moving, warning, test mode |
| `--danger` / `--danger-solid` | blocked, fault, offline, DURDUR |
| `--action` | links and new-event counts |

Type: Bricolage Grotesque (headings), Figtree (body), JetBrains Mono (numbers),
loaded from Google Fonts with system fallbacks. Icons are inline SVG line icons
(`web/src/app/icons.tsx`); no icon fonts, emoji or UI libraries.

## Layout

The panel is a tabbed app with four tabs: **Kapı**, **Kamera**, **Sensörler**
and **Geçmiş** (the active tab is kept in the URL hash).

- Phone: sticky app bar (title, subtitle, test-mode and connection chips), one
  tab at a time, bottom tab bar. On the Kapı tab DURDUR is docked above the tab
  bar; on other tabs a compact "Kapı açılıyor/kapanıyor · DURDUR" bar appears
  while the door moves.
- ≥768px: the tab bar becomes a left rail and DURDUR sits under the door state.
- ≥1024px: a third column shows the camera (with its controls) and the last
  five events.

Tab badges: red "!" for faults (offline board, door error, blocked door line,
camera error), amber dot for open/moving/test mode/warning, blinking dot while
live camera is on, and a count of events that arrived while Geçmiş was closed.

## Door control

The Kapı tab is built around a round dial around the garage drawing. The ring
colour and pattern show the state: green closed, amber open, dashed and
rotating while moving, dotted red with a lock badge while closing is locked.

- Opening and closing need a 900 ms press-and-hold (pointer, Space or Enter);
  a short tap only explains "Basılı tutun".
- A moving door stops with a single tap on the dial.
- STOPPED / UNKNOWN / ERROR: the dial opens, a separate "Kapatmak için basılı
  tutun" pill closes.
- DURDUR is the strongest action and is always available while the controller
  is online.
- A blocked or faulty door line (BLOCKED / SENSOR_FAULT) locks closing and
  says why under the state; it cannot be overridden in the UI.
- The door logic lives in `web/src/lib/door-ui.ts` and is unit tested.

## State language

Door labels: `Kapı kapalı`, `Kapı açık`, `Açılıyor`, `Kapanıyor`, `Durdu`,
`Bilinmiyor`, `Çevrimdışı`, `Hata`. Door-line labels: `Alan temiz`,
`Sınıra yakın`, `Engel var`, `Sensör hatası`. The frontend never displays a
travel percentage.

## Wi-Fi signal

The browser renders the actual telemetry RSSI as the same 0-10 level the device
screen shows (`wifiLevelFromRssi`) with `Çok iyi`, `İyi`, `Orta`, `Zayıf`,
`Çok zayıf`, and never invents an offline value. Disconnected devices show
`Bağlantı yok`; stale values are marked with their last-seen time.

## Camera states

The camera never auto-starts. Idle shows the last live frame (or the last
snapshot) with its time. `Canlı izle` calls `POST /api/camera/live/start`; the
browser then connects to the authenticated backend stream. `Bağlanıyor`,
`Canlı · fps`, `Çevrimdışı` and `Hata` are explicit states. Stop calls
`POST /api/camera/live/stop` and closes the browser socket.

## Accessibility and realtime behavior

Critical status uses text plus a shape (dot, ring pattern, icon), never colour
alone. Buttons keep visible focus, touch targets are at least 44px and motion
respects `prefers-reduced-motion`. Calibration is confirmed in an in-page sheet
(no browser dialogs). State, safety, telemetry, PIR/light and camera activity
arrive through the existing WebSocket and are not polled every second.
