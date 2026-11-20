import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

export interface Harness {
  dataDir: string;
  appsDir: string;
  app: FastifyInstance;
}

export async function createHarness(
  t: TestContext,
  overrides: Partial<Config> = {},
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
  const app = buildApp(config, { logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, appsDir: path.join(dataDir, "apps"), app };
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
