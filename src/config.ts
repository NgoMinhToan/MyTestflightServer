import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
}

const DEFAULT_PORT = 8080;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "0.0.0.0";

  const rawPort = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${rawPort}": expected an integer between 1 and 65535`);
  }

  const dataDir = path.resolve(env.DATA_DIR?.trim() || "./data");
  const logLevel = env.LOG_LEVEL?.trim() || "info";

  return { host, port, dataDir, logLevel };
}
