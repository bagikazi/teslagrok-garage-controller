import { describe, expect, it } from "vitest";
import { CameraStateSchema, CommandSchema, DoorStateSchema, MqttCameraStateMessageSchema, MqttStateMessageSchema, wifiLevelFromRssi } from "./index.js";

describe("shared contracts", () => {
  it("maps RSSI to a 0-10 Wi-Fi level", () => {
    expect(wifiLevelFromRssi(null)).toBeNull();
    expect(wifiLevelFromRssi(-95)).toBe(0);
    expect(wifiLevelFromRssi(-90)).toBe(0);
    expect(wifiLevelFromRssi(-63)).toBe(5);
    expect(wifiLevelFromRssi(-62)).toBe(6);
    expect(wifiLevelFromRssi(-40)).toBe(10);
    expect(wifiLevelFromRssi(-20)).toBe(10);
  });

  it("keeps photocell fields in a state message", () => {
    const result = MqttStateMessageSchema.parse({
      deviceId: "controller-s3-001", timestamp: "2026-09-23T12:00:00.000Z", sequence: 1,
      bootId: "boot-1", firmwareVersion: "0.1.0", state: "OPEN",
      sensors: { closed: false, open: true, obstacleState: "BLOCKED", beamSource: "photocell", photocellClear: false }
    });
    expect(result.sensors).toMatchObject({ beamSource: "photocell", photocellClear: false });
  });

  it("rejects unknown door states", () => {
    expect(() => DoorStateSchema.parse("HALF_OPEN")).toThrow();
  });

  it("validates command UUID and timestamp", () => {
    expect(() => CommandSchema.parse({ commandId: "not-a-uuid", action: "OPEN", timestamp: "now", deviceId: "s3" })).toThrow();
  });

  it("accepts a complete state message", () => {
    const result = MqttStateMessageSchema.parse({
      deviceId: "controller-s3-001", timestamp: "2026-09-20T12:00:00.000Z", sequence: 1,
      bootId: "boot-1", firmwareVersion: "0.1.0", state: "CLOSED",
      sensors: { closed: true, open: false }, requestedAction: null
    });
    expect(result.state).toBe("CLOSED");
  });

  it("accepts a camera state message with garage identity", () => {
    const result = MqttCameraStateMessageSchema.parse({
      deviceId: "garage-camera-01", garageId: "garage-01", timestamp: "2026-09-20T12:00:00.000Z",
      sequence: 2, bootId: "boot-camera-1", firmwareVersion: "0.2.0", cameraState: "STANDBY",
      rssi: -58, uptimeSeconds: 20, freeHeap: 100000, lastError: null, sessionId: null
    });
    expect(result.cameraState).toBe("STANDBY");
    expect(CameraStateSchema.options).toContain("LIVE");
  });
});
