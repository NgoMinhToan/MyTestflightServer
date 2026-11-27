import { readApkEntryBytes } from "./apk-inspect";
import type { ApkIconContentType, ApkIconDescriptor } from "./types";

export const MAX_RASTER_ICON_BYTES = 2 * 1024 * 1024;

export interface ExtractedRasterIcon {
  bytes: Buffer;
  ext: "png" | "webp" | "jpg";
  contentType: ApkIconContentType;
  filename: string;
}

interface ContentTypeInfo {
  ext: "png" | "webp" | "jpg";
  matches: (bytes: Buffer) => boolean;
}

const CONTENT_TYPES: Record<ApkIconContentType, ContentTypeInfo> = {
  "image/png": {
    ext: "png",
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  "image/webp": {
    ext: "webp",
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes.toString("latin1", 0, 4) === "RIFF" &&
      bytes.toString("latin1", 8, 12) === "WEBP",
  },
  "image/jpeg": {
    ext: "jpg",
    matches: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
};

/** Server-owned file name for a version icon. */
export function versionIconName(contentType: ApkIconContentType): string {
  return `version_icon.${CONTENT_TYPES[contentType].ext}`;
}

export function iconContentTypeOf(filename: string): ApkIconContentType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

/**
 * Extracts one raster launcher icon from an APK. Best-effort: adaptive/vector
 * descriptors, missing entries, oversized files, or mismatched magic bytes all
 * return `null`.
 */
export async function extractRasterIcon(
  apkPath: string,
  descriptor: ApkIconDescriptor | null,
): Promise<ExtractedRasterIcon | null> {
  if (descriptor === null || descriptor.kind !== "raster") return null;

  const info = CONTENT_TYPES[descriptor.contentType];
  if (!info) return null;

  let bytes: Buffer | null;
  try {
    bytes = await readApkEntryBytes(apkPath, descriptor.entry, {
      maxCompressedBytes: MAX_RASTER_ICON_BYTES,
      maxInflatedBytes: MAX_RASTER_ICON_BYTES,
    });
  } catch {
    return null;
  }
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_RASTER_ICON_BYTES) {
    return null;
  }
  if (!info.matches(bytes)) return null;

  return {
    bytes,
    ext: info.ext,
    contentType: descriptor.contentType,
    filename: versionIconName(descriptor.contentType),
  };
}
