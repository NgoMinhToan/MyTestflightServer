import { buildApp } from "./app";
import { readConfig } from "./config";

async function main(): Promise<void> {
  const config = readConfig();
  const app = buildApp(config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, "failed to shut down cleanly");
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { host: config.host, port: config.port, dataDir: config.dataDir },
      "testflight server listening",
    );
  } catch (error) {
    app.log.error({ err: error }, "failed to start the server");
    process.exit(1);
  }
}

void main();
