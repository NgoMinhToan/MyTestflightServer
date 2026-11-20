import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
  maxApkBytes: number;
}

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_APK_BYTES = 512 * 1024 * 1024;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "0.0.0.0";

  const rawPort = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${rawPort}": expected an integer between 1 and 65535`);
  }

  const rawMaxApkBytes = env.MAX_APK_BYTES?.trim() || String(DEFAULT_MAX_APK_BYTES);
  const maxApkBytes = Number(rawMaxApkBytes);
  if (!/^\d+$/.test(rawMaxApkBytes) || !Number.isSafeInteger(maxApkBytes) || maxApkBytes < 1) {
    throw new Error(`Invalid MAX_APK_BYTES "${rawMaxApkBytes}": expected a positive integer`);
  }

  const dataDir = path.resolve(env.DATA_DIR?.trim() || "./data");
  const logLevel = env.LOG_LEVEL?.trim() || "info";

  return { host, port, dataDir, logLevel, maxApkBytes };
}
