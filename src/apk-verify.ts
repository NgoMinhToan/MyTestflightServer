import { artifactAbiOf } from "./apk-inspect";
import type { ApkAbi, ApkMetadata } from "./types";

export type MismatchKind = "package" | "version" | "sdk" | "abi";

export const MISMATCH_KINDS: readonly MismatchKind[] = [
  "package",
  "version",
  "sdk",
  "abi",
];

export interface ExpectedApkMetadata {
  /** App id from the route/volume; used for the placeholder-package rule. */
  appId: string;
  /** `app.json.packageName`; may be `""` or the app id (both are treated as unset). */
  packageName: string;
  versionName: string;
  versionCode: number;
  minSdk: number | null;
}

export interface VerifyApkMetadataOptions {
  metadata: ApkMetadata;
  expected: ExpectedApkMetadata;
  /** ABI from the route, or `null` for the auto-ABI/import routes. */
  declaredAbi?: ApkAbi | null;
  allow?: Iterable<MismatchKind>;
}

/**
 * Pure metadata comparison shared by every upload/import route. Returns one
 * human-readable string per mismatched field; empty means the APK matches.
 */
export function verifyApkMetadata(options: VerifyApkMetadataOptions): string[] {
  const { metadata, expected } = options;
  const allow = new Set<MismatchKind>(options.allow ?? []);
  const mismatches: string[] = [];

  const packageUnset =
    expected.packageName.length === 0 || expected.packageName === expected.appId;
  if (
    !allow.has("package") &&
    !packageUnset &&
    metadata.packageName !== expected.packageName
  ) {
    mismatches.push(
      `packageName '${metadata.packageName}' != app '${expected.packageName}'`,
    );
  }

  if (!allow.has("version")) {
    if (metadata.versionCode !== expected.versionCode) {
      mismatches.push(`versionCode ${metadata.versionCode} != ${expected.versionCode}`);
    }
    if (
      metadata.versionName !== null &&
      metadata.versionName !== expected.versionName
    ) {
      mismatches.push(
        `versionName '${metadata.versionName}' != '${expected.versionName}'`,
      );
    }
  }

  if (
    !allow.has("sdk") &&
    metadata.minSdk !== null &&
    expected.minSdk !== null &&
    metadata.minSdk !== expected.minSdk
  ) {
    mismatches.push(`minSdk ${metadata.minSdk} != ${expected.minSdk}`);
  }

  if (!allow.has("abi") && options.declaredAbi) {
    const detected = artifactAbiOf(metadata);
    if (options.declaredAbi !== detected) {
      mismatches.push(`abi ${options.declaredAbi} != detected ${detected}`);
    }
  }

  return mismatches;
}

export function formatMismatch(mismatches: readonly string[]): string {
  return mismatches.join("; ");
}
