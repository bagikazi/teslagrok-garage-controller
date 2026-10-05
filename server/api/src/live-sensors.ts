import type { GarageStatus, SensorSnapshot } from "@garage-control/shared-types";
import type { Repository } from "./repository.js";

/**
 * The database persists only the door state and the two reed switches. Live
 * readings (distances, obstacle state, calibrated baselines) change every few
 * seconds and only matter while the controller is online, so they are kept in
 * memory and merged into every status the API returns or broadcasts.
 */
export function withLiveSensors(repository: Repository): Repository {
  let live: { deviceId: string; sensors: SensorSnapshot } | null = null;
  const merge = (status: GarageStatus): GarageStatus =>
    live && live.deviceId === status.device.deviceId
      ? { ...status, device: { ...status.device, sensors: { ...status.device.sensors, ...live.sensors } } }
      : status;

  const wrapped: Repository & { close?: () => Promise<void> } = {
    getGarageStatus: async () => merge(await repository.getGarageStatus()),
    applyState: async (message) => {
      live = { deviceId: message.deviceId, sensors: message.sensors };
      return merge(await repository.applyState(message));
    },
    applyTelemetry: async (message) => merge(await repository.applyTelemetry(message)),
    markOffline: async (deviceId) => merge(await repository.markOffline(deviceId)),
    findUserByEmail: (email) => repository.findUserByEmail(email),
    findCommand: (commandId) => repository.findCommand(commandId),
    createCommand: (command) => repository.createCommand(command),
    updateCommand: (commandId, patch) => repository.updateCommand(commandId, patch),
    addEvent: (type, detail, imageId) => repository.addEvent(type, detail, imageId),
    listEvents: (limit, type) => repository.listEvents(limit, type),
    getLatestCamera: () => repository.getLatestCamera(),
    saveCameraImage: (input) => repository.saveCameraImage(input)
  };
  const closable = repository as Repository & { close?: () => Promise<void> };
  if (typeof closable.close === "function") wrapped.close = () => closable.close!();
  return wrapped;
}
