import type { ActivityEvent, CameraStatus, GarageStatus, LatestCamera } from "@garage-control/shared-types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(response.status === 401 ? "AUTH_REQUIRED" : `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export const garageApi = {
  login: (email: string, password: string) => request<{ accessToken: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  status: () => request<GarageStatus>("/api/garage/status"),
  events: () => request<ActivityEvent[]>("/api/garage/events?limit=20"),
  latestWifiReport: () => request<ActivityEvent[]>("/api/garage/events?type=WIFI_REPORT&limit=1").then((events) => events[0] ?? null),
  cameraStatus: () => request<CameraStatus>("/api/camera/status"),
  latestCamera: () => request<LatestCamera | null>("/api/camera/latest"),
  snapshot: () => request("/api/camera/snapshot", { method: "POST", body: JSON.stringify({}) }),
  lastLiveFrame: () => request<{ capturedAt: string; cameraId: string; bytes: number } | null>("/api/camera/live/last-frame/info"),
  startLive: () => request<{ sessionId: string; cameraId: string; expiresAt: string; preferredResolution: string; preferredFps: number }>("/api/camera/live/start", { method: "POST", body: JSON.stringify({}) }),
  stopLive: (sessionId: string) => request("/api/camera/live/stop", { method: "POST", body: JSON.stringify({ sessionId }) }),
  renewLive: (sessionId: string) => request<{ sessionId: string; expiresAt: string }>("/api/camera/live/renew", { method: "POST", body: JSON.stringify({ sessionId }) }),
  light: (on: boolean) => request<{ commandId: string; result: string }>("/api/garage/light", { method: "POST", body: JSON.stringify({ on }) }),
  calibrate: () => request<{ commandId: string; result: string }>("/api/garage/calibrate", { method: "POST", body: JSON.stringify({}) }),
  action: (action: "open" | "close" | "stop") => request<{ commandId: string; result: string | null }>(`/api/garage/${action}`, { method: "POST", body: JSON.stringify({}) })
};

export function createGarageSocket(onMessage: (message: unknown) => void): WebSocket | null {
  if (typeof window === "undefined") return null;
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  const url = configured ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => { try { onMessage(JSON.parse(event.data as string)); } catch { /* ignore malformed device payloads */ } });
  return socket;
}

export function createCameraViewerSocket(sessionId: string, onFrame: (frame: Blob) => void): WebSocket | null {
  if (typeof window === "undefined") return null;
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  const base = configured ? new URL(configured) : new URL(window.location.href);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const host = base.host || window.location.host;
  const socket = new WebSocket(`${protocol}//${host}/api/camera/live/view?sessionId=${encodeURIComponent(sessionId)}`);
  socket.binaryType = "blob";
  socket.addEventListener("message", (event) => {
    if (event.data instanceof Blob) {
      onFrame(event.data.type === "image/jpeg" ? event.data : new Blob([event.data], { type: "image/jpeg" }));
    } else if (event.data instanceof ArrayBuffer) {
      onFrame(new Blob([event.data], { type: "image/jpeg" }));
    }
  });
  return socket;
}
