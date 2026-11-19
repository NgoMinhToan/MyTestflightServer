import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

interface Harness {
  dataDir: string;
  appsDir: string;
  app: FastifyInstance;
}

async function createHarness(t: TestContext): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "testflight-"));
  const config: Config = { host: "127.0.0.1", port: 0, dataDir, logLevel: "silent" };
  const app = buildApp(config, { logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, appsDir: path.join(dataDir, "apps"), app };
}

async function writeAppJson(appsDir: string, appId: string, value: unknown): Promise<void> {
  await fs.mkdir(path.join(appsDir, appId), { recursive: true });
  await fs.writeFile(path.join(appsDir, appId, "app.json"), JSON.stringify(value, null, 2));
}

async function writeVersion(
  appsDir: string,
  appId: string,
  dirName: string,
  manifest: Record<string, unknown>,
  apk: Buffer | null = Buffer.from(`apk-${appId}-${dirName}`),
): Promise<string> {
  const versionDir = path.join(appsDir, appId, "versions", dirName);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "version.json"), JSON.stringify(manifest, null, 2));
  if (apk) await fs.writeFile(path.join(versionDir, "app.apk"), apk);
  return versionDir;
}

test("creates the apps directory and serves an empty catalog", async (t) => {
  const harness = await createHarness(t);
  await fs.rm(harness.appsDir, { recursive: true, force: true });

  const response = await harness.app.inject("/api/v1/apps");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { apps: [] });
  assert.ok((await fs.stat(harness.appsDir)).isDirectory());
});

test("normalizes a bare app directory", async (t) => {
  const harness = await createHarness(t);
  await fs.mkdir(path.join(harness.appsDir, "blank_app"), { recursive: true });

  const body = (await harness.app.inject("/api/v1/apps")).json() as {
    apps: Array<Record<string, unknown>>;
  };

  assert.equal(body.apps.length, 1);
  const app = body.apps[0]!;
  assert.equal(app.id, "blank_app");
  assert.equal(app.name, "Blank App");
  assert.equal(app.packageName, "blank_app");
  assert.equal(app.versionCount, 0);
  assert.equal(app.latestVersion, null);
  assert.equal(app.iconPath, null);

  const created = JSON.parse(
    await fs.readFile(path.join(harness.appsDir, "blank_app", "app.json"), "utf8"),
  );
  assert.equal(created.name, "Blank App");
  assert.equal(created.schemaVersion, 1);
  assert.ok(
    (await fs.stat(path.join(harness.appsDir, "blank_app", "versions"))).isDirectory(),
  );
});

test("selects the newest version and lists versions newest first", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", {
    name: "Demo App",
    packageName: "com.demo",
    icon: "app_icon.png",
  });
  const older = Buffer.from("older-apk");
  const newer = Buffer.from("newer-apk-bytes");
  await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    { versionCode: 2, versionName: "1.0.0" },
    older,
  );
  await writeVersion(
    harness.appsDir,
    "demo",
    "2.0.0",
    { versionCode: 10, versionName: "2.0.0", sha256: "A".repeat(64) },
    newer,
  );

  const list = (await harness.app.inject("/api/v1/apps")).json() as any;
  const latest = list.apps[0].latestVersion;
  assert.equal(latest.versionCode, 10);
  assert.equal(latest.versionName, "2.0.0");
  assert.equal(latest.sizeBytes, newer.byteLength);
  assert.equal(latest.downloadPath, "/api/v1/apps/demo/versions/2.0.0/download");
  assert.equal(latest.sha256, "a".repeat(64));
  assert.equal(latest.minSdk, null);
  assert.equal(latest.releaseNotes, null);

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  assert.equal(detail.app.versionCount, 2);
  assert.deepEqual(
    detail.app.versions.map((version: any) => version.versionName),
    ["2.0.0", "1.0.0"],
  );
});

test("skips versions without a versionCode or APK but keeps the app", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "partial", { name: "Partial" });
  await writeVersion(harness.appsDir, "partial", "bad-code", { versionName: "bad-code" }, null);
  await writeVersion(harness.appsDir, "partial", "no-apk", { versionCode: 3 }, null);

  const body = (await harness.app.inject("/api/v1/apps")).json() as any;

  assert.equal(body.apps.length, 1);
  assert.equal(body.apps[0].id, "partial");
  assert.equal(body.apps[0].versionCount, 0);
  assert.equal(body.apps[0].latestVersion, null);
});

test("an invalid app.json does not hide a sibling app", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "good", { name: "Good App" });
  await fs.mkdir(path.join(harness.appsDir, "broken"), { recursive: true });
  await fs.writeFile(path.join(harness.appsDir, "broken", "app.json"), "{not json");

  const body = (await harness.app.inject("/api/v1/apps")).json() as any;

  assert.deepEqual(
    body.apps.map((app: any) => app.id),
    ["good"],
  );
});

test("serves icons and reports missing ones", async (t) => {
  const harness = await createHarness(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await writeAppJson(harness.appsDir, "with_icon", { name: "With Icon", icon: "icon.png" });
  await fs.writeFile(path.join(harness.appsDir, "with_icon", "icon.png"), png);
  await writeAppJson(harness.appsDir, "without_icon", { name: "Without Icon" });

  const list = (await harness.app.inject("/api/v1/apps")).json() as any;
  const withIcon = list.apps.find((app: any) => app.id === "with_icon");
  const withoutIcon = list.apps.find((app: any) => app.id === "without_icon");
  assert.equal(withIcon.iconPath, "/api/v1/apps/with_icon/icon");
  assert.equal(withoutIcon.iconPath, null);

  const icon = await harness.app.inject("/api/v1/apps/with_icon/icon");
  assert.equal(icon.statusCode, 200);
  assert.equal(icon.headers["content-type"], "image/png");
  assert.deepEqual(icon.rawPayload, png);

  const missing = await harness.app.inject("/api/v1/apps/without_icon/icon");
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as any).error.code, "icon_not_found");
});

test("downloads an APK with the required headers", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const apk = Buffer.from("apk-bytes-12345");
  await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0", sha256: "b".repeat(64) },
    apk,
  );

  const response = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="demo-1.0.0.apk"',
  );
  assert.equal(response.headers["content-length"], String(apk.byteLength));
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-checksum-sha256"], "b".repeat(64));
  assert.deepEqual(response.rawPayload, apk);

  const unknownVersion = await harness.app.inject("/api/v1/apps/demo/versions/9.9.9/download");
  assert.equal(unknownVersion.statusCode, 404);
  assert.equal((unknownVersion.json() as any).error.code, "version_not_found");
});

test("rejects invalid app and version identifiers", async (t) => {
  const harness = await createHarness(t);
  const longId = "a".repeat(65);
  const urls = [
    "/api/v1/apps/%2E%2E%2Fetc",
    `/api/v1/apps/${longId}`,
    "/api/v1/apps/bad%20id",
  ];

  for (const url of urls) {
    const response = await harness.app.inject(url);
    assert.equal(response.statusCode, 400, url);
    assert.equal((response.json() as any).error.code, "invalid_request", url);
  }
});

test("health reports ok with no-store caching", async (t) => {
  const harness = await createHarness(t);

  const response = await harness.app.inject("/api/v1/health");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["cache-control"], "no-store");
});

test("rejects manifest paths that escape the version directory or are symlinks", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "escape", { name: "Escape" });
  const outside = path.join(harness.dataDir, "outside.apk");
  await fs.writeFile(outside, Buffer.from("outside"));

  await writeVersion(
    harness.appsDir,
    "escape",
    "traversal",
    { versionCode: 1, versionName: "traversal", file: "../../outside.apk" },
    null,
  );
  await writeVersion(
    harness.appsDir,
    "escape",
    "absolute",
    { versionCode: 2, versionName: "absolute", file: outside },
    null,
  );
  const symlinked = await writeVersion(
    harness.appsDir,
    "escape",
    "symlink",
    { versionCode: 3, versionName: "symlink" },
    null,
  );
  await fs.symlink(outside, path.join(symlinked, "app.apk"));

  const body = (await harness.app.inject("/api/v1/apps")).json() as any;

  assert.equal(body.apps[0].versionCount, 0);
  assert.equal(body.apps[0].latestVersion, null);
});

test("normalizes sha256 and only emits the checksum header for valid digests", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "checks", { name: "Checks" });
  const digest = "ABCDEF0123456789".repeat(4);
  await writeVersion(
    harness.appsDir,
    "checks",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0", sha256: digest },
    Buffer.from("one"),
  );
  await writeVersion(
    harness.appsDir,
    "checks",
    "2.0.0",
    { versionCode: 2, versionName: "2.0.0", sha256: "abc123" },
    Buffer.from("two"),
  );

  const detail = (await harness.app.inject("/api/v1/apps/checks")).json() as any;
  const byName = new Map<string, any>(
    detail.app.versions.map((version: any) => [version.versionName, version]),
  );
  assert.equal(byName.get("1.0.0")!.sha256, digest.toLowerCase());
  assert.equal(byName.get("2.0.0")!.sha256, null);

  const valid = await harness.app.inject("/api/v1/apps/checks/versions/1.0.0/download");
  assert.equal(valid.headers["x-checksum-sha256"], digest.toLowerCase());
  const invalid = await harness.app.inject("/api/v1/apps/checks/versions/2.0.0/download");
  assert.equal(invalid.headers["x-checksum-sha256"], undefined);
});

test("falls back to the APK mtime for an invalid publishedAt", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "dated", { name: "Dated" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "dated",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0", publishedAt: "not-a-date" },
    Buffer.from("dated-apk"),
  );
  await writeVersion(
    harness.appsDir,
    "dated",
    "2.0.0",
    {
      versionCode: 2,
      versionName: "2.0.0",
      publishedAt: "2026-11-19T08:00:00.000Z",
    },
    Buffer.from("dated-apk-2"),
  );
  const mtime = (await fs.stat(path.join(versionDir, "app.apk"))).mtime;

  const detail = (await harness.app.inject("/api/v1/apps/dated")).json() as any;
  const byName = new Map<string, any>(
    detail.app.versions.map((version: any) => [version.versionName, version]),
  );
  assert.equal(byName.get("1.0.0")!.publishedAt, mtime.toISOString());
  assert.equal(byName.get("2.0.0")!.publishedAt, "2026-11-19T08:00:00.000Z");
});

test("orders versions numerically when versionCodes tie", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "ordered", { name: "Ordered" });
  await writeVersion(
    harness.appsDir,
    "ordered",
    "1.9",
    { versionCode: 5, versionName: "1.9" },
    Buffer.from("a"),
  );
  await writeVersion(
    harness.appsDir,
    "ordered",
    "1.10",
    { versionCode: 5, versionName: "1.10" },
    Buffer.from("b"),
  );

  const detail = (await harness.app.inject("/api/v1/apps/ordered")).json() as any;

  assert.equal(detail.app.latestVersion.versionName, "1.10");
  assert.deepEqual(
    detail.app.versions.map((version: any) => version.versionName),
    ["1.10", "1.9"],
  );
});

test("never overwrites an existing app.json and tolerates a read-only app directory", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "kept", {
    name: "Custom Name",
    packageName: "com.custom",
  });
  await harness.app.inject("/api/v1/apps");
  const kept = JSON.parse(
    await fs.readFile(path.join(harness.appsDir, "kept", "app.json"), "utf8"),
  );
  assert.equal(kept.name, "Custom Name");
  assert.equal(kept.packageName, "com.custom");

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root; permission bits are not enforced");
    return;
  }

  const readOnlyDir = path.join(harness.appsDir, "readonly_app");
  await fs.mkdir(readOnlyDir, { recursive: true });
  await fs.chmod(readOnlyDir, 0o555);
  t.after(async () => {
    await fs.chmod(readOnlyDir, 0o755).catch(() => undefined);
  });

  const body = (await harness.app.inject("/api/v1/apps")).json() as any;
  const readOnly = body.apps.find((app: any) => app.id === "readonly_app");
  assert.ok(readOnly, "read-only app is still listed");
  assert.equal(readOnly.name, "Readonly App");
  assert.equal(readOnly.versionCount, 0);
  assert.equal(readOnly.latestVersion, null);
});

test("returns app_not_found for unknown apps and invalid_request for malformed versions", async (t) => {
  const harness = await createHarness(t);

  const detail = await harness.app.inject("/api/v1/apps/missing");
  assert.equal(detail.statusCode, 404);
  assert.equal((detail.json() as any).error.code, "app_not_found");

  const icon = await harness.app.inject("/api/v1/apps/missing/icon");
  assert.equal(icon.statusCode, 404);
  assert.equal((icon.json() as any).error.code, "app_not_found");

  const download = await harness.app.inject("/api/v1/apps/missing/versions/1.0.0/download");
  assert.equal(download.statusCode, 404);
  assert.equal((download.json() as any).error.code, "app_not_found");

  const malformed = await harness.app.inject("/api/v1/apps/missing/versions/bad%20version/download");
  assert.equal(malformed.statusCode, 400);
  assert.equal((malformed.json() as any).error.code, "invalid_request");
});
