import { describe, expect, it } from "vitest";
import { deriveDoorState, actionNeedsPulse, nextMotionState } from "./door.js";

describe("garage door state machine", () => {
  it("derives closed and open from the two sensors", () => {
    expect(deriveDoorState({ closed: true, open: false }, "UNKNOWN", null)).toBe("CLOSED");
    expect(deriveDoorState({ closed: false, open: true }, "UNKNOWN", null)).toBe("OPEN");
  });

  it("reports an impossible dual-active sensor reading as an error", () => {
    expect(deriveDoorState({ closed: true, open: true }, "CLOSED", null)).toBe("ERROR");
  });

  it("uses the last requested action while neither end sensor is active", () => {
    expect(deriveDoorState({ closed: false, open: false }, "CLOSED", "OPEN")).toBe("OPENING");
    expect(deriveDoorState({ closed: false, open: false }, "OPEN", "CLOSE")).toBe("CLOSING");
    expect(deriveDoorState({ closed: false, open: false }, "STOPPED", null)).toBe("STOPPED");
  });

  it("never pulses when the desired endpoint is already reached", () => {
    expect(actionNeedsPulse("OPEN", "OPEN")).toBe(false);
    expect(actionNeedsPulse("CLOSE", "CLOSED")).toBe(false);
    expect(actionNeedsPulse("STOP", "OPENING")).toBe(true);
    expect(actionNeedsPulse("STOP", "CLOSED")).toBe(true);
    expect(actionNeedsPulse("STOP", "STOPPED")).toBe(true);
    expect(actionNeedsPulse("OPEN", "CLOSED")).toBe(true);
  });

  it("transitions to movement after a command pulse", () => {
    expect(nextMotionState("CLOSED", "OPEN")).toBe("OPENING");
    expect(nextMotionState("OPEN", "CLOSE")).toBe("CLOSING");
    expect(nextMotionState("UNKNOWN", "STOP")).toBe("STOPPED");
    expect(nextMotionState("CLOSED", "STOP")).toBe("CLOSED");
  });
});
