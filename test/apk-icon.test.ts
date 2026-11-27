import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectApkBytes } from "../src/apk-inspect";
import { extractRasterIcon, versionIconName } from "../src/apk-icon";
import type { ApkIconDescriptor } from "../src/types";
import { adaptiveIconXml, buildResourcesTable, makeApk, pngBytes } from "./apk-fixtures";

async function withApkFile<T>(bytes: Buffer, run: (file: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "apk-icon-"));
  try {
    const file = path.join(directory, "app.apk");
    await fs.writeFile(file, bytes);
    return await run(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function iconApk(options: { density640?: Buffer; anydpiXml?: Buffer }): Buffer {
  const entries = [
    {
      index: 0,
      key: "ic_launcher",
      config: { density: 160 },
      value: { type: "string" as const, value: "res/mipmap-mdpi/ic_launcher.png" },
    },
    {
      index: 0,
      key: "ic_launcher",
      config: { density: 640 },
      value: { type: "string" as const, value: "res/mipmap-xxxhdpi/ic_launcher.png" },
    },
    {
      index: 0,
      key: "ic_launcher",
      config: { density: 0xfffe },
      value: { type: "string" as const, value: "res/mipmap-anydpi/ic_launcher.xml" },
    },
  ];
  const table = buildResourcesTable(0x7f, [
    { typeId: 1, name: "mipmap", entryCount: 1, entries },
    {
      typeId: 2,
      name: "string",
      entryCount: 2,
      entries: [
        {
          index: 0,
          key: "app_name",
          config: {},
          value: { type: "string", value: "Synthetic App" },
        },
        {
          index: 1,
          key: "version_name",
          config: {},
          value: { type: "string", value: "2.0.0 (beta)+3" },
        },
      ],
    },
  ]);

  return makeApk({
    icon: 0x7f010000,
    label: 0x7f020000,
    versionName: "ignored",
    versionNameAsReference: true,
    versionNameRef: 0x7f020001,
    resourcesArsc: table,
    extraEntries: [
      {
        name: "res/mipmap-mdpi/ic_launcher.png",
        data: options.density640 ? pngBytes("mdpi") : pngBytes("mdpi"),
      },
      {
        name: "res/mipmap-xxxhdpi/ic_launcher.png",
        data: options.density640 ?? pngBytes("xxxhdpi"),
      },
      {
        name: "res/mipmap-anydpi/ic_launcher.xml",
        data: options.anydpiXml ?? adaptiveIconXml(0x7f030000, 0x7f040000),
      },
    ],
  });
}

test("inspects label, resource versionName, and the highest-density raster", async () => {
  const apk = iconApk({});
  const metadata = await inspectApkBytes(apk);
  assert.equal(metadata.label, "Synthetic App");
  assert.equal(metadata.versionName, "2.0.0 (beta)+3");
  assert.equal(metadata.versionNameSource, "resource");
  assert.deepEqual(metadata.icon, {
    kind: "raster",
    entry: "res/mipmap-xxxhdpi/ic_launcher.png",
    contentType: "image/png",
    resourceId: 0x7f010000,
    density: 640,
  });

  await withApkFile(apk, async (file) => {
    const icon = await extractRasterIcon(file, metadata.icon);
    assert.ok(icon);
    assert.equal(icon.filename, "version_icon.png");
    assert.equal(icon.contentType, "image/png");
    assert.deepEqual(icon.bytes, pngBytes("xxxhdpi"));
  });
});

test("stores no version icon when only an adaptive/vector icon exists", async () => {
  const table = buildResourcesTable(0x7f, [
    {
      typeId: 1,
      name: "mipmap",
      entryCount: 1,
      entries: [
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 0xfffe },
          value: { type: "string", value: "res/BW.xml" },
        },
      ],
    },
  ]);
  const apk = makeApk({
    icon: 0x7f010000,
    resourcesArsc: table,
    extraEntries: [
      { name: "res/BW.xml", data: adaptiveIconXml(0x7f030000, 0x7f040000) },
    ],
  });

  const metadata = await inspectApkBytes(apk);
  assert.deepEqual(metadata.icon, {
    kind: "adaptive",
    entry: "res/BW.xml",
    resourceId: 0x7f010000,
  });
  await withApkFile(apk, async (file) => {
    assert.equal(await extractRasterIcon(file, metadata.icon), null);
  });
});

test("rejects raster entries with the wrong magic or over the size cap", async () => {
  const fakeDescriptor: ApkIconDescriptor = {
    kind: "raster",
    entry: "res/fake.png",
    contentType: "image/png",
    resourceId: 1,
    density: 160,
  };
  const fake = makeApk({
    extraEntries: [{ name: "res/fake.png", data: Buffer.from("not a png") }],
  });
  await withApkFile(fake, async (file) => {
    assert.equal(await extractRasterIcon(file, fakeDescriptor), null);
  });

  const oversized = makeApk({
    extraEntries: [
      {
        name: "res/fake.png",
        data: Buffer.concat([pngBytes("big"), Buffer.alloc(2 * 1024 * 1024)]),
      },
    ],
  });
  await withApkFile(oversized, async (file) => {
    assert.equal(await extractRasterIcon(file, fakeDescriptor), null);
  });

  await withApkFile(makeApk(), async (file) => {
    assert.equal(await extractRasterIcon(file, fakeDescriptor), null, "missing entry");
    assert.equal(await extractRasterIcon(file, null), null);
    assert.equal(
      await extractRasterIcon(file, {
        kind: "vector",
        entry: "res/v.xml",
        resourceId: 1,
      }),
      null,
    );
  });
});

test("names version icon files by content type", () => {
  assert.equal(versionIconName("image/png"), "version_icon.png");
  assert.equal(versionIconName("image/webp"), "version_icon.webp");
  assert.equal(versionIconName("image/jpeg"), "version_icon.jpg");
});
