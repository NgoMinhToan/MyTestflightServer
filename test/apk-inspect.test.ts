import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ApkInspectionError,
  artifactAbiOf,
  inspectApkBytes,
  inspectApkFile,
  toDetected,
} from "../src/apk-inspect";
import {
  REAL_ADAPTIVE_ICON_FIXTURE,
  REAL_ARSC_FIXTURE,
  REAL_VECTOR_ICON_FIXTURE,
  loadFixture,
  makeApk,
  realManifestBytes,
  REAL_MANIFEST_EXPECTED,
} from "./apk-fixtures";

async function expectInvalid(apk: Buffer, pattern?: RegExp): Promise<void> {
  await assert.rejects(inspectApkBytes(apk), (error: unknown) => {
    assert.ok(error instanceof ApkInspectionError, "expected ApkInspectionError");
    assert.equal(error.code, "invalid_apk");
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("parses the shared real AndroidManifest.xml fixture", async () => {
  const apk = makeApk({
    manifestBytes: realManifestBytes(),
    abis: [REAL_MANIFEST_EXPECTED.artifactAbi],
  });
  const metadata = await inspectApkBytes(apk);

  assert.equal(metadata.packageName, REAL_MANIFEST_EXPECTED.packageName);
  assert.equal(metadata.versionCode, REAL_MANIFEST_EXPECTED.versionCode);
  assert.equal(metadata.versionName, REAL_MANIFEST_EXPECTED.versionName);
  assert.equal(metadata.minSdk, REAL_MANIFEST_EXPECTED.minSdk);
  assert.equal(metadata.targetSdk, REAL_MANIFEST_EXPECTED.targetSdk);
  assert.deepEqual(metadata.abis, ["arm64-v8a"]);
  assert.equal(metadata.universal, false);
  assert.equal(metadata.configSplit, false);
  assert.equal(artifactAbiOf(metadata), REAL_MANIFEST_EXPECTED.artifactAbi);
  assert.equal(metadata.versionNameSource, "literal");
  assert.equal(metadata.label, null, "no resources.arsc in this fixture");
  assert.equal(metadata.icon, null);

  const detected = toDetected(metadata);
  assert.equal(detected.artifactAbi, REAL_MANIFEST_EXPECTED.artifactAbi);
});

test("resolves label, versionName, and adaptive icon from the real resources.arsc", async () => {
  const apk = makeApk({
    manifestBytes: realManifestBytes(),
    abis: [REAL_MANIFEST_EXPECTED.artifactAbi],
    resourcesArsc: loadFixture(REAL_ARSC_FIXTURE),
    extraEntries: [
      { name: "res/BW.xml", data: loadFixture(REAL_ADAPTIVE_ICON_FIXTURE) },
      { name: "res/Qr.xml", data: loadFixture(REAL_VECTOR_ICON_FIXTURE) },
    ],
  });
  const metadata = await inspectApkBytes(apk);

  assert.equal(metadata.label, "My TestFlight");
  assert.equal(metadata.versionName, "0.2.0");
  assert.equal(metadata.versionNameSource, "literal");
  assert.deepEqual(metadata.icon, {
    kind: "adaptive",
    entry: "res/BW.xml",
    resourceId: 0x7f0b0000,
  });

  // Detected metadata carries only descriptors, never image bytes or tables.
  const detected = toDetected(metadata);
  assert.deepEqual(detected.icon, metadata.icon);
  assert.equal(JSON.stringify(detected).includes("adaptive-icon"), false);
  assert.ok(JSON.stringify(detected).length < 2000);
});

test("resolves a literal label and marks unresolved references as none", async () => {
  const literal = await inspectApkBytes(makeApk({ label: "Literal Label" }));
  assert.equal(literal.label, "Literal Label");

  const unresolved = await inspectApkBytes(
    makeApk({ versionNameAsReference: true, versionNameRef: 0x7f0e0005 }),
  );
  assert.equal(unresolved.versionName, null);
  assert.equal(unresolved.versionNameSource, "none");
});

test("parses stored and deflated manifest entries", async () => {
  for (const method of [0, 8] as const) {
    const metadata = await inspectApkBytes(makeApk({ method }));
    assert.equal(metadata.packageName, "com.demo", `method ${method}`);
    assert.equal(metadata.versionCode, 1);
    assert.equal(metadata.versionName, "1.0.0");
  }
});

test("parses UTF-16LE and UTF-8 string pools", async () => {
  for (const utf16 of [false, true]) {
    const metadata = await inspectApkBytes(makeApk({ utf16 }));
    assert.equal(metadata.packageName, "com.demo", `utf16=${utf16}`);
    assert.equal(metadata.versionName, "1.0.0");
    assert.equal(metadata.minSdk, 26);
  }
});

test("parses non-ASCII UTF-8 strings with 1- and 2-byte length forms", async () => {
  // First length is UTF-16 code units, second is UTF-8 bytes; each uses a
  // 1-byte form below 0x80 and a 2-byte form above it.
  const versionNames = [
    "1.0.0-việt", // 1 byte / 1 byte
    "ệ".repeat(100), // 1 byte / 2 bytes
    `${"x".repeat(200)}-việt`, // 2 bytes / 2 bytes
  ];
  for (const versionName of versionNames) {
    const metadata = await inspectApkBytes(makeApk({ utf16: false, versionName }));
    assert.equal(metadata.versionName, versionName);
    assert.equal(metadata.packageName, "com.demo");
  }
});

test("derives ABI metadata and universal from lib/<abi> entries", async () => {
  const none = await inspectApkBytes(makeApk({ abis: [] }));
  assert.deepEqual(none.abis, []);
  assert.equal(none.universal, true);
  assert.equal(artifactAbiOf(none), "universal");

  const one = await inspectApkBytes(makeApk({ abis: ["x86_64"] }));
  assert.deepEqual(one.abis, ["x86_64"]);
  assert.equal(one.universal, false);
  assert.equal(artifactAbiOf(one), "x86_64");

  const many = await inspectApkBytes(
    makeApk({ abis: ["x86_64", "arm64-v8a", "armeabi-v7a"] }),
  );
  assert.deepEqual(many.abis, ["arm64-v8a", "armeabi-v7a", "x86_64"]);
  assert.equal(many.universal, true);
  assert.equal(artifactAbiOf(many), "universal");
});

test("treats a resource-reference versionName as null", async () => {
  const metadata = await inspectApkBytes(makeApk({ versionNameAsReference: true }));
  assert.equal(metadata.versionName, null);
});

test("treats non-integer SDK codenames as null", async () => {
  const metadata = await inspectApkBytes(makeApk({ minSdk: "Q", targetSdk: "R" }));
  assert.equal(metadata.minSdk, null);
  assert.equal(metadata.targetSdk, null);
});

test("parses debuggable, testOnly, split, and config split flags", async () => {
  const defaults = await inspectApkBytes(makeApk());
  assert.equal(defaults.debuggable, false);
  assert.equal(defaults.testOnly, false);
  assert.equal(defaults.split, null);
  assert.equal(defaults.configSplit, false);

  const flags = await inspectApkBytes(makeApk({ debuggable: true, testOnly: true }));
  assert.equal(flags.debuggable, true);
  assert.equal(flags.testOnly, true);

  const configSplit = await inspectApkBytes(
    makeApk({ split: "config.arm64_v8a", abis: ["arm64-v8a"] }),
  );
  assert.equal(configSplit.split, "config.arm64_v8a");
  assert.equal(configSplit.configSplit, true);

  const configFor = await inspectApkBytes(makeApk({ configForSplit: "base" }));
  assert.equal(configFor.configSplit, true);

  const featureSplit = await inspectApkBytes(makeApk({ split: "feature" }));
  assert.equal(featureSplit.split, "feature");
  assert.equal(featureSplit.configSplit, false);
});

test("rejects invalid versionCode literals and missing package names", async () => {
  await expectInvalid(makeApk({ versionCode: null }), /versionCode/);
  await expectInvalid(makeApk({ versionCode: 0 }), /versionCode/);
  await expectInvalid(makeApk({ versionCode: -1 }), /versionCode/);
  await expectInvalid(makeApk({ versionCodeType: "string" }), /versionCode/);
  await expectInvalid(makeApk({ omitPackage: true }), /package/);
});

test("rejects non-ZIP payloads and APKs without a manifest", async () => {
  await expectInvalid(Buffer.from("this is not an apk"));
  await expectInvalid(makeApk({ omitManifest: true }), /AndroidManifest/);
});

test("rejects ZIP64 sentinels with the zip64 code", async () => {
  await assert.rejects(inspectApkBytes(makeApk({ zip64: true })), (error: unknown) => {
    assert.ok(error instanceof ApkInspectionError);
    assert.equal(error.code, "zip64");
    return true;
  });
});

test("enforces the inflated manifest size cap", async () => {
  await expectInvalid(
    makeApk({ manifestBytes: Buffer.alloc(8 * 1024 * 1024 + 1), method: 8 }),
    /too large/,
  );
});

test("inspects an APK from disk without loading it whole", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "apk-inspect-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "app.apk");
  await fs.writeFile(file, makeApk({ abis: ["arm64-v8a"] }));

  const metadata = await inspectApkFile(file);
  assert.equal(metadata.packageName, "com.demo");
  assert.deepEqual(metadata.abis, ["arm64-v8a"]);
});
