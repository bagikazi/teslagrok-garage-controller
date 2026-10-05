import { describe, expect, it } from "vitest";
import type { SensorSnapshot } from "@garage-control/shared-types";
import { closeBlocked, dialModel, obstacleOf, offersSecondaryClose } from "./door-ui";

const sensors = (extra: Partial<SensorSnapshot> = {}): SensorSnapshot => ({ closed: true, open: false, hcSr04DistanceCm: 210, tofDistanceCm: 208, ...extra });

describe("obstacleOf", () => {
  it("prefers the reported obstacle state", () => expect(obstacleOf(sensors({ obstacleState: "WARNING" }))).toBe("WARNING"));
  it("treats an obstruction as blocked", () => expect(obstacleOf(sensors({ obstruction: true }))).toBe("BLOCKED"));
  it("treats missing or unhealthy readings as a sensor fault", () => {
    expect(obstacleOf(sensors({ hcSr04DistanceCm: null }))).toBe("SENSOR_FAULT");
    expect(obstacleOf(sensors({ tofHealthy: false }))).toBe("SENSOR_FAULT");
  });
  it("is clear with two healthy readings", () => expect(obstacleOf(sensors())).toBe("CLEAR"));
});

describe("dialModel", () => {
  const base = { online: true, obstacle: "CLEAR" as const, pending: null };

  it("opens a closed door only through a hold", () => expect(dialModel({ ...base, state: "CLOSED" })).toMatchObject({ hold: "open", tone: "safe" }));
  it("closes an open door through a hold", () => expect(dialModel({ ...base, state: "OPEN" })).toMatchObject({ hold: "close" }));
  it("locks closing while the door line is blocked or faulty", () => {
    for (const obstacle of ["BLOCKED", "SENSOR_FAULT"] as const) {
      const model = dialModel({ ...base, obstacle, state: "OPEN" });
      expect(model.locked).toBe(true);
      expect(model.hold).toBeUndefined();
      expect(closeBlocked(obstacle)).toBe(true);
    }
  });
  it("stops a moving door on a single tap", () => {
    expect(dialModel({ ...base, state: "OPENING" })).toMatchObject({ tap: "stop", moving: "up" });
    expect(dialModel({ ...base, state: "CLOSING", obstacle: "BLOCKED" })).toMatchObject({ tap: "stop", moving: "down" });
  });
  it("is disabled while the controller is offline", () => expect(dialModel({ ...base, online: false, state: "CLOSED" })).toMatchObject({ disabled: true }));
  it("shows a pending open or close command", () => expect(dialModel({ ...base, state: "CLOSED", pending: "open" })).toMatchObject({ pending: true, disabled: true }));
  it("keeps STOP usable while a stop command is pending", () => expect(dialModel({ ...base, state: "CLOSING", pending: "stop" })).toMatchObject({ tap: "stop" }));
  it("opens a stopped door and offers closing separately", () => {
    expect(dialModel({ ...base, state: "STOPPED" })).toMatchObject({ hold: "open" });
    expect(offersSecondaryClose("STOPPED", true)).toBe(true);
    expect(offersSecondaryClose("OPEN", true)).toBe(false);
    expect(offersSecondaryClose("STOPPED", false)).toBe(false);
  });
});
