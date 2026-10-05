import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryRepository } from "./repository.js";
import { InMemoryMqttGateway } from "./mqtt.js";
import { loadConfig } from "./config.js";

describe("garage API", () => {
  async function authenticatedApp() {
    const repository = new InMemoryRepository();
    const mqtt = new InMemoryMqttGateway();
    const app = await buildApp({ repository, mqtt });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.com", password: "change-me-now" } });
    return { app, repository, mqtt, headers: { authorization: `Bearer ${login.json().accessToken}` } };
  }

  it("rejects malformed and unknown login credentials", async () => {
    const app = await buildApp({ repository: new InMemoryRepository(), mqtt: new InMemoryMqttGateway() });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "bad", password: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.com", password: "wrong" } })).statusCode).toBe(401);
    // Plain usernames are valid identifiers; an unknown one is a credential failure, not a format error.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "someuser", password: "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh" })).statusCode).toBe(401);
    await app.close();
  });

  it("serves health, status, events and camera metadata to an authenticated client", async () => {
    const { app, headers } = await authenticatedApp();
    expect((await app.inject({ method: "GET", url: "/api/system/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/garage/status", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/garage", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/garage/events?limit=bad", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/garage/events?limit=999", headers })).statusCode).toBe(200);
    const cameraStatus = (await app.inject({ method: "GET", url: "/api/camera/status", headers })).json();
    expect(cameraStatus).toMatchObject({ cameraId: "camera-esp32cam-001", garageId: "garage-01", state: "OFFLINE", online: false });
    expect((await app.inject({ method: "GET", url: "/api/camera/latest", headers })).json()).toBeNull();
    await app.close();
  });

  it("tracks authenticated camera state and availability independently of the controller", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const state = await app.inject({ method: "GET", url: "/api/camera/status", headers });
    expect(state.json().state).toBe("OFFLINE");
    await mqtt.inject("camera/camera-esp32cam-001/state", {
      deviceId: "camera-esp32cam-001", garageId: "garage-01", timestamp: new Date().toISOString(), sequence: 1,
      bootId: "camera-boot-1", firmwareVersion: "0.2.0", cameraState: "STANDBY", rssi: -58,
      uptimeSeconds: 12, freeHeap: 100000, lastError: null, sessionId: null
    });
    const online = await app.inject({ method: "GET", url: "/api/camera/status", headers });
    expect(online.json()).toMatchObject({ cameraId: "camera-esp32cam-001", garageId: "garage-01", state: "STANDBY", online: true, rssi: -58 });
    await mqtt.inject("camera/camera-esp32cam-001/availability", { deviceId: "camera-esp32cam-001", garageId: "garage-01", timestamp: new Date().toISOString(), online: false });
    const offline = await app.inject({ method: "GET", url: "/api/camera/status", headers });
    expect(offline.json()).toMatchObject({ state: "OFFLINE", online: false });
    await app.close();
  });

  it("refreshes sessions and rejects invalid refresh tokens", async () => {
    const { app } = await authenticatedApp();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.com", password: "change-me-now" } });
    const cookies = login.headers["set-cookie"];
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: Array.isArray(cookies) ? cookies.join("; ") : cookies } })).statusCode).toBe(200);
    const nonRefresh = await app.jwt.sign({ sub: "user", email: "owner@example.com", role: "owner" });
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: `refreshToken=${nonRefresh}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: "refreshToken=not-a-token" } })).statusCode).toBe(401);
    await app.close();
  });

  it("fans out validated MQTT state, telemetry, ack and offline messages", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const envelope = { deviceId: "controller-s3-001", timestamp: new Date().toISOString(), sequence: 1, bootId: "boot-1", firmwareVersion: "0.1.0" };
    await mqtt.inject("bad-topic", {});
    await mqtt.inject("garage/controller-s3-001/state", "invalid");
    await mqtt.inject("garage/controller-s3-001/state", { ...envelope, state: "CLOSING", sensors: { closed: false, open: false }, requestedAction: "CLOSE" });
    await mqtt.inject("garage/controller-s3-001/state", { ...envelope, state: "OPEN", sensors: { closed: false, open: true }, requestedAction: null });
    await mqtt.inject("garage/controller-s3-001/telemetry", { ...envelope, rssi: -50, uptimeSeconds: 10 });
    await mqtt.inject("garage/controller-s3-001/telemetry", { invalid: true });
    await mqtt.inject("garage/controller-s3-001/availability", { online: true });
    await mqtt.inject("garage/controller-s3-001/availability", { online: false });
    await mqtt.inject("garage/controller-s3-001/ack", { commandId: "33333333-3333-4333-8333-333333333333", accepted: true, result: "ok", currentState: "OPEN" });
    await mqtt.inject("garage/controller-s3-001/ack", { commandId: "33333333-3333-4333-8333-333333333333", accepted: false, result: "rejected", currentState: "OPEN" });
    await mqtt.inject("garage/controller-s3-001/ack", { invalid: true });
    expect((await app.inject({ method: "GET", url: "/api/garage/status", headers })).json().device.online).toBe(false);
    await app.close();
  });

  it("protects uploads and stores a valid JPEG with controlled metadata", async () => {
    const { app, headers } = await authenticatedApp();
    expect((await app.inject({ method: "POST", url: "/api/camera/upload", headers: { "content-type": "image/jpeg" }, payload: Buffer.from([255, 216]) })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/api/camera/upload", headers: { "content-type": "image/jpeg", "x-device-token": "development-camera-token-change-me", "x-device-id": "camera-test", "x-camera-reason": "MANUAL" }, payload: Buffer.from([255, 216, 255, 217]) });
    expect(response.statusCode).toBe(201);
    expect(response.json().reason).toBe("MANUAL");
    const imageId = response.json().id as string;
    expect((await app.inject({ method: "GET", url: `/api/camera/images/${imageId}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/camera/images/not-an-id", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/camera/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/camera/upload", headers: { "content-type": "image/jpeg", "x-device-token": "development-camera-token-change-me" }, payload: Buffer.alloc(0) })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/camera/snapshot", headers })).statusCode).toBe(202);
    await app.close();
  });

  it("creates and stops an authenticated live camera session through MQTT", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const started = await app.inject({ method: "POST", url: "/api/camera/live/start", headers, payload: {} });
    expect(started.statusCode).toBe(202);
    const session = started.json() as { sessionId: string; expiresAt: string };
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(mqtt.published.some((message) => (message.payload as { action?: string }).action === "START_LIVE")).toBe(true);
    const stopped = await app.inject({ method: "POST", url: "/api/camera/live/stop", headers, payload: { sessionId: session.sessionId } });
    expect(stopped.statusCode).toBe(202);
    await Promise.resolve();
    expect(mqtt.published.some((message) => (message.payload as { action?: string }).action === "STOP_LIVE")).toBe(true);
    await app.close();
  });

  it("requires authentication for physical control", async () => {
    const app = await buildApp({ repository: new InMemoryRepository(), mqtt: new InMemoryMqttGateway() });
    const response = await app.inject({ method: "POST", url: "/api/garage/open" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates one idempotent command and publishes it once", async () => {
    const repository = new InMemoryRepository();
    const mqtt = new InMemoryMqttGateway();
    const app = await buildApp({ repository, mqtt });
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "change-me-now" }
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;
    const commandId = "11111111-1111-4111-8111-111111111111";
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: "POST", url: "/api/garage/open", headers, payload: { commandId } });
    const second = await app.inject({ method: "POST", url: "/api/garage/open", headers, payload: { commandId } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(mqtt.published).toHaveLength(1);
    await app.close();
  });

  it("does not pulse for an already-open garage", async () => {
    const repository = new InMemoryRepository();
    repository.setDoorState("OPEN");
    const mqtt = new InMemoryMqttGateway();
    const app = await buildApp({ repository, mqtt });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.com", password: "change-me-now" } });
    const response = await app.inject({
      method: "POST", url: "/api/garage/open", payload: { commandId: "22222222-2222-4222-8222-222222222222" },
      headers: { authorization: `Bearer ${login.json().accessToken}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toBe("already_reached");
    expect(mqtt.published).toHaveLength(0);
    await app.close();
  });

  it("merges live sensor readings into status and replaces unsynced device clocks", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const envelope = { deviceId: "controller-s3-001", timestamp: "1970-01-01T00:00:07Z", sequence: 1, bootId: "boot-1", firmwareVersion: "0.2.0" };
    const sensors = { closed: false, open: true, top: true, bottom: false, obstacleState: "BLOCKED", hcSr04DistanceCm: 61, tofDistanceCm: 58, hcSr04BaselineCm: 150, tofBaselineCm: 148 };
    await mqtt.inject("garage/controller-s3-001/state", { ...envelope, state: "OPEN", sensors });
    const status = (await app.inject({ method: "GET", url: "/api/garage/status", headers })).json();
    expect(status.device.sensors).toMatchObject({ obstacleState: "BLOCKED", hcSr04DistanceCm: 61, tofBaselineCm: 148 });
    expect(Date.parse(status.device.lastSeen)).toBeGreaterThan(Date.parse("2024-01-01T00:00:00Z"));
    await app.close();
  });

  it("logs a door transition once even though state is republished", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const envelope = { deviceId: "controller-s3-001", timestamp: new Date().toISOString(), sequence: 1, bootId: "boot-1", firmwareVersion: "0.2.0" };
    for (let i = 0; i < 3; i++) await mqtt.inject("garage/controller-s3-001/state", { ...envelope, state: "OPEN", sensors: { closed: false, open: true } });
    const events = (await app.inject({ method: "GET", url: "/api/garage/events", headers })).json() as Array<{ type: string }>;
    expect(events.filter((event) => event.type === "DOOR_OPENED")).toHaveLength(1);
    await app.close();
  });

  it("publishes a calibrate command and records controller safety events", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    expect((await app.inject({ method: "POST", url: "/api/garage/calibrate" })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/api/garage/calibrate", headers });
    expect(response.statusCode).toBe(202);
    expect(mqtt.published).toHaveLength(1);
    expect(mqtt.published[0]).toMatchObject({ topic: "garage/controller-s3-001/command", payload: { action: "CALIBRATE", commandId: response.json().commandId } });
    await mqtt.inject("garage/controller-s3-001/event", { deviceId: "controller-s3-001", type: "STOP_AND_REOPEN", detail: "Obstacle while closing" });
    await mqtt.inject("garage/controller-s3-001/event", { deviceId: "someone-else", type: "ERROR", detail: "spoofed" });
    const events = (await app.inject({ method: "GET", url: "/api/garage/events", headers })).json() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toContain("STOP_AND_REOPEN");
    expect(events.map((event) => event.type)).not.toContain("ERROR");
    await app.close();
  });

  it("ignores a retained state replayed long after the controller went offline", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    await mqtt.inject("garage/controller-s3-001/availability", { online: false });
    const dayOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await mqtt.inject("garage/controller-s3-001/state", { deviceId: "controller-s3-001", timestamp: dayOld, sequence: 9, bootId: "boot-1", firmwareVersion: "0.2.1", state: "OPEN", sensors: { closed: false, open: true } });
    expect((await app.inject({ method: "GET", url: "/api/garage/status", headers })).json().device.online).toBe(false);
    await app.close();
  });

  it("keeps the spare Wi-Fi probe apart from the controller", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const before = (await app.inject({ method: "GET", url: "/api/garage/status", headers })).json();
    await mqtt.inject("garage/controller-s3-probe/telemetry", { deviceId: "controller-s3-probe", timestamp: new Date().toISOString(), sequence: 1, bootId: "abc", firmwareVersion: "0.2.2-probe", rssi: -83, uptimeSeconds: 12 });
    await mqtt.inject("garage/controller-s3-probe/event", { deviceId: "controller-s3-probe", type: "WIFI_REPORT", detail: "Açılıştan bağlantıya 9 sn, 0 hata" });
    await mqtt.inject("garage/controller-s3-probe/availability", { online: false });
    expect((await app.inject({ method: "GET", url: "/api/probe/status", headers })).json()).toMatchObject({ deviceId: "controller-s3-probe", online: false, rssi: -83, firmwareVersion: "0.2.2-probe" });
    expect((await app.inject({ method: "GET", url: "/api/garage/status", headers })).json()).toEqual(before);
    const events = (await app.inject({ method: "GET", url: "/api/garage/events", headers })).json() as Array<{ type: string; detail: string }>;
    expect(events.map((event) => event.type)).toEqual(["PROBE_WIFI_REPORT"]);
    expect((await app.inject({ method: "GET", url: "/api/probe/status" })).statusCode).toBe(401);
    await app.close();
  });

  it("filters events by type so the latest Wi-Fi report stays reachable", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    await mqtt.inject("garage/controller-s3-001/event", { deviceId: "controller-s3-001", type: "WIFI_REPORT", detail: "Kopukluk 40 sn, 3 hata" });
    await mqtt.inject("garage/controller-s3-001/event", { deviceId: "controller-s3-001", type: "PIR_MOTION", detail: "Hareket algilandi" });
    const reports = (await app.inject({ method: "GET", url: "/api/garage/events?type=WIFI_REPORT&limit=1", headers })).json() as Array<{ type: string; detail: string }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "WIFI_REPORT", detail: "Kopukluk 40 sn, 3 hata" });
    expect((await app.inject({ method: "GET", url: "/api/garage/events?type=BOGUS", headers })).statusCode).toBe(400);
    await app.close();
  });

  it("refuses calibration while the door is moving", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    const envelope = { deviceId: "controller-s3-001", timestamp: new Date().toISOString(), sequence: 1, bootId: "boot-1", firmwareVersion: "0.2.0" };
    await mqtt.inject("garage/controller-s3-001/state", { ...envelope, state: "CLOSING", sensors: { closed: false, open: false } });
    expect((await app.inject({ method: "POST", url: "/api/garage/calibrate", headers })).statusCode).toBe(409);
    expect(mqtt.published).toHaveLength(0);
    await app.close();
  });

  it("publishes lamp commands and validates the body", async () => {
    const { app, mqtt, headers } = await authenticatedApp();
    expect((await app.inject({ method: "POST", url: "/api/garage/light", payload: { on: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/garage/light", headers, payload: { on: "yes" } })).statusCode).toBe(400);
    const on = await app.inject({ method: "POST", url: "/api/garage/light", headers, payload: { on: true } });
    expect(on.statusCode).toBe(202);
    await app.inject({ method: "POST", url: "/api/garage/light", headers, payload: { on: false } });
    expect(mqtt.published.map((entry) => (entry.payload as { action: string }).action)).toEqual(["LIGHT_ON", "LIGHT_OFF"]);
    await app.close();
  });

  describe("MCP voice-assistant endpoint", () => {
    const mcpToken = "t".repeat(40);
    async function mcpApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
      const repository = new InMemoryRepository();
      const mqtt = new InMemoryMqttGateway();
      const app = await buildApp({ repository, mqtt, config: { ...loadConfig({}), mcpToken, mcpOpenPin: "2468", ...overrides } });
      let nextId = 1;
      const rpc = async (method: string, params: Record<string, unknown> = {}, url = `/api/mcp/${mcpToken}`) =>
        app.inject({ method: "POST", url, payload: { jsonrpc: "2.0", id: nextId++, method, params } });
      const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).json().result;
      return { app, repository, mqtt, rpc, call };
    }

    it("is absent without a token and rejects a wrong one", async () => {
      const disabled = await buildApp({ repository: new InMemoryRepository(), mqtt: new InMemoryMqttGateway() });
      expect((await disabled.inject({ method: "POST", url: `/api/mcp/${mcpToken}`, payload: {} })).statusCode).toBe(404);
      await disabled.close();
      const { app, rpc } = await mcpApp();
      expect((await rpc("tools/list", {}, `/api/mcp/${"x".repeat(40)}`)).statusCode).toBe(401);
      expect((await rpc("tools/list", {}, "/api/mcp")).statusCode).toBe(401);
      const bearer = await app.inject({ method: "POST", url: "/api/mcp", headers: { authorization: `Bearer ${mcpToken}` }, payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
      expect(bearer.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      expect((await app.inject({ method: "GET", url: `/api/mcp/${mcpToken}` })).statusCode).toBe(405);
      await app.close();
    });

    it("initializes, accepts the initialized notification and lists the door tools", async () => {
      const { app, rpc } = await mcpApp();
      const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } })).json();
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "garage-control" } });
      const notification = await app.inject({ method: "POST", url: `/api/mcp/${mcpToken}`, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
      expect(notification.statusCode).toBe(202);
      const tools = (await rpc("tools/list")).json().result.tools as Array<{ name: string; inputSchema: { required: string[] } }>;
      expect(tools.map((tool) => tool.name)).toEqual(["garage_status", "garage_open", "garage_close", "garage_stop"]);
      expect(tools.find((tool) => tool.name === "garage_open")?.inputSchema.required).toEqual(["pin"]);
      expect((await rpc("tools/call", { name: "unknown" })).json().error.code).toBe(-32602);
      expect((await rpc("resources/list")).json().error.code).toBe(-32601);
      await app.close();
    });

    it("reports status and opens only with the right PIN, tagging the log with Grok", async () => {
      const { app, repository, mqtt, call } = await mcpApp();
      expect((await call("garage_status")).content[0].text).toBe("Garaj kapısı kapalı.");
      expect(await call("garage_open")).toMatchObject({ isError: true, content: [{ text: "PIN hatalı, kapı açılmadı." }] });
      expect(await call("garage_open", { pin: "0000" })).toMatchObject({ isError: true });
      expect(mqtt.published).toHaveLength(0);
      const opened = await call("garage_open", { pin: "2 4 6 8" });
      expect(opened.isError).toBeUndefined();
      expect(opened.content[0].text).toBe("Açma komutu gönderildi, kapı açılıyor.");
      expect(mqtt.published.map((entry) => (entry.payload as { action: string }).action)).toEqual(["OPEN"]);
      expect((await repository.listEvents(5)).some((event) => event.detail === "OPEN command sent via Grok")).toBe(true);
      await app.close();
    });

    it("locks opening after five wrong PINs", async () => {
      const { app, mqtt, call } = await mcpApp();
      for (let attempt = 0; attempt < 5; attempt += 1) await call("garage_open", { pin: "1111" });
      const locked = await call("garage_open", { pin: "2468" });
      expect(locked.isError).toBe(true);
      expect(locked.content[0].text).toContain("kilitli");
      expect(mqtt.published).toHaveLength(0);
      await app.close();
    });

    it("closes without a PIN, skips a door already there and refuses when the controller is offline", async () => {
      const { app, repository, mqtt, call } = await mcpApp();
      expect((await call("garage_close")).content[0].text).toBe("Kapı zaten kapalı.");
      repository.setDoorState("OPEN");
      expect((await call("garage_close")).content[0].text).toBe("Kapatma komutu gönderildi, kapı kapanıyor.");
      expect(mqtt.published).toHaveLength(1);
      await repository.markOffline("controller-s3-001");
      expect(await call("garage_stop")).toMatchObject({ isError: true, content: [{ text: "Garaj kontrolcüsü çevrimdışı, komut gönderilemedi." }] });
      expect(mqtt.published).toHaveLength(1);
      await app.close();
    });

    it("opens without a PIN when none is configured", async () => {
      const { app, mqtt, call } = await mcpApp({ mcpOpenPin: undefined });
      expect((await call("garage_open")).isError).toBeUndefined();
      expect(mqtt.published).toHaveLength(1);
      await app.close();
    });
  });
});
