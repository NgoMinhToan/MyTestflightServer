import fs from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import type { ApkAbi, ApkMetadata, DetectedApk, VersionNameSource } from "./types";
import type { ResTable } from "./apk-resources";
import {
  parseResTable,
  resolveIconDescriptor,
  resolveLabel,
  resolveVersionName,
} from "./apk-resources";
import { compareAbi, normalizeAbi } from "./volume";

/**
 * ZIP + binary AndroidManifest.xml inspection. Deliberately dependency free:
 * only `node:zlib` is used to inflate the manifest entry.
 *
 * The parser follows the shared three-repo contract: EOCD within the last
 * 65 557 bytes, ZIP64 rejected, central directory capped at 64 MiB, at most
 * 200 000 entries, a single entry named exactly `AndroidManifest.xml`, sizes
 * taken from the central directory, method 0 (stored) or 8 (deflate), 16 MiB
 * compressed / 8 MiB inflated caps.
 */

export type ApkInspectionCode = "invalid_apk" | "zip64";

export class ApkInspectionError extends Error {
  constructor(
    readonly code: ApkInspectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ApkInspectionError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_COUNT = 0xffff;

const MAX_EOCD_SEARCH = 65557;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_MANIFEST_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_ARSC_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARSC_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ICON_XML_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_ICON_XML_INFLATED_BYTES = 4 * 1024 * 1024;

const MANIFEST_ENTRY_NAME = "AndroidManifest.xml";
const RESOURCES_ENTRY_NAME = "resources.arsc";

const UTF8_STRING_POOL_FLAG = 0x100;

const CHUNK_XML = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_START_ELEMENT = 0x0102;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

interface ByteSource {
  readonly size: number;
  read(position: number, length: number): Promise<Buffer>;
}

interface ZipEntryHeader {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

interface RawManifestFacts {
  packageName?: string;
  versionCode?: number;
  versionName?: string | null;
  versionNameRef?: number | null;
  label?: string | null;
  labelRef?: number | null;
  iconRef?: number | null;
  roundIconRef?: number | null;
  minSdk?: number | null;
  targetSdk?: number | null;
  debuggable?: boolean;
  testOnly?: boolean;
  split?: string | null;
  configForSplit?: string | null;
}

interface ManifestFacts {
  packageName: string;
  versionCode: number;
  versionName: string | null;
  versionNameRef: number | null;
  label: string | null;
  labelRef: number | null;
  iconRef: number | null;
  roundIconRef: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  testOnly: boolean;
  split: string | null;
  configSplit: boolean;
}

interface TypedValue {
  kind: "string" | "int" | "bool" | "reference" | "null";
  string?: string;
  int?: number;
  bool?: boolean;
  reference?: number;
}

function invalid(message: string): ApkInspectionError {
  return new ApkInspectionError("invalid_apk", message);
}

function zip64(message: string): ApkInspectionError {
  return new ApkInspectionError("zip64", message);
}

class BufferByteSource implements ByteSource {
  readonly size: number;

  constructor(private readonly buffer: Buffer) {
    this.size = buffer.length;
  }

  async read(position: number, length: number): Promise<Buffer> {
    if (position < 0 || length < 0) throw invalid("Invalid ZIP range");
    const end = Math.min(this.buffer.length, position + length);
    return this.buffer.subarray(position, end);
  }
}

/**
 * Inspects an on-disk APK with range reads; the whole APK is never buffered.
 */
export async function inspectApkFile(filePath: string): Promise<ApkMetadata> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const source: ByteSource = {
      size: stat.size,
      read: async (position, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      },
    };
    return await inspectApkSource(source);
  } finally {
    await handle.close();
  }
}

/**
 * Inspects in-memory APK bytes. Used by tests and callers that already hold
 * the payload in memory.
 */
export async function inspectApkBytes(buffer: Buffer): Promise<ApkMetadata> {
  return inspectApkSource(new BufferByteSource(buffer));
}

export function artifactAbiOf(metadata: ApkMetadata): ApkAbi {
  return metadata.universal ? "universal" : metadata.abis[0]!;
}

export function toDetected(metadata: ApkMetadata): DetectedApk {
  return { ...metadata, artifactAbi: artifactAbiOf(metadata) };
}

async function inspectApkSource(source: ByteSource): Promise<ApkMetadata> {
  if (source.size < 22) throw invalid("File is too small to be a ZIP/APK");

  const eocd = await readEndOfCentralDirectory(source);
  const centralDirectory = await source.read(eocd.offset, eocd.size);
  if (centralDirectory.length !== eocd.size) {
    throw invalid("ZIP central directory is truncated");
  }

  const entries = readCentralDirectory(centralDirectory, eocd.entryCount);
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY_NAME);
  if (!manifestEntry) {
    throw invalid(`APK is missing ${MANIFEST_ENTRY_NAME}`);
  }

  const manifestBytes = await readManifestBytes(source, manifestEntry);
  const facts = parseAxml(manifestBytes);
  const abis = collectAbis(entries);
  const resolved = await resolveManifestResources(source, entries, facts);

  return {
    packageName: facts.packageName,
    versionCode: facts.versionCode,
    versionName: resolved.versionName,
    versionNameSource: resolved.versionNameSource,
    label: resolved.label,
    icon: resolved.icon,
    minSdk: facts.minSdk,
    targetSdk: facts.targetSdk,
    abis,
    universal: abis.length !== 1,
    debuggable: facts.debuggable,
    testOnly: facts.testOnly,
    split: facts.split,
    configSplit: facts.configSplit,
  };
}

interface ResolvedManifestResources {
  label: string | null;
  versionName: string | null;
  versionNameSource: VersionNameSource;
  icon: ApkMetadata["icon"];
}

/**
 * Best-effort resource resolution. A missing/corrupt `resources.arsc` or icon
 * XML only makes the corresponding value unavailable; the upload still works.
 */
async function resolveManifestResources(
  source: ByteSource,
  entries: ZipEntryHeader[],
  facts: ManifestFacts,
): Promise<ResolvedManifestResources> {
  const table = await readResourcesTable(source, entries);
  const readEntry = (name: string) => readIconXml(source, entries, name);

  let label = facts.label !== null && facts.label.trim().length > 0 ? facts.label : null;
  if (label === null && table !== null && facts.labelRef !== null) {
    label = resolveLabel(table, facts.labelRef);
  }

  let versionName: string | null = null;
  let versionNameSource: VersionNameSource = "none";
  if (facts.versionName !== null && facts.versionName.trim().length > 0) {
    versionName = facts.versionName;
    versionNameSource = "literal";
  } else if (table !== null && facts.versionNameRef !== null) {
    const resolved = resolveVersionName(table, facts.versionNameRef);
    if (resolved !== null && resolved.trim().length > 0) {
      versionName = resolved;
      versionNameSource = "resource";
    }
  }

  let icon: ApkMetadata["icon"] = null;
  if (table !== null) {
    try {
      if (facts.iconRef !== null) {
        icon = await resolveIconDescriptor(table, facts.iconRef, readEntry);
      }
      if (icon === null && facts.roundIconRef !== null) {
        icon = await resolveIconDescriptor(table, facts.roundIconRef, readEntry);
      }
    } catch {
      icon = null;
    }
  }

  return { label, versionName, versionNameSource, icon };
}

async function readResourcesTable(
  source: ByteSource,
  entries: ZipEntryHeader[],
): Promise<ResTable | null> {
  const entry = entries.find((candidate) => candidate.name === RESOURCES_ENTRY_NAME);
  if (!entry) return null;
  try {
    const bytes = await readEntryBytes(
      source,
      entry,
      MAX_ARSC_COMPRESSED_BYTES,
      MAX_ARSC_INFLATED_BYTES,
    );
    return bytes === null ? null : parseResTable(bytes);
  } catch {
    return null;
  }
}

async function readIconXml(
  source: ByteSource,
  entries: ZipEntryHeader[],
  name: string,
): Promise<Buffer | null> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  try {
    return await readEntryBytes(
      source,
      entry,
      MAX_ICON_XML_COMPRESSED_BYTES,
      MAX_ICON_XML_INFLATED_BYTES,
    );
  } catch {
    return null;
  }
}

async function readEndOfCentralDirectory(
  source: ByteSource,
): Promise<{ offset: number; size: number; entryCount: number }> {
  const tailLength = Math.min(source.size, MAX_EOCD_SEARCH);
  const tail = await source.read(source.size - tailLength, tailLength);
  if (tail.length < 22) throw invalid("File is too small to be a ZIP/APK");

  let eocdOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    // A signature inside a ZIP comment must not be mistaken for the EOCD.
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength > tail.length) continue;
    eocdOffset = index;
    break;
  }
  if (eocdOffset < 0) throw invalid("File is not a ZIP/APK (no end of central directory)");

  const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);

  if (
    entriesOnDisk === ZIP64_COUNT ||
    entryCount === ZIP64_COUNT ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    throw zip64("ZIP64 APKs are not supported");
  }
  if (entryCount > MAX_ENTRIES) {
    throw invalid(`ZIP has too many entries (${entryCount} > ${MAX_ENTRIES})`);
  }
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw invalid("ZIP central directory is too large");
  }
  if (centralOffset + centralSize > source.size) {
    throw invalid("ZIP central directory extends past the end of the file");
  }

  return { offset: centralOffset, size: centralSize, entryCount };
}

function readCentralDirectory(buffer: Buffer, entryCount: number): ZipEntryHeader[] {
  const entries: ZipEntryHeader[] = [];
  let position = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > buffer.length) throw invalid("ZIP central directory is truncated");
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw invalid("ZIP central directory entry has an invalid signature");
    }

    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw zip64("ZIP64 APKs are not supported");
    }

    const nameEnd = position + 46 + nameLength;
    if (nameEnd > buffer.length) throw invalid("ZIP central directory entry is truncated");
    const name = buffer.toString("utf8", position + 46, nameEnd);

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    position = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function collectAbis(entries: ZipEntryHeader[]): ApkAbi[] {
  const seen = new Set<ApkAbi>();
  for (const entry of entries) {
    if (!entry.name.startsWith("lib/")) continue;
    const rest = entry.name.slice("lib/".length);
    const separator = rest.indexOf("/");
    if (separator <= 0) continue;
    const abi = normalizeAbi(rest.slice(0, separator));
    if (abi === null || abi === "universal") continue;
    seen.add(abi);
  }
  return [...seen].sort(compareAbi);
}

async function readManifestBytes(
  source: ByteSource,
  entry: ZipEntryHeader,
): Promise<Buffer> {
  const bytes = await readEntryBytes(
    source,
    entry,
    MAX_MANIFEST_COMPRESSED_BYTES,
    MAX_MANIFEST_INFLATED_BYTES,
    MANIFEST_ENTRY_NAME,
  );
  if (bytes === null) throw invalid("AndroidManifest.xml is too large");
  return bytes;
}

async function readEntryBytes(
  source: ByteSource,
  entry: ZipEntryHeader,
  maxCompressed: number,
  maxInflated: number,
  label = entry.name,
): Promise<Buffer | null> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw invalid(`Unsupported compression method for ${label} (${entry.method})`);
  }
  if (entry.compressedSize > maxCompressed || entry.uncompressedSize > maxInflated) {
    throw invalid(`${label} is too large`);
  }

  const localHeader = await source.read(entry.localOffset, 30);
  if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw invalid(`${label} has an invalid local header`);
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > source.size) {
    throw invalid(`${label} data extends past the end of the file`);
  }

  const compressed = await source.read(dataOffset, entry.compressedSize);
  if (compressed.length !== entry.compressedSize) {
    throw invalid(`${label} data is truncated`);
  }

  if (entry.method === 0) {
    if (compressed.length > maxInflated) throw invalid(`${label} is too large`);
    return compressed;
  }

  let inflated: Buffer;
  try {
    inflated = inflateRawSync(compressed, { maxOutputLength: maxInflated });
  } catch {
    throw invalid(`${label} could not be inflated`);
  }
  if (inflated.length > maxInflated) throw invalid(`${label} is too large`);
  return inflated;
}

/**
 * Reads one ZIP entry from an APK using the same capped range reader as
 * inspection. Returns `null` when the file is not a readable ZIP, the entry is
 * missing, or its size exceeds the caps. Used for icon and resource extraction.
 */
export async function readApkEntryBytes(
  filePath: string,
  entryName: string,
  limits: { maxCompressedBytes: number; maxInflatedBytes: number },
): Promise<Buffer | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const source: ByteSource = {
      size: stat.size,
      read: async (position, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      },
    };
    if (source.size < 22) return null;
    const eocd = await readEndOfCentralDirectory(source);
    const centralDirectory = await source.read(eocd.offset, eocd.size);
    if (centralDirectory.length !== eocd.size) return null;
    const entries = readCentralDirectory(centralDirectory, eocd.entryCount);
    const entry = entries.find((candidate) => candidate.name === entryName);
    if (!entry) return null;
    return await readEntryBytes(
      source,
      entry,
      limits.maxCompressedBytes,
      limits.maxInflatedBytes,
    );
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function parseAxml(buffer: Buffer): ManifestFacts {
  if (buffer.length < 8) throw invalid("AndroidManifest.xml is too small");
  if (buffer.readUInt16LE(0) !== CHUNK_XML) {
    throw invalid("AndroidManifest.xml is not binary XML");
  }

  const headerSize = buffer.readUInt16LE(2);
  const declaredSize = buffer.readUInt32LE(4);
  const end = Math.min(buffer.length, declaredSize);
  if (headerSize < 8 || end < 8) throw invalid("AndroidManifest.xml header is invalid");

  let strings: string[] | null = null;
  const facts: RawManifestFacts = {};

  let offset = headerSize;
  while (offset + 8 <= end) {
    const chunkType = buffer.readUInt16LE(offset);
    const chunkHeaderSize = buffer.readUInt16LE(offset + 2);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > end) {
      throw invalid("AndroidManifest.xml contains a malformed chunk");
    }

    if (chunkType === CHUNK_STRING_POOL) {
      strings = parseStringPool(buffer, offset, chunkHeaderSize, chunkSize);
    } else if (chunkType === CHUNK_START_ELEMENT) {
      if (strings === null) throw invalid("AndroidManifest.xml element precedes its string pool");
      parseStartElement(buffer, offset, chunkSize, strings, facts);
    }

    offset += chunkSize;
  }

  const packageName = facts.packageName;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw invalid("AndroidManifest.xml is missing the package attribute");
  }
  if (typeof facts.versionCode !== "number" || facts.versionCode <= 0) {
    throw invalid("AndroidManifest.xml versionCode must be a positive integer literal");
  }

  const split = facts.split ?? null;
  const configForSplit = facts.configForSplit ?? null;
  const configSplit =
    (split !== null && split.startsWith("config.")) ||
    (configForSplit !== null && configForSplit.length > 0);

  return {
    packageName,
    versionCode: facts.versionCode,
    versionName: facts.versionName ?? null,
    versionNameRef: facts.versionNameRef ?? null,
    label: facts.label ?? null,
    labelRef: facts.labelRef ?? null,
    iconRef: facts.iconRef ?? null,
    roundIconRef: facts.roundIconRef ?? null,
    minSdk: facts.minSdk ?? null,
    targetSdk: facts.targetSdk ?? null,
    debuggable: facts.debuggable ?? false,
    testOnly: facts.testOnly ?? false,
    split,
    configSplit,
  };
}

function parseStringPool(
  buffer: Buffer,
  chunkStart: number,
  headerSize: number,
  chunkSize: number,
): string[] {
  if (headerSize < 28) throw invalid("AndroidManifest.xml string pool header is invalid");
  const stringCount = buffer.readUInt32LE(chunkStart + 8);
  const flags = buffer.readUInt32LE(chunkStart + 16);
  const stringsStart = buffer.readUInt32LE(chunkStart + 20);
  const chunkEnd = chunkStart + chunkSize;

  if (stringCount > MAX_ENTRIES) throw invalid("AndroidManifest.xml has too many strings");
  if (headerSize + stringCount * 4 > chunkSize) {
    throw invalid("AndroidManifest.xml string pool offsets are truncated");
  }
  if (stringsStart > chunkSize) {
    throw invalid("AndroidManifest.xml string pool data is out of range");
  }

  const utf8 = (flags & UTF8_STRING_POOL_FLAG) !== 0;
  const offsetsStart = chunkStart + headerSize;
  const dataStart = chunkStart + stringsStart;
  const strings: string[] = [];

  for (let index = 0; index < stringCount; index += 1) {
    const relativeOffset = buffer.readUInt32LE(offsetsStart + index * 4);
    const stringStart = dataStart + relativeOffset;
    if (stringStart > chunkEnd) {
      throw invalid("AndroidManifest.xml string offset is out of range");
    }
    strings.push(readPoolString(buffer, stringStart, chunkEnd, utf8));
  }

  return strings;
}

function readPoolUtf8Length(
  buffer: Buffer,
  start: number,
  end: number,
): { length: number; next: number } {
  if (start >= end) throw invalid("AndroidManifest.xml string is truncated");
  let length = buffer[start]!;
  let position = start + 1;
  if ((length & 0x80) !== 0) {
    if (position >= end) throw invalid("AndroidManifest.xml string is truncated");
    length = ((length & 0x7f) << 8) | buffer[position]!;
    position += 1;
  }
  return { length, next: position };
}

function readPoolString(
  buffer: Buffer,
  start: number,
  end: number,
  utf8: boolean,
): string {
  if (utf8) {
    // Android's UTF-8 pool writes two lengths: the UTF-16 code-unit count,
    // then the UTF-8 byte count. Both use a 1-byte or 2-byte encoding.
    const utf16 = readPoolUtf8Length(buffer, start, end);
    const bytes = readPoolUtf8Length(buffer, utf16.next, end);
    if (bytes.next + bytes.length > end) {
      throw invalid("AndroidManifest.xml string is truncated");
    }
    return buffer.toString("utf8", bytes.next, bytes.next + bytes.length);
  }

  let position = start;
  if (position + 2 > end) throw invalid("AndroidManifest.xml string is truncated");
  let length = buffer.readUInt16LE(position);
  position += 2;
  if ((length & 0x8000) !== 0) {
    if (position + 2 > end) throw invalid("AndroidManifest.xml string is truncated");
    length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(position);
    position += 2;
  }
  const bytes = length * 2;
  if (position + bytes > end) throw invalid("AndroidManifest.xml string is truncated");
  return buffer.toString("utf16le", position, position + bytes);
}

function parseStartElement(
  buffer: Buffer,
  chunkStart: number,
  chunkSize: number,
  strings: string[],
  facts: RawManifestFacts,
): void {
  // ResXMLTree_node is 16 bytes; the attribute extension starts at +16.
  if (chunkSize < 16 + 20) throw invalid("AndroidManifest.xml element is truncated");
  const attributeStart = buffer.readUInt16LE(chunkStart + 24);
  const attributeSize = buffer.readUInt16LE(chunkStart + 26);
  const attributeCount = buffer.readUInt16LE(chunkStart + 28);
  if (attributeSize < 20) throw invalid("AndroidManifest.xml attribute size is invalid");

  const elementName = strings[buffer.readUInt32LE(chunkStart + 20)] ?? "";
  const attributesStart = chunkStart + 16 + attributeStart;
  const chunkEnd = chunkStart + chunkSize;

  for (let index = 0; index < attributeCount; index += 1) {
    const position = attributesStart + index * attributeSize;
    if (position + 20 > chunkEnd) throw invalid("AndroidManifest.xml attribute is truncated");

    const nameIndex = buffer.readUInt32LE(position + 4);
    const rawValueIndex = buffer.readUInt32LE(position + 8);
    const dataType = buffer.readUInt8(position + 15);
    const data = buffer.readUInt32LE(position + 16);
    const name = strings[nameIndex] ?? "";
    const rawValue =
      rawValueIndex === 0xffffffff ? null : (strings[rawValueIndex] ?? null);
    applyAttribute(
      facts,
      elementName,
      name,
      typedValue(strings, dataType, data, rawValue),
    );
  }
}

function typedValue(
  strings: string[],
  dataType: number,
  data: number,
  rawValue: string | null,
): TypedValue {
  switch (dataType) {
    case TYPE_STRING:
      return { kind: "string", string: strings[data] ?? "" };
    case TYPE_INT_DEC:
    case TYPE_INT_HEX: {
      // AXML integers are signed 32-bit; keep negative literals negative.
      const signed = data > 0x7fffffff ? data - 0x100000000 : data;
      return { kind: "int", int: signed };
    }
    case TYPE_INT_BOOLEAN:
      return { kind: "bool", bool: data !== 0 };
    case TYPE_REFERENCE:
      return { kind: "reference", reference: data >>> 0 };
    default:
      // Unknown typed value: fall back to the raw string when present.
      return rawValue === null
        ? { kind: "null" }
        : { kind: "string", string: rawValue };
  }
}

function applyAttribute(
  facts: RawManifestFacts,
  element: string,
  name: string,
  value: TypedValue,
): void {
  switch (name) {
    case "package":
      if (element === "manifest" && value.kind === "string" && value.string!.length > 0) {
        facts.packageName = value.string;
      }
      return;
    case "versionCode":
      if (element !== "manifest") return;
      if (value.kind !== "int" || value.int! <= 0) {
        throw invalid("AndroidManifest.xml versionCode must be a positive integer literal");
      }
      facts.versionCode = value.int;
      return;
    case "versionName":
      if (element !== "manifest") return;
      if (value.kind === "string") {
        facts.versionName = value.string!;
        facts.versionNameRef = null;
      } else if (value.kind === "reference") {
        facts.versionName = null;
        facts.versionNameRef = value.reference!;
      } else {
        facts.versionName = null;
      }
      return;
    case "label":
      if (element !== "application") return;
      if (value.kind === "string") {
        facts.label = value.string!;
        facts.labelRef = null;
      } else if (value.kind === "reference") {
        facts.label = null;
        facts.labelRef = value.reference!;
      }
      return;
    case "icon":
      if (element === "application" && value.kind === "reference") {
        facts.iconRef = value.reference!;
      }
      return;
    case "roundIcon":
      if (element === "application" && value.kind === "reference") {
        facts.roundIconRef = value.reference!;
      }
      return;
    case "minSdkVersion":
      if (element !== "uses-sdk") return;
      facts.minSdk = value.kind === "int" ? value.int! : null;
      return;
    case "targetSdkVersion":
      if (element !== "uses-sdk") return;
      facts.targetSdk = value.kind === "int" ? value.int! : null;
      return;
    case "debuggable":
      if (element !== "application") return;
      facts.debuggable = value.kind === "bool" ? value.bool! : false;
      return;
    case "testOnly":
      if (element !== "application") return;
      facts.testOnly = value.kind === "bool" ? value.bool! : false;
      return;
    case "split":
      if (element !== "manifest") return;
      facts.split = value.kind === "string" ? value.string! : null;
      return;
    case "configForSplit":
      if (element !== "manifest") return;
      facts.configForSplit = value.kind === "string" ? value.string! : null;
      return;
    default:
      return;
  }
}
