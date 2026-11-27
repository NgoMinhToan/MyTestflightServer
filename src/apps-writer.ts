import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config";
import { HttpError } from "./http-errors";
import type { AppsService } from "./apps-service";
import { artifactAbiOf, inspectApkFile, toDetected } from "./apk-inspect";
import {
  formatMismatch,
  verifyApkMetadata,
  type MismatchKind,
} from "./apk-verify";
import type {
  ApkAbi,
  ApkArtifactRecord,
  ApkMetadata,
  AppManifest,
  DetectedApk,
  ImportResult,
} from "./types";
import {
  DEFAULT_ICON,
  ICON_EXTENSIONS,
  ID_PATTERN,
  MAX_ICON_BYTES,
  compareAbi,
  containedPath,
  defaultAppManifest,
  errorCode,
  humanizeAppId,
  isNotFound,
  nonBlankString,
  readJsonObject,
  resolveAppDir,
  unlinkIfExists,
  withLock,
  writeJsonAtomic,
} from "./volume";

export interface CreateAppInput {
  id: string;
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
  icon?: string;
}

export interface UpdateAppInput {
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
  icon?: string;
}

export interface CreateVersionInput {
  versionName: string;
  versionCode: number;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

export interface UpdateVersionInput {
  versionName?: string;
  versionCode?: number;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

interface ReceivedUpload {
  tempPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ReceivedApk extends ReceivedUpload {
  metadata: ApkMetadata;
}

export interface StoreApkOptions {
  /** ABI from the route, or `null` to infer it from the APK. */
  declaredAbi: ApkAbi | null;
  allowMismatch: MismatchKind[];
  /** Overrides the package read from `app.json` (import pre-flight). */
  expectedPackageName?: string;
}

export interface PutArtifactOptions {
  /** ABI from the route, or `null` for `PUT .../artifacts`. */
  abi: ApkAbi | null;
  allowMismatch: MismatchKind[];
}

export interface ImportApkOptions {
  create: boolean;
  appId?: string;
  version?: string;
  versionCode?: number;
  name?: string;
  releaseNotes?: string;
  publishedAt?: string;
  allowMismatch: MismatchKind[];
}

/** Internal import result plus whether anything new was created. */
export interface ImportOutcome {
  result: ImportResult;
  created: boolean;
}

interface ArtifactManifestEntry {
  abi: ApkAbi;
  file: string;
  sha256?: string;
}

/**
 * All volume mutations live here. Reads used for responses go through
 * `AppsService` so the writer and the catalog share one validation model.
 */
export class AppsWriter {
  private readonly uploadsDir: string;

  constructor(
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
    private readonly reader: AppsService,
  ) {
    this.uploadsDir = path.join(config.dataDir, ".uploads");
  }

  async createApp(input: CreateAppInput): Promise<void> {
    this.assertId(input.id, "app id");
    const appsDir = path.join(this.config.dataDir, "apps");
    await fs.mkdir(appsDir, { recursive: true });
    const appDir = path.join(appsDir, input.id);

    await withLock(this.lockKey(input.id), async () => {
      try {
        await fs.mkdir(appDir);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new HttpError(409, "app_exists", `App "${input.id}" already exists`);
        }
        throw error;
      }

      try {
        await fs.mkdir(path.join(appDir, "versions"));
        const manifest: AppManifest = {
          schemaVersion: 1,
          name: input.name ?? humanizeAppId(input.id),
          packageName: input.packageName ?? input.id,
          description: input.description ?? "",
          developer: input.developer ?? "",
          icon: input.icon ?? DEFAULT_ICON,
        };
        await writeJsonAtomic(path.join(appDir, "app.json"), manifest);
      } catch (error) {
        await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async updateApp(appId: string, patch: UpdateAppInput): Promise<void> {
    this.assertId(appId, "app id");

    await withLock(this.lockKey(appId), async () => {
      const appDir = await this.requireAppDir(appId);
      const raw = await this.readAppObject(appDir, appId);
      const next: Record<string, unknown> = { ...raw };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.packageName !== undefined) next.packageName = patch.packageName;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.developer !== undefined) next.developer = patch.developer;
      if (patch.icon !== undefined) next.icon = patch.icon;
      await writeJsonAtomic(path.join(appDir, "app.json"), next);
    });
  }

  async deleteApp(appId: string): Promise<void> {
    this.assertId(appId, "app id");
    const appDir = await this.requireAppDir(appId);

    await withLock(this.lockKey(appId), async () => {
      try {
        await fs.rm(appDir, { recursive: true, force: false });
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
        }
        throw error;
      }
    });
  }

  async putIcon(appId: string, contentType: string, source: Readable | undefined): Promise<void> {
    this.assertId(appId, "app id");
    const extension = ICON_EXTENSIONS[contentType];
    if (!extension) {
      throw new HttpError(415, "unsupported_media_type", `Unsupported icon type "${contentType}"`);
    }
    await this.requireAppDir(appId);

    const received = await this.receiveToTemp(source, MAX_ICON_BYTES);
    let moved = false;
    try {
      await withLock(this.lockKey(appId), async () => {
        const appDir = await this.requireAppDir(appId);
        const raw = await this.readAppObject(appDir, appId);
        const filename = `app_icon.${extension}`;
        await fs.rename(received.tempPath, path.join(appDir, filename));
        moved = true;

        const previous = nonBlankString(raw.icon);
        await writeJsonAtomic(path.join(appDir, "app.json"), { ...raw, icon: filename });
        if (previous !== null && previous !== filename) {
          await this.unlinkContained(appDir, previous);
        }
      });
    } finally {
      if (!moved) {
        await unlinkIfExists(received.tempPath).catch(() => undefined);
      }
    }
  }

  async deleteIcon(appId: string): Promise<void> {
    this.assertId(appId, "app id");

    await withLock(this.lockKey(appId), async () => {
      const appDir = await this.requireAppDir(appId);
      const raw = await this.readAppObject(appDir, appId);
      const declared = nonBlankString(raw.icon) ?? DEFAULT_ICON;
      const resolved = containedPath(appDir, declared);
      if (resolved === null) {
        throw new HttpError(404, "icon_not_found", `No icon for app "${appId}"`);
      }
      let stat;
      try {
        stat = await fs.lstat(resolved);
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, "icon_not_found", `No icon for app "${appId}"`);
        }
        throw error;
      }
      if (!stat.isFile()) {
        throw new HttpError(404, "icon_not_found", `No icon for app "${appId}"`);
      }
      await fs.unlink(resolved);
    });
  }

  async createVersion(appId: string, input: CreateVersionInput): Promise<void> {
    this.assertId(appId, "app id");
    this.assertId(input.versionName, "version name");

    await withLock(this.lockKey(appId), async () => {
      const appDir = await this.requireAppDir(appId);
      const versionsDir = path.join(appDir, "versions");
      const versionDir = path.join(versionsDir, input.versionName);

      if ((await this.reader.getVersionEntry(appId, input.versionName)) !== null) {
        throw new HttpError(
          409,
          "version_exists",
          `Version "${input.versionName}" already exists`,
        );
      }

      try {
        await fs.mkdir(versionsDir, { recursive: true });
        await fs.mkdir(versionDir);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new HttpError(
            409,
            "version_exists",
            `Version "${input.versionName}" already exists`,
          );
        }
        throw error;
      }

      try {
        await writeJsonAtomic(
          path.join(versionDir, "version.json"),
          buildVersionManifest(input),
        );
      } catch (error) {
        await fs.rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async updateVersion(
    appId: string,
    versionName: string,
    input: UpdateVersionInput,
  ): Promise<void> {
    this.assertId(appId, "app id");
    this.assertId(versionName, "version name");
    if (input.versionName !== undefined && input.versionName !== versionName) {
      throw new HttpError(400, "invalid_request", "versionName cannot be changed");
    }

    await withLock(this.lockKey(appId), async () => {
      const entry = await this.requireVersion(appId, versionName);
      let manifest: Record<string, unknown>;
      try {
        manifest = await readJsonObject(path.join(entry.dir, "version.json"));
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
        }
        throw error;
      }

      const next: Record<string, unknown> = { ...manifest };
      if (input.versionCode !== undefined) next.versionCode = input.versionCode;
      if (input.minSdk !== undefined) {
        if (input.minSdk === null) delete next.minSdk;
        else next.minSdk = input.minSdk;
      }
      if (input.releaseNotes !== undefined) {
        if (input.releaseNotes === null) delete next.releaseNotes;
        else next.releaseNotes = input.releaseNotes;
      }
      if (input.publishedAt !== undefined) {
        if (input.publishedAt === null) delete next.publishedAt;
        else next.publishedAt = input.publishedAt;
      }
      await writeJsonAtomic(path.join(entry.dir, "version.json"), next);
    });
  }

  async deleteVersion(appId: string, versionName: string): Promise<void> {
    this.assertId(appId, "app id");
    this.assertId(versionName, "version name");

    await withLock(this.lockKey(appId), async () => {
      const entry = await this.requireVersion(appId, versionName);
      try {
        await fs.rm(entry.dir, { recursive: true, force: false });
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
        }
        throw error;
      }
    });
  }

  /**
   * Streams an APK to `.uploads/` then inspects its binary manifest. The temp
   * file is removed when inspection fails, including configuration splits.
   */
  async receiveApk(
    source: Readable | undefined,
    contentLength?: number,
  ): Promise<ReceivedApk> {
    if (contentLength !== undefined && contentLength > this.config.maxApkBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `APK exceeds ${this.config.maxApkBytes} bytes`,
      );
    }

    const received = await this.receiveToTemp(source, this.config.maxApkBytes);
    let metadata: ApkMetadata;
    try {
      metadata = await inspectApkFile(received.tempPath);
    } catch (error) {
      await unlinkIfExists(received.tempPath).catch(() => undefined);
      throw error;
    }

    if (metadata.configSplit) {
      await unlinkIfExists(received.tempPath).catch(() => undefined);
      throw new HttpError(
        400,
        "invalid_apk",
        `"${metadata.split ?? "config split"}" is a configuration split; upload the base APK instead`,
      );
    }

    return { ...received, metadata };
  }

  /** Removes the temp file if it was not moved into the version directory. */
  async discardApk(received: ReceivedApk): Promise<void> {
    await unlinkIfExists(received.tempPath).catch(() => undefined);
  }

  /**
   * Verifies inspected metadata against the app/version (and route ABI) and
   * moves the APK into place. Runs inside the per-app lock so the comparison
   * and the manifest rewrite cannot race another upload.
   */
  async storeApk(
    appId: string,
    versionName: string,
    received: ReceivedApk,
    options: StoreApkOptions,
  ): Promise<{ created: boolean }> {
    this.assertId(appId, "app id");
    this.assertId(versionName, "version name");

    return withLock(this.lockKey(appId), async () => {
      const entry = await this.requireVersion(appId, versionName);
      const appDir = await this.requireAppDir(appId);
      const appManifest = await this.readAppObject(appDir, appId);
      const expectedPackageName =
        options.expectedPackageName ??
        nonBlankString(appManifest.packageName) ??
        appId;
      const abi = options.declaredAbi ?? artifactAbiOf(received.metadata);

      const mismatches = verifyApkMetadata({
        metadata: received.metadata,
        expected: {
          appId,
          packageName: expectedPackageName,
          versionName: entry.versionName,
          versionCode: entry.versionCode,
          minSdk: entry.minSdk,
        },
        declaredAbi: options.declaredAbi,
        allow: options.allowMismatch,
      });
      if (mismatches.length > 0) {
        throw new HttpError(
          422,
          "apk_metadata_mismatch",
          formatMismatch(mismatches),
        );
      }

      const filename = `${abi}-${received.sha256.slice(0, 16)}.apk`;
      await fs.rename(received.tempPath, path.join(entry.dir, filename));

      const created = !entry.artifacts.some((artifact) => artifact.abi === abi);
      const artifacts: ArtifactManifestEntry[] = entry.artifacts
        .filter((artifact) => artifact.abi !== abi)
        .map((artifact) => ({
          abi: artifact.abi,
          file: artifact.filename,
          sha256: artifact.sha256 ?? undefined,
        }));
      artifacts.push({ abi, file: filename, sha256: received.sha256 });
      artifacts.sort((left, right) => compareAbi(left.abi, right.abi));

      const next: Record<string, unknown> = { ...entry.manifest, artifacts };
      delete next.file;
      delete next.sha256;
      // Auto-fill a missing minSdk from the APK; never overwrite a declared one.
      if (entry.minSdk === null && received.metadata.minSdk !== null) {
        next.minSdk = received.metadata.minSdk;
      }
      await writeJsonAtomic(path.join(entry.dir, "version.json"), next);
      await this.cleanupReplaced(entry.dir, entry.artifacts, artifacts, filename);
      return { created };
    });
  }

  /**
   * Upload pipeline used by both artifact routes: size check, version lookup,
   * receive + inspect, verify + store, and guaranteed temp cleanup.
   */
  async putArtifact(
    appId: string,
    versionName: string,
    source: Readable | undefined,
    contentLength: number | undefined,
    options: PutArtifactOptions,
  ): Promise<{ created: boolean; detected: DetectedApk }> {
    this.assertId(appId, "app id");
    this.assertId(versionName, "version name");
    if (contentLength !== undefined && contentLength > this.config.maxApkBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `APK exceeds ${this.config.maxApkBytes} bytes`,
      );
    }
    if ((await this.reader.getVersionEntry(appId, versionName)) === null) {
      throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
    }

    const received = await this.receiveApk(source, contentLength);
    try {
      const result = await this.storeApk(appId, versionName, received, {
        declaredAbi: options.abi,
        allowMismatch: options.allowMismatch,
      });
      return { created: result.created, detected: toDetected(received.metadata) };
    } finally {
      await this.discardApk(received);
    }
  }

  /**
   * APK-only import. Resolves the app and version from the query or the APK,
   * verifies metadata *before* creating anything, then creates the app/version
   * sequentially (never nested inside another lock for the same app).
   */
  async importApk(
    source: Readable | undefined,
    contentLength: number | undefined,
    options: ImportApkOptions,
  ): Promise<ImportOutcome> {
    if (contentLength !== undefined && contentLength > this.config.maxApkBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `APK exceeds ${this.config.maxApkBytes} bytes`,
      );
    }

    const received = await this.receiveApk(source, contentLength);
    try {
      const metadata = received.metadata;
      const appId = options.appId ?? metadata.packageName;
      this.assertId(appId, "app id");

      const existingApp = await this.reader.getApp(appId);
      if (!existingApp && !options.create) {
        throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
      }
      const appPackageName = existingApp
        ? existingApp.packageName
        : metadata.packageName;
      const appName =
        options.name ??
        (existingApp
          ? undefined
          : humanizeAppId(lastPackageSegment(metadata.packageName)));

      const versionName = options.version ?? metadata.versionName;
      if (versionName === null || versionName === undefined) {
        throw new HttpError(
          400,
          "invalid_request",
          "Cannot infer versionName from the APK; provide ?version=",
        );
      }
      this.assertId(versionName, "version name");

      const existingVersion =
        existingApp === null
          ? null
          : await this.reader.getVersionEntry(appId, versionName);
      const versionCode = existingVersion
        ? existingVersion.versionCode
        : (options.versionCode ?? metadata.versionCode);
      const minSdk = existingVersion ? existingVersion.minSdk : metadata.minSdk;

      // Verify before any write so a 422 leaves no orphan app/version.
      const mismatches = verifyApkMetadata({
        metadata,
        expected: {
          appId,
          packageName: appPackageName,
          versionName,
          versionCode,
          minSdk,
        },
        declaredAbi: null,
        allow: options.allowMismatch,
      });
      if (mismatches.length > 0) {
        throw new HttpError(
          422,
          "apk_metadata_mismatch",
          formatMismatch(mismatches),
        );
      }

      let createdApp = false;
      if (existingApp === null) {
        try {
          await this.createApp({
            id: appId,
            name: appName,
            packageName: metadata.packageName,
          });
          createdApp = true;
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }

      let createdVersion = false;
      if (existingVersion === null) {
        try {
          await this.createVersion(appId, {
            versionName,
            versionCode,
            minSdk: metadata.minSdk,
            releaseNotes: options.releaseNotes ?? null,
            publishedAt: options.publishedAt ?? null,
          });
          createdVersion = true;
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }

      const stored = await this.storeApk(appId, versionName, received, {
        declaredAbi: null,
        allowMismatch: options.allowMismatch,
      });

      // Apply note/date updates to a pre-existing version. `updateVersion`
      // acquires its own lock, so this must stay outside `storeApk`'s lock.
      if (
        existingVersion !== null &&
        (options.releaseNotes !== undefined || options.publishedAt !== undefined)
      ) {
        await this.updateVersion(appId, versionName, {
          releaseNotes: options.releaseNotes,
          publishedAt: options.publishedAt,
        });
      }

      const app = await this.reader.getApp(appId);
      if (!app) {
        throw new HttpError(500, "internal_error", "App disappeared after import");
      }
      const version = await this.reader.getVersionAdmin(appId, versionName);
      if (!version) {
        throw new HttpError(500, "internal_error", "Version disappeared after import");
      }
      const artifactAbi = artifactAbiOf(metadata);
      const artifact = version.artifacts.find(
        (candidate) => candidate.abi === artifactAbi,
      );
      if (!artifact) {
        throw new HttpError(
          500,
          "internal_error",
          "Artifact disappeared after import",
        );
      }

      return {
        result: {
          app,
          version,
          detected: toDetected(metadata),
          artifact: {
            abi: artifact.abi,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            downloadPath: artifact.downloadPath,
          },
          createdApp,
          createdVersion,
        },
        created: createdApp || createdVersion || stored.created,
      };
    } finally {
      await this.discardApk(received);
    }
  }

  async deleteArtifact(appId: string, versionName: string, abi: ApkAbi): Promise<void> {
    this.assertId(appId, "app id");
    this.assertId(versionName, "version name");

    await withLock(this.lockKey(appId), async () => {
      const entry = await this.requireVersion(appId, versionName);
      const target = entry.artifacts.find((artifact) => artifact.abi === abi);
      if (!target) {
        throw new HttpError(
          404,
          "artifact_not_found",
          `Version "${versionName}" has no APK for ABI "${abi}"`,
        );
      }

      const artifacts: ArtifactManifestEntry[] = entry.artifacts
        .filter((artifact) => artifact.abi !== abi)
        .map((artifact) => ({
          abi: artifact.abi,
          file: artifact.filename,
          sha256: artifact.sha256 ?? undefined,
        }));
      const next: Record<string, unknown> = { ...entry.manifest, artifacts };
      delete next.file;
      delete next.sha256;
      await writeJsonAtomic(path.join(entry.dir, "version.json"), next);

      if (!artifacts.some((artifact) => artifact.file === target.filename)) {
        await this.unlinkContained(entry.dir, target.filename);
      }
    });
  }

  private async receiveToTemp(
    source: Readable | undefined,
    maxBytes: number,
  ): Promise<ReceivedUpload> {
    if (!source) {
      throw new HttpError(400, "invalid_request", "Upload body is empty");
    }

    await fs.mkdir(this.uploadsDir, { recursive: true });
    const tempPath = path.join(this.uploadsDir, `${randomUUID()}.part`);
    const handle = await fs.open(tempPath, "wx");
    const writeStream = handle.createWriteStream();
    const hash = createHash("sha256");
    let sizeBytes = 0;

    try {
      // Deliberately not stream.pipeline: destroying the request stream makes
      // Fastify's inject() never resolve. for-await propagates HttpError cleanly.
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > maxBytes) {
          throw new HttpError(413, "payload_too_large", `Upload exceeds ${maxBytes} bytes`);
        }
        hash.update(buffer);
        if (!writeStream.write(buffer)) await once(writeStream, "drain");
      }
      writeStream.end();
      await finished(writeStream);
      if (sizeBytes === 0) {
        throw new HttpError(400, "invalid_request", "Upload body is empty");
      }
      return { tempPath, sizeBytes, sha256: hash.digest("hex") };
    } catch (error) {
      writeStream.destroy();
      await unlinkIfExists(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async cleanupReplaced(
    versionDir: string,
    previous: ApkArtifactRecord[],
    next: ArtifactManifestEntry[],
    newFilename: string,
  ): Promise<void> {
    for (const artifact of previous) {
      if (artifact.filename === newFilename) continue;
      if (next.some((candidate) => candidate.file === artifact.filename)) continue;
      await this.unlinkContained(versionDir, artifact.filename);
    }
  }

  private async unlinkContained(base: string, filename: string): Promise<void> {
    const resolved = containedPath(base, filename);
    if (resolved === null) return;
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isFile()) return;
      await fs.unlink(resolved);
    } catch (error) {
      if (!isNotFound(error)) {
        this.logger.warn({ err: error, file: resolved }, "could not remove file");
      }
    }
  }

  private async requireVersion(appId: string, versionName: string) {
    const entry = await this.reader.getVersionEntry(appId, versionName);
    if (!entry) {
      throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
    }
    return entry;
  }

  private async requireAppDir(appId: string): Promise<string> {
    const appDir = await resolveAppDir(path.join(this.config.dataDir, "apps"), appId);
    if (!appDir) {
      throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
    }
    return appDir;
  }

  private async readAppObject(
    appDir: string,
    appId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await readJsonObject(path.join(appDir, "app.json"));
    } catch (error) {
      if (!isNotFound(error)) {
        throw new HttpError(409, "app_invalid", `app.json for "${appId}" is invalid`);
      }
      const manifest = defaultAppManifest(appId) as unknown as Record<string, unknown>;
      await writeJsonAtomic(path.join(appDir, "app.json"), manifest);
      return manifest;
    }
  }

  private assertId(value: string, label: string): void {
    if (!ID_PATTERN.test(value)) {
      throw new HttpError(400, "invalid_request", `Invalid ${label}`);
    }
  }

  private lockKey(appId: string): string {
    return `app:${appId}`;
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 409;
}

function lastPackageSegment(packageName: string): string {
  const segments = packageName.split(".").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : packageName;
}

function buildVersionManifest(input: CreateVersionInput): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    versionCode: input.versionCode,
    versionName: input.versionName,
  };
  if (input.minSdk !== undefined && input.minSdk !== null) manifest.minSdk = input.minSdk;
  if (input.releaseNotes !== undefined && input.releaseNotes !== null) {
    manifest.releaseNotes = input.releaseNotes;
  }
  if (input.publishedAt !== undefined && input.publishedAt !== null) {
    manifest.publishedAt = input.publishedAt;
  }
  manifest.artifacts = [];
  return manifest;
}
