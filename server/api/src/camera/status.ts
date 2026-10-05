import type { CameraStatus, MqttCameraAvailability, MqttCameraStateMessage } from "@garage-control/shared-types";

export class CameraStatusRegistry {
  private status: CameraStatus;

  constructor(cameraId: string, garageId: string) {
    this.status = {
      cameraId,
      garageId,
      state: "OFFLINE",
      online: false,
      lastSeen: null,
      rssi: null,
      uptimeSeconds: null,
      freeHeap: null,
      firmwareVersion: null,
      lastError: null,
      sessionId: null
    };
  }

  get(): CameraStatus { return structuredClone(this.status); }

  applyState(message: MqttCameraStateMessage): CameraStatus {
    this.status = {
      ...this.status,
      cameraId: message.deviceId,
      garageId: message.garageId,
      state: message.cameraState,
      online: message.cameraState !== "OFFLINE",
      lastSeen: message.timestamp,
      rssi: message.rssi,
      uptimeSeconds: message.uptimeSeconds,
      freeHeap: message.freeHeap,
      firmwareVersion: message.firmwareVersion,
      lastError: message.lastError,
      sessionId: message.sessionId
    };
    return this.get();
  }

  applyAvailability(message: MqttCameraAvailability): CameraStatus {
    this.status = {
      ...this.status,
      cameraId: message.deviceId,
      garageId: message.garageId,
      state: message.online ? (this.status.state === "OFFLINE" ? "CONNECTING" : this.status.state) : "OFFLINE",
      online: message.online,
      lastSeen: message.timestamp
    };
    return this.get();
  }
}
