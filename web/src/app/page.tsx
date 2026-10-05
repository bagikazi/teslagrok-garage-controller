"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ActivityEvent, CameraStatus, CommandAck, GarageStatus, LatestCamera, WsMessage } from "@garage-control/shared-types";
import { createCameraViewerSocket, createGarageSocket, garageApi } from "../lib/api";
import { closeBlocked, closeBlockedReason, dialModel, obstacleOf, offersSecondaryClose, type DoorCommand, type Tone } from "../lib/door-ui";
import { BeamCard, DoorDial, HoldToClose, LightTile, MotionTile, WifiValue, obstacleIcon, obstacleText, obstacleTone } from "./garage-panel";
import { Icon, Spinner, type IconName } from "./icons";

type Tab = "kapi" | "kamera" | "sensor" | "gecmis";
const TABS: { id: Tab; label: string; title: string; icon: IconName }[] = [
  { id: "kapi", label: "Kapı", title: "Garaj", icon: "garage" },
  { id: "kamera", label: "Kamera", title: "Kamera", icon: "video" },
  { id: "sensor", label: "Sensörler", title: "Sensörler", icon: "sensor" },
  { id: "gecmis", label: "Geçmiş", title: "Geçmiş", icon: "history" }
];

const doorLabels: Record<GarageStatus["state"], string> = { OPEN: "Kapı açık", CLOSED: "Kapı kapalı", OPENING: "Açılıyor", CLOSING: "Kapanıyor", STOPPED: "Durdu", UNKNOWN: "Bilinmiyor", OFFLINE: "Çevrimdışı", ERROR: "Hata" };
const commandLabels: Record<DoorCommand, string> = { open: "AÇ", close: "KAPAT", stop: "DURDUR" };

type EventKind = "door" | "motion" | "system";
const eventInfo: Record<ActivityEvent["type"], { label: string; kind: EventKind; tone: Tone | "action"; icon: IconName }> = {
  DOOR_OPENED: { label: "Kapı açıldı", kind: "door", tone: "warn", icon: "up" },
  DOOR_CLOSED: { label: "Kapı kapandı", kind: "door", tone: "safe", icon: "down" },
  DOOR_MOVING: { label: "Kapı hareket ediyor", kind: "door", tone: "warn", icon: "arrows" },
  REMOTE_COMMAND: { label: "Uzaktan komut", kind: "door", tone: "action", icon: "send" },
  CLOSE_BLOCKED: { label: "Kapatma engellendi", kind: "door", tone: "danger", icon: "lock" },
  OBSTACLE_DETECTED: { label: "Engel algılandı", kind: "door", tone: "danger", icon: "octagon" },
  STOP_AND_REOPEN: { label: "Durduruldu ve açılıyor", kind: "door", tone: "warn", icon: "stop" },
  MOTION_DETECTED: { label: "Hareket algılandı", kind: "motion", tone: "neutral", icon: "walk" },
  PIR_MOTION: { label: "PIR hareketi", kind: "motion", tone: "neutral", icon: "walk" },
  LIGHT_ON: { label: "Garaj ışığı açıldı", kind: "motion", tone: "warn", icon: "bulb" },
  LIGHT_OFF: { label: "Garaj ışığı kapandı", kind: "motion", tone: "neutral", icon: "bulb" },
  CAMERA_LIVE_STARTED: { label: "Canlı görüntü başladı", kind: "system", tone: "action", icon: "video" },
  CAMERA_LIVE_STOPPED: { label: "Canlı görüntü kapandı", kind: "system", tone: "neutral", icon: "video" },
  DEVICE_OFFLINE: { label: "ESP32 bağlantısı yok", kind: "system", tone: "danger", icon: "chip" },
  DEVICE_ONLINE: { label: "ESP32 bağlandı", kind: "system", tone: "safe", icon: "chip" },
  DEVICE_RESTARTED: { label: "ESP32 yeniden başladı", kind: "system", tone: "warn", icon: "refresh" },
  WIFI_REPORT: { label: "ESP32 Wi-Fi raporu", kind: "system", tone: "neutral", icon: "wifi" },
  PROBE_WIFI_REPORT: { label: "S3 yedek Wi-Fi raporu", kind: "system", tone: "neutral", icon: "wifi" },
  ERROR: { label: "Sistem hatası", kind: "system", tone: "danger", icon: "warn" }
};
const FILTERS: { id: "all" | EventKind; label: string }[] = [{ id: "all", label: "Tümü" }, { id: "door", label: "Kapı" }, { id: "motion", label: "Hareket" }, { id: "system", label: "Sistem" }];

type CommandNotice = { tone: "ok" | "warn" | "error"; text: string };

// The controller's ack tells what really happened to a door command.
function commandNotice(result: string | null | undefined): CommandNotice | null {
  switch (result) {
    case "pulse_triggered": return { tone: "ok", text: "Röle tetiklendi." };
    case "safe_test_mode": return { tone: "warn", text: "Komut karta ulaştı ama kapı röleleri test modunda; röle tetiklenmedi." };
    case "already_reached": return { tone: "ok", text: "Kapı zaten istenen konumda; röle tetiklenmedi." };
    case "CLOSE_BLOCKED": return { tone: "error", text: "Kapatma engellendi: kapı hattı temiz değil." };
    default: return null;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const timeFormat = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
function formatTime(value: string | null | undefined): string { return value ? timeFormat.format(new Date(value)) : "—"; }
// The Wi-Fi report and camera frames can be days old, so they show the date as well.
function formatDateTime(value: string): string { return dateTimeFormat.format(new Date(value)).replace(",", ""); }
function ago(value: string | null | undefined, now: number): string {
  if (!value) return "";
  const minutes = Math.floor((now - Date.parse(value)) / 60_000);
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} sa önce`;
  return `${Math.floor(minutes / (60 * 24))} gün önce`;
}
function dayLabel(value: string, now: number): string {
  const day = new Date(value); const today = new Date(now); const yesterday = new Date(now - 86_400_000);
  if (day.toDateString() === today.toDateString()) return "Bugün";
  if (day.toDateString() === yesterday.toDateString()) return "Dün";
  return dateFormat.format(day);
}
const fmtNum = (value: number, digits = 1) => value.toFixed(digits).replace(".", ",");

// Save a requested snapshot on the viewing device: the share sheet on phones ("Save image" puts it in the
// gallery), a regular download on desktops. The server copy stays as the transfer/history copy.
async function saveSnapshotToDevice(camera: LatestCamera): Promise<void> {
  const response = await fetch(`${API_BASE}${camera.url}`, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const stamp = new Date(camera.capturedAt ?? Date.now()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = new File([blob], `garaj-${stamp}.jpg`, { type: "image/jpeg" });
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (error) { if ((error as DOMException).name === "AbortError") return; }
  }
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/* ---------- screens before the panel ---------- */

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [showPassword, setShowPassword] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) { setError("Kullanıcı adı ve şifreyi girin."); return; }
    setBusy(true); setError(null);
    try { await garageApi.login(email, password); onLoggedIn(); } catch { setError("Giriş bilgileri kabul edilmedi. Tekrar deneyin."); } finally { setBusy(false); }
  }
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <span className="auth-mark"><Icon name="garage" /></span>
        <h1>Garaja giriş</h1>
        <p className="lead">Kapının durumunu görmek ve komut göndermek için giriş yapın.</p>
        <div className="field"><label htmlFor="login-user">Kullanıcı adı</label><input id="login-user" value={email} onChange={(e) => setEmail(e.target.value)} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required /></div>
        <div className="field"><label htmlFor="login-pass">Şifre</label><div className="input-wrap"><input id="login-pass" value={password} onChange={(e) => setPassword(e.target.value)} type={showPassword ? "text" : "password"} autoComplete="current-password" required /><button className="eye" type="button" aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"} aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}><Icon name={showPassword ? "eye-off" : "eye"} size="sm" /></button></div></div>
        {error && <p className="form-err" role="alert"><Icon name="fault" size="sm" /><span>{error}</span></p>}
        <button className="btn primary block" type="submit" disabled={busy}>{busy ? <><Spinner />Kontrol ediliyor…</> : "Giriş yap"}</button>
        <p className="auth-foot">Özel garaj ağı · oturum bu cihazda açık kalır</p>
      </form>
    </main>
  );
}

function Loading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <main className="loading">
      <div className="loading-inner">
        <div className="load-dial">
          <svg className="ring2" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="44" style={{ stroke: "var(--track)" }} /><circle cx="48" cy="48" r="44" style={{ stroke: "var(--fg)", strokeDasharray: "60 220" }} /></svg>
          <span className="face2"><Icon name="garage" /></span>
        </div>
        <p>{failed ? "Bağlantı kurulamadı" : "Garaja bağlanılıyor…"}</p>
        {failed && <><small>Kontrol servisine ulaşılamıyor. İnternet bağlantınızı kontrol edin.</small><button className="btn" type="button" onClick={onRetry}><Icon name="refresh" size="sm" />Tekrar dene</button></>}
      </div>
    </main>
  );
}

/* ---------- small pieces ---------- */

function Notice({ tone, children, sub, onDismiss, spin }: { tone: "ok" | "warn" | "error" | "info"; children: ReactNode; sub?: ReactNode; onDismiss?: (() => void) | undefined; spin?: boolean }) {
  const icon: IconName = tone === "ok" ? "check" : tone === "warn" ? "warn" : tone === "error" ? "fault" : "send";
  return (
    <div className="notice" data-tone={tone}>
      {spin ? <Spinner /> : <Icon name={icon} />}
      <div className="notice-body">{children}{sub && <small>{sub}</small>}</div>
      {onDismiss && <button type="button" className="x" aria-label="Bildirimi kapat" onClick={onDismiss}><Icon name="x" size="sm" /></button>}
    </div>
  );
}

function Row({ icon, label, sub, children }: { icon: IconName; label: string; sub?: ReactNode; children: ReactNode }) {
  return <div className="row"><span className="row-ic"><Icon name={icon} size="sm" /></span><div className="row-main"><div className="row-label">{label}</div>{sub && <div className="row-sub">{sub}</div>}</div><div className="row-val">{children}</div></div>;
}

function OnlineStat({ online, on = "Çevrimiçi", off = "Çevrimdışı" }: { online: boolean; on?: string; off?: string }) {
  return <span className="stat" data-tone={online ? "safe" : "danger"}><span className="sdot" data-tone={online ? "safe" : "danger"} />{online ? on : off}</span>;
}

function OnOff({ value }: { value: boolean | undefined }) {
  return value === undefined ? <span className="onoff off">—</span> : <span className={`onoff ${value ? "on" : "off"}`}>{value ? "ON" : "OFF"}</span>;
}

function EventRow({ event }: { event: ActivityEvent }) {
  const info = eventInfo[event.type];
  return <div className="ev"><span className="ev-ic" data-tone={info.tone}><Icon name={info.icon} size="sm" /></span><div style={{ minWidth: 0 }}><div className="ev-t">{info.label}</div>{event.detail && <div className="ev-d">{event.detail}</div>}</div><time className="num" dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div>;
}

function StopButton({ moving, onStop }: { moving: boolean; onStop: () => void }) {
  return <button type="button" className={`stop-btn${moving ? " urgent" : ""}`} aria-label="Kapıyı durdur (DURDUR)" onClick={onStop}><Icon name="stop" fill />DURDUR{moving && <small>· hemen</small>}</button>;
}

/* ---------- the panel ---------- */

export default function Home() {
  const [status, setStatus] = useState<GarageStatus | null>(null); const [events, setEvents] = useState<ActivityEvent[]>([]); const [wifiReport, setWifiReport] = useState<ActivityEvent | null>(null); const [camera, setCamera] = useState<LatestCamera | null>(null); const [cameraStatus, setCameraStatus] = useState<CameraStatus | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false); const [serverOnline, setServerOnline] = useState(true); const [sending, setSending] = useState<DoorCommand | null>(null); const [error, setError] = useState<string | null>(null);
  const [lastAck, setLastAck] = useState<CommandAck | null>(null);
  const [pendingCommand, setPendingCommand] = useState<{ id: string; action: DoorCommand } | null>(null);
  const [notice, setNotice] = useState<CommandNotice | null>(null);
  const [liveSession, setLiveSession] = useState<{ sessionId: string; expiresAt: string } | null>(null); const [liveState, setLiveState] = useState<"idle" | "starting" | "live">("idle"); const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [liveFps, setLiveFps] = useState<number | null>(null); const [liveError, setLiveError] = useState<string | null>(null);
  const [lastLive, setLastLive] = useState<{ capturedAt: string } | null>(null);
  const [snapPending, setSnapPending] = useState(false); const [snapError, setSnapError] = useState<string | null>(null); const [snapSaved, setSnapSaved] = useState(false); const snapBaseline = useRef<string | null>(null);
  const frameUrl = useRef<string | null>(null); const staleFrameUrls = useRef<string[]>([]);
  const [tab, setTabState] = useState<Tab>("kapi"); const tabRef = useRef<Tab>("kapi");
  const [unread, setUnread] = useState(0); const [filter, setFilter] = useState<"all" | EventKind>("all");
  const [now, setNow] = useState(() => Date.now()); const [scrolled, setScrolled] = useState(false);

  const setTab = useCallback((next: Tab) => {
    tabRef.current = next; setTabState(next);
    if (next === "gecmis") setUnread(0);
    try { window.history.replaceState(null, "", `#${next}`); } catch { /* history is optional */ }
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => { const hash = window.location.hash.slice(1); if (TABS.some((t) => t.id === hash)) { tabRef.current = hash as Tab; setTabState(hash as Tab); } }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const onScroll = () => setScrolled(window.scrollY > 4); window.addEventListener("scroll", onScroll, { passive: true }); return () => window.removeEventListener("scroll", onScroll); }, []);

  const refresh = useCallback(async () => { try { const [nextStatus, nextEvents, nextCamera, nextCameraStatus, nextWifiReport] = await Promise.all([garageApi.status(), garageApi.events(), garageApi.latestCamera(), garageApi.cameraStatus(), garageApi.latestWifiReport()]); setStatus(nextStatus); setEvents(nextEvents); setWifiReport(nextWifiReport); setCamera(nextCamera); setCameraStatus(nextCameraStatus); setServerOnline(true); setNeedsLogin(false); setError(null); } catch (cause) { setServerOnline(false); if (cause instanceof Error && cause.message === "AUTH_REQUIRED") setNeedsLogin(true); else setError("Kontrol servisine ulaşılamıyor."); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // The live socket reconnects with backoff after any drop (screen lock, network
  // change, server restart) and reloads everything it may have missed meanwhile.
  useEffect(() => {
    let socket: WebSocket | null = null; let retryTimer: number | undefined; let delay = 1000; let disposed = false; let dropped = false;
    const onMessage = (raw: unknown) => { const message = raw as WsMessage; if (message.type === "garage.status") setStatus(message.payload); if (message.type === "activity.created") { setEvents((current) => [message.payload, ...current].slice(0, 20)); if (tabRef.current !== "gecmis") setUnread((count) => Math.min(count + 1, 9)); } if (message.type === "activity.created" && message.payload.type === "WIFI_REPORT") setWifiReport(message.payload); if (message.type === "camera.latest") setCamera(message.payload); if (message.type === "camera.status") setCameraStatus(message.payload); if (message.type === "command.ack") setLastAck(message.payload); };
    const connect = () => {
      window.clearTimeout(retryTimer); if (disposed) return;
      socket = createGarageSocket(onMessage); if (!socket) return;
      socket.addEventListener("open", () => { delay = 1000; setServerOnline(true); if (dropped) { dropped = false; void refresh(); } });
      socket.addEventListener("close", () => { if (disposed) return; dropped = true; setServerOnline(false); retryTimer = window.setTimeout(connect, delay); delay = Math.min(delay * 2, 15_000); });
    };
    const onVisible = () => { if (document.visibilityState !== "visible") return; void refresh(); if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) { delay = 1000; connect(); } };
    connect(); document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; window.clearTimeout(retryTimer); document.removeEventListener("visibilitychange", onVisible); socket?.close(); };
  }, [refresh]);
  useEffect(() => {
    if (!liveSession) return;
    const sessionId = liveSession.sessionId; let closed = false; let gotFrame = false; let frameTimes: number[] = [];
    const socket = createCameraViewerSocket(sessionId, (frame) => { const nextUrl = URL.createObjectURL(frame); if (frameUrl.current) staleFrameUrls.current.push(frameUrl.current); frameUrl.current = nextUrl; setLiveFrame(nextUrl); frameTimes.push(Date.now()); if (!gotFrame) { gotFrame = true; setLiveState("live"); setLiveError(null); } });
    // "Canlı" means frames are really arriving, not just that the socket opened.
    socket?.addEventListener("close", () => { if (closed) return; setLiveSession(null); setLiveState("idle"); setLiveFps(null); setLiveError("Canlı görüntü bağlantısı koptu."); void garageApi.stopLive(sessionId).catch(() => undefined); });
    const fpsTimer = window.setInterval(() => { const now = Date.now(); frameTimes = frameTimes.filter((time) => now - time <= 2000); setLiveFps(gotFrame ? Math.round(frameTimes.length * 5) / 10 : null); }, 1000);
    const startTimer = window.setTimeout(() => { if (gotFrame) return; setLiveSession(null); setLiveState("idle"); setLiveError("Kameradan görüntü gelmedi."); void garageApi.stopLive(sessionId).catch(() => undefined); }, 15_000);
    return () => { closed = true; window.clearInterval(fpsTimer); window.clearTimeout(startTimer); socket?.close(); if (frameUrl.current) URL.revokeObjectURL(frameUrl.current); staleFrameUrls.current.splice(0).forEach((url) => URL.revokeObjectURL(url)); frameUrl.current = null; };
  }, [liveSession]);
  useEffect(() => { if (!liveSession) return; const timer = window.setInterval(() => { void garageApi.renewLive(liveSession.sessionId).then((next) => setLiveSession((current) => current ? { ...current, expiresAt: next.expiresAt } : current)).catch(() => undefined); }, 240_000); return () => window.clearInterval(timer); }, [liveSession]);
  useEffect(() => { if (snapPending && camera && camera.id !== snapBaseline.current) { setSnapPending(false); setSnapError(null); setSnapSaved(true); void saveSnapshotToDevice(camera).catch(() => setSnapError("Fotoğraf cihaza kaydedilemedi; \"tam boy aç\" ile açıp kaydedebilirsiniz.")); } }, [camera, snapPending]);
  useEffect(() => { if (!snapSaved) return; const timer = window.setTimeout(() => setSnapSaved(false), 8_000); return () => window.clearTimeout(timer); }, [snapSaved]);
  useEffect(() => { if (!snapPending) return; const timer = window.setTimeout(() => { setSnapPending(false); setSnapError("Fotoğraf gelmedi (20 sn). Kamerayı kontrol edin."); }, 20_000); return () => window.clearTimeout(timer); }, [snapPending]);

  useEffect(() => { if (!pendingCommand || lastAck?.commandId !== pendingCommand.id) return; setPendingCommand(null); setNotice(commandNotice(lastAck.result) ?? { tone: lastAck.accepted ? "ok" : "error", text: `Kart cevabı: ${lastAck.result}` }); }, [lastAck, pendingCommand]);
  useEffect(() => { if (!pendingCommand) return; const timer = window.setTimeout(() => { setPendingCommand(null); setNotice({ tone: "error", text: "Karttan cevap gelmedi." }); }, 10_000); return () => window.clearTimeout(timer); }, [pendingCommand]);
  // A successful result fades after a while; warnings and errors stay until dismissed or replaced.
  useEffect(() => { if (notice?.tone !== "ok") return; const timer = window.setTimeout(() => setNotice(null), 8_000); return () => window.clearTimeout(timer); }, [notice]);
  async function sendAction(nextAction: DoorCommand) { setSending(nextAction); setError(null); setNotice(null); try { const sent = await garageApi.action(nextAction); const immediate = sent.result === "published" ? null : commandNotice(sent.result); if (immediate) setNotice(immediate); else setPendingCommand({ id: sent.commandId, action: nextAction }); } catch { setError("Komut gönderilemedi. Kart bağlantısını kontrol edin."); } finally { setSending(null); } }
  async function startLive() { setLiveState("starting"); setLiveError(null); try { const session = await garageApi.startLive(); setLiveSession({ sessionId: session.sessionId, expiresAt: session.expiresAt }); } catch { setLiveState("idle"); setLiveError("Canlı görüntü başlatılamadı."); } }
  async function stopLive() { const session = liveSession; setLiveSession(null); setLiveState("idle"); setLiveFrame(null); setLiveFps(null); setLiveError(null); if (session) await garageApi.stopLive(session.sessionId).catch(() => undefined); }
  // While live is off the camera box shows the newest live frame the server kept (not a saved photo).
  useEffect(() => { if (liveState !== "idle" || needsLogin) return; void garageApi.lastLiveFrame().then(setLastLive).catch(() => undefined); }, [liveState, needsLogin]);
  async function takeSnapshot() { snapBaseline.current = camera?.id ?? null; setSnapError(null); setSnapSaved(false); setSnapPending(true); try { await garageApi.snapshot(); } catch { setSnapPending(false); setSnapError("Fotoğraf isteği gönderilemedi."); } }

  if (needsLogin) return <Login onLoggedIn={() => void refresh()} />;
  if (!status) return <Loading failed={error !== null} onRetry={() => { setError(null); void refresh(); }} />;

  const device = status.device; const sensors = device.sensors; const online = device.online;
  const obstacle = obstacleOf(sensors);
  const shownState = online ? status.state : "OFFLINE";
  const moving = online && (status.state === "OPENING" || status.state === "CLOSING");
  const pendingAction = sending ?? pendingCommand?.action ?? null;
  const dial = dialModel({ state: status.state, online, obstacle, pending: pendingAction });
  const testMode = sensors.relaysLocked === true;
  const lastMotionAt = events.find((event) => event.type === "PIR_MOTION")?.createdAt ?? null;
  const showSecondaryClose = offersSecondaryClose(status.state, online) && !pendingAction;
  const showCloseReason = online && closeBlocked(obstacle) && status.state !== "CLOSED";
  const waitingAction = pendingCommand?.action ?? (pendingAction !== "stop" ? pendingAction : null);

  const cameraOnline = cameraStatus?.online === true;
  const cameraError = cameraStatus?.state === "ERROR";
  const camLabel = liveState === "live" ? `Canlı${liveFps !== null ? ` · ${fmtNum(liveFps)} fps` : ""}` : liveState === "starting" ? "Bağlanıyor…" : cameraError ? "Hata" : !cameraOnline ? "Çevrimdışı" : "Kapalı";
  const camTone: Tone = liveState === "live" ? "safe" : cameraError ? "danger" : !cameraOnline ? "warn" : "neutral";
  const liveProblem = liveError ?? (liveState !== "idle" && cameraError ? `Kamera hatası: ${cameraStatus?.lastError ?? "bilinmeyen hata"}` : null);
  const snapshotUrl = camera ? `${API_BASE}${camera.url}` : null;
  const lastLiveUrl = lastLive ? `${API_BASE}/api/camera/live/last-frame?t=${encodeURIComponent(lastLive.capturedAt)}` : null;
  const frameSrc = liveFrame ?? lastLiveUrl ?? snapshotUrl;
  function handleLiveFrameLoad() { staleFrameUrls.current.splice(0).forEach((url) => URL.revokeObjectURL(url)); }

  const badges: Record<Tab, { tone: "warn" | "danger" | "live" | "count"; text?: string; sr: string } | null> = {
    kapi: !online ? { tone: "danger", text: "!", sr: "kart çevrimdışı" } : status.state === "ERROR" ? { tone: "danger", text: "!", sr: "kapı hatası" } : moving ? { tone: "warn", sr: "kapı hareket ediyor" } : status.state === "OPEN" || status.state === "STOPPED" ? { tone: "warn", sr: "kapı açık" } : testMode ? { tone: "warn", sr: "test modu" } : null,
    kamera: cameraError ? { tone: "danger", text: "!", sr: "kamera hatası" } : liveState === "live" ? { tone: "live", sr: "canlı yayın açık" } : !cameraOnline ? { tone: "warn", sr: "kamera çevrimdışı" } : null,
    sensor: !online ? { tone: "danger", text: "!", sr: "bağlantı yok" } : closeBlocked(obstacle) ? { tone: "danger", text: "!", sr: obstacleText[obstacle].toLowerCase() } : obstacle === "WARNING" ? { tone: "warn", sr: "sınıra yakın" } : null,
    gecmis: unread ? { tone: "count", text: String(unread), sr: `${unread} yeni olay` } : null
  };
  const subtitles: Record<Tab, string> = {
    kapi: online ? `ESP32 bağlı · son veri ${formatTime(device.lastSeen)}` : `Son veri ${formatTime(device.lastSeen)} · ${ago(device.lastSeen, now) || "bilinmiyor"}`,
    kamera: `ESP32-CAM · ${camLabel}`,
    sensor: online ? "Kapı hattı, manyetik sensörler ve bağlantı" : "Kart çevrimdışı · değerler eski olabilir",
    gecmis: `Son ${events.length} olay`
  };
  const connected = online && serverOnline;

  const cameraFrame = (compact: boolean) => (
    <div className={`frame${compact ? "" : " bleed"}${liveState === "idle" && !cameraOnline ? " dim" : ""}${liveState === "idle" && cameraError ? " err" : ""}`}>
      {frameSrc && <img src={frameSrc} alt={liveFrame ? "Canlı garaj görüntüsü" : lastLiveUrl ? "Son canlı kare" : "Son garaj kamera görüntüsü"} onLoad={liveFrame ? handleLiveFrameLoad : undefined} />}
      {liveState === "live" ? <>
        <span className="fb tl"><span className="live-dot" />CANLI{liveFps !== null && <> · {fmtNum(liveFps)} fps</>}</span>
        {snapSaved && snapshotUrl && camera && <a className="snap-thumb" href={snapshotUrl} target="_blank" rel="noreferrer" title={`Son fotoğraf · ${formatTime(camera.capturedAt)}`}><img src={snapshotUrl} alt="Son fotoğraf" /></a>}
      </> : liveState === "starting" ? <>
        <span className="fb tl"><span className="off-dot" />Bağlanıyor</span>
        <div className="fcenter"><div className="fcenter-card"><Spinner /><strong>Kameraya bağlanılıyor…</strong>{!compact && <span>İlk kare gelince canlı görüntü başlar.</span>}</div></div>
      </> : cameraError ? (
        <div className="fcenter"><div className="fcenter-card"><Icon name="warn" /><strong>Kamera hatası</strong><span>{cameraStatus?.lastError ?? "Bilinmeyen hata"}{!compact && ". Canlı izle ile yeniden deneyin."}</span></div></div>
      ) : !cameraOnline ? (
        <div className="fcenter"><div className="fcenter-card"><Icon name="wifi" /><strong>Kamera çevrimdışı</strong>{cameraStatus?.lastSeen && <span>Son görülme {formatDateTime(cameraStatus.lastSeen)}</span>}</div></div>
      ) : frameSrc ? <>
        <span className="fb tl"><span className="off-dot" />Kapalı</span>
        <span className="fb bl">{lastLive ? `Son canlı kare · ${formatDateTime(lastLive.capturedAt)}` : camera ? `Son fotoğraf · ${formatDateTime(camera.capturedAt)}` : ""}</span>
      </> : (
        <div className="fcenter"><div className="fcenter-card"><Icon name="video" /><strong>Kamera hazır</strong><span>Canlı görüntü yalnızca istediğinizde başlar.</span></div></div>
      )}
    </div>
  );

  const liveDisabled = liveState === "starting" || (liveState === "idle" && !cameraOnline);
  const onLive = () => void (liveState === "idle" ? startLive() : stopLive());
  const cameraControls = (compact: boolean) => compact ? (
    <div className="aside-ctl">
      <button type="button" className={`btn${liveState === "idle" ? " primary" : " stop"}`} onClick={onLive} aria-pressed={liveState !== "idle"} disabled={liveDisabled}>{liveState === "starting" ? <Spinner size={15} /> : <Icon name={liveState === "live" ? "stop" : "play"} size="xs" fill />}{liveState === "live" ? "Durdur" : liveState === "starting" ? "Bağlanıyor" : "Canlı izle"}</button>
      <button type="button" className="btn" onClick={() => void takeSnapshot()} disabled={snapPending || !cameraOnline}><Icon name="photo" size="sm" />{snapPending ? "Çekiliyor…" : "Fotoğraf"}</button>
    </div>
  ) : (
    <div className="cam-ctl">
      <button type="button" className={`big${liveState === "idle" ? " primary" : " stop"}`} onClick={onLive} aria-pressed={liveState !== "idle"} disabled={liveDisabled}>{liveState === "starting" ? <Spinner /> : <Icon name={liveState === "live" ? "stop" : "play"} fill />}<b>{liveState === "live" ? "Durdur" : liveState === "starting" ? "Bağlanıyor…" : "Canlı izle"}</b><small>{liveState === "live" ? "CANLI" : "İSTEĞE BAĞLI"}</small></button>
      <button type="button" className="big" onClick={() => void takeSnapshot()} disabled={snapPending || !cameraOnline}>{snapPending ? <Spinner /> : <Icon name="photo" />}<b>{snapPending ? "Çekiliyor…" : "Fotoğraf çek"}</b><small>TAM BOY</small></button>
    </div>
  );

  const filtered = events.filter((event) => filter === "all" || eventInfo[event.type].kind === filter);
  const groups: { label: string; items: ActivityEvent[] }[] = [];
  for (const event of filtered) { const label = dayLabel(event.createdAt, now); const group = groups.find((g) => g.label === label); if (group) group.items.push(event); else groups.push({ label, items: [event] }); }
  const stop = () => void sendAction("stop");

  return (
    <div className="app">
      <nav className="nav" aria-label="Bölümler">
        <div className="nav-brand"><span className="mk"><Icon name="garage" /></span>Garaj</div>
        {TABS.map((t) => { const badge = badges[t.id]; return (
          <button key={t.id} type="button" className="tabbtn" aria-current={tab === t.id ? "page" : undefined} aria-label={badge ? `${t.label} · ${badge.sr}` : t.label} onClick={() => setTab(t.id)}>
            <span className="pillic"><Icon name={t.icon} />{badge && <span className="badge" data-tone={badge.tone}>{badge.text}</span>}</span><span>{t.label}</span>
          </button>
        ); })}
        <div className="nav-foot"><span className="sdot" data-tone={connected ? "safe" : "danger"} /><span>{connected ? "Bağlı" : !serverOnline ? "Sunucu yok" : "Kart çevrimdışı"}</span></div>
      </nav>

      <div className="center">
        <header className={`appbar${scrolled ? " scrolled" : ""}`}>
          <div className="appbar-text"><h1>{TABS.find((t) => t.id === tab)?.title}</h1><p className="appbar-sub">{subtitles[tab]}</p></div>
          <div className="appbar-chips">
            {testMode && <span className="chip-status" data-tone="warn"><Icon name="test" size="xs" />Test modu</span>}
            <button type="button" className="chip-status" data-tone={connected ? undefined : "danger"} onClick={() => setTab("sensor")} aria-label={connected ? "Bağlantılar: ESP32 ve sunucu bağlı" : "Bağlantı sorunu, ayrıntılar"}><span className="sdot" data-tone={connected ? "safe" : "danger"} />{connected ? "Bağlı" : !serverOnline ? "Sunucu yok" : "Çevrimdışı"}</button>
          </div>
        </header>

        <main className="main">
          {tab === "kapi" && (
            <section className="tab" key="kapi" aria-label="Kapı">
              {testMode ? <div className="banner" role="status"><Icon name="test" /><div><strong>Test modu açık</strong>Kapı röleleri kilitli (SAFE_TEST_MODE): komutlar karta ulaşır ama röleyi tetiklemez.</div></div>
                : !online ? <div className="banner danger" role="status"><Icon name="wifi" /><div><strong>Kontrol kartına ulaşılamıyor</strong>Kapı komutları kart yeniden bağlanınca kullanılabilir. Son veri {formatTime(device.lastSeen)}.</div></div> : null}
              <DoorDial model={dial} state={status.state} offline={!online} lockedHint={obstacle === "BLOCKED" ? "Önce engeli kaldırın" : "Sensör hatası"} onCommand={(command) => void sendAction(command)} />
              <div className="door-state">
                <h2>{doorLabels[shownState]}</h2>
                <p className="state-meta">{online
                  ? <>Son değişiklik <span className="num">{formatTime(status.lastChangedAt)}</span>{status.lastChangedAt && ` · ${ago(status.lastChangedAt, now)}`}{status.requestedAction && ` · ${commandLabels[status.requestedAction.toLowerCase() as DoorCommand]} istendi`}</>
                  : <>Son bilinen: {doorLabels[status.state].toLowerCase()} · <span className="num">{formatTime(device.lastSeen)}</span></>}</p>
                {online
                  ? <button type="button" className="pill" data-tone={obstacleTone[obstacle]} onClick={() => setTab("sensor")} aria-label={`Kapı hattı: ${obstacleText[obstacle]}. Sensörleri aç.`}><Icon name={obstacleIcon[obstacle]} size="sm" />{obstacleText[obstacle]}<span className="chev"><Icon name="chev" size="xs" /></span></button>
                  : <span className="pill"><Icon name="unknown" size="sm" />Kapı hattı bilinmiyor</span>}
                {(showCloseReason || showSecondaryClose) && (
                  <div className="secondary">
                    {showCloseReason && <p className="reason"><Icon name="lock" size="sm" />Kapatma engellendi · {closeBlockedReason(obstacle)}</p>}
                    {showSecondaryClose && <HoldToClose locked={closeBlocked(obstacle)} onConfirm={() => void sendAction("close")} />}
                  </div>
                )}
                {online && <div className="stop-inline"><StopButton moving={moving} onStop={stop} /></div>}
              </div>
              <div className="notice-slot" role="status" aria-live="polite">
                {waitingAction ? <Notice tone="info" spin sub="Kart yanıtı bekleniyor…">{commandLabels[waitingAction]} komutu gönderildi</Notice>
                  : notice ? <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice> : null}
                {error && <Notice tone="error" onDismiss={() => setError(null)}>{error}</Notice>}
              </div>
              <div className="tiles">
                <LightTile sensors={sensors} online={online} />
                <MotionTile sensors={sensors} online={online} lastMotionAt={lastMotionAt} />
                <button type="button" className="tile cam" onClick={() => setTab("kamera")}>
                  <span className="thumb">{frameSrc && <img src={frameSrc} alt="" />}{liveState === "live" && <span className="thumb-badge"><i />CANLI</span>}</span>
                  <span className="tile-body"><span className="tile-name">Kamera <Icon name="chev" size="xs" /></span><span className="tile-sub">{liveState === "live" ? "Canlı izleniyor" : liveState === "starting" ? "Bağlanıyor…" : cameraError ? "Kamera hatası" : !cameraOnline ? "Çevrimdışı" : lastLive ? `Son kare ${formatTime(lastLive.capturedAt)}` : camera ? `Son foto ${formatTime(camera.capturedAt)}` : "Hazır"}</span></span>
                </button>
              </div>
            </section>
          )}

          {tab === "kamera" && (
            <section className="tab" key="kamera" aria-label="Kamera">
              {cameraFrame(false)}
              {cameraControls(false)}
              <div className="notice-slot" role="status" aria-live="polite">
                {snapSaved && snapshotUrl && camera && <Notice tone="ok" sub={`${formatDateTime(camera.capturedAt)} · cihaza da kaydedildi`} onDismiss={() => setSnapSaved(false)}>Fotoğraf kaydedildi · <a href={snapshotUrl} target="_blank" rel="noreferrer">tam boy aç</a></Notice>}
                {liveProblem && <Notice tone="error" onDismiss={liveError ? () => setLiveError(null) : undefined}>{liveProblem}</Notice>}
                {snapError && <Notice tone="error" onDismiss={() => setSnapError(null)}>{snapError}</Notice>}
                {!cameraOnline && liveState === "idle" && <Notice tone="warn" sub="Kameranın Wi-Fi bağlantısını ve beslemesini kontrol edin.">Kamera çevrimdışı.</Notice>}
              </div>
            </section>
          )}

          {tab === "sensor" && (
            <section className="tab" key="sensor" aria-label="Sensörler">
              <div className="sec-h"><h2>Kapı hattı</h2>{online ? <span className="stat" data-tone={obstacleTone[obstacle]}><Icon name={obstacleIcon[obstacle]} size="sm" />{obstacleText[obstacle]}</span> : <span className="stat" data-tone="neutral"><Icon name="unknown" size="sm" />Bilinmiyor</span>}</div>
              <BeamCard sensors={sensors} online={online} doorMoving={moving} lastAck={lastAck} />
              <div className="sec-h"><h2>Manyetik sensörler</h2><span className="aux">Kapı konumu</span></div>
              <div className="group">
                <Row icon="magnet" label="Üst sensör" sub="Kapı tam açıkken ON"><OnOff value={sensors.top ?? sensors.open} /></Row>
                <Row icon="magnet" label="Alt sensör" sub="Kapı tam kapalıyken ON"><OnOff value={sensors.bottom ?? sensors.closed} /></Row>
              </div>
              <div className="sec-h"><h2>Bağlantılar</h2><span className="aux">{connected && cameraOnline ? "Tümü bağlı" : !online ? "Kart bağlantısı yok" : !serverOnline ? "Sunucu bağlantısı yok" : "Kamera bağlı değil"}</span></div>
              <div className="group">
                <Row icon="chip" label="ESP32-S3 kontrol kartı" sub="Kapı, sensörler ve lamba"><OnlineStat online={online} /></Row>
                <Row icon="wifi" label="Wi-Fi" sub={online ? "Kontrol kartı" : "Bağlantı yok"}><WifiValue rssi={device.rssi} online={online} /></Row>
                <Row icon="server" label="Sunucu" sub={serverOnline ? "Canlı bağlantı açık" : "Yeniden bağlanılıyor…"}><OnlineStat online={serverOnline} /></Row>
                <Row icon="video" label="ESP32-CAM" sub={cameraOnline ? (cameraStatus?.rssi != null ? `${cameraStatus.rssi} dBm` : undefined) : cameraStatus?.lastSeen ? `Son görülme ${formatDateTime(cameraStatus.lastSeen)}` : undefined}><span className="stat" data-tone={camTone}>{camLabel}</span></Row>
                <Row icon="refresh" label="Firmware" sub="Kontrol kartı"><strong className="num">{device.firmwareVersion ?? "—"}</strong></Row>
                <Row icon="history" label="Son veri" sub={device.lastSeen ? ago(device.lastSeen, now) : undefined}><strong className="num">{formatTime(device.lastSeen)}</strong></Row>
              </div>
              <div className="card report">
                <div className="report-h"><span>Son Wi-Fi raporu</span><span className="num">{wifiReport ? formatDateTime(wifiReport.createdAt) : "—"}</span></div>
                <p>{wifiReport?.detail ?? "Henüz rapor yok. S3 yeniden bağlandığında burada görünür."}</p>
              </div>
            </section>
          )}

          {tab === "gecmis" && (
            <section className="tab" key="gecmis" aria-label="Geçmiş">
              <div className="chips" role="group" aria-label="Olay filtresi">
                {FILTERS.map((f) => <button key={f.id} type="button" className="fchip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{f.id === "all" ? events.length : events.filter((event) => eventInfo[event.type].kind === f.id).length}</span></button>)}
              </div>
              {groups.length === 0
                ? <div className="group" style={{ marginTop: 12 }}><p className="empty">{events.length === 0 ? "Henüz olay yok. Kontrol kartı bildirdikçe burada görünür." : "Bu filtrede kayıt yok."}</p></div>
                : groups.map((group) => <div key={group.label}><h3 className="day-h">{group.label}</h3><div className="group">{group.items.map((event) => <EventRow key={event.id} event={event} />)}</div></div>)}
            </section>
          )}

          {online && tab === "kapi" && <div className="dock kapi-dock"><StopButton moving={moving} onStop={stop} /></div>}
          {moving && tab !== "kapi" && <div className="dock compact"><button type="button" className="stop-btn urgent" aria-label={`Kapı ${status.state === "OPENING" ? "açılıyor" : "kapanıyor"}, durdur`} onClick={stop}><span><Icon name={status.state === "OPENING" ? "up" : "down"} size="sm" />Kapı {status.state === "OPENING" ? "açılıyor" : "kapanıyor"}</span><span className="stop-pill"><Icon name="stop" size="xs" fill />DURDUR</span></button></div>}
        </main>
      </div>

      <aside className="aside" aria-label="Kamera ve son olaylar">
        {tab !== "kamera" && <section>
          <div className="aside-h"><h2>Kamera</h2><button type="button" className="linkbtn" onClick={() => setTab("kamera")}>Ayrıntılar</button></div>
          {cameraFrame(true)}
          {cameraControls(true)}
        </section>}
        {tab !== "gecmis" && <section>
          <div className="aside-h"><h2>Son olaylar</h2><button type="button" className="linkbtn" onClick={() => setTab("gecmis")}>Tümü</button></div>
          <div className="group">{events.length === 0 ? <p className="empty">Henüz olay yok.</p> : events.slice(0, 5).map((event) => <EventRow key={event.id} event={event} />)}</div>
        </section>}
      </aside>
    </div>
  );
}
