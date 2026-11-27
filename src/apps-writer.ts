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
import { appIdFromPackage, isValidPackageName } from "./app-id";
import { extractRasterIcon } from "./apk-icon";
import {
  formatMismatch,
  verifyApkMetadata,
  type MismatchKind,
} from "./apk-verify";
import { isValidVersionName } from "./version-name";
import type {
  ApkAbi,
  ApkArtifactRecord,
  ApkMetadata,
  AppManifest,
  DetectedApk,
  ImportResult,
  VersionEntry,
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
    const declaredPackage = input.packageName?.trim() || undefined;
    if (declaredPackage !== undefined) this.assertPackage(declaredPackage);
    const packageName = declaredPackage ?? input.id;

    const appsDir = path.join(this.config.dataDir, "apps");
    await fs.mkdir(appsDir, { recursive: true });
    const appDir = path.join(appsDir, input.id);

    await withLock(this.lockKey(input.id), async () => {
      if (packageName !== input.id) {
        await this.assertPackageUnused(packageName, input.id);
      }

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
          packageName,
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
    const nextPackage = patch.packageName?.trim();
    if (nextPackage !== undefined) this.assertPackage(nextPackage);

    await withLock(this.lockKey(appId), async () => {
      const appDir = await this.requireAppDir(appId);
      const raw = await this.readAppObject(appDir, appId);
      const next: Record<string, unknown> = { ...raw };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.developer !== undefined) next.developer = patch.developer;
      if (patch.icon !== undefined) next.icon = patch.icon;

      if (nextPackage !== undefined) {
        const current = nonBlankString(raw.packageName) ?? appId;
        if (nextPackage !== current) {
          if (await this.appHasArtifact(appId)) {
            throw new HttpError(
              409,
              "package_locked",
              `Cannot change packageName for "${appId}" after an APK was uploaded`,
            );
          }
          if (nextPackage !== appId) {
            await this.assertPackageUnused(nextPackage, appId);
          }
        }
        next.packageName = nextPackage;
      }

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

  async putIcon(
    appId: string,
    contentType: string,
    source: Readable | undefined,
    options: { ifMissing?: boolean } = {},
  ): Promise<{ skipped: boolean }> {
    this.assertId(appId, "app id");
    const extension = ICON_EXTENSIONS[contentType];
    if (!extension) {
      throw new HttpError(415, "unsupported_media_type", `Unsupported icon type "${contentType}"`);
    }
    await this.requireAppDir(appId);

    const received = await this.receiveToTemp(source, MAX_ICON_BYTES);
    let moved = false;
    try {
      return await withLock(this.lockKey(appId), async () => {
        const appDir = await this.requireAppDir(appId);
        const raw = await this.readAppObject(appDir, appId);

        if (options.ifMissing && (await this.findAppIcon(appDir, raw.icon)) !== null) {
          return { skipped: true };
        }

        const filename = `app_icon.${extension}`;
        await fs.rename(received.tempPath, path.join(appDir, filename));
        moved = true;

        const previous = nonBlankString(raw.icon);
        await writeJsonAtomic(path.join(appDir, "app.json"), { ...raw, icon: filename });
        if (previous !== null && previous !== filename) {
          await this.unlinkContained(appDir, previous);
        }
        return { skipped: false };
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
      const resolved = await this.findAppIcon(appDir, declared);
      if (resolved === null) {
        throw new HttpError(404, "icon_not_found", `No icon for app "${appId}"`);
      }
      await fs.unlink(resolved);
      // Reset to the default name so a later GET falls back to the newest
      // version icon instead of pointing at a deleted file.
      await writeJsonAtomic(path.join(appDir, "app.json"), { ...raw, icon: DEFAULT_ICON });
    });
  }

  async createVersion(appId: string, input: CreateVersionInput): Promise<void> {
    this.assertId(appId, "app id");
    this.assertVersionName(input.versionName);

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
    this.assertVersionName(versionName);
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
    this.assertVersionName(versionName);

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
    this.assertVersionName(versionName);

    return withLock(this.lockKey(appId), async () => {
      const entry = await this.requireVersion(appId, versionName);
      const appDir = await this.requireAppDir(appId);
      const appManifest = await this.readAppObject(appDir, appId);
      const declaredPackage = nonBlankString(appManifest.packageName);
      // A brand-new app (`apps create <id>`) stores the id as a placeholder;
      // the first successful upload replaces it with the APK package.
      const bindPackage = declaredPackage === null || declaredPackage === appId;
      const expectedPackageName =
        options.expectedPackageName ??
        (bindPackage ? received.metadata.packageName : declaredPackage);
      const abi = options.declaredAbi ?? artifactAbiOf(received.metadata);

      if (
        bindPackage &&
        received.metadata.packageName !== appId
      ) {
        await this.assertPackageUnused(received.metadata.packageName, appId);
      }

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
      const storedPath = path.join(entry.dir, filename);
      await fs.rename(received.tempPath, storedPath);

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
      next.detectedPackageName = received.metadata.packageName;
      // Auto-fill a missing minSdk from the APK; never overwrite a declared one.
      if (entry.minSdk === null && received.metadata.minSdk !== null) {
        next.minSdk = received.metadata.minSdk;
      }

      const icon = await this.storeVersionIcon(entry, storedPath, received.metadata);
      if (icon !== null) next.icon = icon;

      await writeJsonAtomic(path.join(entry.dir, "version.json"), next);
      await this.cleanupReplaced(entry.dir, entry.artifacts, artifacts, filename);
      if (icon !== null && entry.icon !== null && entry.icon !== icon) {
        await this.unlinkContained(entry.dir, entry.icon);
      }

      if (bindPackage) {
        await writeJsonAtomic(path.join(appDir, "app.json"), {
          ...appManifest,
          packageName: received.metadata.packageName,
        });
      }

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
    this.assertVersionName(versionName);
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
      const appId = options.appId ?? appIdFromPackage(metadata.packageName);
      this.assertId(appId, "app id");

      const existingApp = await this.reader.getApp(appId);
      if (!existingApp && !options.create) {
        throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
      }
      const existingPackage = existingApp
        ? nonBlankString(existingApp.packageName)
        : null;
      const appPackageName =
        existingPackage === null || existingPackage === appId
          ? metadata.packageName
          : existingPackage;
      const appName =
        options.name ??
        metadata.label ??
        humanizeAppId(lastPackageSegment(metadata.packageName));

      // A resource-referenced versionName that could not be resolved falls back
      // to the numeric versionCode, matching Play Console's behavior.
      const versionName =
        options.version ?? metadata.versionName ?? String(metadata.versionCode);
      this.assertVersionName(versionName);

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
          // The app was created concurrently under the same id. Re-read it and
          // refuse to mutate an app that belongs to a different package.
          if (error instanceof HttpError && error.code === "package_in_use") throw error;
          const raced = await this.reader.getApp(appId);
          if (!raced) throw error;
          const racedPackage = nonBlankString(raced.packageName);
          const racedIsPlaceholder =
            racedPackage === null || racedPackage === appId;
          if (!racedIsPlaceholder && racedPackage !== metadata.packageName) {
            throw new HttpError(
              409,
              "package_in_use",
              `App "${appId}" already exists with package "${racedPackage}"`,
            );
          }
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
    this.assertVersionName(versionName);

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

  private assertVersionName(value: string): void {
    if (!isValidVersionName(value)) {
      throw new HttpError(
        400,
        "version_name_invalid",
        `Invalid version name "${value}"`,
      );
    }
  }

  private assertPackage(value: string): void {
    if (!isValidPackageName(value)) {
      throw new HttpError(400, "invalid_request", `Invalid packageName "${value}"`);
    }
  }

  /** Rejects a package already bound to another app (placeholders are unbound). */
  private async assertPackageUnused(packageName: string, excludeAppId: string): Promise<void> {
    const apps = await this.reader.listApps();
    for (const app of apps) {
      if (app.id === excludeAppId) continue;
      if (app.packageName === app.id) continue;
      if (app.packageName === packageName) {
        throw new HttpError(
          409,
          "package_in_use",
          `Package "${packageName}" is already used by app "${app.id}"`,
        );
      }
    }
  }

  private async appHasArtifact(appId: string): Promise<boolean> {
    const versions = await this.reader.listVersionsAdmin(appId);
    return versions?.some((version) => version.artifacts.length > 0) ?? false;
  }

  private async findAppIcon(appDir: string, declared: unknown): Promise<string | null> {
    const name = nonBlankString(declared);
    if (name === null) return null;
    const resolved = containedPath(appDir, name);
    if (resolved === null) return null;
    try {
      const stat = await fs.lstat(resolved);
      return stat.isFile() ? resolved : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Best-effort raster icon extraction. A missing/corrupt/adaptive icon never
   * fails the upload; the previous version icon (if any) is kept.
   */
  private async storeVersionIcon(
    entry: VersionEntry,
    apkPath: string,
    metadata: ApkMetadata,
  ): Promise<string | null> {
    if (metadata.icon === null || metadata.icon.kind !== "raster") return null;
    try {
      const extracted = await extractRasterIcon(apkPath, metadata.icon);
      if (extracted === null) return null;
      const target = containedPath(entry.dir, extracted.filename);
      if (target === null) return null;
      await fs.writeFile(target, extracted.bytes);
      return extracted.filename;
    } catch (error) {
      this.logger.warn(
        { err: error, versionDir: entry.dir },
        "could not extract or store the version icon",
      );
      return null;
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
