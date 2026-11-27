export type ApkAbi =
  | "universal"
  | "arm64-v8a"
  | "armeabi-v7a"
  | "x86_64"
  | "x86"
  | "riscv64"
  | "armeabi";

export type ApkIconContentType = "image/png" | "image/webp" | "image/jpeg";

/**
 * Launcher icon resolved from `resources.arsc`, never containing image bytes.
 * The dashboard previews `entry` itself; the server only extracts rasters.
 */
export type ApkIconDescriptor =
  | {
      kind: "raster";
      entry: string;
      contentType: ApkIconContentType;
      resourceId: number;
      density: number;
    }
  | { kind: "adaptive"; entry: string; resourceId: number }
  | { kind: "vector"; entry: string; resourceId: number };

export type VersionNameSource = "literal" | "resource" | "none";

/**
 * Metadata parsed from an APK's binary `AndroidManifest.xml` plus its native
 * library directories. Shared contract with the CLI and dashboard.
 */
export interface ApkMetadata {
  packageName: string;
  /** Positive integer literal from `android:versionCode`. */
  versionCode: number;
  /** `null` when the manifest uses an unresolvable reference or non-string type. */
  versionName: string | null;
  /** How `versionName` was obtained; `none` means the fallback applies. */
  versionNameSource: VersionNameSource;
  /** `android:label` after resolving a resource reference through `resources.arsc`. */
  label: string | null;
  /** Launcher icon descriptor resolved from `android:icon`/`android:roundIcon`. */
  icon: ApkIconDescriptor | null;
  minSdk: number | null;
  targetSdk: number | null;
  /** ABI directories under `lib/`; never contains `universal`. */
  abis: ApkAbi[];
  /** `true` when the APK is not a single-ABI split (0 or more than 1 ABI). */
  universal: boolean;
  debuggable: boolean;
  testOnly: boolean;
  /** `android:split` value, when present. */
  split: string | null;
  /** `true` for configuration splits, which the server rejects. */
  configSplit: boolean;
}

/** `ApkMetadata` plus the ABI the artifact is stored under. */
export interface DetectedApk extends ApkMetadata {
  artifactAbi: ApkAbi;
}

/** Response body of `POST /api/v1/import`. */
export interface ImportResult {
  app: AppDetail;
  version: VersionAdmin;
  detected: DetectedApk;
  artifact: ApkArtifactSummary;
  createdApp: boolean;
  createdVersion: boolean;
}

export interface AppManifest {
  schemaVersion: number;
  name: string;
  packageName: string;
  /**
   * `true` once the package is authoritative for upload verification. `false`
   * means `packageName` is only a placeholder (usually the app id).
   */
  packageBound: boolean;
  description: string;
  developer: string;
  icon: string;
}

export interface ApkArtifactManifest {
  abi: string;
  file: string;
  sha256?: string | null;
}

export interface VersionManifest {
  versionCode: number;
  versionName?: string;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string;
  file?: string;
  sha256?: string | null;
  artifacts?: ApkArtifactManifest[];
  /** Server-owned raster icon filename (`version_icon.<ext>`). */
  icon?: string;
  /** Package name read from the APK that first populated this version. */
  detectedPackageName?: string;
}

export interface ApkArtifactRecord {
  abi: ApkAbi;
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  mtime: Date;
}

export interface VersionRecord {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  artifacts: ApkArtifactRecord[];
  defaultArtifact: ApkArtifactRecord;
  /** Resolved `version.json.icon` file, used for the app icon fallback. */
  iconPath: string | null;
  iconContentType: string | null;
}

export interface AppRecord {
  id: string;
  name: string;
  packageName: string;
  packageBound: boolean;
  description: string;
  developer: string;
  iconPath: string | null;
  iconContentType: string | null;
  versions: VersionRecord[];
}

export interface ApkArtifactSummary {
  abi: ApkAbi;
  sizeBytes: number;
  sha256: string | null;
  downloadPath: string;
}

export interface VersionAdminArtifact extends ApkArtifactSummary {
  /** Server-owned file name inside the version directory. */
  filename: string;
}

/**
 * Admin representation of a version. Unlike `VersionSummary` it tolerates an
 * empty artifact set, so a version created before its first APK upload is
 * visible through the write API (a "draft") but not through the public catalog.
 */
export interface VersionAdmin {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  draft: boolean;
  abis: ApkAbi[];
  universal: boolean;
  artifacts: VersionAdminArtifact[];
  defaultArtifact: VersionAdminArtifact | null;
  sizeBytes: number | null;
  sha256: string | null;
  downloadPath: string | null;
}

/** Parsed version manifest plus its resolved artifacts, used by the writer. */
export interface VersionEntry {
  dir: string;
  dirName: string;
  manifest: Record<string, unknown>;
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  artifacts: ApkArtifactRecord[];
  /** `version.json.icon` filename when it resolves to a file in the version dir. */
  icon: string | null;
  iconPath: string | null;
  iconContentType: string | null;
  /** Package name recorded from the APK upload. */
  detectedPackageName: string | null;
}

export interface VersionSummary {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  sizeBytes: number;
  sha256: string | null;
  downloadPath: string;
  abis: ApkAbi[];
  universal: boolean;
  artifacts: ApkArtifactSummary[];
}

export interface AppSummary {
  id: string;
  name: string;
  packageName: string;
  /** `false` while the package is only a placeholder awaiting the first APK. */
  packageBound: boolean;
  description: string;
  developer: string;
  iconPath: string | null;
  versionCount: number;
  latestVersion: VersionSummary | null;
}

export interface AppDetail extends AppSummary {
  versions: VersionSummary[];
}

export interface DownloadRecord {
  path: string;
  fileSize: number;
  sha256: string | null;
  filename: string;
  abi: ApkAbi;
}

export type DownloadLookup =
  | { ok: true; download: DownloadRecord }
  | { ok: false; reason: "app_not_found" | "version_not_found" | "abi_not_found" };
