import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type CameraLiveStopReason = "explicit" | "idle" | "expired" | "shutdown";

export type CameraViewer = {
  readyState: number;
  bufferedAmount: number;
  send(frame: Buffer): void;
  close?: (code?: number, reason?: string) => void;
};

export type CameraLiveSession = {
  id: string;
  userId: string;
  cameraId: string;
  streamToken: string;
  createdAt: number;
  expiresAt: number;
  lastViewerAt: number;
  lastFrameAt: number | null;
  viewerCount: number;
};

export type CameraLivePublicSession = Omit<CameraLiveSession, "streamToken" | "userId">;

type InternalSession = CameraLiveSession & {
  viewers: Set<CameraViewer>;
  ingestConnected: boolean;
};

type LiveOptions = {
  deviceToken: string;
  idleTimeoutMs?: number;
  maxSessionMs?: number;
  maxFrameBytes?: number;
  maxFps?: number;
  now?: () => number;
  onStop?: (session: CameraLivePublicSession, reason: CameraLiveStopReason) => void | Promise<void>;
};

type IngestResult = { accepted: true } | { accepted: false; reason: "not_found" | "unauthorized" | "expired" | "invalid_jpeg" | "frame_too_large" | "rate_limited" };

const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSION_MS = 10 * 60_000;
const DEFAULT_MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_MAX_FPS = 5;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(left: string, right: string): boolean {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

function isJpeg(frame: Buffer): boolean {
  return frame.length >= 4 && frame[0] === 0xff && frame[1] === 0xd8 && frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xd9;
}

function publicSession(session: InternalSession): CameraLivePublicSession {
  const { streamToken: _streamToken, userId: _userId, viewers: _viewers, ingestConnected: _ingestConnected, ...safe } = session;
  return { ...safe };
}

export class CameraLiveManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly deviceToken: string;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;
  private readonly maxFrameBytes: number;
  private readonly frameIntervalMs: number;
  private readonly now: () => number;
  private readonly onStop?: LiveOptions["onStop"];
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  /** Newest accepted live frame, shown by the panel while no live session runs. In memory only. */
  private lastFrame: { data: Buffer; capturedAt: string; cameraId: string } | null = null;

  constructor(options: LiveOptions) {
    this.deviceToken = options.deviceToken;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = options.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.frameIntervalMs = 1000 / (options.maxFps ?? DEFAULT_MAX_FPS);
    this.now = options.now ?? Date.now;
    this.onStop = options.onStop;
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000);
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) this.cleanupTimer.unref();
  }

  create(userId: string, cameraId: string): CameraLiveSession {
    const now = this.now();
    const session: InternalSession = {
      id: randomUUID(),
      userId,
      cameraId,
      streamToken: randomBytes(32).toString("hex"),
      createdAt: now,
      expiresAt: now + this.maxSessionMs,
      lastViewerAt: now,
      lastFrameAt: null,
      viewerCount: 0,
      viewers: new Set(),
      ingestConnected: false
    };
    this.sessions.set(session.id, session);
    const { viewers: _viewers, ingestConnected: _ingestConnected, ...publicData } = session;
    return publicData;
  }

  get(sessionId: string): CameraLivePublicSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) return null;
    return publicSession(session);
  }

  private isExpired(session: InternalSession): boolean {
    return this.now() >= session.expiresAt;
  }

  owns(sessionId: string, userId: string): boolean {
    return this.sessions.get(sessionId)?.userId === userId;
  }

  authenticateIngest(sessionId: string, streamToken: string, deviceToken: string): boolean {
    const session = this.sessions.get(sessionId);
    return Boolean(session && !this.isExpired(session) && sameSecret(session.streamToken, streamToken) && sameSecret(this.deviceToken, deviceToken));
  }

  connectIngest(sessionId: string, streamToken: string, deviceToken: string): boolean {
    if (!this.authenticateIngest(sessionId, streamToken, deviceToken)) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.ingestConnected = true;
    return true;
  }

  disconnectIngest(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.ingestConnected = false;
  }

  addViewer(sessionId: string, viewer: CameraViewer): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) return false;
    session.viewers.add(viewer);
    session.viewerCount = session.viewers.size;
    session.lastViewerAt = this.now();
    return true;
  }

  removeViewer(sessionId: string, viewer: CameraViewer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.viewers.delete(viewer);
    session.viewerCount = session.viewers.size;
    if (session.viewerCount > 0) session.lastViewerAt = this.now();
  }

  renew(sessionId: string, userId: string): CameraLivePublicSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || this.isExpired(session)) return null;
    session.expiresAt = Math.min(session.createdAt + this.maxSessionMs, this.now() + this.maxSessionMs);
    session.lastViewerAt = this.now();
    return publicSession(session);
  }

  ingest(sessionId: string, streamToken: string, frame: Buffer): IngestResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { accepted: false, reason: "not_found" };
    if (!sameSecret(session.streamToken, streamToken)) return { accepted: false, reason: "unauthorized" };
    if (this.isExpired(session)) return { accepted: false, reason: "expired" };
    if (!isJpeg(frame)) return { accepted: false, reason: "invalid_jpeg" };
    if (frame.length > this.maxFrameBytes) return { accepted: false, reason: "frame_too_large" };
    const now = this.now();
    if (session.lastFrameAt !== null && now - session.lastFrameAt < this.frameIntervalMs) return { accepted: false, reason: "rate_limited" };
    session.lastFrameAt = now;
    this.lastFrame = { data: frame, capturedAt: new Date(now).toISOString(), cameraId: session.cameraId };
    for (const viewer of session.viewers) {
      if (viewer.readyState !== 1 || viewer.bufferedAmount > this.maxFrameBytes * 2) continue;
      try { viewer.send(frame); } catch { session.viewers.delete(viewer); }
    }
    session.viewerCount = session.viewers.size;
    return { accepted: true };
  }

  getLastFrame(): { data: Buffer; capturedAt: string; cameraId: string } | null { return this.lastFrame; }

  stop(sessionId: string, reason: CameraLiveStopReason = "explicit"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    for (const viewer of session.viewers) viewer.close?.(1000, reason);
    void this.onStop?.(publicSession(session), reason);
    return true;
  }

  cleanup(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now >= session.expiresAt) {
        this.stop(session.id, "expired");
      } else if (session.viewerCount === 0 && now - session.lastViewerAt >= this.idleTimeoutMs) {
        this.stop(session.id, "idle");
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const session of [...this.sessions.values()]) this.stop(session.id, "shutdown");
  }
}
