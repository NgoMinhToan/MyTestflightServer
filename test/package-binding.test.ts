import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { AppsWriter } from "../src/apps-writer";
import type { AppsService } from "../src/apps-service";
import type { Config } from "../src/config";
import { HttpError } from "../src/http-errors";
import {
  authedInject,
  importApk as importApkRequest,
  createHarness,
  uploadApk,
} from "./harness";
import { makeRasterApk } from "./apk-fixtures";

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function injectJson(
  app: Parameters<typeof authedInject>[0],
  method: "POST" | "PUT",
  url: string,
  payload: unknown,
) {
  return authedInject(app, {
    method,
    url,
    payload: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

test("binds the APK package on the first upload and then verifies strictly", async (t) => {
  const harness = await createHarness(t);
  assert.equal(
    (await injectJson(harness.app, "POST", "/api/v1/apps", { id: "bindme" })).statusCode,
    201,
  );
  assert.equal(
    (
      await injectJson(harness.app, "POST", "/api/v1/apps/bindme/versions", {
        versionName: "1.0.0",
        versionCode: 1,
      })
    ).statusCode,
    201,
  );
  const before = await readJson(path.join(harness.appsDir, "bindme", "app.json"));
  assert.equal(before.packageName, "bindme", "placeholder starts as the app id");

  const apk = makeRasterApk({
    packageName: "com.acme.bindme",
    versionName: "1.0.0",
    versionCode: 1,
    abis: ["arm64-v8a"],
  });
  const upload = await uploadApk(harness.app, "bindme", "1.0.0", "arm64-v8a", apk);
  assert.equal(upload.statusCode, 201);
  assert.equal(upload.json().detected.packageName, "com.acme.bindme");

  const app = await readJson(path.join(harness.appsDir, "bindme", "app.json"));
  assert.equal(app.packageName, "com.acme.bindme");
  const version = await readJson(
    path.join(harness.appsDir, "bindme", "versions", "1.0.0", "version.json"),
  );
  assert.equal(version.detectedPackageName, "com.acme.bindme");

  const other = makeRasterApk({
    packageName: "com.other.app",
    versionName: "1.0.0",
    versionCode: 1,
    abis: ["x86_64"],
  });
  const rejected = await uploadApk(harness.app, "bindme", "1.0.0", "x86_64", other);
  assert.equal(rejected.statusCode, 422);
  assert.match(rejected.json().error.message, /com\.other\.app/);

  const allowed = await uploadApk(harness.app, "bindme", "1.0.0", "x86_64", other, {
    query: { allow_mismatch: "package" },
  });
  assert.equal(allowed.statusCode, 201);
  const after = await readJson(path.join(harness.appsDir, "bindme", "app.json"));
  assert.equal(after.packageName, "com.acme.bindme", "allow_mismatch never rebinds");
});

test("import derives appId/name/version and binds the package", async (t) => {
  const harness = await createHarness(t);
  const apk = makeRasterApk({
    packageName: "com.bound.label",
    label: "Bound Label",
    versionName: "2.0.0 (beta)+4",
    versionCode: 4,
    versionNameFromResource: true,
  });

  const response = await importApkRequest(harness.app, apk, { create: "true" });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.app.id, "com.bound.label");
  assert.equal(body.app.name, "Bound Label");
  assert.equal(body.app.packageName, "com.bound.label");
  assert.equal(body.version.versionName, "2.0.0 (beta)+4");
  assert.equal(body.detected.versionNameSource, "resource");
  assert.equal(body.detected.label, "Bound Label");
});

test("enforces package uniqueness on create and on first bind", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "uniq-a" });
  await injectJson(harness.app, "POST", "/api/v1/apps/uniq-a/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });
  const first = await uploadApk(
    harness.app,
    "uniq-a",
    "1.0.0",
    "arm64-v8a",
    makeRasterApk({
      packageName: "com.dup.app",
      versionName: "1.0.0",
      versionCode: 1,
      abis: ["arm64-v8a"],
    }),
  );
  assert.equal(first.statusCode, 201);

  const duplicateCreate = await injectJson(harness.app, "POST", "/api/v1/apps", {
    id: "uniq-b",
    packageName: "com.dup.app",
  });
  assert.equal(duplicateCreate.statusCode, 409);
  assert.equal(duplicateCreate.json().error.code, "package_in_use");

  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "uniq-c" });
  await injectJson(harness.app, "POST", "/api/v1/apps/uniq-c/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });
  const duplicateBind = await uploadApk(
    harness.app,
    "uniq-c",
    "1.0.0",
    "arm64-v8a",
    makeRasterApk({
      packageName: "com.dup.app",
      versionName: "1.0.0",
      versionCode: 1,
      abis: ["arm64-v8a"],
    }),
  );
  assert.equal(duplicateBind.statusCode, 409);
  assert.equal(duplicateBind.json().error.code, "package_in_use");
});

test("locks the package once a version has an artifact", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "locked" });
  await injectJson(harness.app, "POST", "/api/v1/apps/locked/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const beforeUpload = await injectJson(harness.app, "PUT", "/api/v1/apps/locked", {
    packageName: "com.locked.app",
  });
  assert.equal(beforeUpload.statusCode, 200, "package may change while the version is a draft");
  assert.equal(beforeUpload.json().app.packageName, "com.locked.app");

  await injectJson(harness.app, "POST", "/api/v1/apps/locked/versions", {
    versionName: "2.0.0",
    versionCode: 2,
  });
  const upload = await uploadApk(
    harness.app,
    "locked",
    "2.0.0",
    "arm64-v8a",
    makeRasterApk({
      packageName: "com.locked.app",
      versionName: "2.0.0",
      versionCode: 2,
      abis: ["arm64-v8a"],
    }),
  );
  assert.equal(upload.statusCode, 201);

  const locked = await injectJson(harness.app, "PUT", "/api/v1/apps/locked", {
    packageName: "com.locked.new",
  });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().error.code, "package_locked");
});

test("rejects an update that collides with another app package", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", {
    id: "upd-a",
    packageName: "com.shared.pkg",
  });
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "upd-b" });

  const collision = await injectJson(harness.app, "PUT", "/api/v1/apps/upd-b", {
    packageName: "com.shared.pkg",
  });
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error.code, "package_in_use");
});

test("import refuses to mutate a concurrently created app with another package", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "package-race-"));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dataDir, "apps", "race"), { recursive: true });

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "silent",
    maxApkBytes: 1024 * 1024,
    corsOrigins: [],
  };
  const logger = {
    warn() {},
    debug() {},
    info() {},
    error() {},
  } as unknown as FastifyBaseLogger;

  let appReads = 0;
  const racedApp = {
    id: "race",
    name: "Race",
    packageName: "com.other.app",
    description: "",
    developer: "",
    iconPath: null,
    iconContentType: null,
    versions: [],
  };
  const reader = {
    getApp: async () => {
      appReads += 1;
      return appReads === 1 ? null : racedApp;
    },
    getVersionEntry: async () => null,
    listApps: async () => [],
    listVersionsAdmin: async () => [],
  } as unknown as AppsService;

  const writer = new AppsWriter(config, logger, reader);
  const apk = makeRasterApk({
    packageName: "com.race.app",
    versionName: "1.0.0",
    versionCode: 1,
  });

  await assert.rejects(
    writer.importApk(Readable.from(apk), apk.length, {
      create: true,
      appId: "race",
      version: "1.0.0",
      allowMismatch: [],
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "package_in_use",
  );
  assert.equal(appReads, 2);
});

test("checks uniqueness even when the APK package equals the app id", async (t) => {
  const harness = await createHarness(t);
  // App A is a placeholder whose id happens to be the package name.
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "com.acme" });
  await injectJson(harness.app, "POST", "/api/v1/apps/com.acme/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });
  // App B already owns the real package "com.acme".
  const owner = await injectJson(harness.app, "POST", "/api/v1/apps", {
    id: "owner",
    packageName: "com.acme",
  });
  assert.equal(owner.statusCode, 201);

  const upload = await uploadApk(
    harness.app,
    "com.acme",
    "1.0.0",
    "arm64-v8a",
    makeRasterApk({
      packageName: "com.acme",
      versionName: "1.0.0",
      versionCode: 1,
      abis: ["arm64-v8a"],
    }),
  );
  assert.equal(upload.statusCode, 409);
  assert.equal(upload.json().error.code, "package_in_use");
});
