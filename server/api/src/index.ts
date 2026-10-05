import { buildApp, buildCameraIngestApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresRepository } from "./postgres-repository.js";

const config = loadConfig();
const repository = config.databaseUrl ? new PostgresRepository(config.databaseUrl) : undefined;
const app = await buildApp({ config, ...(repository ? { repository } : {}) });
const cameraLive = app.cameraLive;
const ingestApp = await buildCameraIngestApp(cameraLive, config);

const shutdown = async () => {
  await Promise.allSettled([ingestApp.close(), app.close()]);
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });

await app.listen({ host: config.host, port: config.port });
await ingestApp.listen({ host: config.cameraIngestBindHost, port: config.cameraIngestBindPort });
