import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { authedInject, createHarness, writeAppJson, writeVersion } from "./harness";

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
  const manifest = await readJson(path.join(harness.appsDir, "demo", "app.json"));
  assert.equal(manifest.name, "Demo");
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

  const payloads = [
    {},
    { versionName: "1.0.0" },
    { versionName: "1.0.0", versionCode: 0 },
    { versionName: "1.0.0", versionCode: 1.5 },
    { versionName: "1.0.0", versionCode: "1" },
    { versionName: "bad name", versionCode: 1 },
    { versionName: "1.0.0", versionCode: 1, artifacts: [] },
    { versionName: "1.0.0", versionCode: 1, file: "app.apk" },
  ];
  for (const payload of payloads) {
    const response = await injectJson(
      harness.app,
      "POST",
      "/api/v1/apps/demo/versions",
      payload,
    );
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "invalid_request");
  }
});

test("updates version metadata and keeps artifacts", async (t) => {
  const harness = await createHarness(t);
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });
  const upload = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.from("arm64"),
    headers: { "content-type": APK },
  });
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

  const bytes = Buffer.from("apk-payload-arm64");
  const response = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: bytes,
    headers: { "content-type": APK },
  });
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

  const first = Buffer.from("arm64-v1");
  const firstResponse = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: first,
    headers: { "content-type": APK },
  });
  assert.equal(firstResponse.statusCode, 201);
  const oldFilename = firstResponse.json().version.artifacts[0].filename;

  const second = Buffer.from("arm64-v2-longer");
  const replaced = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: second,
    headers: { "content-type": OCTET },
  });
  assert.equal(replaced.statusCode, 200);
  const newFilename = replaced.json().version.artifacts[0].filename;
  assert.notEqual(newFilename, oldFilename);
  assert.equal(replaced.json().version.artifacts[0].sha256, sha256(second));
  await assert.rejects(
    fs.stat(path.join(harness.appsDir, "demo", "versions", "1.0.0", oldFilename)),
  );

  const x86 = Buffer.from("x86-payload");
  const added = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/x86_64",
    payload: x86,
    headers: { "content-type": APK },
  });
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

test("enforces MAX_APK_BYTES and cleans the upload temp directory", async (t) => {
  const harness = await createHarness(t, { maxApkBytes: 8 });
  await injectJson(harness.app, "POST", "/api/v1/apps", { id: "demo" });
  await injectJson(harness.app, "POST", "/api/v1/apps/demo/versions", {
    versionName: "1.0.0",
    versionCode: 1,
  });

  const tooBig = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.alloc(9, 1),
    headers: { "content-type": APK },
  });
  assert.equal(tooBig.statusCode, 413);
  assert.equal(tooBig.json().error.code, "payload_too_large");
  const uploads = await fs.readdir(path.join(harness.dataDir, ".uploads")).catch(() => []);
  assert.deepEqual(uploads, []);

  const ok = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.alloc(8, 1),
    headers: { "content-type": APK },
  });
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

  const uploaded = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.from("arm64"),
    headers: { "content-type": APK },
  });
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

  const arm64 = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/arm64-v8a",
    payload: Buffer.from("arm64"),
    headers: { "content-type": APK },
  });
  const filename = arm64.json().version.artifacts[0].filename;
  const universal = await authedInject(harness.app, {
    method: "PUT",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/universal",
    payload: Buffer.from("universal"),
    headers: { "content-type": APK },
  });
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
  const urls = [
    "/api/v1/apps/%2E%2E%2Fx",
    "/api/v1/apps/bad%20id",
    "/api/v1/apps/demo/versions/bad%20version",
  ];
  for (const url of urls) {
    const response = await authedInject(harness.app, { method: "DELETE", url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, "invalid_request", url);
  }

  const badAbi = await authedInject(harness.app, {
    method: "DELETE",
    url: "/api/v1/apps/demo/versions/1.0.0/artifacts/armv7",
  });
  assert.equal(badAbi.statusCode, 400);
});
