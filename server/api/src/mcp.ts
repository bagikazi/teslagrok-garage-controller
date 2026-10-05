import { timingSafeEqual } from "node:crypto";
import type { DoorAction, DoorState, GarageStatus } from "@garage-control/shared-types";

/**
 * Minimal MCP (Model Context Protocol) server over Streamable HTTP, stateless and
 * JSON-only (no SSE stream). It lets a voice assistant such as Grok in the car read
 * the door state and send door commands. Opening can require a spoken PIN, and
 * repeated wrong PINs lock opening for a while.
 */

export type DoorActionOutcome = { statusCode: number; result: string | null };
export type McpDeps = {
  openPin?: string | undefined;
  getStatus: () => Promise<GarageStatus>;
  runDoorAction: (action: DoorAction) => Promise<DoorActionOutcome>;
  now?: () => number;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MS = 15 * 60_000;

const STATE_TEXT: Record<DoorState, string> = {
  CLOSED: "kapalı", OPEN: "açık", OPENING: "açılıyor", CLOSING: "kapanıyor", STOPPED: "yarı yolda durdu",
  UNKNOWN: "bilinmiyor", OFFLINE: "çevrimdışı", ERROR: "hata durumunda"
};
const ACTION_TEXT: Record<DoorAction, { sent: string; reached: string }> = {
  OPEN: { sent: "Açma komutu gönderildi, kapı açılıyor.", reached: "Kapı zaten açık." },
  CLOSE: { sent: "Kapatma komutu gönderildi, kapı kapanıyor.", reached: "Kapı zaten kapalı." },
  STOP: { sent: "Durdurma komutu gönderildi.", reached: "Kapı zaten hareket etmiyor." }
};

/** Constant-time comparison so the token cannot be guessed byte by byte. */
export function secretMatches(candidate: string | undefined, secret: string): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMcpServer(deps: McpDeps) {
  const now = deps.now ?? Date.now;
  let pinFailures = 0;
  let lockedUntil = 0;

  const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

  const tools = [
    {
      name: "garage_status",
      title: "Garaj durumu",
      description: "Returns whether the garage door is open, closed or moving, and whether the controller is online.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
      name: "garage_open",
      title: "Garajı aç",
      description: deps.openPin
        ? "Opens the garage door. Requires the owner's garage PIN: always ask the user to say it for this request; never guess it or reuse one from earlier in the conversation."
        : "Opens the garage door.",
      inputSchema: {
        type: "object",
        properties: deps.openPin ? { pin: { type: "string", description: "Garage PIN spoken by the user, digits only." } } : {},
        required: deps.openPin ? ["pin"] : [],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    {
      name: "garage_close",
      title: "Garajı kapat",
      description: "Closes the garage door. The controller refuses if the doorway sensor reports an obstacle.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
      name: "garage_stop",
      title: "Garajı durdur",
      description: "Stops the garage door while it is moving.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }
  ];

  const checkPin = (args: Record<string, unknown>): string | null => {
    if (!deps.openPin) return null;
    if (now() < lockedUntil) return "Çok fazla hatalı PIN denendi; açma 15 dakika kilitli. Web panelini kullanın.";
    const pin = typeof args.pin === "string" ? args.pin.replace(/\D/g, "") : "";
    if (secretMatches(pin, deps.openPin)) { pinFailures = 0; return null; }
    pinFailures += 1;
    if (pinFailures >= MAX_PIN_FAILURES) { pinFailures = 0; lockedUntil = now() + PIN_LOCKOUT_MS; }
    return "PIN hatalı, kapı açılmadı.";
  };

  const doorCommand = async (action: DoorAction): Promise<ToolResult> => {
    const status = await deps.getStatus();
    if (!status.device.online) return text("Garaj kontrolcüsü çevrimdışı, komut gönderilemedi.", true);
    try {
      const outcome = await deps.runDoorAction(action);
      return text(outcome.result === "already_reached" ? ACTION_TEXT[action].reached : ACTION_TEXT[action].sent);
    } catch {
      return text("Kontrolcü bağlantısı yok, komut gönderilemedi.", true);
    }
  };

  const callTool = async (name: unknown, args: Record<string, unknown>): Promise<ToolResult | null> => {
    switch (name) {
      case "garage_status": {
        const status = await deps.getStatus();
        if (!status.device.online) return text("Garaj kontrolcüsü çevrimdışı; kapı durumu bilinmiyor.");
        return text(`Garaj kapısı ${STATE_TEXT[status.state]}.`);
      }
      case "garage_open": {
        const pinError = checkPin(args);
        return pinError ? text(pinError, true) : doorCommand("OPEN");
      }
      case "garage_close": return doorCommand("CLOSE");
      case "garage_stop": return doorCommand("STOP");
      default: return null;
    }
  };

  const handleOne = async (message: unknown): Promise<object | null> => {
    if (typeof message !== "object" || message === null || (message as JsonRpcRequest).jsonrpc !== "2.0" || typeof (message as JsonRpcRequest).method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const request = message as JsonRpcRequest;
    // Notifications (no id) such as notifications/initialized get no response.
    if (request.id === undefined || request.id === null) return null;
    const ok = (result: object) => ({ jsonrpc: "2.0", id: request.id, result });
    const fail = (code: number, errorMessage: string) => ({ jsonrpc: "2.0", id: request.id, error: { code, message: errorMessage } });
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return ok({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "garage-control", title: "Garaj", version: "0.1.0" },
          instructions: "Controls the owner's home garage door. Check garage_status when unsure. Answer the user in their language."
        });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools });
      case "tools/call": {
        const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments as Record<string, unknown> : {};
        const result = await callTool(params.name, args);
        return result ? ok(result) : fail(-32602, `Unknown tool: ${String(params.name)}`);
      }
      default: return fail(-32601, `Method not found: ${request.method}`);
    }
  };

  /** Handles one JSON-RPC message or a batch; null means "reply 202 with no body". */
  const handle = async (body: unknown): Promise<object | null> => {
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleOne))).filter((response) => response !== null);
      return responses.length > 0 ? responses : null;
    }
    return handleOne(body);
  };

  return { handle };
}
