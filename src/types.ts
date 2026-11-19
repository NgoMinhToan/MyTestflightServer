export interface AppManifest {
  schemaVersion: number;
  name: string;
  packageName: string;
  description: string;
  developer: string;
  icon: string;
}

export interface VersionManifest {
  versionCode: number;
  versionName: string;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  file: string;
  sha256: string | null;
}

export interface VersionRecord {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  sizeBytes: number;
  sha256: string | null;
  apkPath: string;
  apkFilename: string;
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

export interface VersionSummary {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  sizeBytes: number;
  sha256: string | null;
  downloadPath: string;
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
}
