import mqtt from "mqtt";
import { randomUUID } from "node:crypto";
import type { DoorAction, DoorState, GarageCommand, SensorSnapshot } from "@garage-control/shared-types";

const brokerUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const deviceId = process.env.DEVICE_ID ?? "controller-s3-001";
const firmwareVersion = "mock-0.1.0";
const client = mqtt.connect(brokerUrl, { clientId: `mock-${deviceId}-${process.pid}`, ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME } : {}), ...(process.env.MQTT_PASSWORD ? { password: process.env.MQTT_PASSWORD } : {}) });
let state: DoorState = "CLOSED";
let sequence = 0;
let requestedAction: DoorAction | null = null;
const bootId = randomUUID();
const processed = new Set<string>();

function sensors(): SensorSnapshot { return { closed: state === "CLOSED", open: state === "OPEN" }; }
function publish(kind: "state" | "telemetry" | "availability" | "event", payload: Record<string, unknown>): void { client.publish(`garage/${deviceId}/${kind}`, JSON.stringify({ deviceId, timestamp: new Date().toISOString(), sequence: sequence++, bootId, firmwareVersion, ...payload }), { qos: 1 }); }
function stateMessage(): void { publish("state", { state, sensors: sensors(), requestedAction }); }
function complete(action: DoorAction): void { state = action === "OPEN" ? "OPENING" : action === "CLOSE" ? "CLOSING" : "STOPPED"; requestedAction = action; stateMessage(); if (action !== "STOP") setTimeout(() => { state = action === "OPEN" ? "OPEN" : "CLOSED"; requestedAction = null; stateMessage(); publish("event", { eventType: state === "OPEN" ? "DOOR_OPENED" : "DOOR_CLOSED" }); }, 2200); }

client.on("connect", () => {
  client.subscribe(`garage/${deviceId}/command`, { qos: 1 });
  publish("availability", { online: true });
  stateMessage();
  setInterval(() => publish("telemetry", { rssi: -48, uptimeSeconds: Math.floor(process.uptime()) }), 25000);
  console.log(`Mock device ${deviceId} connected to ${brokerUrl}`);
});
client.on("message", (topic, raw) => {
  if (!topic.endsWith("/command")) return;
  try {
    const command = JSON.parse(raw.toString()) as GarageCommand;
    if (processed.has(command.commandId)) return;
    processed.add(command.commandId);
    // CALIBRATE and the light actions do not move the door in the mock.
    if (command.action === "OPEN" || command.action === "CLOSE" || command.action === "STOP") complete(command.action);
    client.publish(`garage/${deviceId}/ack`, JSON.stringify({ ...command, accepted: true, result: "pulse_triggered", currentState: state }), { qos: 1 });
  } catch (error) { console.error("Invalid command", error); }
});
client.on("error", (error) => console.error("Mock MQTT error", error.message));
process.on("SIGINT", () => { publish("availability", { online: false }); client.end(false, {}, () => process.exit(0)); });
