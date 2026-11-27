import assert from "node:assert/strict";
import test from "node:test";
import {
  collectIconLeaves,
  formatColor,
  parseBinaryXml,
  parseResTable,
  resolveColor,
  resolveIconDescriptor,
  resolveLabel,
  resolveString,
  resolveVersionName,
} from "../src/apk-resources";
import {
  REAL_ADAPTIVE_ICON_FIXTURE,
  REAL_ARSC_FIXTURE,
  REAL_VECTOR_ICON_FIXTURE,
  adaptiveIconXml,
  buildResourcesTable,
  loadFixture,
  vectorIconXml,
} from "./apk-fixtures";

const REAL_FILES = new Map<string, Buffer>([
  ["res/BW.xml", loadFixture(REAL_ADAPTIVE_ICON_FIXTURE)],
  ["res/Qr.xml", loadFixture(REAL_VECTOR_ICON_FIXTURE)],
]);

function realReadEntry(name: string): Buffer | null {
  return REAL_FILES.get(name) ?? null;
}

test("parses the real resources.arsc fixture", () => {
  const table = parseResTable(loadFixture(REAL_ARSC_FIXTURE));
  assert.ok(table);
  assert.ok(table.strings.includes("My TestFlight"));

  assert.equal(resolveLabel(table, 0x7f0e0005), "My TestFlight");
  assert.equal(resolveVersionName(table, 0x7f0e0005), "My TestFlight");

  const color = resolveColor(table, 0x7f040005);
  assert.deepEqual(color, { dataType: 0x1d, data: 0xffff4f40 });
  assert.equal(formatColor(color!.dataType, color!.data), "#ffff4f40");
});

test("resolves the real adaptive icon to res/BW.xml", async () => {
  const table = parseResTable(loadFixture(REAL_ARSC_FIXTURE));
  assert.ok(table);
  const descriptor = await resolveIconDescriptor(table, 0x7f0b0000, realReadEntry);
  assert.deepEqual(descriptor, {
    kind: "adaptive",
    entry: "res/BW.xml",
    resourceId: 0x7f0b0000,
  });
  // The adaptive icon points at the drawable vector.
  const foreground = await resolveIconDescriptor(table, 0x7f060007, realReadEntry);
  assert.deepEqual(foreground, {
    kind: "vector",
    entry: "res/Qr.xml",
    resourceId: 0x7f060007,
  });
});

test("parses the real vector binary XML with two white paths", () => {
  const vector = parseBinaryXml(loadFixture(REAL_VECTOR_ICON_FIXTURE));
  assert.ok(vector);
  assert.equal(vector.name, "vector");
  assert.equal(vector.children.length, 2);
  for (const path of vector.children) {
    assert.equal(path.name, "path");
    const fill = path.attributes.find((attribute) => attribute.name === "fillColor");
    assert.ok(fill);
    assert.equal(fill.dataType, 0x1d);
    assert.equal(fill.value, 0xffffffff);
    assert.equal(formatColor(fill.dataType, fill.value as number), "#ffffffff");
    const data = path.attributes.find((attribute) => attribute.name === "pathData");
    assert.equal(typeof data?.value, "string");
  }
});

function syntheticTable() {
  return buildResourcesTable(0x7f, [
    {
      typeId: 1,
      name: "mipmap",
      entryCount: 1,
      entries: [
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 160 },
          value: { type: "string", value: "res/mipmap-mdpi/ic_launcher.png" },
        },
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 320 },
          value: { type: "string", value: "res/mipmap-xhdpi/ic_launcher.png" },
        },
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 640 },
          value: { type: "string", value: "res/mipmap-xxxhdpi/ic_launcher.png" },
        },
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 0xfffe },
          value: { type: "string", value: "res/mipmap-anydpi/ic_launcher.xml" },
        },
      ],
    },
    {
      typeId: 2,
      name: "string",
      entryCount: 12,
      entries: [
        {
          index: 0,
          key: "app_name",
          config: {},
          value: { type: "string", value: "Default Label" },
        },
        {
          index: 1,
          key: "app_name_en",
          config: { language: "en" },
          value: { type: "string", value: "English Label" },
        },
        {
          index: 2,
          key: "version",
          config: {},
          value: { type: "string", value: "1.2.3 (beta)+7" },
        },
        {
          index: 3,
          key: "version_ref",
          config: {},
          value: { type: "reference", id: 0x7f020002 },
        },
        {
          index: 4,
          key: "cycle_a",
          config: {},
          value: { type: "reference", id: 0x7f020005 },
        },
        {
          index: 5,
          key: "cycle_b",
          config: {},
          value: { type: "reference", id: 0x7f020004 },
        },
      ],
    },
    {
      typeId: 3,
      name: "color",
      entryCount: 1,
      entries: [
        {
          index: 0,
          key: "ic_launcher_background",
          config: {},
          value: { type: "color", value: 0xffff4f40 },
        },
      ],
    },
    {
      typeId: 4,
      name: "drawable",
      entryCount: 1,
      entries: [
        {
          index: 0,
          key: "adaptive",
          config: { density: 0xfffe },
          value: { type: "string", value: "res/drawable/adaptive.xml" },
        },
      ],
    },
    {
      typeId: 5,
      name: "drawable",
      entryCount: 1,
      entries: [
        {
          index: 0,
          key: "vector",
          config: {},
          value: { type: "string", value: "res/drawable/vector.xml" },
        },
      ],
    },
  ]);
}

test("selects default and language-specific strings and follows references", () => {
  const table = parseResTable(syntheticTable());
  assert.ok(table);
  assert.equal(resolveLabel(table, 0x7f020000), "Default Label");
  assert.equal(resolveLabel(table, 0x7f020001), "English Label");
  assert.equal(resolveVersionName(table, 0x7f020003), "1.2.3 (beta)+7");
  assert.equal(resolveString(table, 0x7f020004), null, "reference cycle is null");
  assert.deepEqual(resolveColor(table, 0x7f030000), {
    dataType: 0x1d,
    data: 0xffff4f40,
  });
  assert.equal(formatColor(0x1d, 0x004f40), "#ff004f40");
});

test("picks the highest-density raster and only falls back to XML", async () => {
  const table = parseResTable(syntheticTable());
  assert.ok(table);
  const files = new Map<string, Buffer>([
    ["res/drawable/adaptive.xml", adaptiveIconXml(0x7f030000, 0x7f050000)],
    ["res/drawable/vector.xml", vectorIconXml(["M0,0h24v24z"])],
  ]);
  const readEntry = (name: string) => files.get(name) ?? null;

  const raster = await resolveIconDescriptor(table, 0x7f010000, readEntry);
  assert.deepEqual(raster, {
    kind: "raster",
    entry: "res/mipmap-xxxhdpi/ic_launcher.png",
    contentType: "image/png",
    resourceId: 0x7f010000,
    density: 640,
  });

  const adaptive = await resolveIconDescriptor(table, 0x7f040000, readEntry);
  assert.deepEqual(adaptive, {
    kind: "adaptive",
    entry: "res/drawable/adaptive.xml",
    resourceId: 0x7f040000,
  });

  const vector = await resolveIconDescriptor(table, 0x7f050000, readEntry);
  assert.deepEqual(vector, {
    kind: "vector",
    entry: "res/drawable/vector.xml",
    resourceId: 0x7f050000,
  });

  const leaves = collectIconLeaves(table, 0x7f010000);
  assert.equal(leaves.length, 4);
});

test("tolerates corrupt or truncated resource tables and icon XML", async () => {
  assert.equal(parseResTable(Buffer.from([1, 2, 3, 4])), null);
  assert.equal(parseResTable(Buffer.alloc(0)), null);
  assert.equal(parseBinaryXml(Buffer.from("not xml")), null);

  const table = parseResTable(syntheticTable());
  assert.ok(table);
  const broken = await resolveIconDescriptor(table, 0x7f040000, () => {
    throw new Error("broken zip");
  });
  assert.equal(broken, null);
});
