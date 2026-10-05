import type { DoorAction, DoorState, SensorSnapshot } from "@garage-control/shared-types";

export function deriveDoorState(
  sensors: SensorSnapshot,
  previousState: DoorState,
  requestedAction: DoorAction | null
): DoorState {
  if (sensors.closed && sensors.open) return "ERROR";
  if (sensors.closed) return "CLOSED";
  if (sensors.open) return "OPEN";
  if (requestedAction === "OPEN") return "OPENING";
  if (requestedAction === "CLOSE") return "CLOSING";
  return previousState === "OPENING" || previousState === "CLOSING" ? previousState : "STOPPED";
}

export function actionNeedsPulse(action: DoorAction, currentState: DoorState): boolean {
  if (action === "OPEN") return currentState !== "OPEN";
  if (action === "CLOSE") return currentState !== "CLOSED";
  // STOP is the kill switch: always sent, whatever the reported state, since
  // that state can lag or be wrong while the motor is actually running.
  return true;
}

export function nextMotionState(currentState: DoorState, action: DoorAction): DoorState {
  if (action === "OPEN") return currentState === "OPEN" ? "OPEN" : "OPENING";
  if (action === "CLOSE") return currentState === "CLOSED" ? "CLOSED" : "CLOSING";
  return currentState === "OPEN" || currentState === "CLOSED" ? currentState : "STOPPED";
}
