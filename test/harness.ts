import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";
import { MANAGEMENT_KEY_HEADER } from "../src/management-config";

export const TEST_MANAGEMENT_KEY = "test-management-key";

export interface HarnessOptions {
  /** null = do not pre-write config.json; let onReady generate it. */
  managementKey?: string | null;
}

export interface Harness {
  dataDir: string;
  appsDir: string;
  app: FastifyInstance;
  configPath: string;
  managementKey: string | null;
}

export function authHeaders(
  extra: Record<string, string> = {},
  key: string = TEST_MANAGEMENT_KEY,
): Record<string, string> {
  return { [MANAGEMENT_KEY_HEADER]: key, ...extra };
}

export function authedInject(
  app: FastifyInstance,
  options: {
    method: string;
    url: string;
    payload?: string | Buffer;
    headers?: Record<string, string>;
  },
  key: string = TEST_MANAGEMENT_KEY,
) {
  return app.inject({
    ...options,
    headers: authHeaders(options.headers, key),
  });
}

export async function createHarness(
  t: TestContext,
  overrides: Partial<Config> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "testflight-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "silent",
    maxApkBytes: 1024 * 1024,
    ...overrides,
  };
  const configPath = path.join(config.dataDir, "config.json");
  let managementKey =
    options.managementKey === undefined ? TEST_MANAGEMENT_KEY : options.managementKey;

  if (managementKey !== null) {
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ management_key: managementKey }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  const app = buildApp(config, { logger: false });
  await app.ready();

  if (managementKey === null) {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      management_key?: unknown;
    };
    managementKey = typeof raw.management_key === "string" ? raw.management_key : null;
  }

  t.after(async () => {
    await app.close();
    await fs.rm(config.dataDir, { recursive: true, force: true });
  });
  return {
    dataDir: config.dataDir,
    appsDir: path.join(config.dataDir, "apps"),
    app,
    configPath,
    managementKey,
  };
}

export async function writeAppJson(
  appsDir: string,
  appId: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.join(appsDir, appId), { recursive: true });
  await fs.writeFile(path.join(appsDir, appId, "app.json"), JSON.stringify(value, null, 2));
}

export async function writeVersion(
  appsDir: string,
  appId: string,
  dirName: string,
  manifest: Record<string, unknown>,
  apk: Buffer | null = Buffer.from(`apk-${appId}-${dirName}`),
  apkFilename = "app.apk",
): Promise<string> {
  const versionDir = path.join(appsDir, appId, "versions", dirName);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "version.json"), JSON.stringify(manifest, null, 2));
  if (apk) await fs.writeFile(path.join(versionDir, apkFilename), apk);
  return versionDir;
}

export async function writeApk(
  versionDir: string,
  filename: string,
  bytes: Buffer,
): Promise<void> {
  await fs.writeFile(path.join(versionDir, filename), bytes);
}
