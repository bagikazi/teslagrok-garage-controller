import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { CameraLiveStartCommandSchema, CommandAckSchema, CommandSchema, EventTypeSchema, type ProbeStatus, MqttCameraAvailabilitySchema, MqttDeviceEventSchema, MqttCameraStateMessageSchema, MqttStateMessageSchema, MqttTelemetryMessageSchema, type CameraLiveStartCommand, type CameraLiveStopCommand, type DoorAction } from "@garage-control/shared-types";
import { z } from "zod";
import { actionNeedsPulse, nextMotionState } from "./domain/door.js";
import { loadConfig, parseDuration, type AppConfig } from "./config.js";
import { EventBus } from "./events.js";
import type { MqttGateway } from "./mqtt.js";
import { InMemoryMqttGateway, MqttClientGateway } from "./mqtt.js";
import { InMemoryRepository, type Repository } from "./repository.js";
import { verifyPassword } from "./security.js";
import { withLiveSensors } from "./live-sensors.js";
import { CameraLiveManager, type CameraViewer } from "./camera/live.js";
import { CameraStatusRegistry } from "./camera/status.js";
import { createMcpServer, secretMatches } from "./mcp.js";

type BuildOptions = { repository?: Repository; mqtt?: MqttGateway; config?: AppConfig; cameraLive?: CameraLiveManager };
export type GarageApiInstance = FastifyInstance & { cameraLive: CameraLiveManager };

function authError(reply: FastifyReply): void { void reply.code(401).send({ error: "Authentication required" }); }

// Devices without a synced clock report 1970 timestamps; use the receive time instead.
const EARLIEST_DEVICE_TIME = Date.parse("2024-01-01T00:00:00Z");
// The controller retains its state on the broker, so after an API restart the
// broker replays it even when the controller has been offline for days. A replay
// that old must not mark the controller online with its old signal again.
const STALE_STATE_MS = 2 * 60 * 1000;
function receivedTimestamp(deviceTimestamp: string): string {
  return Date.parse(deviceTimestamp) < EARLIEST_DEVICE_TIME ? new Date().toISOString() : deviceTimestamp;
}

export async function buildApp(options: BuildOptions = {}): Promise<GarageApiInstance> {
  const config = options.config ?? loadConfig();
  const repository = withLiveSensors(options.repository ?? new InMemoryRepository(config.defaultDeviceId));
  const mqtt = options.mqtt ?? (config.mqttUrl ? new MqttClientGateway(config) : new InMemoryMqttGateway());
  const bus = new EventBus();
  const cameraLive = options.cameraLive ?? new CameraLiveManager({
    deviceToken: config.cameraDeviceToken,
    idleTimeoutMs: parseDuration(config.cameraIdleTimeout),
    maxSessionMs: parseDuration(config.cameraMaxSession),
    maxFrameBytes: config.cameraMaxFrameBytes,
    maxFps: config.cameraMaxFps,
    onStop: (session, reason) => {
      const command: CameraLiveStopCommand = { commandId: randomUUID(), action: "STOP_LIVE", timestamp: new Date().toISOString(), cameraId: session.cameraId, sessionId: session.id };
      void mqtt.publishCameraLiveStop(command);
      void repository.addEvent("CAMERA_LIVE_STOPPED", `Camera ${session.cameraId} live session stopped (${reason})`).then((event) => bus.publish({ type: "activity.created", payload: event }));
    }
  });
  // The MCP token can sit in the URL path, so request logs mask it.
  const logger: FastifyServerOptions["logger"] = config.nodeEnv === "production" && {
    serializers: { req: (request) => ({ method: request.method, url: request.url.replace(/^\/api\/mcp\/[^/?#]+/, "/api/mcp/<redacted>"), host: request.host, remoteAddress: request.ip }) }
  };
  const app = Fastify({ logger });
  const cameraStatus = new CameraStatusRegistry(config.defaultCameraId, config.defaultGarageId);
  app.decorate("cameraLive", cameraLive);
  app.addContentTypeParser("image/jpeg", { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 }, (_request, body, done) => done(null, body));

  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret, cookie: { cookieName: "accessToken", signed: false }, sign: { expiresIn: config.accessTokenTtl } });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try { await request.jwtVerify(); } catch { authError(reply); }
  };

  const publishStatus = async () => bus.publish({ type: "garage.status", payload: await repository.getGarageStatus() });
  // The spare S3 only measures Wi-Fi. It is kept apart from the controller so its
  // availability and telemetry never touch the garage status.
  let probe: ProbeStatus = { deviceId: config.probeDeviceId, online: false, lastSeen: null, rssi: null, firmwareVersion: null };
  const handleProbeMessage = async (kind: string, parsed: unknown): Promise<void> => {
    if (kind === "telemetry") {
      const result = MqttTelemetryMessageSchema.safeParse(parsed);
      if (!result.success) return;
      probe = { ...probe, online: true, lastSeen: new Date().toISOString(), rssi: result.data.rssi, firmwareVersion: result.data.firmwareVersion };
    } else if (kind === "availability") {
      probe = { ...probe, online: typeof parsed === "object" && parsed !== null && "online" in parsed && parsed.online === true };
    } else if (kind === "event") {
      const result = MqttDeviceEventSchema.safeParse(parsed);
      if (!result.success || result.data.type !== "WIFI_REPORT") return;
      bus.publish({ type: "activity.created", payload: await repository.addEvent("PROBE_WIFI_REPORT", result.data.detail) });
      return;
    } else return;
    bus.publish({ type: "probe.status", payload: probe });
  };

  const handleMqttMessage = async (topic: string, rawPayload: string): Promise<void> => {
    const [namespace, deviceId, kind] = topic.split("/");
    if (!namespace || !deviceId || !kind) return;
    let parsed: unknown;
    try { parsed = JSON.parse(rawPayload); } catch { return; }
    if (namespace === "garage" && deviceId === config.probeDeviceId) return handleProbeMessage(kind, parsed);
    if (namespace === "camera" && kind === "state") {
      const result = MqttCameraStateMessageSchema.safeParse(parsed);
      if (!result.success || result.data.deviceId !== config.defaultCameraId) return;
      bus.publish({ type: "camera.status", payload: cameraStatus.applyState(result.data) });
    } else if (namespace === "camera" && kind === "availability") {
      const result = MqttCameraAvailabilitySchema.safeParse(parsed);
      if (!result.success || result.data.deviceId !== config.defaultCameraId) return;
      bus.publish({ type: "camera.status", payload: cameraStatus.applyAvailability(result.data) });
    } else if (namespace === "garage" && kind === "state") {
      const result = MqttStateMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const timestamp = receivedTimestamp(result.data.timestamp);
      if (Date.now() - Date.parse(timestamp) > STALE_STATE_MS) return;
      const previousState = (await repository.getGarageStatus()).state;
      const status = await repository.applyState({ ...result.data, timestamp });
      bus.publish({ type: "garage.status", payload: status });
      // The controller republishes state every few seconds; only log real transitions.
      if (previousState === result.data.state) return;
      const eventType = result.data.state === "OPEN" ? "DOOR_OPENED" : result.data.state === "CLOSED" ? "DOOR_CLOSED" : result.data.state === "OPENING" || result.data.state === "CLOSING" ? "DOOR_MOVING" : null;
      if (eventType) bus.publish({ type: "activity.created", payload: await repository.addEvent(eventType, `Controller reported ${result.data.state}`) });
      if (eventType === "DOOR_OPENED" || eventType === "DOOR_CLOSED") void mqtt.publishCameraSnapshot(config.defaultCameraId, eventType);
    } else if (namespace === "garage" && kind === "telemetry") {
      const result = MqttTelemetryMessageSchema.safeParse(parsed);
      if (!result.success) return;
      bus.publish({ type: "garage.status", payload: await repository.applyTelemetry({ ...result.data, timestamp: receivedTimestamp(result.data.timestamp) }) });
    } else if (namespace === "garage" && kind === "ack") {
      const result = CommandAckSchema.safeParse(parsed);
      if (!result.success) return;
      await repository.updateCommand(result.data.commandId, { status: result.data.accepted ? "ACKNOWLEDGED" : "FAILED", result: result.data.result });
      bus.publish({ type: "command.ack", payload: result.data });
      const ackEvent = result.data.result === "CLOSE_BLOCKED" ? "CLOSE_BLOCKED" : result.data.accepted ? "REMOTE_COMMAND" : "ERROR";
      bus.publish({ type: "activity.created", payload: await repository.addEvent(ackEvent, `Command ${result.data.commandId} ${result.data.result}`) });
    } else if (namespace === "garage" && kind === "event") {
      const result = MqttDeviceEventSchema.safeParse(parsed);
      if (!result.success || result.data.deviceId !== deviceId) return;
      bus.publish({ type: "activity.created", payload: await repository.addEvent(result.data.type, result.data.detail) });
    } else if (namespace === "garage" && kind === "availability") {
      const online = typeof parsed === "object" && parsed !== null && "online" in parsed && parsed.online === true;
      const status = online ? await repository.getGarageStatus() : await repository.markOffline(deviceId);
      bus.publish({ type: "garage.status", payload: status });
      if (!online) bus.publish({ type: "activity.created", payload: await repository.addEvent("DEVICE_OFFLINE", `${deviceId} went offline`) });
    }
  };

  await mqtt.start(handleMqttMessage);

  app.get("/api/system/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  app.post("/api/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = request.body as unknown;
    // "email" is the login identifier: an e-mail address or a plain username (users.email holds either).
    const parsed = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }).safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid credentials format" });
    const user = await repository.findUserByEmail(parsed.data.email);
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) return reply.code(401).send({ error: "Invalid credentials" });
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await app.jwt.sign(payload);
    const refreshToken = await app.jwt.sign({ ...payload, typ: "refresh" }, { expiresIn: config.refreshTokenTtl });
    reply.setCookie("refreshToken", refreshToken, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/api/auth" });
    reply.setCookie("accessToken", accessToken, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/" });
    return reply.send({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const token = request.cookies.refreshToken;
    if (!token) return reply.code(401).send({ error: "Refresh token required" });
    try {
      const payload = await app.jwt.verify<{ sub: string; email: string; role: string; typ?: string }>(token);
      if (payload.typ !== "refresh") return reply.code(401).send({ error: "Invalid refresh token" });
      const accessToken = await app.jwt.sign({ sub: payload.sub, email: payload.email, role: payload.role });
      reply.setCookie("accessToken", accessToken, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/" });
      return reply.send({ accessToken });
    } catch { return reply.code(401).send({ error: "Invalid refresh token" }); }
  });

  app.get("/api/garage/status", { preHandler: authenticate }, async () => repository.getGarageStatus());
  app.get("/api/garage", { preHandler: authenticate }, async () => repository.getGarageStatus());
  app.get("/api/garage/events", { preHandler: authenticate }, async (request, reply) => {
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 50);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
    // Optional ?type= filter, e.g. the latest WIFI_REPORT, which the busy log would push out.
    const rawType = (request.query as { type?: string }).type;
    const type = rawType === undefined ? undefined : EventTypeSchema.safeParse(rawType);
    if (type && !type.success) return reply.code(400).send({ error: "Unknown event type" });
    return reply.send(await repository.listEvents(limit, type?.data));
  });

  // Shared by the web routes and the MCP tools; `source` tags the activity log entry.
  const runDoorAction = async (action: DoorAction, commandId: string, source?: string): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
    const commandResult = CommandSchema.safeParse({ commandId, action, timestamp: new Date().toISOString(), deviceId: config.defaultDeviceId });
    if (!commandResult.success) return { statusCode: 400, body: { error: "Invalid commandId" } };
    const existing = await repository.findCommand(commandId);
    if (existing) return { statusCode: 200, body: { ...existing, result: existing.result ?? "already_processed" } };
    const status = await repository.getGarageStatus();
    if (!actionNeedsPulse(action, status.state)) {
      const command = await repository.createCommand(commandResult.data);
      const updated = await repository.updateCommand(command.commandId, { status: "ACKNOWLEDGED", result: "already_reached" });
      return { statusCode: 200, body: { ...updated } };
    }
    const command = await repository.createCommand(commandResult.data);
    await mqtt.publishCommand(config.defaultDeviceId, commandResult.data);
    await repository.updateCommand(command.commandId, { status: "PENDING", result: "published" });
    const optimistic = { ...status, state: nextMotionState(status.state, action), requestedAction: action, lastChangedAt: new Date().toISOString() };
    bus.publish({ type: "garage.status", payload: optimistic });
    bus.publish({ type: "activity.created", payload: await repository.addEvent("REMOTE_COMMAND", `${action} command sent${source ? ` via ${source}` : ""}`) });
    return { statusCode: 202, body: { ...command, result: "published" } };
  };

  const actionRoute = (action: DoorAction) => async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { commandId?: unknown } | undefined;
    const commandId = typeof body?.commandId === "string" ? body.commandId : randomUUID();
    const outcome = await runDoorAction(action, commandId);
    return reply.code(outcome.statusCode).send(outcome.body);
  };

  app.post("/api/garage/open", { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, actionRoute("OPEN"));
  app.post("/api/garage/close", { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, actionRoute("CLOSE"));
  app.post("/api/garage/stop", { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, actionRoute("STOP"));

  // Voice assistant (Grok custom connector) over MCP. Grok's dialog only takes a URL,
  // so the token may sit in the path; an Authorization: Bearer header also works.
  const mcpToken = config.mcpToken;
  if (mcpToken) {
    const mcpServer = createMcpServer({
      openPin: config.mcpOpenPin,
      getStatus: () => repository.getGarageStatus(),
      runDoorAction: async (action) => {
        const outcome = await runDoorAction(action, randomUUID(), "Grok");
        return { statusCode: outcome.statusCode, result: typeof outcome.body.result === "string" ? outcome.body.result : null };
      }
    });
    const mcpAuthorized = (request: FastifyRequest): boolean => {
      const pathToken = (request.params as { token?: string }).token;
      const header = request.headers.authorization;
      const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
      return secretMatches(pathToken ?? bearer, mcpToken);
    };
    const mcpPost = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!mcpAuthorized(request)) return reply.code(401).send({ error: "Invalid MCP token" });
      const response = await mcpServer.handle(request.body);
      return response === null ? reply.code(202).send() : reply.send(response);
    };
    // Stateless JSON-only server: no SSE stream to open and no session to delete.
    const mcpNoStream = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header("allow", "POST").send({ error: "Use POST" });
    const mcpLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
    for (const url of ["/api/mcp", "/api/mcp/:token"]) {
      app.post(url, mcpLimit, mcpPost);
      app.get(url, mcpLimit, mcpNoStream);
      app.delete(url, mcpLimit, mcpNoStream);
    }
  }

  // Re-measures the empty-doorway distances on the controller and stores them in
  // its NVS. Not persisted in the commands table (its CHECK only allows door
  // actions); the result reaches the browser as a command.ack WebSocket message.
  app.post("/api/garage/calibrate", { preHandler: authenticate, config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const status = await repository.getGarageStatus();
    if (!status.device.online) return reply.code(409).send({ error: "Controller is offline" });
    if (status.state === "OPENING" || status.state === "CLOSING") return reply.code(409).send({ error: "Door is moving" });
    const command = CommandSchema.parse({ commandId: randomUUID(), action: "CALIBRATE", timestamp: new Date().toISOString(), deviceId: config.defaultDeviceId });
    try {
      await mqtt.publishCommand(config.defaultDeviceId, command);
    } catch {
      return reply.code(503).send({ error: "Controller link unavailable" });
    }
    bus.publish({ type: "activity.created", payload: await repository.addEvent("REMOTE_COMMAND", "Kapı hattı kalibrasyonu istendi") });
    return reply.code(202).send({ commandId: command.commandId, result: "published" });
  });

  // Garage lamp relay. Like calibration it is not stored in the commands table;
  // the controller acks and reports LIGHT_ON/LIGHT_OFF events and lightOn state.
  app.post("/api/garage/light", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ on: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Body must be { on: boolean }" });
    const status = await repository.getGarageStatus();
    if (!status.device.online) return reply.code(409).send({ error: "Controller is offline" });
    const command = CommandSchema.parse({ commandId: randomUUID(), action: parsed.data.on ? "LIGHT_ON" : "LIGHT_OFF", timestamp: new Date().toISOString(), deviceId: config.defaultDeviceId });
    try {
      await mqtt.publishCommand(config.defaultDeviceId, command);
    } catch {
      return reply.code(503).send({ error: "Controller link unavailable" });
    }
    return reply.code(202).send({ commandId: command.commandId, result: "published" });
  });

  const actorId = (request: FastifyRequest): string => {
    const user = request.user as { sub?: string } | undefined;
    return user?.sub ?? "unknown";
  };

  app.get("/api/camera/status", { preHandler: authenticate }, async () => cameraStatus.get());
  app.get("/api/probe/status", { preHandler: authenticate }, async () => probe);
  app.get("/api/camera/latest", { preHandler: authenticate }, async () => repository.getLatestCamera());
  // The newest live frame (not a saved photo), for the panel to show while live is off.
  app.get("/api/camera/live/last-frame/info", { preHandler: authenticate }, async () => {
    const frame = cameraLive.getLastFrame();
    return frame ? { capturedAt: frame.capturedAt, cameraId: frame.cameraId, bytes: frame.data.length } : null;
  });
  app.get("/api/camera/live/last-frame", { preHandler: authenticate }, async (_request, reply) => {
    const frame = cameraLive.getLastFrame();
    if (!frame) return reply.code(404).send({ error: "No live frame yet" });
    return reply.header("Content-Type", "image/jpeg").header("Cache-Control", "no-store").header("X-Captured-At", frame.capturedAt).send(frame.data);
  });
  app.post("/api/camera/snapshot", { preHandler: authenticate, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (_request, reply) => { await mqtt.publishCameraSnapshot(config.defaultCameraId, "MANUAL"); return reply.code(202).send({ result: "snapshot_requested" }); });

  app.post("/api/camera/live/start", { preHandler: authenticate, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
    const session = cameraLive.create(actorId(request), config.defaultCameraId);
    const command: CameraLiveStartCommand = {
      commandId: randomUUID(), action: "START_LIVE", timestamp: new Date().toISOString(), cameraId: config.defaultCameraId,
      sessionId: session.id, streamToken: session.streamToken, ingestHost: config.cameraIngestHost, ingestPort: config.cameraIngestPort,
      preferredResolution: "320x240", preferredFps: config.cameraMaxFps
    };
    const parsed = CameraLiveStartCommandSchema.safeParse(command);
    if (!parsed.success) { cameraLive.stop(session.id, "explicit"); return reply.code(500).send({ error: "Unable to create camera session" }); }
    try {
      await mqtt.publishCameraLiveStart(parsed.data);
    } catch {
      cameraLive.stop(session.id, "explicit");
      return reply.code(503).send({ error: "Camera control unavailable" });
    }
    const event = await repository.addEvent("CAMERA_LIVE_STARTED", `Camera ${config.defaultCameraId} live session started`);
    bus.publish({ type: "activity.created", payload: event });
    return reply.code(202).send({ sessionId: session.id, cameraId: session.cameraId, expiresAt: new Date(session.expiresAt).toISOString(), ingestHost: config.cameraIngestHost, ingestPort: config.cameraIngestPort, preferredResolution: "320x240", preferredFps: config.cameraMaxFps });
  });

  app.post("/api/camera/live/stop", { preHandler: authenticate, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Valid sessionId required" });
    if (!cameraLive.owns(parsed.data.sessionId, actorId(request))) return reply.code(404).send({ error: "Live session not found" });
    if (!cameraLive.stop(parsed.data.sessionId, "explicit")) return reply.code(404).send({ error: "Live session not found" });
    return reply.code(202).send({ result: "stopping" });
  });

  app.post("/api/camera/live/renew", { preHandler: authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Valid sessionId required" });
    const session = cameraLive.renew(parsed.data.sessionId, actorId(request));
    if (!session) return reply.code(404).send({ error: "Live session not found" });
    return reply.send({ sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.get("/api/camera/live/view", { websocket: true, preValidation: authenticate }, (socket, request) => {
    const query = z.object({ sessionId: z.string().uuid() }).safeParse(request.query);
    if (!query.success) { socket.close(1008, "Valid sessionId required"); return; }
    const viewer: CameraViewer = { readyState: socket.readyState, bufferedAmount: socket.bufferedAmount, send: (frame) => socket.send(frame), close: (code, reason) => socket.close(code, reason) };
    if (!cameraLive.addViewer(query.data.sessionId, viewer)) { socket.close(1008, "Live session not found"); return; }
    socket.on("close", () => cameraLive.removeViewer(query.data.sessionId, viewer));
  });

  app.post("/api/camera/upload", async (request, reply) => {
    const token = request.headers["x-device-token"];
    if (token !== config.cameraUploadToken) return reply.code(401).send({ error: "Invalid device token" });
    if (!Buffer.isBuffer(request.body) || request.body.length < 4 || request.body.length > 5 * 1024 * 1024 || request.body[0] !== 0xff || request.body[1] !== 0xd8 || request.body[request.body.length - 2] !== 0xff || request.body[request.body.length - 1] !== 0xd9) return reply.code(400).send({ error: "Valid JPEG body required and must be <= 5MB" });
    const cameraId = typeof request.headers["x-device-id"] === "string" ? request.headers["x-device-id"] : config.defaultCameraId;
    const rawReason = typeof request.headers["x-camera-reason"] === "string" ? request.headers["x-camera-reason"] : "MOTION";
    const reason = rawReason === "DOOR_OPENED" || rawReason === "DOOR_CLOSED" || rawReason === "MANUAL" ? rawReason : "MOTION";
    const id = randomUUID(); const filename = `${id}.jpg`; const directory = path.resolve(config.cameraDataDir); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, filename), request.body);
    const image = await repository.saveCameraImage({ id, cameraId, capturedAt: new Date().toISOString(), reason, url: `/api/camera/images/${id}` });
    bus.publish({ type: "camera.latest", payload: image });
    bus.publish({ type: "activity.created", payload: await repository.addEvent("MOTION_DETECTED", `Camera ${cameraId} uploaded a ${reason} frame`, id) });
    return reply.code(201).send(image);
  });
  app.get("/api/camera/images/:id", { preHandler: authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "Invalid image id" });
    try {
      const image = await readFile(path.join(path.resolve(config.cameraDataDir), `${id}.jpg`));
      return reply.type("image/jpeg").send(image);
    } catch {
      return reply.code(404).send({ error: "Image not found" });
    }
  });

  app.get("/ws", { websocket: true, preValidation: authenticate }, (socket) => {
    const unsubscribe = bus.subscribe((message) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); });
    void repository.getGarageStatus().then((status) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: "garage.status", payload: status })); });
    // Ping keeps proxies and mobile NATs from dropping an idle socket and
    // drops a dead peer, whose browser then reconnects.
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) { socket.terminate(); return; } alive = false; socket.ping(); }, 25_000);
    socket.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.addHook("onClose", async () => { cameraLive.dispose(); await mqtt.stop(); if ("close" in repository && typeof repository.close === "function") await repository.close(); });
  await publishStatus();
  return app as unknown as GarageApiInstance;
}

/**
 * Builds the isolated camera ingest listener. It has no browser routes or JWT
 * surface; the short-lived stream token and device token are checked per session.
 */
export async function buildCameraIngestApp(cameraLive: CameraLiveManager, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv === "production" });
  await app.register(websocket);
  app.get("/api/camera/live/ingest", { websocket: true }, (socket, request) => {
    const query = z.object({ sessionId: z.string().uuid(), token: z.string().min(32) }).safeParse(request.query);
    const deviceToken = request.headers["x-camera-device-token"];
    if (!query.success || typeof deviceToken !== "string" || !cameraLive.connectIngest(query.data.sessionId, query.data.token, deviceToken)) {
      socket.close(1008, "Unauthorized camera ingest");
      return;
    }
    socket.on("message", (data: unknown) => {
      const frame = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : null;
      if (frame) void cameraLive.ingest(query.data.sessionId, query.data.token, frame);
    });
    socket.on("close", () => cameraLive.disconnectIngest(query.data.sessionId));
  });
  return app;
}
