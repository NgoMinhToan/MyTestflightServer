import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config";
import type {
  AppDetail,
  AppManifest,
  AppRecord,
  AppSummary,
  DownloadRecord,
  VersionRecord,
  VersionSummary,
} from "./types";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const APK_EXTENSION = /\.apk$/i;
const DEFAULT_ICON = "app_icon.png";

const ICON_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isProvisioned(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "EISDIR" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function humanizeAppId(id: string): string {
  const parts = id.split(/[-_.]+/).filter((part) => part.length > 0);
  const name = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return name || id;
}

function defaultAppManifest(id: string): AppManifest {
  return {
    schemaVersion: 1,
    name: humanizeAppId(id),
    packageName: id,
    description: "",
    developer: "",
    icon: DEFAULT_ICON,
  };
}

function normalizeAppManifest(value: unknown, id: string): AppManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("app.json must contain a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    schemaVersion:
      typeof record.schemaVersion === "number" && Number.isFinite(record.schemaVersion)
        ? record.schemaVersion
        : 1,
    name: nonBlankString(record.name) ?? humanizeAppId(id),
    packageName: nonBlankString(record.packageName) ?? id,
    description: typeof record.description === "string" ? record.description : "",
    developer: typeof record.developer === "string" ? record.developer : "",
    icon: nonBlankString(record.icon) ?? DEFAULT_ICON,
  };
}

/**
 * Resolves `candidate` inside `base`, rejecting absolute paths and anything
 * that escapes `base` (including `..` segments).
 */
function containedPath(base: string, candidate: string): string | null {
  if (candidate.length === 0 || path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function resolvePublishedAt(value: unknown, mtime: Date): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return mtime.toISOString();
}

function resolveSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SHA256_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

async function readRegularJsonFile(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text);
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export class AppsService {
  constructor(
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async ensureVolume(): Promise<void> {
    await fs.mkdir(path.join(this.config.dataDir, "apps"), { recursive: true });
  }

  async scan(): Promise<AppRecord[]> {
    const appsDir = path.join(this.config.dataDir, "apps");
    try {
      await this.ensureVolume();
    } catch (error) {
      this.logger.warn(
        { err: error, appsDir },
        "could not create apps directory; continuing with existing content",
      );
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(appsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const ids = entries
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    const records: AppRecord[] = [];
    for (const id of ids) {
      try {
        records.push(await this.readApp(appsDir, id));
      } catch (error) {
        this.logger.warn({ err: error, appId: id }, "skipping app with unreadable manifest");
      }
    }

    records.sort(
      (left, right) => collator.compare(left.name, right.name) || left.id.localeCompare(right.id),
    );
    return records;
  }

  async listApps(): Promise<AppSummary[]> {
    const records = await this.scan();
    return records.map((record) => this.toSummary(record));
  }

  async getApp(id: string): Promise<AppDetail | null> {
    const record = (await this.scan()).find((candidate) => candidate.id === id);
    if (!record) return null;
    return {
      ...this.toSummary(record),
      versions: record.versions.map((version) => this.toVersionSummary(record.id, version)),
    };
  }

  async getIcon(id: string): Promise<{ path: string; contentType: string } | null> {
    const record = (await this.scan()).find((candidate) => candidate.id === id);
    if (!record || !record.iconPath || !record.iconContentType) return null;
    return { path: record.iconPath, contentType: record.iconContentType };
  }

  async getDownload(id: string, versionName: string): Promise<DownloadRecord | null> {
    const record = (await this.scan()).find((candidate) => candidate.id === id);
    if (!record) return null;
    const version = record.versions.find((candidate) => candidate.versionName === versionName);
    if (!version) return null;
    return {
      path: version.apkPath,
      fileSize: version.sizeBytes,
      sha256: version.sha256,
      filename: `${record.id}-${version.versionName}.apk`,
    };
  }

  private toSummary(record: AppRecord): AppSummary {
    const latest = record.versions[0];
    return {
      id: record.id,
      name: record.name,
      packageName: record.packageName,
      description: record.description,
      developer: record.developer,
      iconPath: record.iconPath ? `/api/v1/apps/${record.id}/icon` : null,
      versionCount: record.versions.length,
      latestVersion: latest ? this.toVersionSummary(record.id, latest) : null,
    };
  }

  private toVersionSummary(appId: string, version: VersionRecord): VersionSummary {
    return {
      versionName: version.versionName,
      versionCode: version.versionCode,
      minSdk: version.minSdk,
      releaseNotes: version.releaseNotes,
      publishedAt: version.publishedAt,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      downloadPath: `/api/v1/apps/${appId}/versions/${version.versionName}/download`,
    };
  }

  private async readApp(appsDir: string, id: string): Promise<AppRecord> {
    const appDir = path.join(appsDir, id);
    const manifest = await this.readOrCreateAppManifest(appDir, id);

    const versionsDir = path.join(appDir, "versions");
    await this.ensureVersionsDir(versionsDir);

    let versionEntries: Dirent[] = [];
    try {
      versionEntries = await fs.readdir(versionsDir, { withFileTypes: true });
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.warn({ err: error, appId: id }, "could not read versions directory");
      }
    }

    const versionDirs = versionEntries
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const versions: VersionRecord[] = [];
    const seenVersionNames = new Set<string>();
    for (const dirName of versionDirs) {
      let version: VersionRecord | null;
      try {
        version = await this.readVersion(path.join(versionsDir, dirName), dirName);
      } catch (error) {
        this.logger.warn(
          { err: error, appId: id, versionDir: dirName },
          "skipping unreadable version",
        );
        continue;
      }
      if (!version) continue;
      if (seenVersionNames.has(version.versionName)) {
        this.logger.warn(
          { appId: id, versionDir: dirName, versionName: version.versionName },
          "skipping duplicate versionName",
        );
        continue;
      }
      seenVersionNames.add(version.versionName);
      versions.push(version);
    }

    versions.sort(
      (left, right) =>
        right.versionCode - left.versionCode ||
        collator.compare(right.versionName, left.versionName),
    );

    const icon = await this.resolveIcon(appDir, manifest.icon);
    return {
      id,
      name: manifest.name,
      packageName: manifest.packageName,
      description: manifest.description,
      developer: manifest.developer,
      iconPath: icon?.path ?? null,
      iconContentType: icon?.contentType ?? null,
      versions,
    };
  }

  private async readOrCreateAppManifest(appDir: string, id: string): Promise<AppManifest> {
    const manifestPath = path.join(appDir, "app.json");
    let raw: unknown;
    try {
      raw = await readRegularJsonFile(manifestPath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw new Error(`app.json is invalid: ${errorMessage(error)}`);
      }
      const manifest = defaultAppManifest(id);
      try {
        await writeJsonExclusive(manifestPath, manifest);
      } catch (writeError) {
        if (!isProvisioned(writeError)) {
          this.logger.warn(
            { err: writeError, appId: id },
            "could not create app.json; using the derived manifest in memory",
          );
        }
      }
      return manifest;
    }
    return normalizeAppManifest(raw, id);
  }

  private async ensureVersionsDir(versionsDir: string): Promise<void> {
    try {
      await fs.mkdir(versionsDir, { recursive: true });
    } catch (error) {
      if (!isProvisioned(error)) {
        this.logger.warn(
          { err: error, versionsDir },
          "could not create versions directory; continuing with existing content",
        );
      }
    }
  }

  private async readVersion(versionDir: string, dirName: string): Promise<VersionRecord | null> {
    let raw: unknown;
    try {
      raw = await readRegularJsonFile(path.join(versionDir, "version.json"));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("version.json must contain a JSON object");
    }
    const manifest = raw as Record<string, unknown>;

    const versionCode = manifest.versionCode;
    if (
      typeof versionCode !== "number" ||
      !Number.isInteger(versionCode) ||
      versionCode <= 0
    ) {
      this.logger.warn(
        { versionDir, versionCode },
        "skipping version with an invalid versionCode",
      );
      return null;
    }

    let versionName = dirName;
    const declaredName = nonBlankString(manifest.versionName);
    if (declaredName !== null) {
      if (!ID_PATTERN.test(declaredName)) {
        this.logger.warn(
          { versionDir, versionName: declaredName },
          "skipping version with an invalid versionName",
        );
        return null;
      }
      versionName = declaredName;
    }

    const apk = await this.resolveApk(versionDir, manifest.file);
    if (!apk) {
      this.logger.warn({ versionDir }, "skipping version without a resolvable APK");
      return null;
    }

    const minSdkValue = manifest.minSdk;
    const minSdk =
      typeof minSdkValue === "number" && Number.isInteger(minSdkValue) && minSdkValue > 0
        ? minSdkValue
        : null;

    return {
      versionName,
      versionCode,
      minSdk,
      releaseNotes: typeof manifest.releaseNotes === "string" ? manifest.releaseNotes : null,
      publishedAt: resolvePublishedAt(manifest.publishedAt, apk.mtime),
      sizeBytes: apk.sizeBytes,
      sha256: resolveSha256(manifest.sha256),
      apkPath: apk.path,
      apkFilename: apk.filename,
    };
  }

  private async resolveApk(
    versionDir: string,
    declared: unknown,
  ): Promise<{ path: string; filename: string; sizeBytes: number; mtime: Date } | null> {
    let filename: string | null = null;

    if (declared === undefined || declared === null || declared === "") {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(versionDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const apkNames = entries
        .filter((entry) => entry.isFile() && APK_EXTENSION.test(entry.name))
        .map((entry) => entry.name);
      if (apkNames.length !== 1) return null;
      filename = apkNames[0] ?? null;
    } else if (typeof declared === "string" && declared.trim().length > 0) {
      filename = declared.trim();
    } else {
      return null;
    }

    if (filename === null || !APK_EXTENSION.test(filename)) return null;

    const resolved = containedPath(versionDir, filename);
    if (resolved === null) return null;

    let stat;
    try {
      stat = await fs.lstat(resolved);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (!stat.isFile()) return null;

    return {
      path: resolved,
      filename: path.basename(resolved),
      sizeBytes: stat.size,
      mtime: stat.mtime,
    };
  }

  private async resolveIcon(
    appDir: string,
    declared: string,
  ): Promise<{ path: string; contentType: string } | null> {
    const resolved = containedPath(appDir, declared);
    if (resolved === null) return null;
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isFile()) return null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const contentType =
      ICON_CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
    return { path: resolved, contentType };
  }
}
