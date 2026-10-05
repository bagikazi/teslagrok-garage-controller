import { randomUUID } from "node:crypto";
import type { ActivityEvent, DoorAction, DoorState, DeviceState, GarageCommand, GarageStatus, LatestCamera, MqttStateMessage, MqttTelemetryMessage, SensorSnapshot } from "@garage-control/shared-types";
import { hashPassword } from "./security.js";

export type UserRecord = { id: string; email: string; passwordHash: string; role: "owner" | "operator" };
export type CommandRecord = GarageCommand & { status: "PENDING" | "ACKNOWLEDGED" | "FAILED"; result: string | null };

export interface Repository {
  getGarageStatus(): Promise<GarageStatus>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findCommand(commandId: string): Promise<CommandRecord | null>;
  createCommand(command: GarageCommand): Promise<CommandRecord>;
  updateCommand(commandId: string, patch: Partial<Pick<CommandRecord, "status" | "result">>): Promise<CommandRecord | null>;
  applyState(message: MqttStateMessage): Promise<GarageStatus>;
  applyTelemetry(message: MqttTelemetryMessage): Promise<GarageStatus>;
  markOffline(deviceId: string): Promise<GarageStatus>;
  addEvent(type: ActivityEvent["type"], detail: string, imageId?: string): Promise<ActivityEvent>;
  listEvents(limit: number, type?: ActivityEvent["type"]): Promise<ActivityEvent[]>;
  getLatestCamera(): Promise<LatestCamera | null>;
  saveCameraImage(input: { id: string; cameraId: string; capturedAt: string; reason: LatestCamera["reason"]; url: string }): Promise<LatestCamera>;
}

const now = () => new Date().toISOString();

export class InMemoryRepository implements Repository {
  private status: GarageStatus;
  private readonly users: UserRecord[];
  private readonly commands = new Map<string, CommandRecord>();
  private readonly events: ActivityEvent[] = [];
  private latestCamera: LatestCamera | null = null;

  constructor(deviceId = "controller-s3-001") {
    this.status = {
      state: "CLOSED", lastChangedAt: now(), requestedAction: null,
      device: { deviceId, online: true, lastSeen: now(), rssi: null, uptimeSeconds: null, sensors: { closed: true, open: false }, firmwareVersion: null }
    };
    this.users = [{ id: randomUUID(), email: "owner@example.com", passwordHash: hashPassword(process.env.DEV_SEED_PASSWORD ?? "change-me-now"), role: "owner" }];
  }

  async getGarageStatus(): Promise<GarageStatus> { return structuredClone(this.status); }
  async findUserByEmail(email: string): Promise<UserRecord | null> { return this.users.find((user) => user.email === email) ?? null; }
  async findCommand(commandId: string): Promise<CommandRecord | null> { return this.commands.get(commandId) ?? null; }

  async createCommand(command: GarageCommand): Promise<CommandRecord> {
    const record: CommandRecord = { ...command, status: "PENDING", result: null };
    this.commands.set(command.commandId, record);
    return structuredClone(record);
  }

  async updateCommand(commandId: string, patch: Partial<Pick<CommandRecord, "status" | "result">>): Promise<CommandRecord | null> {
    const current = this.commands.get(commandId);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.commands.set(commandId, updated);
    return structuredClone(updated);
  }

  async applyState(message: MqttStateMessage): Promise<GarageStatus> {
    const previous = this.status;
    const changed = previous.state !== message.state;
    this.status = {
      state: message.state,
      lastChangedAt: changed ? message.timestamp : previous.lastChangedAt,
      requestedAction: message.requestedAction ?? previous.requestedAction,
      device: { ...previous.device, deviceId: message.deviceId, online: true, lastSeen: message.timestamp, sensors: message.sensors, firmwareVersion: message.firmwareVersion }
    };
    return structuredClone(this.status);
  }

  async applyTelemetry(message: MqttTelemetryMessage): Promise<GarageStatus> {
    this.status = { ...this.status, device: { ...this.status.device, deviceId: message.deviceId, online: true, lastSeen: message.timestamp, rssi: message.rssi, uptimeSeconds: message.uptimeSeconds, firmwareVersion: message.firmwareVersion } };
    return structuredClone(this.status);
  }

  async markOffline(deviceId: string): Promise<GarageStatus> {
    this.status = { ...this.status, device: { ...this.status.device, deviceId, online: false, lastSeen: this.status.device.lastSeen } };
    return structuredClone(this.status);
  }

  async addEvent(type: ActivityEvent["type"], detail: string, imageId?: string): Promise<ActivityEvent> {
    const event: ActivityEvent = { id: randomUUID(), type, createdAt: now(), detail, ...(imageId ? { imageId } : {}) };
    this.events.unshift(event);
    return structuredClone(event);
  }

  async listEvents(limit: number, type?: ActivityEvent["type"]): Promise<ActivityEvent[]> { return structuredClone(this.events.filter((event) => !type || event.type === type).slice(0, limit)); }
  async getLatestCamera(): Promise<LatestCamera | null> { return this.latestCamera ? structuredClone(this.latestCamera) : null; }
  async saveCameraImage(input: { id: string; cameraId: string; capturedAt: string; reason: LatestCamera["reason"]; url: string }): Promise<LatestCamera> { this.latestCamera = structuredClone(input); return structuredClone(input); }
  setDoorState(state: DoorState, sensors: SensorSnapshot = { closed: state === "CLOSED", open: state === "OPEN" }): void { this.status = { ...this.status, state, device: { ...this.status.device, sensors, lastSeen: now() } }; }
  setLatestCamera(camera: LatestCamera): void { this.latestCamera = structuredClone(camera); }
}

export function commandToRecord(command: GarageCommand): CommandRecord { return { ...command, status: "PENDING", result: null }; }
