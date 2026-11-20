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
  apkFilename = "app.apk",
): Promise<string> {
  const versionDir = path.join(appsDir, appId, "versions", dirName);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "version.json"), JSON.stringify(manifest, null, 2));
  if (apk) await fs.writeFile(path.join(versionDir, apkFilename), apk);
  return versionDir;
}

async function writeApk(versionDir: string, filename: string, bytes: Buffer): Promise<void> {
  await fs.writeFile(path.join(versionDir, filename), bytes);
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

test("exposes declared artifacts and points legacy fields at the universal APK", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const universal = Buffer.from("universal-bytes");
  const arm64 = Buffer.from("arm64-bytes-xxxx");
  const armv7 = Buffer.from("armv7-bytes");
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk", sha256: "a".repeat(64) },
        { abi: "universal", file: "app-universal.apk", sha256: "c".repeat(64) },
        { abi: "armeabi-v7a", file: "app-armeabi-v7a.apk" },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-arm64-v8a.apk", arm64);
  await writeApk(versionDir, "app-universal.apk", universal);
  await writeApk(versionDir, "app-armeabi-v7a.apk", armv7);

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  const version = detail.app.latestVersion;
  assert.deepEqual(version.abis, ["universal", "arm64-v8a", "armeabi-v7a"]);
  assert.equal(version.universal, true);
  assert.equal(version.artifacts.length, 3);
  assert.equal(version.sizeBytes, universal.byteLength);
  assert.equal(version.sha256, "c".repeat(64));
  assert.equal(version.downloadPath, "/api/v1/apps/demo/versions/1.0.0/download");

  const byAbi = new Map<string, any>(
    version.artifacts.map((artifact: any) => [artifact.abi, artifact]),
  );
  assert.equal(byAbi.get("arm64-v8a").sizeBytes, arm64.byteLength);
  assert.equal(byAbi.get("arm64-v8a").sha256, "a".repeat(64));
  assert.equal(
    byAbi.get("arm64-v8a").downloadPath,
    "/api/v1/apps/demo/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(byAbi.get("armeabi-v7a").sha256, null);

  const download = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="demo-1.0.0.apk"');
  assert.deepEqual(download.rawPayload, universal);
});

test("defaults to the highest-priority ABI when no universal APK exists", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const arm64 = Buffer.from("arm64-bytes");
  const armv7 = Buffer.from("armv7-bytes");
  const x86 = Buffer.from("x86_64-bytes");
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        { abi: "armeabi-v7a", file: "app-armeabi-v7a.apk" },
        { abi: "x86_64", file: "app-x86_64.apk" },
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk", sha256: "d".repeat(64) },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-armeabi-v7a.apk", armv7);
  await writeApk(versionDir, "app-x86_64.apk", x86);
  await writeApk(versionDir, "app-arm64-v8a.apk", arm64);

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  const version = detail.app.latestVersion;
  assert.deepEqual(version.abis, ["arm64-v8a", "armeabi-v7a", "x86_64"]);
  assert.equal(version.universal, false);
  assert.equal(version.sizeBytes, arm64.byteLength);
  assert.equal(version.sha256, "d".repeat(64));

  const download = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="demo-1.0.0.apk"');
  assert.deepEqual(download.rawPayload, arm64);
});

test("downloads a requested ABI with an ABI-suffixed filename", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const universal = Buffer.from("universal");
  const arm64 = Buffer.from("arm64-payload");
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        { abi: "universal", file: "app-universal.apk" },
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk", sha256: "e".repeat(64) },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-universal.apk", universal);
  await writeApk(versionDir, "app-arm64-v8a.apk", arm64);

  const response = await harness.app.inject(
    "/api/v1/apps/demo/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, arm64);
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="demo-1.0.0-arm64-v8a.apk"',
  );
  assert.equal(response.headers["content-length"], String(arm64.byteLength));
  assert.equal(response.headers["x-checksum-sha256"], "e".repeat(64));
});

test("normalizes ABI labels and matches the abi query case-insensitively", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const arm64 = Buffer.from("arm64-payload");
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [{ abi: "ARM64-V8A", file: "app-arm64-v8a.apk" }],
    },
    null,
  );
  await writeApk(versionDir, "app-arm64-v8a.apk", arm64);

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  assert.deepEqual(detail.app.latestVersion.abis, ["arm64-v8a"]);

  const response = await harness.app.inject(
    "/api/v1/apps/demo/versions/1.0.0/download?abi=ARM64-V8A",
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, arm64);
});

test("requires an exact abi match instead of falling back to universal", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "split", { name: "Split" });
  const splitDir = await writeVersion(
    harness.appsDir,
    "split",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        { abi: "universal", file: "app-universal.apk" },
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk" },
      ],
    },
    null,
  );
  await writeApk(splitDir, "app-universal.apk", Buffer.from("universal"));
  await writeApk(splitDir, "app-arm64-v8a.apk", Buffer.from("arm64"));

  const missingSplit = await harness.app.inject(
    "/api/v1/apps/split/versions/1.0.0/download?abi=x86_64",
  );
  assert.equal(missingSplit.statusCode, 404);
  assert.equal((missingSplit.json() as any).error.code, "abi_not_found");

  await writeAppJson(harness.appsDir, "universal_only", { name: "Universal" });
  const universalDir = await writeVersion(
    harness.appsDir,
    "universal_only",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0", file: "app.apk" },
    null,
  );
  await writeApk(universalDir, "app.apk", Buffer.from("only-universal"));

  const missingUniversal = await harness.app.inject(
    "/api/v1/apps/universal_only/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(missingUniversal.statusCode, 404);
  assert.equal((missingUniversal.json() as any).error.code, "abi_not_found");

  const explicitUniversal = await harness.app.inject(
    "/api/v1/apps/universal_only/versions/1.0.0/download?abi=universal",
  );
  assert.equal(explicitUniversal.statusCode, 200);
  assert.equal(
    explicitUniversal.headers["content-disposition"],
    'attachment; filename="universal_only-1.0.0.apk"',
  );
});

test("rejects malformed abi queries and treats a blank abi as absent", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const universal = Buffer.from("universal-bytes");
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        { abi: "universal", file: "app-universal.apk" },
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk" },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-universal.apk", universal);
  await writeApk(versionDir, "app-arm64-v8a.apk", Buffer.from("arm64"));

  const urls = [
    "/api/v1/apps/demo/versions/1.0.0/download?abi=armv7",
    "/api/v1/apps/demo/versions/1.0.0/download?abi=arm64-v8a&abi=x86_64",
  ];
  for (const url of urls) {
    const response = await harness.app.inject(url);
    assert.equal(response.statusCode, 400, url);
    assert.equal((response.json() as any).error.code, "invalid_request", url);
  }

  const blank = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download?abi=");
  assert.equal(blank.statusCode, 200);
  assert.deepEqual(blank.rawPayload, universal);
});

test("treats a legacy single-APK manifest as a universal artifact", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const apk = Buffer.from("legacy-bytes");
  await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0", file: "app.apk", sha256: "F".repeat(64) },
    apk,
  );

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  const version = detail.app.latestVersion;
  assert.deepEqual(version.abis, ["universal"]);
  assert.equal(version.universal, true);
  assert.equal(version.artifacts.length, 1);
  assert.equal(
    version.artifacts[0].downloadPath,
    "/api/v1/apps/demo/versions/1.0.0/download?abi=universal",
  );
  assert.equal(version.sha256, "f".repeat(64));
  assert.equal(version.sizeBytes, apk.byteLength);

  const download = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="demo-1.0.0.apk"');
  assert.equal(download.headers["x-checksum-sha256"], "f".repeat(64));
  assert.deepEqual(download.rawPayload, apk);
});

test("prefers the artifacts array over the legacy file field", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      file: "ignored.apk",
      artifacts: [{ abi: "arm64-v8a", file: "app-arm64-v8a.apk" }],
    },
    null,
  );
  await writeApk(versionDir, "ignored.apk", Buffer.from("ignored"));
  await writeApk(versionDir, "app-arm64-v8a.apk", Buffer.from("chosen"));

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  assert.deepEqual(detail.app.latestVersion.abis, ["arm64-v8a"]);
  assert.equal(detail.app.latestVersion.artifacts.length, 1);

  const download = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.deepEqual(download.rawPayload, Buffer.from("chosen"));
});

test("skips invalid artifact entries and keeps the valid ones", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "escape", { name: "Escape" });
  const outside = path.join(harness.dataDir, "outside.apk");
  await fs.writeFile(outside, Buffer.from("outside"));

  const versionDir = await writeVersion(
    harness.appsDir,
    "escape",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      artifacts: [
        "not-an-object",
        { abi: "armv7", file: "app.apk" },
        { abi: "x86", file: "   " },
        { abi: "x86_64", file: "../../outside.apk" },
        { abi: "riscv64", file: outside },
        { abi: "armeabi", file: "notes.txt" },
        { abi: "armeabi-v7a", file: "linked.apk" },
        { abi: "universal", file: "app.apk" },
        { abi: "universal", file: "other.apk" },
      ],
    },
    null,
  );
  const valid = Buffer.from("valid-universal");
  await writeApk(versionDir, "app.apk", valid);
  await writeApk(versionDir, "other.apk", Buffer.from("other"));
  await writeApk(versionDir, "notes.txt", Buffer.from("notes"));
  await fs.symlink(outside, path.join(versionDir, "linked.apk"));

  const detail = (await harness.app.inject("/api/v1/apps/escape")).json() as any;
  assert.deepEqual(detail.app.latestVersion.abis, ["universal"]);
  assert.equal(detail.app.latestVersion.artifacts.length, 1);

  const download = await harness.app.inject("/api/v1/apps/escape/versions/1.0.0/download");
  assert.deepEqual(download.rawPayload, valid);
});

test("skips a version when no artifact is resolvable", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "empty", { name: "Empty" });
  await writeVersion(harness.appsDir, "empty", "bad-abi", {
    versionCode: 1,
    versionName: "bad-abi",
    artifacts: [{ abi: "nope", file: "app.apk" }],
  });
  await writeVersion(harness.appsDir, "empty", "empty-list", {
    versionCode: 2,
    versionName: "empty-list",
    file: "app.apk",
    artifacts: [],
  });

  const detail = (await harness.app.inject("/api/v1/apps/empty")).json() as any;
  assert.equal(detail.app.versionCount, 0);
  assert.equal(detail.app.latestVersion, null);
});

test("skips versions with several APKs and neither artifacts nor file", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "multi", { name: "Multi" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "multi",
    "1.0.0",
    { versionCode: 1, versionName: "1.0.0" },
    null,
  );
  await writeApk(versionDir, "a.apk", Buffer.from("a"));
  await writeApk(versionDir, "b.apk", Buffer.from("b"));

  const detail = (await harness.app.inject("/api/v1/apps/multi")).json() as any;
  assert.equal(detail.app.versionCount, 0);
  assert.equal(detail.app.latestVersion, null);
});

test("uses the default artifact mtime when publishedAt is invalid", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "dated", { name: "Dated" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "dated",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      publishedAt: "not-a-date",
      artifacts: [
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk" },
        { abi: "armeabi-v7a", file: "app-armeabi-v7a.apk" },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-arm64-v8a.apk", Buffer.from("arm64"));
  await writeApk(versionDir, "app-armeabi-v7a.apk", Buffer.from("armv7"));
  await fs.utimes(
    path.join(versionDir, "app-arm64-v8a.apk"),
    new Date("2020-01-01T00:00:00.000Z"),
    new Date("2020-01-01T00:00:00.000Z"),
  );
  await fs.utimes(
    path.join(versionDir, "app-armeabi-v7a.apk"),
    new Date("2021-01-01T00:00:00.000Z"),
    new Date("2021-01-01T00:00:00.000Z"),
  );

  const detail = (await harness.app.inject("/api/v1/apps/dated")).json() as any;
  const expected = (await fs.stat(path.join(versionDir, "app-arm64-v8a.apk"))).mtime.toISOString();
  assert.equal(detail.app.latestVersion.publishedAt, expected);
});

test("uses per-artifact digests and ignores the version-level sha256", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "checks", { name: "Checks" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "checks",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      sha256: "B".repeat(64),
      artifacts: [
        { abi: "arm64-v8a", file: "app-arm64-v8a.apk", sha256: "A".repeat(64) },
        { abi: "universal", file: "app-universal.apk", sha256: "abc123" },
      ],
    },
    null,
  );
  await writeApk(versionDir, "app-arm64-v8a.apk", Buffer.from("arm64"));
  await writeApk(versionDir, "app-universal.apk", Buffer.from("universal"));

  const detail = (await harness.app.inject("/api/v1/apps/checks")).json() as any;
  const byAbi = new Map<string, any>(
    detail.app.latestVersion.artifacts.map((artifact: any) => [artifact.abi, artifact]),
  );
  assert.equal(byAbi.get("arm64-v8a").sha256, "a".repeat(64));
  assert.equal(byAbi.get("universal").sha256, null);
  assert.equal(detail.app.latestVersion.sha256, null);

  const arm64 = await harness.app.inject(
    "/api/v1/apps/checks/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(arm64.headers["x-checksum-sha256"], "a".repeat(64));
  const universal = await harness.app.inject(
    "/api/v1/apps/checks/versions/1.0.0/download?abi=universal",
  );
  assert.equal(universal.headers["x-checksum-sha256"], undefined);
});

test("reports app and version not-found before abi availability", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  await writeVersion(harness.appsDir, "demo", "1.0.0", {
    versionCode: 1,
    versionName: "1.0.0",
  });

  const unknownApp = await harness.app.inject(
    "/api/v1/apps/missing/versions/1.0.0/download?abi=x86_64",
  );
  assert.equal(unknownApp.statusCode, 404);
  assert.equal((unknownApp.json() as any).error.code, "app_not_found");

  const unknownVersion = await harness.app.inject(
    "/api/v1/apps/demo/versions/9.9.9/download?abi=x86_64",
  );
  assert.equal(unknownVersion.statusCode, 404);
  assert.equal((unknownVersion.json() as any).error.code, "version_not_found");
});

test("falls back to the legacy file when artifacts is not an array", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      file: "app.apk",
      artifacts: { abi: "arm64-v8a", file: "app.apk" },
    },
    null,
  );
  await writeApk(versionDir, "app.apk", Buffer.from("legacy"));

  const detail = (await harness.app.inject("/api/v1/apps/demo")).json() as any;
  assert.deepEqual(detail.app.latestVersion.abis, ["universal"]);
  assert.equal(detail.app.latestVersion.universal, true);

  const download = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0/download");
  assert.deepEqual(download.rawPayload, Buffer.from("legacy"));
});
