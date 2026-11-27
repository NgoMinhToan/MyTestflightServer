import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import {
  authedInject,
  createHarness,
  importApk as importApkRequest,
  uploadApk,
  writeAppJson,
  writeVersion,
} from "./harness";
import {
  makeApk,
  realManifestBytes,
  REAL_MANIFEST_EXPECTED,
} from "./apk-fixtures";

const APK = "application/vnd.android.package-archive";
const OCTET = "application/octet-stream";
const PNG = "image/png";
const JPEG = "image/jpeg";

function injectJson(
  app: FastifyInstance,
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("creates, updates, and deletes an app", async (t) => {
  const harness = await createHarness(t);

  const created = await injectJson(harness.app, "POST", "/api/v1/apps", {
    id: "demo",
    name: "Demo",
    packageName: "com.demo",
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers.location, "/api/v1/apps/demo");
  assert.equal(created.json().app.id, "demo");
  assert.equal(created.json().app.packageBound, true);
  const manifest = await readJson(path.join(harness.appsDir, "demo", "app.json"));
  assert.equal(manifest.name, "Demo");
  assert.equal(manifest.packageBound, true);
  assert.ok((await fs.stat(path.join(harness.appsDir, "demo", "versions"))).isDirectory());

  const updated = await injectJson(harness.app, "PUT", "/api/v1/apps/demo", {
    description: "Updated",
    developer: "Team",
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().app.description, "Updated");
  assert.equal(updated.json().app.name, "Demo");

  const deleted = await authedInject(harness.app, { method: "DELETE", url: "/api/v1/apps/demo" });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await harness.app.inject("/api/v1/apps/demo")).statusCode, 404);
  assert.equal(
    (await authedInject(harness.app, { method: "DELETE", url: "/api/v1/apps/demo" })).statusCode,
    404,
  );
});

test("rejects duplicate apps and invalid app payloads", async (t) => {
  const harness = await createHarness(t);
  assert.equal(
    (await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" })).statusCode,
    201,
  );

  const duplicate = await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "app_exists");

  for (const payload of [{}, { id: "bad id" }, { id: "../x" }, { id: "" }]) {
    const response = await injectJson(harness.app, "POST", "/api/v1/apps", payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "invalid_request");
  }

  const empty = await injectJson(harness.app, "PUT", "/api/v1/apps/demo", {});
  assert.equal(empty.statusCode, 400);
  const nonObject = await authedInject(harness.app, {
    method: "POST",
    url: "/api/v1/apps",
    payload: "[]",
    headers: { "content-type": "application/json" },
  });
  assert.equal(nonObject.statusCode, 400);
});

test("preserves unknown app.json fields and validates icon names", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo", extra: { keep: true } });

  const updated = await injectJson(harness.app, "PUT", "/api/v1/apps/demo", {
    name: "Renamed",
  });
  assert.equal(updated.statusCode, 200);
  const manifest = await readJson(path.join(harness.appsDir, "demo", "app.json"));
  assert.deepEqual(manifest.extra, { keep: true });
  assert.equal(manifest.name, "Renamed");

  assert.equal(
    (await injectJson(harness.app, "PUT", "/api/v1/apps/demo", { icon: "../x.png" }))
      .statusCode,
    400,
  );
  assert.equal(
    (await injectJson(harness.app, "PUT", "/api/v1/apps/demo", { icon: "logo.png" }))
      .statusCode,
    200,
  );
});

test("creates a draft version that the public catalog hides", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });

  const created = await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
    releaseNotes: "First",
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers.location, "/api/v1/apps/demo/versions/1.0.0");
  const version = created.json().version;
  assert.equal(version.draft, true);
  assert.deepEqual(version.artifacts, []);
  assert.equal(version.defaultArtifact, null);
  assert.equal(version.downloadPath, null);

  const adminList = (await harness.app.inject("/api/v1/apps/demo/versions")).json();
  assert.deepEqual(
    adminList.versions.map((entry: any) => entry.versionName),
    ["1.0.0"],
  );
  assert.equal(
    (await harness.app.inject("/api/v1/apps/demo/versions/1.0.0")).json().version.draft,
    true,
  );

  const publicDetail = (await harness.app.inject("/api/v1/apps/demo")).json();
  assert.equal(publicDetail.app.versionCount, 0);
  assert.equal(publicDetail.app.latestVersion, null);

  const duplicate = await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 2,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "version_exists");
});

test("validates version metadata", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });

  const payloads: Array<[Record<string, unknown>, string]> = [
    [{}, "version_name_invalid"],
    [{ versionName: "1.0.0" }, "invalid_request"],
    [{ versionName: "1.0.0", versionCode: 0 }, "invalid_request"],
    [{ versionName: "1.0.0", versionCode: 1.5 }, "invalid_request"],
    [{ versionName: "1.0.0", versionCode: "1" }, "invalid_request"],
    [{ versionName: "bad/name", versionCode: 1 }, "version_name_invalid"],
    [{ versionName: "bad\\name", versionCode: 1 }, "version_name_invalid"],
    [{ versionName: "1.0.0", versionCode: 1, artifacts: [] }, "invalid_request"],
    [{ versionName: "1.0.0", versionCode: 1, file: "app.apk" }, "invalid_request"],
  ];
  for (const [payload, expectedCode] of payloads) {
    const response = await injectJson(
      harness.app,
      "POST",
      "/api/v1/apps/demo/versions",
      payload,
    );
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, expectedCode, JSON.stringify(payload));
  }

  const flexible = await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "0.2.0 (beta)+1",
    versionCode: 2,
  });
  assert.equal(flexible.statusCode, 201);
  assert.equal(flexible.json().version.versionName, "0.2.0 (beta)+1");
});

test("updates version metadata and keeps artifacts", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });
  const upload = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ abis: ["arm64-v8a"] }),
  );
  assert.equal(upload.statusCode, 201);

  const updated = await injectJson(harness.app, "PUT", "/api/v1/apps/demo/versions/1.0.0", {
    versionCode: 2,
    minSdk: 26,
    releaseNotes: "Notes",
    publishedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(updated.statusCode, 200);
  const version = updated.json().version;
  assert.equal(version.versionCode, 2);
  assert.equal(version.minSdk, 26);
  assert.equal(version.publishedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(version.artifacts.length, 1);
  assert.equal(version.artifacts[0].abi, "arm64-v8a");

  assert.equal(
    (
      await injectJson(harness.app, "PUT", "/api/v1/apps/demo/versions/1.0.0", {
        versionName: "2.0.0",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await injectJson(harness.app, "PUT", "/api/v1/apps/demo/versions/1.0.0", {}))
      .statusCode,
    400,
  );
});

test("uploads an APK with a computed sha256 and serves it", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const bytes = makeApk({ abis: ["arm64-v8a"] });
  const response = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    bytes,
  );
  assert.equal(response.statusCode, 201);
  const version = response.json().version;
  assert.equal(version.draft, false);
  assert.equal(version.artifacts.length, 1);
  const artifact = version.artifacts[0];
  assert.equal(artifact.abi, "arm64-v8a");
  assert.equal(artifact.sha256, sha256(bytes));
  assert.equal(artifact.sizeBytes, bytes.byteLength);
  assert.match(artifact.filename, /^arm64-v8a-[0-9a-f]{16}\.apk$/);
  assert.equal(
    artifact.downloadPath,
    "/api/v1/apps/demo/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(version.defaultArtifact.abi, "arm64-v8a");
  assert.equal(version.downloadPath, "/api/v1/apps/demo/versions/1.0.0/download");

  const versionDir = path.join(harness.appsDir, "demo", "versions", "1.0.0");
  const manifest = await readJson(path.join(versionDir, "version.json"));
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].file, artifact.filename);
  assert.equal(manifest.artifacts[0].sha256, sha256(bytes));
  assert.equal(manifest.file, undefined);
  assert.equal(manifest.sha256, undefined);
  assert.deepEqual(await fs.readFile(path.join(versionDir, artifact.filename)), bytes);

  const publicDetail = (await harness.app.inject("/api/v1/apps/demo")).json();
  assert.equal(publicDetail.app.versionCount, 1);
  assert.deepEqual(publicDetail.app.latestVersion.abis, ["arm64-v8a"]);

  const download = await harness.app.inject(
    "/api/v1/apps/demo/versions/1.0.0/download?abi=arm64-v8a",
  );
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers["x-checksum-sha256"], sha256(bytes));
});

test("replaces an ABI upload and keeps the other ABIs", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const first = makeApk({
    abis: ["arm64-v8a"],
    extraEntries: [{ name: "assets/build.txt", data: Buffer.from("v1") }],
  });
  const firstResponse = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    first,
  );
  assert.equal(firstResponse.statusCode, 201);
  const oldFilename = firstResponse.json().version.artifacts[0].filename;

  const second = makeApk({
    abis: ["arm64-v8a"],
    extraEntries: [{ name: "assets/build.txt", data: Buffer.from("v2-longer") }],
  });
  const replaced = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    second,
  );
  assert.equal(replaced.statusCode, 200);
  const newFilename = replaced.json().version.artifacts[0].filename;
  assert.notEqual(newFilename, oldFilename);
  assert.equal(replaced.json().version.artifacts[0].sha256, sha256(second));
  await assert.rejects(
    fs.stat(path.join(harness.appsDir, "demo", "versions", "1.0.0", oldFilename)),
  );

  const x86 = makeApk({ abis: ["x86_64"] });
  const added = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "x86_64",
    x86,
  );
  assert.equal(added.statusCode, 201);
  assert.deepEqual(added.json().version.abis, ["arm64-v8a", "x86_64"]);
  assert.equal(added.json().version.defaultArtifact.abi, "arm64-v8a");

  const download = await harness.app.inject(
    "/api/v1/apps/demo/versions/1.0.0/download?abi=x86_64",
  );
  assert.deepEqual(download.rawPayload, x86);
});

test("rejects invalid uploads", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const unknownAbi = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/armv7",
    payload: Buffer.from("x"),
    headers: { "content-type": APK },
  });
  assert.equal(unknownAbi.statusCode, 400);
  assert.equal(unknownAbi.json().error.code, "invalid_request");

  const wrongType = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.from("x"),
    headers: { "content-type": PNG },
  });
  assert.equal(wrongType.statusCode, 415);
  assert.equal(wrongType.json().error.code, "unsupported_media_type");

  const empty = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.alloc(0),
    headers: { "content-type": APK },
  });
  assert.equal(empty.statusCode, 400);

  const unknownVersion = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/9.9.9/artifacts/arm64-v8a",
    payload: Buffer.from("x"),
    headers: { "content-type": APK },
  });
  assert.equal(unknownVersion.statusCode, 404);
  assert.equal(unknownVersion.json().error.code, "version_not_found");

  const unknownApp = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/missing/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.from("x"),
    headers: { "content-type": APK },
  });
  assert.equal(unknownApp.statusCode, 404);
  assert.equal(unknownApp.json().error.code, "version_not_found");
});

test("enforces MAX_APK_BYTES before inspecting and cleans the temp directory", async (t) => {
  const harness = await createHarness(t, { maxApkBytes: 8192 });
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const tooBig = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.alloc(8193, 1),
    headers: { "content-type": APK },
  });
  assert.equal(tooBig.statusCode, 413);
  assert.equal(tooBig.json().error.code, "payload_too_large");
  const uploads = await fs.readdir(path.join(harness.dataDir, ".uploads")).catch(() => []);
  assert.deepEqual(uploads, []);

  const ok = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ abis: ["arm64-v8a"] }),
  );
  assert.equal(ok.statusCode, 201);
});

test("migrates a legacy file manifest and preserves the universal artifact", async (t) => {
  const harness = await createHarness(t);
  const legacy = Buffer.from("legacy-universal");
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  const versionDir = await writeVersion(
    harness.appsDir,
    "demo",
    "1.0.0",
    {
      versionCode: 1,
      versionName: "1.0.0",
      file: "app.apk",
      sha256: sha256(legacy),
    },
    legacy,
    "app.apk",
  );

  const uploaded = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ abis: ["arm64-v8a"] }),
  );
  assert.equal(uploaded.statusCode, 201);
  const version = uploaded.json().version;
  assert.deepEqual(version.abis, ["universal", "arm64-v8a"]);
  assert.equal(version.universal, true);
  assert.equal(version.defaultArtifact.abi, "universal");
  assert.equal(version.defaultArtifact.sha256, sha256(legacy));

  const manifest = await readJson(path.join(versionDir, "version.json"));
  assert.equal(manifest.file, undefined);
  assert.equal(manifest.sha256, undefined);
  assert.equal(manifest.artifacts.length, 2);
  const universal = manifest.artifacts.find((artifact: any) => artifact.abi === "universal");
  assert.equal(universal.file, "app.apk");
  assert.deepEqual(await fs.readFile(path.join(versionDir, "app.apk")), legacy);
});

test("deletes artifacts and hides the version after the last one", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const arm64 = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ abis: ["arm64-v8a"] }),
  );
  const filename = arm64.json().version.artifacts[0].filename;
  const universal = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "universal",
    makeApk({ abis: [] }),
  );
  assert.equal(universal.statusCode, 201);

  const deleted = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
  });
  assert.equal(deleted.statusCode, 204);
  await assert.rejects(
    fs.stat(path.join(harness.appsDir, "demo", "versions", "1.0.0", filename)),
  );
  const afterFirst = (await harness.app.inject("/api/v1/apps/demo/versions/1.0.0")).json()
    .version;
  assert.deepEqual(afterFirst.abis, ["universal"]);

  const last = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/universal",
  });
  assert.equal(last.statusCode, 204);
  const draft = (await harness.app.inject("/api/v1/apps/demo/versions/1.0.0")).json().version;
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.artifacts, []);
  assert.equal(
    (await harness.app.inject("/api/v1/apps/demo")).json().app.versionCount,
    0,
  );

  const missing = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/universal",
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "artifact_not_found");
});

test("deletes versions and apps recursively", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const deletedVersion = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0",
  });
  assert.equal(deletedVersion.statusCode, 204);
  assert.equal(
    (await harness.app.inject("/api/v1/apps/demo/versions/1.0.0")).statusCode,
    404,
  );

  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "2.0.0",
    versionCode: 2,
  });
  const deletedApp = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo",
  });
  assert.equal(deletedApp.statusCode, 204);
  await assert.rejects(fs.stat(path.join(harness.appsDir, "demo")));
});

test("uploads, replaces, and deletes the icon", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const putPng = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/icon",
    payload: png,
    headers: { "content-type": PNG },
  });
  assert.equal(putPng.statusCode, 200);
  assert.deepEqual(putPng.json(), { iconPath: "/api/v1/apps/demo/icon" });
  assert.equal(
    (await readJson(path.join(harness.appsDir, "demo", "app.json"))).icon,
    "app_icon.png",
  );
  const icon = await harness.app.inject("/api/v1/apps/demo/icon");
  assert.equal(icon.statusCode, 200);
  assert.equal(icon.headers["content-type"], "image/png");
  assert.equal(icon.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(icon.rawPayload, png);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1]);
  const putJpeg = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/icon",
    payload: jpeg,
    headers: { "content-type": JPEG },
  });
  assert.equal(putJpeg.statusCode, 200);
  await assert.rejects(fs.stat(path.join(harness.appsDir, "demo", "app_icon.png")));
  assert.deepEqual(
    await fs.readFile(path.join(harness.appsDir, "demo", "app_icon.jpg")),
    jpeg,
  );

  const wrong = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/icon",
    payload: Buffer.from("x"),
    headers: { "content-type": OCTET },
  });
  assert.equal(wrong.statusCode, 415);

  assert.equal(
    (await authedInject(harness.app, { method: "DELETE", url: "/api/v1/apps/demo/icon" }))
      .statusCode,
    204,
  );
  assert.equal((await harness.app.inject("/api/v1/apps/demo/icon")).statusCode, 404);
  const again = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/icon",
  });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error.code, "icon_not_found");
});

test("rejects oversized icons", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });

  const response = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/icon",
    payload: Buffer.alloc(2 * 1024 * 1024 + 1, 1),
    headers: { "content-type": PNG },
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "payload_too_large");
});

test("maps malformed and oversized JSON bodies", async (t) => {
  const harness = await createHarness(t);

  const malformed = await authedInject(harness.app, {
    method: "POST",
    url: "/api/v1/apps",
    payload: "{not json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "invalid_request");

  const oversized = await authedInject(harness.app, {
    method: "POST",
    url: "/api/v1/apps",
    payload: JSON.stringify({ id: "demo", name: "x".repeat(1024 * 1024) }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "payload_too_large");
});

test("resolves versions by manifest versionName and refuses duplicates", async (t) => {
  const harness = await createHarness(t);
  await writeAppJson(harness.appsDir, "demo", { name: "Demo" });
  await writeVersion(
    harness.appsDir,
    "demo",
    "v1",
    { versionCode: 1, versionName: "1.0.0" },
    Buffer.from("apk"),
  );

  const detail = await harness.app.inject("/api/v1/apps/demo/versions/1.0.0");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().version.versionName, "1.0.0");

  const duplicate = await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 2,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "version_exists");
});

test("rejects traversal identifiers on write routes", async (t) => {
  const harness = await createHarness(t);
  const appUrls = ["/api/v1/apps/%2E%2E%2Fx", "/api/v1/apps/bad%20id"];
  for (const url of appUrls) {
    const response = await authedInject(harness.app, { method: "DELETE", url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, "invalid_request", url);
  }

  const badVersion = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/bad%2Fversion",
  });
  assert.equal(badVersion.statusCode, 400);
  assert.equal(badVersion.json().error.code, "version_name_invalid");

  const spaces = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/bad%20version",
  });
  assert.equal(spaces.statusCode, 404, "spaces are a valid flexible version name");
  assert.equal(spaces.json().error.code, "version_not_found");

  const badAbi = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/armv7",
  });
  assert.equal(badAbi.statusCode, 400);
});

async function uploadsDirIsEmpty(harness: { dataDir: string }): Promise<void> {
  const uploads = await fs.readdir(path.join(harness.dataDir, ".uploads")).catch(() => []);
  assert.deepEqual(uploads, []);
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

test("rejects a non-APK payload with invalid_apk and cleans the temp directory", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const response = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    Buffer.from("not an apk"),
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_apk");
  await uploadsDirIsEmpty(harness);
});

test("enforces packageName and honors allow_mismatch=package", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", {
    id: "pkgapp",
    packageName: "com.real",
  });
  await injectJson(harness.app, "POST", "/api/v1/apps/pkgapp/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const apk = makeApk({ packageName: "com.other", abis: ["arm64-v8a"] });
  const mismatch = await uploadApk(harness.app, "pkgapp", "1.0.0", "arm64-v8a", apk);
  assert.equal(mismatch.statusCode, 422);
  assert.equal(mismatch.json().error.code, "apk_metadata_mismatch");
  assert.match(
    mismatch.json().error.message,
    /packageName 'com\.other' != app 'com\.real'/,
  );
  await uploadsDirIsEmpty(harness);

  const allowed = await uploadApk(harness.app, "pkgapp", "1.0.0", "arm64-v8a", apk, {
    query: { allow_mismatch: "package" },
  });
  assert.equal(allowed.statusCode, 201);
  assert.equal(allowed.json().detected.packageName, "com.other");
});

test("enforces versionCode and versionName, and honors allow_mismatch=version", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const wrongCode = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ versionCode: 2, abis: ["arm64-v8a"] }),
  );
  assert.equal(wrongCode.statusCode, 422);
  assert.match(wrongCode.json().error.message, /versionCode 2 != 1/);

  const wrongName = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ versionName: "2.0.0", abis: ["arm64-v8a"] }),
  );
  assert.equal(wrongName.statusCode, 422);
  assert.match(wrongName.json().error.message, /versionName '2\.0\.0' != '1\.0\.0'/);

  const allowed = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ versionCode: 2, versionName: "2.0.0", abis: ["arm64-v8a"] }),
    { query: { allow_mismatch: "version" } },
  );
  assert.equal(allowed.statusCode, 201);
  assert.equal(allowed.json().version.versionCode, 1);
  assert.equal(allowed.json().detected.versionCode, 2);
  assert.equal(allowed.json().detected.versionName, "2.0.0");
});

test("enforces the route ABI and honors allow_mismatch=abi", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const apk = makeApk({ abis: ["arm64-v8a"] });
  const mismatch = await uploadApk(harness.app, "demo", "1.0.0", "x86_64", apk);
  assert.equal(mismatch.statusCode, 422);
  assert.match(
    mismatch.json().error.message,
    /abi x86_64 != detected arm64-v8a/,
  );

  const allowed = await uploadApk(harness.app, "demo", "1.0.0", "x86_64", apk, {
    query: { allow_mismatch: "abi" },
  });
  assert.equal(allowed.statusCode, 201);
  assert.deepEqual(allowed.json().version.abis, ["x86_64"]);
  assert.equal(allowed.json().detected.artifactAbi, "arm64-v8a");
});

test("infers the ABI on the route without :abi", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const arm64 = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    null,
    makeApk({ abis: ["arm64-v8a"] }),
  );
  assert.equal(arm64.statusCode, 201);
  assert.deepEqual(arm64.json().version.abis, ["arm64-v8a"]);
  assert.equal(arm64.json().detected.artifactAbi, "arm64-v8a");

  const universal = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    null,
    makeApk({ abis: [] }),
  );
  assert.equal(universal.statusCode, 201);
  assert.deepEqual(universal.json().version.abis, ["universal", "arm64-v8a"]);
  assert.equal(universal.json().detected.artifactAbi, "universal");
  assert.equal(universal.json().detected.universal, true);
});

test("rejects configuration splits", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const response = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ split: "config.arm64_v8a", abis: ["arm64-v8a"] }),
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_apk");
  await uploadsDirIsEmpty(harness);
});

test("rejects unknown allow_mismatch values", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const response = await uploadApk(
    harness.app,
    "demo",
    "1.0.0",
    "arm64-v8a",
    makeApk({ abis: ["arm64-v8a"] }),
    { query: { allow_mismatch: "color" } },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("import returns 404 when the app is missing and create is not set", async (t) => {
  const harness = await createHarness(t);
  const response = await importApkRequest(
    harness.app,
    makeApk({ abis: ["arm64-v8a"] }),
    { appId: "missing", version: "1.0.0" },
  );
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "app_not_found");
  assert.deepEqual(await fs.readdir(harness.appsDir).catch(() => []), []);
});

test("import creates an app and version when create=true", async (t) => {
  const harness = await createHarness(t);
  const apk = makeApk({
    packageName: "com.acme.todo",
    versionCode: 7,
    versionName: "1.2.3",
    minSdk: 24,
    abis: ["arm64-v8a"],
  });

  const response = await importApkRequest(harness.app, apk, {
    create: "true",
    appId: "todo",
    version: "1.2.3",
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.createdApp, true);
  assert.equal(body.createdVersion, true);
  assert.equal(body.app.id, "todo");
  assert.equal(body.app.packageName, "com.acme.todo");
  assert.equal(body.version.versionName, "1.2.3");
  assert.equal(body.version.versionCode, 7);
  assert.equal(body.version.minSdk, 24);
  assert.deepEqual(body.version.abis, ["arm64-v8a"]);
  assert.equal(body.detected.packageName, "com.acme.todo");
  assert.equal(body.detected.artifactAbi, "arm64-v8a");
  assert.equal(body.artifact.abi, "arm64-v8a");
  assert.equal(body.artifact.sha256, sha256(apk));

  const manifest = await readJson(path.join(harness.appsDir, "todo", "app.json"));
  assert.equal(manifest.packageName, "com.acme.todo");
  assert.equal(manifest.name, "Todo");
});

test("import infers appId and version from the shared real manifest", async (t) => {
  const harness = await createHarness(t);
  const apk = makeApk({
    manifestBytes: realManifestBytes(),
    abis: ["arm64-v8a"],
  });

  const response = await importApkRequest(harness.app, apk, { create: "true" });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.app.id, REAL_MANIFEST_EXPECTED.packageName);
  assert.equal(body.app.packageName, REAL_MANIFEST_EXPECTED.packageName);
  assert.equal(body.version.versionName, REAL_MANIFEST_EXPECTED.versionName);
  assert.equal(body.version.versionCode, REAL_MANIFEST_EXPECTED.versionCode);
  assert.equal(body.version.minSdk, REAL_MANIFEST_EXPECTED.minSdk);
  assert.equal(body.detected.packageName, REAL_MANIFEST_EXPECTED.packageName);
  assert.equal(body.detected.targetSdk, REAL_MANIFEST_EXPECTED.targetSdk);
  assert.equal(body.detected.artifactAbi, REAL_MANIFEST_EXPECTED.artifactAbi);
});

test("import groups three ABI splits into one version", async (t) => {
  const harness = await createHarness(t);
  const metadata = {
    packageName: "com.split.app",
    versionCode: 3,
    versionName: "3.0.0",
  };

  const first = await importApkRequest(
    harness.app,
    makeApk({ ...metadata, abis: ["arm64-v8a"] }),
    { create: "true", appId: "splitapp", version: "3.0.0" },
  );
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().createdApp, true);
  assert.equal(first.json().createdVersion, true);

  const second = await importApkRequest(
    harness.app,
    makeApk({ ...metadata, abis: ["armeabi-v7a"] }),
    { appId: "splitapp", version: "3.0.0" },
  );
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().createdApp, false);
  assert.equal(second.json().createdVersion, false);

  const third = await importApkRequest(
    harness.app,
    makeApk({ ...metadata, abis: ["x86_64"] }),
    { appId: "splitapp", version: "3.0.0" },
  );
  assert.equal(third.statusCode, 201);
  assert.deepEqual(third.json().version.abis, [
    "arm64-v8a",
    "armeabi-v7a",
    "x86_64",
  ]);

  const versions = (
    await harness.app.inject("/api/v1/apps/splitapp/versions")
  ).json().versions;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].artifacts.length, 3);
});

test("re-importing the same APK returns 200", async (t) => {
  const harness = await createHarness(t);
  const apk = makeApk({ abis: ["arm64-v8a"] });
  const query = { create: "true", appId: "reimport", version: "1.0.0" };

  const first = await importApkRequest(harness.app, apk, query);
  assert.equal(first.statusCode, 201);

  const again = await importApkRequest(harness.app, apk, {
    appId: "reimport",
    version: "1.0.0",
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().createdApp, false);
  assert.equal(again.json().createdVersion, false);
  assert.deepEqual(again.json().version.abis, ["arm64-v8a"]);
});

test("import applies a versionCode query override only with allow_mismatch", async (t) => {
  const harness = await createHarness(t);
  const apk = makeApk({ versionCode: 1, abis: ["arm64-v8a"] });

  const rejected = await importApkRequest(harness.app, apk, {
    create: "true",
    appId: "override",
    version: "1.0.0",
    versionCode: "99",
  });
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.json().error.code, "apk_metadata_mismatch");
  assert.match(rejected.json().error.message, /versionCode 1 != 99/);
  assert.equal(
    await pathExists(path.join(harness.appsDir, "override")),
    false,
    "a 422 must not leave an orphan app",
  );
  await uploadsDirIsEmpty(harness);

  const allowed = await importApkRequest(harness.app, apk, {
    create: "true",
    appId: "override",
    version: "1.0.0",
    versionCode: "99",
    allow_mismatch: "version",
  });
  assert.equal(allowed.statusCode, 201);
  assert.equal(allowed.json().version.versionCode, 99);
  assert.equal(allowed.json().detected.versionCode, 1);
});

test("import falls back to String(versionCode) when versionName is unresolved", async (t) => {
  const harness = await createHarness(t);
  const response = await importApkRequest(
    harness.app,
    makeApk({ versionNameAsReference: true, versionCode: 7, abis: ["arm64-v8a"] }),
    { create: "true", appId: "noversion" },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().version.versionName, "7");
  assert.equal(response.json().detected.versionName, null);
  assert.equal(response.json().detected.versionNameSource, "none");
  assert.equal(response.json().app.packageName, "com.demo");
});

test("import applies releaseNotes and publishedAt to an existing version", async (t) => {
  const harness = await createHarness(t);
  const metadata = {
    packageName: "com.notes.app",
    versionCode: 1,
    versionName: "1.0.0",
  };

  const first = await importApkRequest(
    harness.app,
    makeApk({ ...metadata, abis: ["arm64-v8a"] }),
    { create: "true", appId: "notes", version: "1.0.0" },
  );
  assert.equal(first.statusCode, 201);

  const publishedAt = "2026-02-03T04:05:06.000Z";
  const second = await importApkRequest(
    harness.app,
    makeApk({ ...metadata, abis: ["x86_64"] }),
    {
      appId: "notes",
      version: "1.0.0",
      releaseNotes: "split notes",
      publishedAt,
    },
  );
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().version.releaseNotes, "split notes");
  assert.equal(second.json().version.publishedAt, publishedAt);

  const manifest = await readJson(
    path.join(harness.appsDir, "notes", "versions", "1.0.0", "version.json"),
  );
  assert.equal(manifest.releaseNotes, "split notes");
  assert.equal(manifest.publishedAt, publishedAt);
  assert.equal(manifest.artifacts.length, 2);
});

test("supports flexible version names through encoded routes", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });

  const versionName = "0.2.0 (beta)+1";
  const encoded = encodeURIComponent(versionName);
  const created = await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName,
    versionCode: 2,
  });
  assert.equal(created.statusCode, 201);

  const detail = await harness.app.inject(`/api/v1/apps/demo/versions/${encoded}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().version.versionName, versionName);

  const upload = await uploadApk(
    harness.app,
    "demo",
    encoded,
    "arm64-v8a",
    makeApk({
      packageName: "com.demo",
      versionName,
      versionCode: 2,
      abis: ["arm64-v8a"],
    }),
  );
  assert.equal(upload.statusCode, 201);
  assert.equal(upload.json().version.versionName, versionName);

  const versionDir = path.join(harness.appsDir, "demo", "versions", versionName);
  assert.ok((await fs.stat(versionDir)).isDirectory());

  const catalog = (await harness.app.inject("/api/v1/apps/demo")).json().app;
  assert.equal(catalog.latestVersion.versionName, versionName);
  assert.equal(
    catalog.latestVersion.downloadPath,
    `/api/v1/apps/demo/versions/${versionName}/download`,
  );

  const download = await harness.app.inject(
    `/api/v1/apps/demo/versions/${encoded}/download`,
  );
  assert.equal(download.statusCode, 200);
  assert.ok(download.rawPayload.length > 0);
});
