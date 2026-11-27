import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { REAL_MANIFEST_AXML_BASE64 } from "./fixtures/real-manifest";

/**
 * Builders for real ZIP/APK and binary AndroidManifest.xml fixtures. No APK is
 * committed; the shared real manifest is stored as base64.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface BuildZipOptions {
  /** Writes the ZIP64 sentinel into the EOCD (for rejection tests). */
  zip64?: boolean;
}

export function buildZip(entries: ZipEntry[], options: BuildZipOptions = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const compressed =
      method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data);
    const checksum = crc32(entry.data);
    const name = Buffer.from(entry.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, eocd]);
}

type AxmlAttributeType = "string" | "int" | "bool" | "reference";

interface AxmlAttribute {
  name: string;
  type: AxmlAttributeType;
  value: string | number | boolean;
}

interface AxmlElement {
  name: string;
  attributes: AxmlAttribute[];
}

const STRING_POOL_UTF8_FLAG = 0x100;

/**
 * Android's UTF-8 pool encodes each length as one byte below 0x80, otherwise
 * as two bytes (high bit set on the first).
 */
function encodePoolUtf8Length(length: number): Buffer {
  return length < 0x80
    ? Buffer.from([length])
    : Buffer.from([0x80 | ((length >> 8) & 0x7f), length & 0xff]);
}

function encodeStringPool(strings: string[], utf8: boolean): Buffer {
  const headerSize = 28;
  const offsets = Buffer.alloc(strings.length * 4);
  const parts: Buffer[] = [];
  let dataLength = 0;

  for (const [index, value] of strings.entries()) {
    offsets.writeUInt32LE(dataLength, index * 4);
    let encoded: Buffer;
    if (utf8) {
      const bytes = Buffer.from(value, "utf8");
      // Two lengths: UTF-16 code units, then UTF-8 bytes.
      encoded = Buffer.concat([
        encodePoolUtf8Length(value.length),
        encodePoolUtf8Length(bytes.length),
        bytes,
        Buffer.from([0]),
      ]);
    } else {
      const body = Buffer.from(value, "utf16le");
      const units = body.length / 2;
      const length = Buffer.alloc(units < 0x8000 ? 2 : 4);
      if (units < 0x8000) {
        length.writeUInt16LE(units, 0);
      } else {
        length.writeUInt16LE(0x8000 | (units >> 16), 0);
        length.writeUInt16LE(units & 0xffff, 2);
      }
      encoded = Buffer.concat([length, body, Buffer.from([0, 0])]);
    }
    parts.push(encoded);
    dataLength += encoded.length;
  }

  const stringsStart = headerSize + strings.length * 4;
  const unpadded = stringsStart + dataLength;
  const size = (unpadded + 3) & ~3;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(utf8 ? STRING_POOL_UTF8_FLAG : 0, 16);
  header.writeUInt32LE(stringsStart, 20);
  header.writeUInt32LE(0, 24);

  return Buffer.concat([header, offsets, ...parts, Buffer.alloc(size - unpadded)]);
}

function encodeStartElement(
  element: AxmlElement,
  indexOf: (value: string) => number,
): Buffer {
  const count = element.attributes.length;
  const size = 16 + 20 + count * 20;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16LE(0x0102, 0);
  buffer.writeUInt16LE(16, 2);
  buffer.writeUInt32LE(size, 4);
  buffer.writeUInt32LE(0, 8);
  buffer.writeUInt32LE(0xffffffff, 12);
  buffer.writeUInt32LE(0xffffffff, 16);
  buffer.writeUInt32LE(indexOf(element.name), 20);
  buffer.writeUInt16LE(20, 24);
  buffer.writeUInt16LE(20, 26);
  buffer.writeUInt16LE(count, 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);

  let position = 36;
  for (const attribute of element.attributes) {
    buffer.writeUInt32LE(0xffffffff, position);
    buffer.writeUInt32LE(indexOf(attribute.name), position + 4);

    let dataType: number;
    let data: number;
    let rawValue = 0xffffffff;
    if (attribute.type === "string") {
      rawValue = indexOf(String(attribute.value));
      dataType = 0x03;
      data = rawValue;
    } else if (attribute.type === "int") {
      dataType = 0x10;
      data = Number(attribute.value) >>> 0;
    } else if (attribute.type === "bool") {
      dataType = 0x12;
      data = attribute.value ? 1 : 0;
    } else {
      dataType = 0x01;
      data = Number(attribute.value) >>> 0;
    }

    buffer.writeUInt32LE(rawValue, position + 8);
    buffer.writeUInt16LE(8, position + 12);
    buffer.writeUInt8(0, position + 14);
    buffer.writeUInt8(dataType, position + 15);
    buffer.writeUInt32LE(data, position + 16);
    position += 20;
  }

  return buffer;
}

function encodeEndElement(nameIndex: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt16LE(0x0103, 0);
  buffer.writeUInt16LE(24, 2);
  buffer.writeUInt32LE(24, 4);
  buffer.writeUInt32LE(0, 8);
  buffer.writeUInt32LE(0xffffffff, 12);
  buffer.writeUInt32LE(0xffffffff, 16);
  buffer.writeUInt32LE(nameIndex, 20);
  return buffer;
}

export function buildAxml(elements: AxmlElement[], options: { utf16?: boolean } = {}): Buffer {
  const strings: string[] = [];
  const indices = new Map<string, number>();
  const add = (value: string) => {
    if (!indices.has(value)) {
      indices.set(value, strings.length);
      strings.push(value);
    }
  };
  for (const element of elements) {
    add(element.name);
    for (const attribute of element.attributes) {
      add(attribute.name);
      if (attribute.type === "string") add(String(attribute.value));
    }
  }
  const indexOf = (value: string) => indices.get(value)!;

  const chunks: Buffer[] = [encodeStringPool(strings, !options.utf16)];
  for (const element of elements) {
    chunks.push(encodeStartElement(element, indexOf));
    chunks.push(encodeEndElement(indexOf(element.name)));
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export interface AxmlSpec {
  packageName?: string;
  omitPackage?: boolean;
  versionCode?: number | null;
  /** `"string"` builds an invalid (non-integer) versionCode. */
  versionCodeType?: "int" | "string";
  versionName?: string | null;
  /** Emits a resource reference instead of a string for `versionName`. */
  versionNameAsReference?: boolean;
  /** Explicit resource id for the `versionName` reference. */
  versionNameRef?: number;
  /** `android:label`; a number emits a resource reference. */
  label?: string | number | null;
  /** `android:icon` resource reference. */
  icon?: number | null;
  /** `android:roundIcon` resource reference. */
  roundIcon?: number | null;
  /** A string is emitted as a codename and should parse as `null`. */
  minSdk?: number | string | null;
  targetSdk?: number | string | null;
  debuggable?: boolean;
  testOnly?: boolean;
  split?: string | null;
  configForSplit?: string | null;
  utf16?: boolean;
}

export const DEFAULT_AXML = {
  packageName: "com.demo",
  versionCode: 1,
  versionName: "1.0.0",
  minSdk: 26,
  targetSdk: 37,
} as const;

export function makeAxml(spec: AxmlSpec = {}): Buffer {
  const packageName = spec.packageName ?? DEFAULT_AXML.packageName;
  const versionCode = spec.versionCode === undefined ? DEFAULT_AXML.versionCode : spec.versionCode;
  const versionName = spec.versionName === undefined ? DEFAULT_AXML.versionName : spec.versionName;
  const minSdk = spec.minSdk === undefined ? DEFAULT_AXML.minSdk : spec.minSdk;
  const targetSdk = spec.targetSdk === undefined ? DEFAULT_AXML.targetSdk : spec.targetSdk;

  const manifestAttributes: AxmlAttribute[] = [];
  if (!spec.omitPackage) {
    manifestAttributes.push({ name: "package", type: "string", value: packageName });
  }
  if (versionCode !== null) {
    manifestAttributes.push({
      name: "versionCode",
      type: spec.versionCodeType === "string" ? "string" : "int",
      value: spec.versionCodeType === "string" ? String(versionCode) : versionCode,
    });
  }
  if (versionName !== null) {
    manifestAttributes.push({
      name: "versionName",
      type: spec.versionNameAsReference ? "reference" : "string",
      value: spec.versionNameAsReference
        ? (spec.versionNameRef ?? 0x7f010001)
        : versionName,
    });
  }
  if (spec.split != null) {
    manifestAttributes.push({ name: "split", type: "string", value: spec.split });
  }
  if (spec.configForSplit != null) {
    manifestAttributes.push({
      name: "configForSplit",
      type: "string",
      value: spec.configForSplit,
    });
  }

  const elements: AxmlElement[] = [{ name: "manifest", attributes: manifestAttributes }];

  const sdkAttributes: AxmlAttribute[] = [];
  if (minSdk !== null) {
    sdkAttributes.push({
      name: "minSdkVersion",
      type: typeof minSdk === "number" ? "int" : "string",
      value: minSdk,
    });
  }
  if (targetSdk !== null) {
    sdkAttributes.push({
      name: "targetSdkVersion",
      type: typeof targetSdk === "number" ? "int" : "string",
      value: targetSdk,
    });
  }
  if (sdkAttributes.length > 0) {
    elements.push({ name: "uses-sdk", attributes: sdkAttributes });
  }

  const applicationAttributes: AxmlAttribute[] = [];
  if (spec.debuggable !== undefined) {
    applicationAttributes.push({
      name: "debuggable",
      type: "bool",
      value: spec.debuggable,
    });
  }
  if (spec.testOnly !== undefined) {
    applicationAttributes.push({ name: "testOnly", type: "bool", value: spec.testOnly });
  }
  if (spec.label !== undefined && spec.label !== null) {
    applicationAttributes.push(
      typeof spec.label === "number"
        ? { name: "label", type: "reference", value: spec.label }
        : { name: "label", type: "string", value: spec.label },
    );
  }
  if (spec.icon !== undefined && spec.icon !== null) {
    applicationAttributes.push({ name: "icon", type: "reference", value: spec.icon });
  }
  if (spec.roundIcon !== undefined && spec.roundIcon !== null) {
    applicationAttributes.push({
      name: "roundIcon",
      type: "reference",
      value: spec.roundIcon,
    });
  }
  if (applicationAttributes.length > 0) {
    elements.push({ name: "application", attributes: applicationAttributes });
  }

  return buildAxml(elements, { utf16: spec.utf16 });
}

export interface ApkSpec extends AxmlSpec {
  abis?: string[];
  method?: 0 | 8;
  extraEntries?: ZipEntry[];
  zip64?: boolean;
  omitManifest?: boolean;
  manifestBytes?: Buffer;
  includeResources?: boolean;
  /** Real or synthetic `resources.arsc`; defaults to a tiny bogus buffer. */
  resourcesArsc?: Buffer;
}

export function makeApk(spec: ApkSpec = {}): Buffer {
  const method = spec.method ?? 8;
  const entries: ZipEntry[] = [];
  if (!spec.omitManifest) {
    entries.push({
      name: "AndroidManifest.xml",
      data: spec.manifestBytes ?? makeAxml(spec),
      method,
    });
  }
  for (const abi of spec.abis ?? []) {
    entries.push({
      name: `lib/${abi}/libnative.so`,
      data: Buffer.from(`native-${abi}`),
      method,
    });
  }
  if (spec.includeResources !== false) {
    entries.push({
      name: "resources.arsc",
      data: spec.resourcesArsc ?? Buffer.from([1, 2, 3, 4]),
      method,
    });
  }
  if (spec.extraEntries) entries.push(...spec.extraEntries);
  return buildZip(entries, { zip64: spec.zip64 });
}

/** The shared real AndroidManifest.xml fixture (8000 bytes). */
export function realManifestBytes(): Buffer {
  return Buffer.from(REAL_MANIFEST_AXML_BASE64, "base64");
}

export const REAL_MANIFEST_EXPECTED = {
  packageName: "dev.minhtoan.mytestflight",
  versionCode: 18,
  versionName: "0.2.0",
  minSdk: 26,
  targetSdk: 37,
  artifactAbi: "arm64-v8a",
} as const;

/** Reads a committed fixture from `test/fixtures/`. */
export function loadFixture(name: string): Buffer {
  return fs.readFileSync(path.join(__dirname, "fixtures", name));
}

export const REAL_ARSC_FIXTURE = "resources.arsc";
export const REAL_ADAPTIVE_ICON_FIXTURE = "icon-adaptive.xml";
export const REAL_VECTOR_ICON_FIXTURE = "icon-vector.xml";

export interface ResourceConfigSpec {
  language?: string;
  country?: string;
  density?: number;
  sdkVersion?: number;
}

export type ResourceValueSpec =
  | { type: "string"; value: string }
  | { type: "reference"; id: number }
  | { type: "int"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "color"; value: number; colorType?: 0x1c | 0x1d | 0x1e | 0x1f };

export interface ResourceEntrySpec {
  index: number;
  key: string;
  config: ResourceConfigSpec;
  value: ResourceValueSpec;
}

export interface ResourceTypeSpec {
  typeId: number;
  name: string;
  entryCount: number;
  entries: ResourceEntrySpec[];
}

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_CONFIG_SIZE = 64;
const RES_TABLE_PACKAGE_HEADER_SIZE = 288;

function encodeResTableConfig(config: ResourceConfigSpec): Buffer {
  const buffer = Buffer.alloc(RES_TABLE_CONFIG_SIZE);
  buffer.writeUInt32LE(RES_TABLE_CONFIG_SIZE, 0);
  const language = (config.language ?? "").toLowerCase().slice(0, 2);
  const country = (config.country ?? "").toUpperCase().slice(0, 2);
  if (language.length > 0) buffer.write(language, 8, "latin1");
  if (country.length > 0) buffer.write(country, 10, "latin1");
  buffer.writeUInt16LE(config.density ?? 0, 14);
  buffer.writeUInt16LE(config.sdkVersion ?? 0, 24);
  return buffer;
}

function configKey(config: ResourceConfigSpec): string {
  return [
    (config.language ?? "").toLowerCase(),
    (config.country ?? "").toUpperCase(),
    config.density ?? 0,
    config.sdkVersion ?? 0,
  ].join("|");
}

function encodeTypeSpec(type: ResourceTypeSpec): Buffer {
  const size = 16 + type.entryCount * 4;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16LE(RES_TABLE_TYPE_SPEC_TYPE, 0);
  buffer.writeUInt16LE(16, 2);
  buffer.writeUInt32LE(size, 4);
  buffer.writeUInt8(type.typeId, 8);
  buffer.writeUInt32LE(type.entryCount, 12);
  return buffer;
}

function encodeTypeChunks(
  type: ResourceTypeSpec,
  configs: Map<string, ResourceEntrySpec[]>,
  keyIndex: (key: string) => number,
  globalIndex: (value: string) => number,
): Buffer[] {
  const chunks: Buffer[] = [];

  for (const entries of configs.values()) {
    const config = entries[0]!.config;
    const configBuffer = encodeResTableConfig(config);
    const headerSize = 20 + RES_TABLE_CONFIG_SIZE;
    const entriesStart = headerSize + type.entryCount * 4;
    const offsets = Buffer.alloc(type.entryCount * 4, 0xff);

    const readable: ResourceEntrySpec[] = [];
    for (const entry of entries) {
      if (entry.index < 0 || entry.index >= type.entryCount) {
        throw new Error(`entry index ${entry.index} out of range`);
      }
      readable.push(entry);
    }
    readable.sort((left, right) => left.index - right.index);

    const parts: Buffer[] = [];
    let cursor = 0;
    for (const entry of readable) {
      let dataType: number;
      let data: number;
      switch (entry.value.type) {
        case "string":
          dataType = 0x03;
          data = globalIndex(entry.value.value);
          break;
        case "reference":
          dataType = 0x01;
          data = entry.value.id >>> 0;
          break;
        case "int":
          dataType = 0x10;
          data = entry.value.value >>> 0;
          break;
        case "bool":
          dataType = 0x12;
          data = entry.value.value ? 1 : 0;
          break;
        case "color":
          dataType = entry.value.colorType ?? 0x1d;
          data = entry.value.value >>> 0;
          break;
        default:
          throw new Error("unknown resource value type");
      }

      const record = Buffer.alloc(16);
      record.writeUInt16LE(8, 0); // ResTable_entry.size
      record.writeUInt16LE(0, 2); // flags
      record.writeUInt32LE(keyIndex(entry.key), 4);
      record.writeUInt16LE(8, 8); // Res_value.size
      record.writeUInt8(0, 10);
      record.writeUInt8(dataType, 11);
      record.writeUInt32LE(data, 12);
      offsets.writeUInt32LE(cursor, entry.index * 4);
      parts.push(record);
      cursor += record.length;
    }

    const entryBytes = Buffer.concat(parts);
    const size = entriesStart + entryBytes.length;
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(RES_TABLE_TYPE_TYPE, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(size, 4);
    header.writeUInt8(type.typeId, 8);
    header.writeUInt16LE(type.entryCount, 12);
    header.writeUInt32LE(entriesStart, 16);
    configBuffer.copy(header, 20);

    chunks.push(Buffer.concat([header, offsets, entryBytes]));
  }

  return chunks;
}

/**
 * Minimal `resources.arsc` encoder used by the resolver matrix tests. It emits
 * one package with a global string pool, type/key pools, type specs, and one
 * type chunk per configuration.
 */
export function buildResourcesTable(
  packageId: number,
  types: ResourceTypeSpec[],
): Buffer {
  const maxTypeId = types.reduce((max, type) => Math.max(max, type.typeId), 0);
  if (maxTypeId > 255) throw new Error("typeId must fit in one byte");

  const typeNames: string[] = [];
  for (let typeId = 1; typeId <= maxTypeId; typeId += 1) {
    const type = types.find((candidate) => candidate.typeId === typeId);
    typeNames.push(type?.name ?? `?${typeId}`);
  }

  const globalValues: string[] = [];
  const globalMap = new Map<string, number>();
  const globalIndex = (value: string): number => {
    const existing = globalMap.get(value);
    if (existing !== undefined) return existing;
    const index = globalValues.length;
    globalMap.set(value, index);
    globalValues.push(value);
    return index;
  };

  const keys: string[] = [];
  const keyMap = new Map<string, number>();
  const keyIndex = (key: string): number => {
    const existing = keyMap.get(key);
    if (existing !== undefined) return existing;
    const index = keys.length;
    keyMap.set(key, index);
    keys.push(key);
    return index;
  };

  // Assign string-pool indices first so entry encoding is deterministic.
  for (const type of types) {
    for (const entry of type.entries) {
      if (entry.value.type === "string") globalIndex(entry.value.value);
      keyIndex(entry.key);
    }
  }

  const typePool = encodeStringPool(typeNames, true);
  const keyPool = encodeStringPool(keys, true);

  const specChunks = types.map(encodeTypeSpec);
  const typeChunks: Buffer[] = [];
  for (const type of types) {
    const groups = new Map<string, ResourceEntrySpec[]>();
    for (const entry of type.entries) {
      const key = configKey(entry.config);
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }
    typeChunks.push(...encodeTypeChunks(type, groups, keyIndex, globalIndex));
  }

  const typeStringsOffset = RES_TABLE_PACKAGE_HEADER_SIZE;
  const keyStringsOffset = typeStringsOffset + typePool.length;
  const packageHeader = Buffer.alloc(RES_TABLE_PACKAGE_HEADER_SIZE);
  packageHeader.writeUInt16LE(RES_TABLE_PACKAGE_TYPE, 0);
  packageHeader.writeUInt16LE(RES_TABLE_PACKAGE_HEADER_SIZE, 2);
  packageHeader.writeUInt32LE(packageId, 8);
  packageHeader.writeUInt32LE(typeStringsOffset, 268);
  packageHeader.writeUInt32LE(types.length, 272);
  packageHeader.writeUInt32LE(keyStringsOffset, 276);
  packageHeader.writeUInt32LE(keys.length, 280);
  packageHeader.writeUInt32LE(0, 284);

  const packageBody = Buffer.concat([
    packageHeader,
    typePool,
    keyPool,
    ...specChunks,
    ...typeChunks,
  ]);
  packageBody.writeUInt32LE(packageBody.length, 4);

  const globalPool = encodeStringPool(globalValues, true);
  const tableHeader = Buffer.alloc(12);
  tableHeader.writeUInt16LE(RES_TABLE_TYPE, 0);
  tableHeader.writeUInt16LE(12, 2);
  tableHeader.writeUInt32LE(1, 8);

  const table = Buffer.concat([tableHeader, globalPool, packageBody]);
  table.writeUInt32LE(table.length, 4);
  return table;
}

/** A tiny but valid PNG header payload (the extractor only checks magic/size). */
export function pngBytes(label = "icon"): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`png:${label}`, "utf8"),
  ]);
}

export interface RasterApkOptions {
  packageName?: string;
  versionCode?: number;
  versionName?: string;
  label?: string;
  png?: Buffer;
  abis?: string[];
  /** Only emit the anydpi adaptive XML (no raster). */
  adaptiveOnly?: boolean;
  /** Reference the versionName resource instead of writing a literal. */
  versionNameFromResource?: boolean;
}

/** Builds a synthetic APK with a raster (or adaptive-only) launcher icon. */
export function makeRasterApk(options: RasterApkOptions = {}): Buffer {
  const png = options.png ?? pngBytes("raster");
  const versionName = options.versionName ?? "1.0.0";
  const label = options.label ?? "Raster App";

  const mipmapEntries = options.adaptiveOnly
    ? [
        {
          index: 0,
          key: "ic_launcher",
          config: { density: 0xfffe },
          value: { type: "string" as const, value: "res/BW.xml" },
        },
      ]
    : [
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
      ];

  const table = buildResourcesTable(0x7f, [
    { typeId: 1, name: "mipmap", entryCount: 1, entries: mipmapEntries },
    {
      typeId: 2,
      name: "string",
      entryCount: 2,
      entries: [
        {
          index: 0,
          key: "app_name",
          config: {},
          value: { type: "string", value: label },
        },
        {
          index: 1,
          key: "version_name",
          config: {},
          value: { type: "string", value: versionName },
        },
      ],
    },
  ]);

  const extraEntries: ZipEntry[] = options.adaptiveOnly
    ? [{ name: "res/BW.xml", data: adaptiveIconXml(0x7f030000, 0x7f040000) }]
    : [
        { name: "res/mipmap-mdpi/ic_launcher.png", data: png },
        { name: "res/mipmap-xxxhdpi/ic_launcher.png", data: png },
      ];

  return makeApk({
    packageName: options.packageName ?? "com.demo",
    versionCode: options.versionCode ?? 1,
    abis: options.abis ?? [],
    versionName: options.versionNameFromResource ? "ignored" : versionName,
    versionNameAsReference: options.versionNameFromResource ?? false,
    versionNameRef: 0x7f020001,
    label: 0x7f020000,
    icon: 0x7f010000,
    resourcesArsc: table,
    extraEntries,
  });
}

/** Builds an adaptive-icon binary XML document referencing two drawables. */
export function adaptiveIconXml(backgroundRef: number, foregroundRef: number): Buffer {
  return buildAxml([
    {
      name: "adaptive-icon",
      attributes: [],
    },
    {
      name: "background",
      attributes: [{ name: "drawable", type: "reference", value: backgroundRef }],
    },
    {
      name: "foreground",
      attributes: [{ name: "drawable", type: "reference", value: foregroundRef }],
    },
  ]);
}

/** Builds a vector drawable binary XML with `paths` white paths. */
export function vectorIconXml(paths: string[]): Buffer {
  const pathElements: AxmlElement[] = paths.map((pathData) => ({
    name: "path",
    attributes: [
      { name: "fillColor", type: "int", value: 0xffffffff },
      { name: "pathData", type: "string", value: pathData },
    ],
  }));
  return buildAxml([
    {
      name: "vector",
      attributes: [
        { name: "viewportWidth", type: "int", value: 24 },
        { name: "viewportHeight", type: "int", value: 24 },
      ],
    },
    ...pathElements,
  ]);
}
