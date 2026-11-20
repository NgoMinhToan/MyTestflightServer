import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
  maxApkBytes: number;
  /**
   * Allowed browser origins for the dashboard. Empty disables CORS entirely.
   * `"*"` allows any origin; otherwise entries are normalized origins such as
   * `https://owner.github.io`.
   */
  corsOrigins: string[];
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
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);

  return { host, port, dataDir, logLevel, maxApkBytes, corsOrigins };
}

function parseCorsOrigins(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry === "*") return "*";
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`Invalid CORS_ORIGINS entry "${entry}": expected an origin`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Invalid CORS_ORIGINS entry "${entry}": expected http(s)`);
      }
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error(
          `Invalid CORS_ORIGINS entry "${entry}": use an origin without a path`,
        );
      }
      return url.origin;
    });
  return [...new Set(origins)];
}
