import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  host: z.string().min(1).default("0.0.0.0"),
  port: z.coerce.number().int().min(1).max(65535).default(4000),
  webOrigin: z.string().url().default("http://localhost:3000"),
  databaseUrl: z.string().url().optional(),
  mqttUrl: z.string().url().optional(),
  mqttUsername: z.string().optional(),
  mqttPassword: z.string().optional(),
  mqttCaFile: z.string().optional(),
  jwtSecret: z.string().min(32).default("development-only-secret-change-before-production-1234"),
  accessTokenTtl: z.string().default("15m"),
  refreshTokenTtl: z.string().default("30d"),
  cameraUploadToken: z.string().min(16).default("development-camera-token-change-me"),
  cameraDataDir: z.string().default("./data/camera"),
  cameraIngestHost: z.string().min(1).default("localhost"),
  cameraIngestPort: z.coerce.number().int().min(1).max(65535).default(20000),
  cameraIngestBindHost: z.string().min(1).default("127.0.0.1"),
  cameraIngestBindPort: z.coerce.number().int().min(1).max(65535).default(20000),
  cameraDeviceToken: z.string().min(32).default("development-camera-device-token-change-me-1234"),
  cameraSessionTtl: z.string().default("10m"),
  cameraIdleTimeout: z.string().default("10s"),
  cameraMaxSession: z.string().default("10m"),
  cameraMaxFrameBytes: z.coerce.number().int().min(1024).max(5 * 1024 * 1024).default(512 * 1024),
  cameraMaxFps: z.coerce.number().int().min(1).max(10).default(5),
  defaultGarageId: z.string().min(1).default("garage-01"),
  defaultDeviceId: z.string().default("controller-s3-001"),
  defaultCameraId: z.string().default("camera-esp32cam-001"),
  probeDeviceId: z.string().min(1).default("controller-s3-probe"),
  // Voice-assistant (Grok) MCP endpoint; disabled unless a token is set.
  mcpToken: z.string().min(32).optional(),
  mcpOpenPin: z.string().regex(/^\d{4,8}$/, "MCP_OPEN_PIN must be 4-8 digits").optional()
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    host: env.API_HOST,
    port: env.API_PORT,
    webOrigin: env.WEB_ORIGIN,
    databaseUrl: env.DATABASE_URL,
    mqttUrl: env.MQTT_URL,
    mqttUsername: env.MQTT_USERNAME,
    mqttPassword: env.MQTT_PASSWORD,
    mqttCaFile: env.MQTT_CA_FILE || undefined,
    jwtSecret: env.JWT_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtl: env.REFRESH_TOKEN_TTL,
    cameraUploadToken: env.CAMERA_UPLOAD_TOKEN,
    cameraDataDir: env.CAMERA_DATA_DIR,
    cameraIngestHost: env.CAMERA_INGEST_HOST,
    cameraIngestPort: env.CAMERA_INGEST_PORT,
    cameraIngestBindHost: env.CAMERA_INGEST_BIND_HOST,
    cameraIngestBindPort: env.CAMERA_INGEST_BIND_PORT,
    cameraDeviceToken: env.CAMERA_DEVICE_TOKEN,
    cameraSessionTtl: env.CAMERA_SESSION_TTL,
    cameraIdleTimeout: env.CAMERA_IDLE_TIMEOUT,
    cameraMaxSession: env.CAMERA_MAX_SESSION,
    cameraMaxFrameBytes: env.CAMERA_MAX_FRAME_BYTES,
    cameraMaxFps: env.CAMERA_MAX_FPS,
    defaultGarageId: env.DEFAULT_GARAGE_ID,
    defaultDeviceId: env.DEFAULT_DEVICE_ID,
    defaultCameraId: env.DEFAULT_CAMERA_ID,
    probeDeviceId: env.PROBE_DEVICE_ID,
    mcpToken: env.MCP_TOKEN || undefined,
    mcpOpenPin: env.MCP_OPEN_PIN || undefined
  });
}

export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"];
  return amount * multiplier;
}
