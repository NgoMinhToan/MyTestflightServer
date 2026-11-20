export type ApkAbi =
  | "universal"
  | "arm64-v8a"
  | "armeabi-v7a"
  | "x86_64"
  | "x86"
  | "riscv64"
  | "armeabi";

export interface AppManifest {
  schemaVersion: number;
  name: string;
  packageName: string;
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
}

export interface AppRecord {
  id: string;
  name: string;
  packageName: string;
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
