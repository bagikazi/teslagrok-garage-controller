import { z } from "zod";

export const DoorStateSchema = z.enum(["CLOSED", "OPEN", "OPENING", "CLOSING", "STOPPED", "UNKNOWN", "OFFLINE", "ERROR"]);
export type DoorState = z.infer<typeof DoorStateSchema>;

export const DoorActionSchema = z.enum(["OPEN", "CLOSE", "STOP"]);
export type DoorAction = z.infer<typeof DoorActionSchema>;

/** Everything the controller accepts on its command topic: door actions plus maintenance. */
export const CommandActionSchema = z.enum(["OPEN", "CLOSE", "STOP", "CALIBRATE", "LIGHT_ON", "LIGHT_OFF"]);
export type CommandAction = z.infer<typeof CommandActionSchema>;

/**
 * Wi-Fi signal level 0-10 shown on the web and the device screen: -90 dBm or
 * weaker is 0, -40 dBm or stronger is 10, one step per 5 dB. The controller
 * firmware (wifi_level_from_rssi in main.c) uses the same scale.
 */
export function wifiLevelFromRssi(rssi: number | null | undefined): number | null {
  if (rssi == null) return null;
  return Math.min(10, Math.max(0, Math.round((rssi + 90) / 5)));
}

export const SensorSnapshotSchema = z.object({
  closed: z.boolean(),
  open: z.boolean(),
  obstruction: z.boolean().optional(),
  top: z.boolean().optional(),
  bottom: z.boolean().optional(),
  obstacleState: z.enum(["CLEAR", "WARNING", "BLOCKED", "SENSOR_FAULT"]).optional(),
  hcSr04DistanceCm: z.number().nonnegative().nullable().optional(),
  tofDistanceCm: z.number().nonnegative().nullable().optional(),
  hcSr04Healthy: z.boolean().optional(),
  tofHealthy: z.boolean().optional(),
  /** Calibrated empty-doorway distances the obstacle beam is compared against. */
  hcSr04BaselineCm: z.number().nonnegative().nullable().optional(),
  tofBaselineCm: z.number().nonnegative().nullable().optional(),
  beamToleranceCm: z.number().nonnegative().nullable().optional(),
  /** Doorway obstacle sensor in use; "photocell" means no distance readings are published. */
  beamSource: z.enum(["distance", "photocell"]).optional(),
  /** Photocell beam received (doorway clear). Only with beamSource "photocell". */
  photocellClear: z.boolean().optional(),
  /** TOF responding (with or without a target). tofBaselineCm null = presence mode. */
  tofOnline: z.boolean().optional(),
  /** Presence-mode reach: readings at or below this are obstacles; beyond it shows "> N cm". */
  tofRangeCm: z.number().nonnegative().optional(),
  /** Door relays locked by SAFE_TEST_MODE: commands are acked but never pulse. */
  relaysLocked: z.boolean().optional(),
  pirMotion: z.boolean().optional(),
  lightOn: z.boolean().optional(),
  /** AUTO = switched on by the PIR, MANUAL = switched on from the web. */
  lightMode: z.enum(["OFF", "AUTO", "MANUAL"]).optional()
});
export type SensorSnapshot = z.infer<typeof SensorSnapshotSchema>;

export const ObstacleStateSchema = z.enum(["CLEAR", "WARNING", "BLOCKED", "SENSOR_FAULT"]);
export type ObstacleState = z.infer<typeof ObstacleStateSchema>;

export const DeviceStateSchema = z.object({
  deviceId: z.string().min(1),
  online: z.boolean(),
  lastSeen: z.string().datetime().nullable(),
  rssi: z.number().int().min(-127).max(0).nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  sensors: SensorSnapshotSchema,
  firmwareVersion: z.string().nullable()
});
export type DeviceState = z.infer<typeof DeviceStateSchema>;

export const GarageStatusSchema = z.object({
  state: DoorStateSchema,
  lastChangedAt: z.string().datetime().nullable(),
  requestedAction: DoorActionSchema.nullable(),
  device: DeviceStateSchema
});
export type GarageStatus = z.infer<typeof GarageStatusSchema>;

export const CommandSchema = z.object({
  commandId: z.string().uuid(),
  action: CommandActionSchema,
  timestamp: z.string().datetime(),
  deviceId: z.string().min(1)
});
export type GarageCommand = z.infer<typeof CommandSchema>;

export const CommandAckSchema = z.object({
  commandId: z.string().uuid(),
  accepted: z.boolean(),
  result: z.string(),
  currentState: DoorStateSchema
});
export type CommandAck = z.infer<typeof CommandAckSchema>;

export const MqttEnvelopeSchema = z.object({
  deviceId: z.string().min(1),
  timestamp: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  bootId: z.string().min(1),
  firmwareVersion: z.string().min(1)
});

export const MqttStateMessageSchema = MqttEnvelopeSchema.extend({
  state: DoorStateSchema,
  sensors: SensorSnapshotSchema,
  requestedAction: DoorActionSchema.nullable().optional()
});
export type MqttStateMessage = z.infer<typeof MqttStateMessageSchema>;

export const MqttTelemetryMessageSchema = MqttEnvelopeSchema.extend({
  rssi: z.number().int().min(-127).max(0),
  uptimeSeconds: z.number().nonnegative()
});
export type MqttTelemetryMessage = z.infer<typeof MqttTelemetryMessageSchema>;

export const EventTypeSchema = z.enum(["DOOR_OPENED", "DOOR_CLOSED", "DOOR_MOVING", "MOTION_DETECTED", "REMOTE_COMMAND", "DEVICE_OFFLINE", "DEVICE_ONLINE", "DEVICE_RESTARTED", "CLOSE_BLOCKED", "OBSTACLE_DETECTED", "STOP_AND_REOPEN", "PIR_MOTION", "LIGHT_ON", "LIGHT_OFF", "CAMERA_LIVE_STARTED", "CAMERA_LIVE_STOPPED", "WIFI_REPORT", "PROBE_WIFI_REPORT", "ERROR"]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  id: z.string().uuid(),
  type: EventTypeSchema,
  createdAt: z.string().datetime(),
  detail: z.string(),
  imageId: z.string().uuid().nullable().optional()
});
export type ActivityEvent = z.infer<typeof EventSchema>;

/** Safety events the controller publishes on garage/<deviceId>/event. */
export const MqttDeviceEventSchema = z.object({
  deviceId: z.string().min(1),
  type: EventTypeSchema,
  detail: z.string().max(200)
});
export type MqttDeviceEvent = z.infer<typeof MqttDeviceEventSchema>;

export const LatestCameraSchema = z.object({
  id: z.string().uuid(),
  cameraId: z.string().min(1),
  capturedAt: z.string().datetime(),
  reason: z.enum(["MOTION", "DOOR_OPENED", "DOOR_CLOSED", "MANUAL"]),
  url: z.string().min(1)
});
export type LatestCamera = z.infer<typeof LatestCameraSchema>;

export const CameraStateSchema = z.enum(["OFFLINE", "CONNECTING", "STANDBY", "STARTING", "LIVE", "ERROR"]);
export type CameraState = z.infer<typeof CameraStateSchema>;

export const CameraStatusSchema = z.object({
  cameraId: z.string().min(1),
  garageId: z.string().min(1),
  state: CameraStateSchema,
  online: z.boolean(),
  lastSeen: z.string().datetime().nullable(),
  rssi: z.number().int().min(-127).max(0).nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  freeHeap: z.number().int().nonnegative().nullable(),
  firmwareVersion: z.string().nullable(),
  lastError: z.string().max(256).nullable(),
  sessionId: z.string().uuid().nullable()
});
export type CameraStatus = z.infer<typeof CameraStatusSchema>;

export const CameraLiveStartCommandSchema = z.object({
  commandId: z.string().uuid(),
  action: z.literal("START_LIVE"),
  timestamp: z.string().datetime(),
  cameraId: z.string().min(1),
  sessionId: z.string().uuid(),
  streamToken: z.string().min(32),
  ingestHost: z.string().min(1),
  ingestPort: z.number().int().min(1).max(65535),
  preferredResolution: z.enum(["320x240", "640x480"]),
  preferredFps: z.number().int().min(1).max(10)
});
export type CameraLiveStartCommand = z.infer<typeof CameraLiveStartCommandSchema>;

export const CameraLiveStopCommandSchema = z.object({
  commandId: z.string().uuid(),
  action: z.literal("STOP_LIVE"),
  timestamp: z.string().datetime(),
  cameraId: z.string().min(1),
  sessionId: z.string().uuid()
});
export type CameraLiveStopCommand = z.infer<typeof CameraLiveStopCommandSchema>;

export const MqttCameraStateMessageSchema = MqttEnvelopeSchema.extend({
  garageId: z.string().min(1),
  cameraState: CameraStateSchema,
  rssi: z.number().int().min(-127).max(0),
  uptimeSeconds: z.number().nonnegative(),
  freeHeap: z.number().int().nonnegative(),
  lastError: z.string().max(256).nullable(),
  sessionId: z.string().uuid().nullable()
});
export type MqttCameraStateMessage = z.infer<typeof MqttCameraStateMessageSchema>;

export const MqttCameraAvailabilitySchema = z.object({
  deviceId: z.string().min(1),
  garageId: z.string().min(1),
  timestamp: z.string().datetime(),
  online: z.boolean()
});
export type MqttCameraAvailability = z.infer<typeof MqttCameraAvailabilitySchema>;

/** Spare S3 that only measures Wi-Fi in the garage (firmware GARAGE_WIFI_PROBE). */
export const ProbeStatusSchema = z.object({
  deviceId: z.string().min(1),
  online: z.boolean(),
  lastSeen: z.string().datetime().nullable(),
  rssi: z.number().int().min(-127).max(0).nullable(),
  firmwareVersion: z.string().nullable()
});
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export type WsMessage =
  | { type: "garage.status"; payload: GarageStatus }
  | { type: "probe.status"; payload: ProbeStatus }
  | { type: "activity.created"; payload: ActivityEvent }
  | { type: "camera.latest"; payload: LatestCamera }
  | { type: "camera.status"; payload: CameraStatus }
  | { type: "command.ack"; payload: CommandAck };
