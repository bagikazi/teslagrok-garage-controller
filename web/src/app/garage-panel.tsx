"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { wifiLevelFromRssi, type CommandAck, type GarageStatus, type ObstacleState, type SensorSnapshot } from "@garage-control/shared-types";
import { garageApi } from "../lib/api";
import type { DialModel } from "../lib/door-ui";
import { Icon, Spinner, type IconName } from "./icons";

type DoorState = GarageStatus["state"];
type SceneMode = "open" | "closed" | "opening" | "closing" | "stopped";

function sceneMode(state: DoorState): SceneMode {
  switch (state) {
    case "OPEN": return "open";
    case "CLOSED": return "closed";
    case "OPENING": return "opening";
    case "CLOSING": return "closing";
    default: return "stopped";
  }
}

// Opening geometry in SVG units; mirrors the 62x58 icon on the ST7789 at 2x.
const OPENING = { x: 18, y: 18, w: 88, h: 88 };
const DOOR_HEIGHT: Record<SceneMode, number> = { open: 16, closed: 88, opening: 16, closing: 16, stopped: 44 };

/**
 * The garage drawing from the controller's display: flat roof on two pillars
 * with a roll-up door. OPEN rolls the door up with a green arrow, CLOSED drops
 * it, OPENING/CLOSING loop an arrow through the opening, anything else parks
 * the door half way.
 */
export function GarageScene({ state, offline }: { state: DoorState; offline: boolean }) {
  const mode = sceneMode(state);
  const arrowUp = mode === "open" || mode === "opening";
  const arrowClass = mode === "closing" ? "down loop-down" : mode === "opening" ? "up loop-up" : "up";
  return (
    <svg className={`scene${offline ? " offline" : ""}`} viewBox="0 0 124 116" aria-hidden="true">
      <defs><clipPath id="garage-opening"><rect x={OPENING.x} y={OPENING.y} width={OPENING.w} height={OPENING.h} /></clipPath></defs>
      <rect className="s-roof" x="0" y="4" width="124" height="14" rx="4" />
      <rect className="s-pillar" x="6" y="18" width="12" height="88" />
      <rect className="s-pillar" x="106" y="18" width="12" height="88" />
      <g clipPath="url(#garage-opening)">
        <rect className="s-inside" x={OPENING.x} y={OPENING.y} width={OPENING.w} height={OPENING.h} />
        <g className="s-door" style={{ transform: `scaleY(${DOOR_HEIGHT[mode] / OPENING.h})` }}>
          <rect className="s-panel" x={OPENING.x} y={OPENING.y} width={OPENING.w} height={OPENING.h} />
          {Array.from({ length: 7 }, (_, i) => <rect key={i} className="s-slat" x={OPENING.x + 4} y={OPENING.y + 8 + i * 12} width={OPENING.w - 8} height="3" />)}
        </g>
        {mode !== "closed" && mode !== "stopped" && (
          <g className={`s-arrow ${arrowClass}`}><path d={arrowUp ? "M62 64 L50 78 H58 V92 H66 V78 H74 Z" : "M62 92 L50 78 H58 V64 H66 V78 H74 Z"} /></g>
        )}
      </g>
      <rect className="s-floor" x="0" y="106" width="124" height="8" rx="4" />
    </svg>
  );
}

const HOLD_MS = 900;
const RING_R = 132;
const RING_C = 2 * Math.PI * RING_R;
const TICKS = Array.from({ length: 60 }, (_, i) => {
  const a = (i / 60) * Math.PI * 2; const major = i % 5 === 0; const r1 = major ? 141 : 143; const r2 = 148;
  return { major, x1: 150 + Math.sin(a) * r1, y1: 150 - Math.cos(a) * r1, x2: 150 + Math.sin(a) * r2, y2: 150 - Math.cos(a) * r2 };
});

function vibrate(pattern: number | number[]) { try { navigator.vibrate?.(pattern); } catch { /* not supported */ } }

/**
 * Press-and-hold confirmation for door commands: progress runs for HOLD_MS while
 * the pointer (or Space/Enter) stays down; releasing early cancels. A short tap
 * reports onShort so the control can explain that it needs a hold.
 */
function useHoldToConfirm({ enabled, onConfirm, onProgress, onShort }: { enabled: boolean; onConfirm: () => void; onProgress: (p: number, animate: boolean) => void; onShort: () => void }) {
  const hold = useRef<{ t0: number; raf: number } | null>(null);
  const [holding, setHolding] = useState(false);
  const latest = useRef({ onConfirm, onProgress, onShort });
  useEffect(() => { latest.current = { onConfirm, onProgress, onShort }; });

  const end = useCallback((released: boolean) => {
    const current = hold.current; if (!current) return;
    cancelAnimationFrame(current.raf); hold.current = null; setHolding(false);
    latest.current.onProgress(0, true);
    if (released && performance.now() - current.t0 < 300) latest.current.onShort();
  }, []);

  const start = useCallback(() => {
    if (!enabled || hold.current) return;
    const t0 = performance.now();
    const step = () => {
      const current = hold.current; if (!current) return;
      const p = Math.min(1, (performance.now() - t0) / HOLD_MS);
      latest.current.onProgress(p, false);
      if (p >= 1) { hold.current = null; setHolding(false); vibrate([14, 40, 22]); latest.current.onConfirm(); return; }
      current.raf = requestAnimationFrame(step);
    };
    hold.current = { t0, raf: requestAnimationFrame(step) };
    setHolding(true); vibrate(8);
  }, [enabled]);

  useEffect(() => { if (!enabled) end(false); }, [enabled, end]);
  useEffect(() => () => { if (hold.current) cancelAnimationFrame(hold.current.raf); }, []);

  const handlers = enabled ? {
    onPointerDown: (event: PointerEvent<HTMLElement>) => { if (event.button !== 0) return; event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is optional */ } start(); },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (event.key !== " " && event.key !== "Enter") return; event.preventDefault(); if (!event.repeat) start(); },
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => { if (event.key !== " " && event.key !== "Enter") return; event.preventDefault(); end(true); }
  } : {};
  return { holding, handlers };
}

const DIAL_ICONS: Record<Exclude<DialModel["icon"], "spinner">, IconName> = { up: "up", down: "down", stop: "stop", lock: "lock", wifi: "wifi" };

/**
 * The door control: a round button around the garage drawing whose ring shows
 * the state (green closed, amber open/moving, red locked) and whose action
 * follows the dial model: hold to open/close, tap to stop a moving door.
 */
export function DoorDial({ model, state, offline, lockedHint, onCommand }: { model: DialModel; state: DoorState; offline: boolean; lockedHint: string; onCommand: (command: "open" | "close" | "stop") => void }) {
  const progress = useRef<SVGCircleElement>(null);
  const [nudge, setNudge] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const holdCommand = model.hold;
  const { holding, handlers } = useHoldToConfirm({
    enabled: holdCommand !== undefined,
    onConfirm: () => { setConfirmed(true); if (holdCommand) onCommand(holdCommand); },
    onProgress: (p, animate) => { const arc = progress.current; if (!arc) return; arc.style.transition = animate ? "stroke-dashoffset .28s ease" : "none"; arc.style.strokeDashoffset = String(RING_C * (1 - p)); },
    onShort: () => setNudge("Basılı tutun")
  });
  useEffect(() => { if (!nudge) return; const timer = window.setTimeout(() => setNudge(null), 1400); return () => window.clearTimeout(timer); }, [nudge]);
  useEffect(() => { if (!confirmed) return; const timer = window.setTimeout(() => setConfirmed(false), 420); return () => window.clearTimeout(timer); }, [confirmed]);

  function click() {
    if (model.tap) { vibrate(12); onCommand(model.tap); return; }
    if (model.locked) setNudge(lockedHint);
  }

  const hintIcon = nudge ? <Icon name="eye" size="xs" /> : holding ? <Icon name={holdCommand === "close" ? "down" : "up"} size="xs" /> : model.icon === "spinner" ? <Spinner /> : <Icon name={DIAL_ICONS[model.icon]} size="xs" fill={model.icon === "stop"} />;
  const hintText = nudge ?? (holding ? "Tutmaya devam edin…" : model.hint);
  return (
    <div className="dial-wrap">
      <button type="button" className={`dial${holding ? " is-holding" : ""}${confirmed ? " is-confirmed" : ""}${nudge ? " nudge" : ""}`} data-tone={model.tone} data-moving={model.moving} data-locked={model.locked ? "true" : "false"} data-pending={model.pending ? "true" : "false"} data-disabled={model.disabled ? "true" : "false"} aria-label={model.label} aria-disabled={model.disabled ? "true" : "false"} onClick={click} onContextMenu={(event) => event.preventDefault()} {...handlers}>
        <svg className="ring" viewBox="0 0 300 300" aria-hidden="true">
          <g className="ticks">{TICKS.map((tick, i) => <line key={i} className={tick.major ? "major" : undefined} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />)}</g>
          <circle className="track" cx="150" cy="150" r={RING_R} />
          <circle className="arc" cx="150" cy="150" r={RING_R} />
          <circle ref={progress} className="prog" cx="150" cy="150" r={RING_R} />
        </svg>
        <span className="face">
          <GarageScene state={state} offline={offline} />
          <span className="dial-hint" aria-hidden="true">{hintIcon}<span>{hintText}</span></span>
        </span>
        {model.locked && <span className="lock-badge"><Icon name="lock" size="sm" /></span>}
      </button>
    </div>
  );
}

/** "Hold to close" pill for a door parked half way (STOPPED / UNKNOWN / ERROR). */
export function HoldToClose({ locked, onConfirm }: { locked: boolean; onConfirm: () => void }) {
  const pill = useRef<HTMLButtonElement>(null);
  const shake = () => { pill.current?.animate?.([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], { duration: 260 }); };
  const { holding, handlers } = useHoldToConfirm({
    enabled: !locked,
    onConfirm,
    onProgress: (p, animate) => { const el = pill.current; if (!el) return; el.style.transition = animate ? "--hold .25s ease" : "none"; el.style.setProperty("--hold", String(p)); },
    onShort: shake
  });
  return (
    <button ref={pill} type="button" className={`hold-pill${holding ? " is-holding" : ""}`} aria-disabled={locked ? "true" : undefined} aria-label="Kapıyı kapat. Onaylamak için basılı tutun." onClick={locked ? shake : undefined} onContextMenu={(event) => event.preventDefault()} {...handlers}>
      <Icon name="down" size="sm" />Kapatmak için basılı tutun
    </button>
  );
}

/* ---------- door line (beam) ---------- */

function BeamRow({ name, distance, baseline, tolerance, healthy, presenceRange }: { name: string; distance: number | null | undefined; baseline: number | null | undefined; tolerance: number; healthy: boolean | undefined; presenceRange?: number | null }) {
  const hasReading = distance != null && healthy !== false;
  // Presence mode (TOF, far side out of range): the bar spans 0..range and any reading inside it is an obstacle.
  if (presenceRange != null) {
    const blocked = hasReading && distance <= presenceRange;
    return (
      <div className="beam-row">
        <div className="beam-label"><span>{name}</span><strong>{hasReading ? `${distance.toFixed(0)} cm` : `> ${presenceRange.toFixed(0)} cm`}</strong></div>
        <div className="bar" role="img" aria-label={`${name}: ${blocked ? "engel" : "temiz"}`}><i className={blocked ? "blocked" : "clear"} style={{ width: hasReading ? `${Math.min(distance / presenceRange, 1) * 100}%` : "100%" }} /></div>
        <div className="bar-cap"><span>Varlık modu · {blocked ? "menzil içinde cisim var" : "menzil içi boş"}</span><span className="num">≤{presenceRange.toFixed(0)} cm engel</span></div>
      </div>
    );
  }
  const ratio = hasReading && baseline ? Math.min(distance / baseline, 1.15) : 0;
  const threshold = baseline != null ? baseline - tolerance : null;
  const blocked = hasReading && threshold != null && distance < threshold;
  const near = hasReading && threshold != null && !blocked && distance < threshold + 6;
  const thresholdPct = baseline ? Math.max(0, ((baseline - tolerance) / baseline) * 100 / 1.15) : 0;
  const tone = !hasReading ? "missing" : blocked ? "blocked" : near ? "near" : "clear";
  const caption = !hasReading ? "Sensör yanıt vermiyor" : baseline == null ? "Kalibrasyon yok" : blocked ? "Eşiğin solunda · engel" : near ? "Eşiğe yakın" : "Eşiğin sağında · temiz";
  return (
    <div className="beam-row">
      <div className="beam-label"><span>{name}</span><strong>{hasReading ? `${distance.toFixed(0)} cm` : "—"}<small> / boş {baseline != null ? `${baseline.toFixed(0)} cm` : "—"}</small></strong></div>
      <div className="bar" role="img" aria-label={`${name}: ${hasReading ? `${distance.toFixed(0)} cm` : "ölçüm yok"}, ${caption.toLowerCase()}`}>
        <i className={tone} style={{ width: `${(ratio / 1.15) * 100}%` }} />
        {baseline != null && <b style={{ left: `${thresholdPct}%` }} />}
      </div>
      <div className="bar-cap"><span>{caption}</span>{threshold != null && <span className="num">eşik {threshold.toFixed(0)} cm</span>}</div>
    </div>
  );
}

function calibrationMessage(ack: CommandAck): string {
  if (ack.accepted) {
    const match = /hc=([\d.]+)cm tof=([\d.]+)cm/.exec(ack.result);
    if (match) return `Kalibrasyon kaydedildi · HC-SR04 ${match[1]} cm, TOF ${match[2]} cm`;
    const presence = /hc=([\d.]+)cm tof=presence<=([\d.]+)cm/.exec(ack.result);
    return presence ? `Kalibrasyon kaydedildi · HC-SR04 ${presence[1]} cm · karşı taraf TOF menzili dışında, TOF varlık modunda (${presence[2]} cm içi engel)` : "Kalibrasyon kaydedildi.";
  }
  if (ack.result.includes("door moving")) return "Kalibrasyon yapılamadı · Kapı hareket ediyor.";
  if (ack.result.includes("TOF")) return `Kalibrasyon yapılamadı · TOF karşı hedefi göremiyor (${ack.result.replace("calibration_failed: ", "")}).`;
  if (ack.result.includes("HC-SR04")) return `Kalibrasyon yapılamadı · HC-SR04 ölçümü kararsız (${ack.result.replace("calibration_failed: ", "")}).`;
  return `Kalibrasyon yapılamadı · ${ack.result}`;
}

function CalibrationSheet({ onCancel, onStart }: { onCancel: () => void; onStart: () => void }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    go.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [onCancel]);
  return createPortal(
    <div className="scrim" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="calibration-title">
        <div className="grab" />
        <h2 id="calibration-title">Kapı hattını kalibre et</h2>
        <p>Sensörler 3 saniye ölçüm yapıp bu mesafeyi “boş kapı” olarak kaydedecek. Başlamadan önce kapı hattının tamamen boş olduğundan emin olun.</p>
        <ul className="checks">
          <li><Icon name="check" size="sm" />Kapı hattında araç yok</li>
          <li><Icon name="check" size="sm" />Kimse kapının altında durmuyor</li>
          <li><Icon name="check" size="sm" />Eşya, bisiklet ya da çöp kutusu yok</li>
        </ul>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onCancel}>Vazgeç</button>
          <button type="button" className="btn primary" ref={go} onClick={onStart}><Icon name="target" size="sm" />Ölçümü başlat</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Doorway light-barrier status: each sensor's live distance against its
 * calibrated empty-doorway baseline, plus the calibration trigger (confirmed in
 * a sheet). The result arrives asynchronously as a command.ack for the
 * published commandId.
 */
export function BeamCard({ sensors, online, doorMoving, lastAck }: { sensors: SensorSnapshot; online: boolean; doorMoving: boolean; lastAck: CommandAck | null }) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tolerance = sensors.beamToleranceCm ?? 15;
  const closeSheet = useCallback(() => setConfirming(false), []);

  useEffect(() => {
    if (!pending || !lastAck || lastAck.commandId !== pending) return;
    setPending(null);
    setMessage({ text: calibrationMessage(lastAck), ok: lastAck.accepted });
  }, [lastAck, pending]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => { setPending(null); setMessage({ text: "Cihazdan yanıt gelmedi. Bağlantıyı kontrol edip tekrar deneyin.", ok: false }); }, 15_000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  async function calibrate() {
    setConfirming(false);
    setMessage(null);
    try {
      const { commandId } = await garageApi.calibrate();
      setPending(commandId);
    } catch (cause) {
      setMessage({ text: cause instanceof Error && cause.message.includes("409") ? "Kalibrasyon şu an yapılamaz · cihaz çevrimdışı ya da kapı hareket ediyor." : "Kalibrasyon komutu gönderilemedi.", ok: false });
    }
  }

  const offlineNote = !online && <div className="msg info"><Icon name="wifi" size="sm" /><span>Kart çevrimdışı · değerler son bilinen ölçümlerdir.</span></div>;

  if (sensors.beamSource === "photocell") {
    const clear = sensors.photocellClear === true;
    return (
      <div className="card beam">
        {offlineNote}
        <div className="beam-row">
          <div className="beam-label"><span>Garaj fotoseli · ışın</span><strong>{clear ? "Alınıyor" : "Kesildi"}</strong></div>
          <div className="bar" role="img" aria-label={`Fotosel ışını ${clear ? "alınıyor" : "kesildi"}`}><i className={clear ? "clear" : "blocked"} style={{ width: "100%" }} /></div>
        </div>
        <p className="beam-note">{clear ? "Işın karşıya ulaşıyor: kapı hattı boş, kapatmaya izin var." : "Işın kesik: hatta bir şey var, fotoselin elektriği yok ya da kablosu kopuk. Kapatma engellenir."}</p>
      </div>
    );
  }

  const blockedReason = !online ? "Kart çevrimdışı." : doorMoving ? "Kapı hareket ederken kalibre edilemez." : null;
  return (
    <div className="card beam">
      {offlineNote}
      <BeamRow name="HC-SR04 · ultrasonik" distance={sensors.hcSr04DistanceCm} baseline={sensors.hcSr04BaselineCm} tolerance={tolerance} healthy={sensors.hcSr04Healthy} />
      <BeamRow name="VL53L0X · lazer (TOF)" distance={sensors.tofDistanceCm} baseline={sensors.tofBaselineCm} tolerance={tolerance} healthy={sensors.tofHealthy} presenceRange={sensors.tofBaselineCm == null && sensors.tofRangeCm != null ? sensors.tofRangeCm : null} />
      <div className="beam-foot">
        <p>Çubuk, boş kapı mesafesine göre doluluktur. Çizginin solu engel sayılır (±{tolerance.toFixed(0)} cm tolerans).</p>
        <button type="button" className="btn" disabled={blockedReason !== null || pending !== null} onClick={() => setConfirming(true)}>{pending ? <><Spinner />Ölçülüyor…</> : <><Icon name="target" size="sm" />Kalibre et</>}</button>
      </div>
      {blockedReason && !pending && <p className="beam-note" style={{ color: "var(--fg-3)", marginTop: -6 }}>{blockedReason}</p>}
      {pending && <div className="progress" aria-hidden="true"><i /></div>}
      {message && <div className={`msg ${message.ok ? "ok" : "err"}`} role="status"><Icon name={message.ok ? "check" : "fault"} size="sm" /><span>{message.text}</span></div>}
      {confirming && <CalibrationSheet onCancel={closeSheet} onStart={() => void calibrate()} />}
    </div>
  );
}

/* ---------- light / motion tiles ---------- */

/**
 * The garage lamp follows the controller: motion switches it on automatically
 * (off again after the quiet time), the switch turns it on/off manually. The
 * switch waits for the reported lightOn to change rather than assuming the
 * relay switched.
 */
export function LightTile({ sensors, online }: { sensors: SensorSnapshot; online: boolean }) {
  const [pendingOn, setPendingOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lightOn = sensors.lightOn === true;

  useEffect(() => { if (pendingOn !== null && lightOn === pendingOn) setPendingOn(null); }, [lightOn, pendingOn]);
  useEffect(() => {
    if (pendingOn === null) return;
    const timer = window.setTimeout(() => { setPendingOn(null); setError("Cihazdan yanıt gelmedi."); }, 10_000);
    return () => window.clearTimeout(timer);
  }, [pendingOn]);

  async function toggle() {
    setError(null);
    const next = !lightOn;
    setPendingOn(next);
    try { await garageApi.light(next); } catch { setPendingOn(null); setError("Lamba komutu gönderilemedi."); }
  }

  const mode = sensors.lightMode === "AUTO" ? "otomatik" : sensors.lightMode === "MANUAL" ? "manuel" : null;
  const sub = !online ? "Bağlantı yok" : pendingOn !== null ? (pendingOn ? "Yakılıyor…" : "Söndürülüyor…") : lightOn ? `Yanıyor${mode ? ` · ${mode}` : ""}` : "Kapalı";
  return (
    <div className={`tile${lightOn && online ? " lit" : ""}`}>
      <div className="tile-top">
        <span className="tile-ic"><Icon name="bulb" /></span>
        <button type="button" className="switch" role="switch" aria-checked={pendingOn ?? lightOn} aria-label={lightOn ? "Lambayı söndür" : "Lambayı yak"} data-pending={pendingOn !== null ? "true" : "false"} disabled={!online || pendingOn !== null} onClick={() => void toggle()} />
      </div>
      <div className="tile-name">Işık</div>
      <div className="tile-sub">{sub}</div>
      {error && <div className="tile-err" role="status">{error}</div>}
    </div>
  );
}

function clock(value: string): string { return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

/** HC-SR501 motion: live alert while it sees motion, otherwise the last motion time. */
export function MotionTile({ sensors, online, lastMotionAt }: { sensors: SensorSnapshot; online: boolean; lastMotionAt: string | null }) {
  const motion = sensors.pirMotion === true && online;
  return (
    <div className={`tile${motion ? " alert" : ""}`}>
      <div className="tile-top"><span className="tile-ic"><Icon name="walk" /></span></div>
      <div className="tile-name">Hareket</div>
      <div className="tile-sub">{!online ? "Bağlantı yok" : motion ? "Şu an hareket var" : lastMotionAt ? <>Son <span className="num">{clock(lastMotionAt)}</span></> : "Kayıt yok"}</div>
    </div>
  );
}

/* ---------- Wi-Fi ---------- */

export function wifiQuality(level: number | null): string { return level === null ? "Bağlantı yok" : level >= 8 ? "Çok iyi" : level >= 6 ? "İyi" : level >= 4 ? "Orta" : level >= 2 ? "Zayıf" : "Çok zayıf"; }

/** 10-step signal meter; the same 0-10 scale the device screen shows next to "WiFi". */
export function WifiMeter({ level }: { level: number | null }) {
  const tone = level === null ? "none" : level >= 7 ? "good" : level >= 4 ? "fair" : "poor";
  return <span className="wifi" data-tone={tone} aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} className={level !== null && i < level ? "on" : ""} style={{ height: 5 + i * 1.2 }} />)}</span>;
}

/** Meter + "7/10 · İyi" + dBm, for a row value. */
export function WifiValue({ rssi, online }: { rssi: number | null | undefined; online: boolean }) {
  const level = online ? wifiLevelFromRssi(rssi) : null;
  return <><WifiMeter level={level} /><span><strong className="num">{level === null ? "—" : `${level}/10`}</strong> · {wifiQuality(level)}<small className="num">{online && rssi != null ? `${rssi} dBm` : "—"}</small></span></>;
}

export const obstacleText: Record<ObstacleState, string> = { CLEAR: "Alan temiz", WARNING: "Sınıra yakın", BLOCKED: "Engel var", SENSOR_FAULT: "Sensör hatası" };
export const obstacleTone: Record<ObstacleState, "safe" | "warn" | "danger"> = { CLEAR: "safe", WARNING: "warn", BLOCKED: "danger", SENSOR_FAULT: "danger" };
export const obstacleIcon: Record<ObstacleState, IconName> = { CLEAR: "check", WARNING: "warn", BLOCKED: "octagon", SENSOR_FAULT: "fault" };
