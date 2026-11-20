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
