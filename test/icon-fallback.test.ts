import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { authedInject, createHarness, importApk } from "./harness";
import { makeRasterApk, pngBytes } from "./apk-fixtures";

const PNG = "image/png";

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function listVersionDir(versionDir: string): Promise<string[]> {
  return (await fs.readdir(versionDir)).sort();
}

test("stores version icons and falls back from app icon to the newest version", async (t) => {
  const harness = await createHarness(t);
  const one = pngBytes("one");
  const two = pngBytes("two");

  const first = await importApk(
    harness.app,
    makeRasterApk({
      packageName: "com.demo",
      versionName: "1.0.0",
      versionCode: 1,
      png: one,
    }),
    { create: "true", appId: "icons", version: "1.0.0" },
  );
  assert.equal(first.statusCode, 201);
  const firstDir = path.join(harness.appsDir, "icons", "versions", "1.0.0");
  const firstFiles = await listVersionDir(firstDir);
  assert.ok(firstFiles.includes("version.json"));
  assert.ok(firstFiles.includes("version_icon.png"));
  assert.ok(firstFiles.some((file) => file.endsWith(".apk")));
  assert.deepEqual(await fs.readFile(path.join(firstDir, "version_icon.png")), one);
  const firstManifest = await readJson(path.join(firstDir, "version.json"));
  assert.equal(firstManifest.icon, "version_icon.png");

  const summary = (await harness.app.inject("/api/v1/apps")).json().apps[0];
  assert.equal(summary.iconPath, "/api/v1/apps/icons/icon");
  const firstIcon = await harness.app.inject("/api/v1/apps/icons/icon");
  assert.equal(firstIcon.statusCode, 200);
  assert.equal(firstIcon.headers["content-type"], PNG);
  assert.deepEqual(firstIcon.rawPayload, one);

  const second = await importApk(
    harness.app,
    makeRasterApk({
      packageName: "com.demo",
      versionName: "2.0.0",
      versionCode: 2,
      png: two,
    }),
    { appId: "icons", version: "2.0.0" },
  );
  assert.equal(second.statusCode, 201);
  const newest = await harness.app.inject("/api/v1/apps/icons/icon");
  assert.deepEqual(newest.rawPayload, two, "highest versionCode wins");

  const appPng = pngBytes("app");
  const putApp = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/icons/icon",
    payload: appPng,
    headers: { "content-type": PNG },
  });
  assert.equal(putApp.statusCode, 200);
  assert.deepEqual(putApp.json(), { iconPath: "/api/v1/apps/icons/icon" });
  assert.equal(
    (await readJson(path.join(harness.appsDir, "icons", "app.json"))).icon,
    "app_icon.png",
  );
  assert.deepEqual(
    (await harness.app.inject("/api/v1/apps/icons/icon")).rawPayload,
    appPng,
  );

  const skipPng = pngBytes("skip");
  const skipped = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/icons/icon?if_missing=1",
    payload: skipPng,
    headers: { "content-type": PNG },
  });
  assert.equal(skipped.statusCode, 200);
  assert.deepEqual(skipped.json(), {
    iconPath: "/api/v1/apps/icons/icon",
    skipped: true,
  });
  assert.deepEqual(
    (await harness.app.inject("/api/v1/apps/icons/icon")).rawPayload,
    appPng,
    "if_missing never overwrites",
  );

  const deleted = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/icons/icon",
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(
    (await readJson(path.join(harness.appsDir, "icons", "app.json"))).icon,
    "app_icon.png",
    "DELETE resets the app-level icon to the default name",
  );
  assert.deepEqual(
    (await harness.app.inject("/api/v1/apps/icons/icon")).rawPayload,
    two,
    "GET falls back to the newest version icon",
  );

  const again = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/icons/icon",
  });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error.code, "icon_not_found");
  assert.deepEqual(
    (await harness.app.inject("/api/v1/apps/icons/icon")).rawPayload,
    two,
    "a failed DELETE leaves the fallback untouched",
  );
});

test("if_missing writes when the app has no app-level icon", async (t) => {
  const harness = await createHarness(t);
  const imported = await importApk(
    harness.app,
    makeRasterApk({
      packageName: "com.ifmissing.app",
      versionName: "1.0.0",
      versionCode: 1,
      png: pngBytes("version"),
    }),
    { create: "true", appId: "ifmissing", version: "1.0.0" },
  );
  assert.equal(imported.statusCode, 201);

  const png = pngBytes("written");
  const response = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/ifmissing/icon?if_missing=1",
    payload: png,
    headers: { "content-type": PNG },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { iconPath: "/api/v1/apps/ifmissing/icon" });
  assert.deepEqual(
    (await harness.app.inject("/api/v1/apps/ifmissing/icon")).rawPayload,
    png,
  );
});

test("an adaptive-only APK stores no version icon", async (t) => {
  const harness = await createHarness(t);
  const response = await importApk(
    harness.app,
    makeRasterApk({
      packageName: "com.adaptive.app",
      versionName: "1.0.0",
      versionCode: 1,
      adaptiveOnly: true,
    }),
    { create: "true", appId: "adaptive", version: "1.0.0" },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().detected.icon.kind, "adaptive");

  const versionDir = path.join(harness.appsDir, "adaptive", "versions", "1.0.0");
  const files = await fs.readdir(versionDir);
  assert.equal(files.some((file) => file.startsWith("version_icon.")), false);
  const manifest = await readJson(path.join(versionDir, "version.json"));
  assert.equal(manifest.icon, undefined);

  const icon = await harness.app.inject("/api/v1/apps/adaptive/icon");
  assert.equal(icon.statusCode, 404);
  assert.equal(icon.json().error.code, "icon_not_found");
});

test("an oversized raster icon never fails the upload", async (t) => {
  const harness = await createHarness(t, { maxApkBytes: 8 * 1024 * 1024 });
  const tooBig = Buffer.concat([pngBytes("big"), Buffer.alloc(2 * 1024 * 1024 + 1)]);
  const response = await importApk(
    harness.app,
    makeRasterApk({
      packageName: "com.big.icon",
      versionName: "1.0.0",
      versionCode: 1,
      png: tooBig,
    }),
    { create: "true", appId: "bigicon", version: "1.0.0" },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().detected.icon.kind, "raster");

  const versionDir = path.join(harness.appsDir, "bigicon", "versions", "1.0.0");
  const files = await fs.readdir(versionDir);
  assert.equal(files.some((file) => file.startsWith("version_icon.")), false);
  assert.equal(
    (await harness.app.inject("/api/v1/apps/bigicon/icon")).statusCode,
    404,
  );
});
