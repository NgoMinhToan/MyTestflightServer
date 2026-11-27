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
      value: spec.versionNameAsReference ? 0x7f010001 : versionName,
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
    entries.push({ name: "resources.arsc", data: Buffer.from([1, 2, 3, 4]), method });
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
