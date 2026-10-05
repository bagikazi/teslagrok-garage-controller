import type { DoorState, ObstacleState, SensorSnapshot } from "@garage-control/shared-types";

export type DoorCommand = "open" | "close" | "stop";
export type Tone = "safe" | "warn" | "danger" | "neutral";

/** Door-line state; falls back to the raw readings when the controller does not report one. */
export function obstacleOf(sensors: SensorSnapshot): ObstacleState {
  if (sensors.obstacleState) return sensors.obstacleState;
  if (sensors.obstruction) return "BLOCKED";
  if (sensors.hcSr04Healthy === false || sensors.tofHealthy === false || sensors.hcSr04DistanceCm == null || sensors.tofDistanceCm == null) return "SENSOR_FAULT";
  return "CLEAR";
}

/** KAPAT is never offered while the door line is blocked or the sensors cannot be trusted. */
export function closeBlocked(obstacle: ObstacleState): boolean {
  return obstacle === "BLOCKED" || obstacle === "SENSOR_FAULT";
}

export function closeBlockedReason(obstacle: ObstacleState): string {
  return obstacle === "BLOCKED" ? "Kapı hattında engel algılandı." : "Sensör verisi güvenilir değil.";
}

export type DialIcon = "up" | "down" | "stop" | "lock" | "wifi" | "spinner";

export interface DialModel {
  tone: Tone;
  hint: string;
  icon: DialIcon;
  /** Accessible name of the dial button. */
  label: string;
  /** Command sent after the hold-to-confirm completes. */
  hold?: "open" | "close";
  /** Command sent on a plain tap (only STOP, while the door moves). */
  tap?: "stop";
  moving?: "up" | "down";
  locked?: boolean;
  pending?: boolean;
  disabled?: boolean;
}

/**
 * What the big door dial offers for a given door state. Opening and closing
 * need a deliberate hold; a moving door stops on a single tap; a blocked door
 * line locks closing; an offline controller disables the dial.
 */
export function dialModel({ state, online, obstacle, pending }: { state: DoorState; online: boolean; obstacle: ObstacleState; pending: DoorCommand | null }): DialModel {
  if (!online || state === "OFFLINE") return { tone: "neutral", icon: "wifi", hint: "Kart çevrimdışı", disabled: true, label: "Kapı kontrolü kullanılamıyor: kart çevrimdışı" };
  if (pending === "open" || pending === "close") return { tone: "warn", icon: "spinner", hint: "Gönderiliyor…", pending: true, disabled: true, label: "Komut gönderiliyor" };
  if (state === "OPENING" || state === "CLOSING") return { tone: "warn", icon: "stop", moving: state === "OPENING" ? "up" : "down", tap: "stop", hint: "Durdurmak için dokunun", label: "Kapıyı durdur" };
  if (state === "CLOSED") return { tone: "safe", icon: "up", hold: "open", hint: "Açmak için basılı tutun", label: "Kapıyı aç. Onaylamak için basılı tutun." };
  if (state === "OPEN") {
    if (closeBlocked(obstacle)) return { tone: "danger", icon: "lock", locked: true, hint: "Kapatma kilitli", label: `Kapatma engellendi. ${closeBlockedReason(obstacle)}` };
    return { tone: "warn", icon: "down", hold: "close", hint: "Kapatmak için basılı tutun", label: "Kapıyı kapat. Onaylamak için basılı tutun." };
  }
  // STOPPED / UNKNOWN / ERROR: the dial opens; closing is a separate hold control below it.
  return { tone: state === "ERROR" ? "danger" : "warn", icon: "up", hold: "open", hint: "Açmak için basılı tutun", label: "Kapıyı aç. Onaylamak için basılı tutun." };
}

/** STOPPED, UNKNOWN and ERROR doors get a second "hold to close" control next to the dial. */
export function offersSecondaryClose(state: DoorState, online: boolean): boolean {
  return online && (state === "STOPPED" || state === "UNKNOWN" || state === "ERROR");
}
