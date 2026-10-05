import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("camera ingest network configuration", () => {
  it("keeps the public camera endpoint separate from the internal listener", () => {
    const config = loadConfig({
      CAMERA_INGEST_HOST: "garage.example.com",
      CAMERA_INGEST_PORT: "443",
      CAMERA_INGEST_BIND_HOST: "127.0.0.1",
      CAMERA_INGEST_BIND_PORT: "20000"
    });

    expect(config.cameraIngestHost).toBe("garage.example.com");
    expect(config.cameraIngestPort).toBe(443);
    expect(config.cameraIngestBindHost).toBe("127.0.0.1");
    expect(config.cameraIngestBindPort).toBe(20000);
  });

  it("defaults the internal listener to a private service port", () => {
    const config = loadConfig({ CAMERA_INGEST_PORT: "443" });

    expect(config.cameraIngestBindHost).toBe("127.0.0.1");
    expect(config.cameraIngestBindPort).toBe(20000);
  });
});
