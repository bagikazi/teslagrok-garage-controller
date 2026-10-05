import { describe, expect, it, vi } from "vitest";
import { CameraLiveManager, type CameraViewer } from "./live.js";

function sink(): CameraViewer & { frames: Buffer[] } {
  const frames: Buffer[] = [];
  return { frames, readyState: 1, bufferedAmount: 0, send: (frame) => frames.push(Buffer.from(frame)) };
}

describe("camera live sessions", () => {
  it("creates short-lived sessions with an unguessable stream token", () => {
    const manager = new CameraLiveManager({ deviceToken: "device-token-that-is-long-enough-123", now: () => 1_000 });
    const session = manager.create("user-1", "camera-1");

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.streamToken).toHaveLength(64);
    expect(session.expiresAt).toBeGreaterThan(1_000);
    expect(manager.authenticateIngest(session.id, session.streamToken, "device-token-that-is-long-enough-123")).toBe(true);
    manager.dispose();
  });

  it("fans out only valid JPEG frames and enforces frame limits", () => {
    let now = 10_000;
    const manager = new CameraLiveManager({
      deviceToken: "device-token-that-is-long-enough-123",
      maxFrameBytes: 8,
      maxFps: 2,
      now: () => now
    });
    const session = manager.create("user-1", "camera-1");
    const viewer = sink();
    expect(manager.addViewer(session.id, viewer)).toBe(true);

    expect(manager.ingest(session.id, session.streamToken, Buffer.from([0, 1, 2]))).toEqual({ accepted: false, reason: "invalid_jpeg" });
    expect(manager.getLastFrame()).toBeNull();
    const frame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    expect(manager.ingest(session.id, session.streamToken, frame)).toEqual({ accepted: true });
    expect(viewer.frames).toHaveLength(1);
    // Only accepted frames become the "last frame" the panel shows while live is off.
    expect(manager.getLastFrame()).toMatchObject({ data: frame, cameraId: "camera-1", capturedAt: new Date(now).toISOString() });
    expect(manager.ingest(session.id, session.streamToken, frame)).toEqual({ accepted: false, reason: "rate_limited" });
    now += 500;
    const oversized = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5), Buffer.from([0xff, 0xd9])]);
    expect(manager.ingest(session.id, session.streamToken, oversized)).toEqual({ accepted: false, reason: "frame_too_large" });
    manager.dispose();
  });

  it("stops orphaned sessions after the idle timeout and expires hard limits", () => {
    let now = 100;
    const onStop = vi.fn();
    const manager = new CameraLiveManager({
      deviceToken: "device-token-that-is-long-enough-123",
      idleTimeoutMs: 10,
      maxSessionMs: 50,
      now: () => now,
      onStop
    });
    const session = manager.create("user-1", "camera-1");
    manager.cleanup();
    expect(onStop).not.toHaveBeenCalled();
    now = 111;
    manager.cleanup();
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), "idle");

    const second = manager.create("user-1", "camera-1");
    manager.addViewer(second.id, sink());
    now = 162;
    manager.cleanup();
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }), "expired");
    manager.dispose();
  });

  it("rejects wrong device or stream credentials", () => {
    const manager = new CameraLiveManager({ deviceToken: "device-token-that-is-long-enough-123", now: () => 1_000 });
    const session = manager.create("user-1", "camera-1");
    expect(manager.authenticateIngest(session.id, session.streamToken, "wrong-device-token")).toBe(false);
    expect(manager.authenticateIngest(session.id, "wrong-stream-token", "device-token-that-is-long-enough-123")).toBe(false);
    manager.dispose();
  });
});
