import type { ApkIconContentType, ApkIconDescriptor } from "./types";

/**
 * Dependency-free `resources.arsc` (ResTable) and binary XML reader. Corrupt or
 * oversized input is never fatal: `parseResTable`/`parseBinaryXml` return
 * `null`, which makes the affected value unavailable without failing an upload.
 *
 * Layout references (AOSP ResourceTypes.h):
 * - ResTable_header: chunk header + `packageCount`
 * - ResTable_package: `typeStrings` at +268, `keyStrings` at +276 (from package start)
 * - ResTable_typeSpec: id +8, entryCount +12
 * - ResTable_type: id +8, entryCount +12, entriesStart +16, config at +20
 * - ResTable_entry: size/flags/key; a simple Res_value follows at `entry + size`
 */

const RES_TABLE_TYPE = 0x0002;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;
const RES_TABLE_TYPE_TYPE = 0x0201;

const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const TYPE_INT_COLOR_ARGB8 = 0x1c;
const TYPE_INT_COLOR_RGB8 = 0x1d;
const TYPE_INT_COLOR_ARGB4 = 0x1e;
const TYPE_INT_COLOR_RGB4 = 0x1f;

const ENTRY_FLAG_COMPLEX = 0x0001;
const ENTRY_FLAG_COMPACT = 0x0008;
const NO_ENTRY = 0xffffffff;
const NO_ENTRY_LEGACY = 0xffff;

const UTF8_STRING_POOL_FLAG = 0x100;

export const DENSITY_ANY = 0xfffe;
export const DENSITY_NONE = 0xffff;

const MAX_ARSC_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_STRING_POOL_STRINGS = 1_000_000;
const MAX_TYPES = 256;
const MAX_ENTRIES_PER_TYPE = 100_000;
const MAX_REFERENCE_DEPTH = 8;

export interface ResourceConfig {
  language: string;
  country: string;
  density: number;
  sdkVersion: number;
}

export interface ResourceValue {
  dataType: number;
  data: number;
  /** Global-pool string for `TYPE_STRING`, otherwise `null`. */
  string: string | null;
}

export interface ResourceVariant {
  config: ResourceConfig;
  value: ResourceValue;
}

export interface ResTable {
  strings: string[];
  /** Resource id -> every configuration variant that defines it. */
  resources: Map<number, ResourceVariant[]>;
}

export interface ResolvedResource {
  dataType: number;
  data: number;
  string: string | null;
}

export interface XmlAttribute {
  name: string;
  dataType: number;
  value: string | number | boolean | null;
  raw: string | null;
  resourceId: number | null;
}

export interface XmlNode {
  name: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
}

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseResTable(bytes: Buffer): ResTable | null {
  try {
    return parseResTableUnsafe(bytes);
  } catch {
    return null;
  }
}

function parseResTableUnsafe(bytes: Buffer): ResTable | null {
  if (bytes.length < 12 || bytes.length > MAX_ARSC_INFLATED_BYTES) return null;
  if (u16(bytes, 0) !== RES_TABLE_TYPE) return null;

  const headerSize = u16(bytes, 2);
  const declaredSize = u32(bytes, 4);
  const end = Math.min(bytes.length, declaredSize);
  if (headerSize < 12 || end < 12) return null;

  let strings: string[] = [];
  const resources = new Map<number, ResourceVariant[]>();
  let position = headerSize;

  while (position + 8 <= end) {
    const type = u16(bytes, position);
    const chunkHeaderSize = u16(bytes, position + 2);
    const chunkSize = u32(bytes, position + 4);
    if (chunkSize < 8 || position + chunkSize > end) return null;

    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(bytes, position, chunkHeaderSize, chunkSize);
    } else if (type === RES_TABLE_PACKAGE_TYPE) {
      parsePackage(bytes, position, chunkHeaderSize, chunkSize, strings, resources);
    }

    position += chunkSize;
  }

  return { strings, resources };
}

function parseStringPool(
  buffer: Buffer,
  chunkStart: number,
  headerSize: number,
  chunkSize: number,
): string[] {
  if (headerSize < 28) fail("string pool header");
  const stringCount = u32(buffer, chunkStart + 8);
  if (stringCount > MAX_STRING_POOL_STRINGS) fail("string pool too large");
  const flags = u32(buffer, chunkStart + 16);
  const stringsStart = u32(buffer, chunkStart + 20);
  const chunkEnd = chunkStart + chunkSize;

  if (headerSize + stringCount * 4 > chunkSize) fail("string pool offsets");
  if (stringsStart > chunkSize) fail("string pool data");

  const utf8 = (flags & UTF8_STRING_POOL_FLAG) !== 0;
  const offsetsStart = chunkStart + headerSize;
  const dataStart = chunkStart + stringsStart;
  const strings: string[] = [];

  for (let index = 0; index < stringCount; index += 1) {
    const relativeOffset = u32(buffer, offsetsStart + index * 4);
    const stringStart = dataStart + relativeOffset;
    if (stringStart > chunkEnd) fail("string pool string offset");
    strings.push(readPoolString(buffer, stringStart, chunkEnd, utf8));
  }

  return strings;
}

function readPoolUtf8Length(
  buffer: Buffer,
  start: number,
  end: number,
): { length: number; next: number } {
  if (start >= end) fail("string truncated");
  let length = buffer[start]!;
  let position = start + 1;
  if ((length & 0x80) !== 0) {
    if (position >= end) fail("string truncated");
    length = ((length & 0x7f) << 8) | buffer[position]!;
    position += 1;
  }
  return { length, next: position };
}

function readPoolString(buffer: Buffer, start: number, end: number, utf8: boolean): string {
  if (utf8) {
    const utf16 = readPoolUtf8Length(buffer, start, end);
    const bytes = readPoolUtf8Length(buffer, utf16.next, end);
    if (bytes.next + bytes.length > end) fail("string truncated");
    return buffer.toString("utf8", bytes.next, bytes.next + bytes.length);
  }

  let position = start;
  if (position + 2 > end) fail("string truncated");
  let length = buffer.readUInt16LE(position);
  position += 2;
  if ((length & 0x8000) !== 0) {
    if (position + 2 > end) fail("string truncated");
    length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(position);
    position += 2;
  }
  const byteLength = length * 2;
  if (position + byteLength > end) fail("string truncated");
  return buffer.toString("utf16le", position, position + byteLength);
}

function parsePackage(
  buffer: Buffer,
  packageStart: number,
  headerSize: number,
  chunkSize: number,
  globalStrings: string[],
  resources: Map<number, ResourceVariant[]>,
): void {
  if (headerSize < 288) fail("package header");
  const packageEnd = packageStart + chunkSize;
  const packageId = u32(buffer, packageStart + 8);
  const typeStringsOffset = u32(buffer, packageStart + 268);
  const keyStringsOffset = u32(buffer, packageStart + 276);

  const typeStrings = parseStringPoolAt(buffer, packageStart, typeStringsOffset, packageEnd);
  const keyStrings = parseStringPoolAt(buffer, packageStart, keyStringsOffset, packageEnd);
  if (typeStrings.length > MAX_TYPES) fail("too many types");
  void keyStrings;

  let position = packageStart + headerSize;
  while (position + 8 <= packageEnd) {
    const type = u16(buffer, position);
    const chunkHeaderSize = u16(buffer, position + 2);
    const size = u32(buffer, position + 4);
    if (size < 8 || position + size > packageEnd) fail("package chunk");

    if (type === RES_TABLE_TYPE_TYPE) {
      parseType(
        buffer,
        position,
        chunkHeaderSize,
        size,
        packageId,
        typeStrings,
        globalStrings,
        resources,
      );
    } else if (type !== RES_TABLE_TYPE_SPEC_TYPE) {
      // Unknown package chunks are ignored for forward compatibility.
    }

    position += size;
  }
}

function parseStringPoolAt(
  buffer: Buffer,
  packageStart: number,
  relativeOffset: number,
  packageEnd: number,
): string[] {
  const start = packageStart + relativeOffset;
  if (start + 8 > packageEnd) return [];
  const headerSize = u16(buffer, start + 2);
  const size = u32(buffer, start + 4);
  if (size < 8 || start + size > packageEnd) return [];
  return parseStringPool(buffer, start, headerSize, size);
}

function parseType(
  buffer: Buffer,
  chunkStart: number,
  headerSize: number,
  chunkSize: number,
  packageId: number,
  typeStrings: string[],
  globalStrings: string[],
  resources: Map<number, ResourceVariant[]>,
): void {
  const typeId = buffer[chunkStart + 8]!;
  if (typeId === 0) return;
  const entryCount = u32(buffer, chunkStart + 12);
  if (entryCount > MAX_ENTRIES_PER_TYPE) fail("too many entries");
  const entriesStart = u32(buffer, chunkStart + 16);
  if (entriesStart > chunkSize) fail("entries start");
  const configSize = u32(buffer, chunkStart + 20);
  if (configSize < 24 || configSize > chunkSize) fail("config size");
  const offsetsStart = chunkStart + 20 + configSize;
  const chunkEnd = chunkStart + chunkSize;
  if (offsetsStart + entryCount * 4 > chunkEnd) fail("entry offsets");

  const config = parseConfig(buffer, chunkStart + 20);
  const typeName = typeStrings[typeId - 1];
  void typeName;

  for (let index = 0; index < entryCount; index += 1) {
    const offset = u32(buffer, offsetsStart + index * 4);
    if (offset === NO_ENTRY || offset === NO_ENTRY_LEGACY) continue;

    const entryStart = chunkStart + entriesStart + offset;
    if (entryStart + 8 > chunkEnd) continue;

    const entrySize = u16(buffer, entryStart);
    const flags = u16(buffer, entryStart + 2);
    if ((flags & ENTRY_FLAG_COMPLEX) !== 0) continue;
    if ((flags & ENTRY_FLAG_COMPACT) !== 0) continue;
    if (entrySize < 8) continue;

    const valueStart = entryStart + entrySize;
    if (valueStart + 8 > chunkEnd) continue;

    const dataType = buffer[valueStart + 3]!;
    const data = u32(buffer, valueStart + 4);
    const string = dataType === TYPE_STRING ? (globalStrings[data] ?? null) : null;

    const resourceId = (packageId << 24) | (typeId << 16) | index;
    const value: ResourceValue = { dataType, data, string };
    const variants = resources.get(resourceId);
    if (variants) variants.push({ config, value });
    else resources.set(resourceId, [{ config, value }]);
  }
}

function parseConfig(buffer: Buffer, configStart: number): ResourceConfig {
  return {
    language: readLocalePart(buffer, configStart + 8),
    country: readLocalePart(buffer, configStart + 10),
    density: buffer.readUInt16LE(configStart + 14),
    sdkVersion: buffer.readUInt16LE(configStart + 24),
  };
}

function readLocalePart(buffer: Buffer, offset: number): string {
  const first = buffer[offset] ?? 0;
  const second = buffer[offset + 1] ?? 0;
  if (first === 0 && second === 0) return "";
  // Packed 3-letter codes use the high bit; only plain two-letter codes map.
  if ((first & 0x80) !== 0 || (second & 0x80) !== 0) return "";
  const text = String.fromCharCode(first, second);
  return /^[A-Za-z]{2}$/.test(text) ? text.toLowerCase() : "";
}

function stringConfigScore(config: ResourceConfig): number {
  if (config.language.length === 0 && config.country.length === 0) {
    return config.density === 0 ? 0 : 1;
  }
  if (config.language.length === 0) return 1;
  if (config.language === "en") return 2;
  return 3;
}

function selectVariant(variants: readonly ResourceVariant[]): ResourceVariant | null {
  if (variants.length === 0) return null;
  let best = variants[0]!;
  let bestScore = stringConfigScore(best.config);
  for (let index = 1; index < variants.length; index += 1) {
    const candidate = variants[index]!;
    const score = stringConfigScore(candidate.config);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Follows resource references (max 8, cycle-safe) and returns the leaf value. */
export function resolveResource(table: ResTable, resourceId: number): ResolvedResource | null {
  let current = resourceId;
  const seen = new Set<number>();

  for (let depth = 0; depth <= MAX_REFERENCE_DEPTH; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);

    const variant = selectVariant(table.resources.get(current) ?? []);
    if (!variant) return null;

    const { dataType, data, string } = variant.value;
    if (dataType === TYPE_REFERENCE) {
      current = data;
      continue;
    }
    return { dataType, data, string };
  }

  return null;
}

export function resolveString(table: ResTable, resourceId: number): string | null {
  const resolved = resolveResource(table, resourceId);
  if (!resolved || resolved.dataType !== TYPE_STRING) return null;
  const value = resolved.string;
  return value !== null && value.trim().length > 0 ? value : null;
}

export function resolveLabel(table: ResTable, resourceId: number): string | null {
  return resolveString(table, resourceId);
}

export function resolveVersionName(table: ResTable, resourceId: number): string | null {
  return resolveString(table, resourceId);
}

export function resolveColor(
  table: ResTable,
  resourceId: number,
): { dataType: number; data: number } | null {
  const resolved = resolveResource(table, resourceId);
  if (!resolved || !isColorType(resolved.dataType)) return null;
  return { dataType: resolved.dataType, data: resolved.data >>> 0 };
}

function isColorType(dataType: number): boolean {
  return (
    dataType === TYPE_INT_COLOR_ARGB8 ||
    dataType === TYPE_INT_COLOR_RGB8 ||
    dataType === TYPE_INT_COLOR_ARGB4 ||
    dataType === TYPE_INT_COLOR_RGB4
  );
}

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).padStart(digits, "0");
}

/** Formats an ARGB/RGB color resource as `#rrggbb` or `#aarrggbb`. */
export function formatColor(dataType: number, data: number): string | null {
  switch (dataType) {
    case TYPE_INT_COLOR_ARGB8:
      return `#${hex(data, 8)}`;
    case TYPE_INT_COLOR_RGB8:
      return `#ff${hex(data & 0x00ffffff, 6)}`;
    case TYPE_INT_COLOR_ARGB4: {
      const nibbles = (data >>> 0) & 0xffff;
      const expand = (value: number) => (value << 4) | value;
      const a = expand((nibbles >> 12) & 0xf);
      const r = expand((nibbles >> 8) & 0xf);
      const g = expand((nibbles >> 4) & 0xf);
      const b = expand(nibbles & 0xf);
      return `#${hex(a, 2)}${hex(r, 2)}${hex(g, 2)}${hex(b, 2)}`;
    }
    case TYPE_INT_COLOR_RGB4: {
      const nibbles = (data >>> 0) & 0x0fff;
      const expand = (value: number) => (value << 4) | value;
      const r = expand((nibbles >> 8) & 0xf);
      const g = expand((nibbles >> 4) & 0xf);
      const b = expand(nibbles & 0xf);
      return `#ff${hex(r, 2)}${hex(g, 2)}${hex(b, 2)}`;
    }
    default:
      return null;
  }
}

export interface IconLeaf {
  resourceId: number;
  config: ResourceConfig;
  value: ResolvedResource;
}

/**
 * Collects every leaf value reachable from an icon resource id, across all
 * configuration variants. Reference chains are followed with a cycle guard.
 */
export function collectIconLeaves(table: ResTable, resourceId: number): IconLeaf[] {
  const leaves: IconLeaf[] = [];
  const visited = new Set<number>();
  const queue: number[] = [resourceId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const variant of table.resources.get(current) ?? []) {
      if (variant.value.dataType === TYPE_REFERENCE) {
        if (!visited.has(variant.value.data)) queue.push(variant.value.data);
        continue;
      }
      leaves.push({
        resourceId: current,
        config: variant.config,
        value: {
          dataType: variant.value.dataType,
          data: variant.value.data,
          string: variant.value.string,
        },
      });
    }
  }

  return leaves;
}

export type ReadXmlEntry = (entry: string) => Buffer | null | Promise<Buffer | null>;

interface IconCandidate {
  entry: string;
  config: ResourceConfig;
  kind: "raster" | "adaptive" | "vector";
  contentType: ApkIconContentType | null;
}

const RASTER_CONTENT_TYPES: Record<string, ApkIconContentType> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function entryExtension(entry: string): string {
  const dot = entry.lastIndexOf(".");
  return dot >= 0 ? entry.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolves the launcher icon descriptor. The server stores rasters, so the
 * highest-density raster wins; adaptive/vector XML is used only when no raster
 * variant exists. XML entries are read through `readEntry` to classify the root.
 */
export async function resolveIconDescriptor(
  table: ResTable,
  resourceId: number,
  readEntry: ReadXmlEntry,
): Promise<ApkIconDescriptor | null> {
  const candidates: IconCandidate[] = [];
  const seenEntries = new Set<string>();

  for (const leaf of collectIconLeaves(table, resourceId)) {
    if (leaf.value.dataType !== TYPE_STRING || leaf.value.string === null) continue;
    const entry = leaf.value.string.trim();
    if (entry.length === 0 || seenEntries.has(entry)) continue;
    seenEntries.add(entry);

    const extension = entryExtension(entry);
    const contentType = RASTER_CONTENT_TYPES[extension];
    if (contentType) {
      candidates.push({ entry, config: leaf.config, kind: "raster", contentType });
      continue;
    }
    if (extension !== "xml") continue;

    let xml: Buffer | null;
    try {
      xml = await readEntry(entry);
    } catch {
      xml = null;
    }
    if (!xml) continue;
    const root = parseBinaryXml(xml);
    if (!root) continue;
    if (root.name === "adaptive-icon") {
      candidates.push({ entry, config: leaf.config, kind: "adaptive", contentType: null });
    } else if (root.name === "vector") {
      candidates.push({ entry, config: leaf.config, kind: "vector", contentType: null });
    }
  }

  const raster = candidates.filter((candidate) => candidate.kind === "raster");
  if (raster.length > 0) {
    raster.sort((left, right) => {
      const density =
        normalizeDensity(right.config.density) - normalizeDensity(left.config.density);
      if (density !== 0) return density;
      return left.entry.localeCompare(right.entry);
    });
    const best = raster[0]!;
    return {
      kind: "raster",
      entry: best.entry,
      contentType: best.contentType!,
      resourceId,
      density: best.config.density,
    };
  }

  const xmlCandidates = candidates.filter((candidate) => candidate.kind !== "raster");
  if (xmlCandidates.length === 0) return null;
  xmlCandidates.sort((left, right) => {
    const density = xmlConfigRank(left.config) - xmlConfigRank(right.config);
    if (density !== 0) return density;
    return left.entry.localeCompare(right.entry);
  });
  const best = xmlCandidates[0]!;
  return {
    kind: best.kind === "adaptive" ? "adaptive" : "vector",
    entry: best.entry,
    resourceId,
  };
}

function normalizeDensity(density: number): number {
  if (density === DENSITY_ANY || density === DENSITY_NONE) return 0;
  return density;
}

function xmlConfigRank(config: ResourceConfig): number {
  if (config.density === DENSITY_ANY) return 0;
  if (config.language.length === 0 && config.country.length === 0 && config.density === 0) {
    return 1;
  }
  return 2 + config.sdkVersion;
}

export function parseBinaryXml(bytes: Buffer): XmlNode | null {
  try {
    return parseBinaryXmlUnsafe(bytes);
  } catch {
    return null;
  }
}

function parseBinaryXmlUnsafe(bytes: Buffer): XmlNode | null {
  if (bytes.length < 8) return null;
  if (u16(bytes, 0) !== RES_XML_TYPE) return null;

  const headerSize = u16(bytes, 2);
  const declaredSize = u32(bytes, 4);
  const end = Math.min(bytes.length, declaredSize);
  if (headerSize < 8 || end < 8) return null;

  let strings: string[] | null = null;
  let root: XmlNode | null = null;
  const stack: XmlNode[] = [];
  let position = headerSize;

  while (position + 8 <= end) {
    const type = u16(bytes, position);
    const chunkHeaderSize = u16(bytes, position + 2);
    const chunkSize = u32(bytes, position + 4);
    if (chunkSize < 8 || position + chunkSize > end) break;

    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(bytes, position, chunkHeaderSize, chunkSize);
    } else if (type === RES_XML_START_ELEMENT) {
      if (strings === null) break;
      const node = parseStartElementXml(bytes, position, chunkSize, strings);
      if (node) {
        if (stack.length === 0) {
          if (root === null) root = node;
        } else {
          stack[stack.length - 1]!.children.push(node);
        }
        stack.push(node);
      }
    } else if (type === RES_XML_END_ELEMENT) {
      stack.pop();
    }

    position += chunkSize;
  }

  return root;
}

function parseStartElementXml(
  buffer: Buffer,
  chunkStart: number,
  chunkSize: number,
  strings: string[],
): XmlNode | null {
  if (chunkSize < 36) return null;
  const attributeStart = u16(buffer, chunkStart + 24);
  const attributeSize = u16(buffer, chunkStart + 26);
  const attributeCount = u16(buffer, chunkStart + 28);
  if (attributeSize < 20) return null;

  const nameIndex = u32(buffer, chunkStart + 20);
  const name = strings[nameIndex];
  if (name === undefined) return null;

  const attributesStart = chunkStart + 16 + attributeStart;
  const chunkEnd = chunkStart + chunkSize;
  const attributes: XmlAttribute[] = [];

  for (let index = 0; index < attributeCount; index += 1) {
    const position = attributesStart + index * attributeSize;
    if (position + 20 > chunkEnd) break;

    const attributeName = strings[u32(buffer, position + 4)] ?? "";
    const rawIndex = u32(buffer, position + 8);
    const raw = rawIndex === NO_ENTRY ? null : (strings[rawIndex] ?? null);
    const dataType = buffer[position + 15]!;
    const data = u32(buffer, position + 16);
    attributes.push({
      name: attributeName,
      dataType,
      value: decodeXmlValue(dataType, data, raw, strings),
      raw,
      resourceId: dataType === TYPE_REFERENCE ? data >>> 0 : null,
    });
  }

  return { name, attributes, children: [] };
}

function decodeXmlValue(
  dataType: number,
  data: number,
  raw: string | null,
  strings: string[],
): string | number | boolean | null {
  switch (dataType) {
    case TYPE_STRING:
      return strings[data] ?? raw;
    case TYPE_REFERENCE:
      return data >>> 0;
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_INT_DEC:
    case TYPE_INT_HEX:
      return data > 0x7fffffff ? data - 0x100000000 : data;
    case TYPE_FLOAT:
      return Buffer.from(new Uint32Array([data]).buffer).readFloatLE(0);
    case TYPE_INT_COLOR_ARGB8:
    case TYPE_INT_COLOR_RGB8:
    case TYPE_INT_COLOR_ARGB4:
    case TYPE_INT_COLOR_RGB4:
      return data >>> 0;
    default:
      return raw ?? (data >>> 0);
  }
}
