import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { TEST_MANAGEMENT_KEY, authedInject, createHarness } from "./harness";
import { makeApk } from "./apk-fixtures";

const APK = "application/vnd.android.package-archive";
const PNG = "image/png";

function createApp(
  app: FastifyInstance,
  id: string,
  key: string = TEST_MANAGEMENT_KEY,
) {
  return authedInject(
    app,
    {
      method: "POST",
      url: "/api/v1/apps",
      payload: JSON.stringify({ id }),
      headers: { "content-type": "application/json" },
    },
    key,
  );
}

function createVersion(
  app: FastifyInstance,
  appId: string,
  versionName = "1.0.0",
  key: string = TEST_MANAGEMENT_KEY,
) {
  return authedInject(
    app,
    {
      method: "POST",
      url: `/api/v1/apps/${appId}/versions`,
      payload: JSON.stringify({ versionName, versionCode: 1 }),
      headers: { "content-type": "application/json" },
    },
    key,
  );
}

function uploadApk(
  app: FastifyInstance,
  appId: string,
  versionName: string,
  abi: string,
  bytes: Buffer,
  key: string = TEST_MANAGEMENT_KEY,
) {
  return authedInject(
    app,
    {
      method: "PUT",
      url: `/api/v1/apps/${appId}/versions/${versionName}/artifacts/${abi}`,
      payload: bytes,
      headers: { "content-type": APK },
    },
    key,
  );
}

test("reads stay public without a management key", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await createApp(harness.app, "demo")).statusCode, 201);
  assert.equal((await createVersion(harness.app, "demo")).statusCode, 201);
  assert.equal(
    (
      await uploadApk(
        harness.app,
        "demo",
        "1.0.0",
        "arm64-v8a",
        makeApk({ abis: ["arm64-v8a"] }),
      )
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await authedInject(harness.app, {
        method: "PUT",
        url: "/api/v1/apps/demo/icon",
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        headers: { "content-type": PNG },
      })
    ).statusCode,
    200,
  );

  const urls = [
    "/api/v1/health",
    "/api/v1/apps",
    "/api/v1/apps/demo",
    "/api/v1/apps/demo/icon",
    "/api/v1/apps/demo/versions/1.0.0/download",
    "/api/v1/apps/demo/versions",
    "/api/v1/apps/demo/versions/1.0.0",
  ];
  for (const url of urls) {
    const response = await harness.app.inject(url);
    assert.equal(response.statusCode, 200, url);
  }
});

test("requires a valid management key for writes", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await createApp(harness.app, "demo")).statusCode, 201);
  assert.equal((await createVersion(harness.app, "demo")).statusCode, 201);

  const createBody = {
    method: "POST",
    url: "/api/v1/apps",
    payload: JSON.stringify({ id: "second" }),
    headers: { "content-type": "application/json" },
  };

  const missing = await harness.app.inject(createBody);
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error.code, "invalid_management_key");
  assert.equal(missing.headers.connection, "close");

  const wrong = await authedInject(harness.app, createBody, "wrong-key");
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, "invalid_management_key");

  assert.equal((await authedInject(harness.app, createBody)).statusCode, 201);

  const upload = {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: makeApk({ abis: ["arm64-v8a"] }),
    headers: { "content-type": APK },
  };
  assert.equal((await harness.app.inject(upload)).statusCode, 401);
  assert.equal((await authedInject(harness.app, upload, "wrong-key")).statusCode, 401);
  assert.equal((await authedInject(harness.app, upload)).statusCode, 201);

  const importBody = {
    method: "POST",
    url: "/api/v1/import?create=true&appId=keyapp&version=1.0.0",
    payload: makeApk({ abis: ["arm64-v8a"] }),
    headers: { "content-type": APK },
  };
  assert.equal((await harness.app.inject(importBody)).statusCode, 401);
  assert.equal((await authedInject(harness.app, importBody, "wrong-key")).statusCode, 401);
  assert.equal((await authedInject(harness.app, importBody)).statusCode, 201);

  const icon = {
    method: "PUT",
    url: "/api/v1/apps/demo/icon",
    payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    headers: { "content-type": PNG },
  };
  assert.equal((await harness.app.inject(icon)).statusCode, 401);
  assert.equal((await authedInject(harness.app, icon)).statusCode, 200);
});

test("checks the management key before parsing the body", async (t) => {
  const harness = await createHarness(t);

  const malformed = await authedInject(
    harness.app,
    {
      method: "POST",
      url: "/api/v1/apps",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    },
    "wrong-key",
  );
  assert.equal(malformed.statusCode, 401);
  assert.equal(malformed.json().error.code, "invalid_management_key");

  const wrongType = await authedInject(
    harness.app,
    {
      method: "PUT",
      url: "/api/v1/apps/demo/icon",
      payload: Buffer.from("x"),
      headers: { "content-type": "text/plain" },
    },
    "wrong-key",
  );
  assert.equal(wrongType.statusCode, 401);

  const oversized = await authedInject(
    harness.app,
    {
      method: "PUT",
      url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
      payload: Buffer.alloc(2 * 1024 * 1024, 1),
      headers: { "content-type": APK },
    },
    "wrong-key",
  );
  assert.equal(oversized.statusCode, 401);
});

test("applies management key changes without a restart", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await createApp(harness.app, "first")).statusCode, 201);

  await fs.writeFile(
    harness.configPath,
    `${JSON.stringify({ management_key: "rotated-key" }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const oldKey = await createApp(harness.app, "second", TEST_MANAGEMENT_KEY);
  assert.equal(oldKey.statusCode, 401);
  assert.equal(oldKey.json().error.code, "invalid_management_key");

  assert.equal((await createApp(harness.app, "second", "rotated-key")).statusCode, 201);
});

test("fails closed when config.json is missing", async (t) => {
  const harness = await createHarness(t);
  await fs.rm(harness.configPath);

  const write = await createApp(harness.app, "demo");
  assert.equal(write.statusCode, 503);
  assert.equal(write.json().error.code, "management_key_not_configured");

  assert.equal((await harness.app.inject("/api/v1/apps")).statusCode, 200);
});

test("fails closed for blank, non-string, invalid, or symlinked config", async (t) => {
  const harness = await createHarness(t);

  for (const value of [
    { management_key: "   " },
    { management_key: 123 },
    { other: "field" },
  ]) {
    await fs.writeFile(harness.configPath, `${JSON.stringify(value)}\n`);
    const response = await createApp(harness.app, "demo");
    assert.equal(response.statusCode, 503, JSON.stringify(value));
    assert.equal(response.json().error.code, "management_key_not_configured");
  }

  await fs.writeFile(harness.configPath, "{not json\n");
  assert.equal((await createApp(harness.app, "demo")).statusCode, 503);

  if (process.platform !== "win32") {
    await fs.rm(harness.configPath, { force: true });
    const target = path.join(harness.dataDir, "secret.json");
    await fs.writeFile(target, `${JSON.stringify({ management_key: "linked" })}\n`);
    await fs.symlink(target, harness.configPath);
    assert.equal((await createApp(harness.app, "demo")).statusCode, 503);
  }
});

test("creates config.json on startup with a usable generated key", async (t) => {
  const harness = await createHarness(t, {}, { managementKey: null });
  const raw = JSON.parse(await fs.readFile(harness.configPath, "utf8")) as {
    management_key: string;
  };
  assert.match(raw.management_key, /^[0-9a-f]{64}$/);
  assert.equal(harness.managementKey, raw.management_key);

  if (
    process.platform !== "win32" &&
    (typeof process.getuid !== "function" || process.getuid() !== 0)
  ) {
    const stat = await fs.stat(harness.configPath);
    assert.equal(stat.mode & 0o777, 0o600);
  }

  assert.equal(
    (await createApp(harness.app, "demo", raw.management_key)).statusCode,
    201,
  );
});

test("does not overwrite an existing config.json", async (t) => {
  const harness = await createHarness(t);
  const raw = JSON.parse(await fs.readFile(harness.configPath, "utf8")) as {
    management_key: string;
  };
  assert.equal(raw.management_key, TEST_MANAGEMENT_KEY);
});
