import fs from "node:fs";
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import type { CameraLiveStartCommand, CameraLiveStopCommand, GarageCommand } from "@garage-control/shared-types";
import type { AppConfig } from "./config.js";

export type MqttMessageHandler = (topic: string, payload: string) => Promise<void>;

export interface MqttGateway {
  start(handler: MqttMessageHandler): Promise<void>;
  stop(): Promise<void>;
  publishCommand(deviceId: string, command: GarageCommand): Promise<void>;
  publishCameraSnapshot(cameraId: string, reason: string): Promise<void>;
  publishCameraLiveStart(command: CameraLiveStartCommand): Promise<void>;
  publishCameraLiveStop(command: CameraLiveStopCommand): Promise<void>;
}

export class InMemoryMqttGateway implements MqttGateway {
  readonly published: Array<{ topic: string; payload: unknown }> = [];
  private handler: MqttMessageHandler | null = null;
  async start(handler: MqttMessageHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async publishCommand(deviceId: string, command: GarageCommand): Promise<void> { this.published.push({ topic: `garage/${deviceId}/command`, payload: structuredClone(command) }); }
  async publishCameraSnapshot(cameraId: string, reason: string): Promise<void> { this.published.push({ topic: `camera/${cameraId}/command`, payload: { commandId: "00000000-0000-4000-8000-000000000000", action: "SNAPSHOT", timestamp: new Date().toISOString(), deviceId: cameraId, reason } as unknown as GarageCommand }); }
  async publishCameraLiveStart(command: CameraLiveStartCommand): Promise<void> { this.published.push({ topic: `camera/${command.cameraId}/command`, payload: structuredClone(command) }); }
  async publishCameraLiveStop(command: CameraLiveStopCommand): Promise<void> { this.published.push({ topic: `camera/${command.cameraId}/command`, payload: structuredClone(command) }); }
  async inject(topic: string, payload: unknown): Promise<void> { await this.handler?.(topic, JSON.stringify(payload)); }
}

export class MqttClientGateway implements MqttGateway {
  private client: MqttClient | null = null;
  constructor(private readonly config: AppConfig) {}
  async start(handler: MqttMessageHandler): Promise<void> {
    if (!this.config.mqttUrl) return;
    const options = { reconnectPeriod: 1000, clientId: `garage-api-${process.pid}`, ...(this.config.mqttUsername ? { username: this.config.mqttUsername } : {}), ...(this.config.mqttPassword ? { password: this.config.mqttPassword } : {}), ...(this.config.mqttCaFile ? { ca: fs.readFileSync(this.config.mqttCaFile) } : {}) };
    this.client = mqtt.connect(this.config.mqttUrl, options);
    await new Promise<void>((resolve, reject) => {
      this.client?.once("connect", () => { this.client?.subscribe(["garage/+/state", "garage/+/telemetry", "garage/+/ack", "garage/+/availability", "garage/+/event", "camera/+/state", "camera/+/availability", "camera/+/event"]); resolve(); });
      this.client?.once("error", reject);
    });
    this.client.on("message", (topic, payload) => { void handler(topic, payload.toString()); });
  }
  async stop(): Promise<void> { await this.client?.endAsync(); this.client = null; }
  async publishCommand(deviceId: string, command: GarageCommand): Promise<void> { if (!this.client) throw new Error("MQTT gateway is not connected"); await this.client.publishAsync(`garage/${deviceId}/command`, JSON.stringify(command), { qos: 1 }); }
  async publishCameraSnapshot(cameraId: string, reason: string): Promise<void> { if (!this.client) throw new Error("MQTT gateway is not connected"); await this.client.publishAsync(`camera/${cameraId}/command`, JSON.stringify({ commandId: randomUUID(), action: "SNAPSHOT", reason, timestamp: new Date().toISOString(), cameraId }), { qos: 1 }); }
  async publishCameraLiveStart(command: CameraLiveStartCommand): Promise<void> { if (!this.client) throw new Error("MQTT gateway is not connected"); await this.client.publishAsync(`camera/${command.cameraId}/command`, JSON.stringify(command), { qos: 1 }); }
  async publishCameraLiveStop(command: CameraLiveStopCommand): Promise<void> { if (!this.client) throw new Error("MQTT gateway is not connected"); await this.client.publishAsync(`camera/${command.cameraId}/command`, JSON.stringify(command), { qos: 1 }); }
}
