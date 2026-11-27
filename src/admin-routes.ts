import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppsService } from "./apps-service";
import type { AppsWriter, CreateAppInput, CreateVersionInput, UpdateAppInput, UpdateVersionInput } from "./apps-writer";
import type { Config } from "./config";
import { HttpError } from "./http-errors";
import { ApkInspectionError } from "./apk-inspect";
import { MANAGEMENT_KEY_HEADER, requireManagementKey } from "./management-config";
import {
  parseAllowMismatchQuery,
  parseCreateQuery,
  parseOptionalQueryText,
  parsePositiveIntQuery,
  parsePublishedAtQuery,
  requireValidAbi,
  requireValidId,
} from "./params";
import { ICON_EXTENSIONS, ID_PATTERN, MAX_ICON_BYTES, containedPath, isPlainObject } from "./volume";

const APK_CONTENT_TYPES = new Set([
  "application/vnd.android.package-archive",
  "application/octet-stream",
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const MANAGED_VERSION_FIELDS = ["artifacts", "file", "sha256"] as const;

export interface AdminRoutesOptions {
  config: Config;
  service: AppsService;
  writer: AppsWriter;
}

function mediaType(request: FastifyRequest): string {
  const header = request.headers["content-type"];
  return typeof header === "string" ? (header.split(";")[0] ?? "").trim().toLowerCase() : "";
}

/**
 * Shared APK body reader: validates the content type and returns the raw
 * stream. The caller must `request.raw.resume()` on every failure path.
 */
function readApkBody(request: FastifyRequest): {
  body: Readable;
  contentLength: number | undefined;
} {
  const type = mediaType(request);
  if (!APK_CONTENT_TYPES.has(type)) {
    throw new HttpError(415, "unsupported_media_type", `Unsupported content type "${type}"`);
  }
  const body = request.body;
  if (!(body instanceof Readable)) {
    throw new HttpError(400, "invalid_request", "Missing APK body");
  }
  const declared = Number(request.headers["content-length"]);
  return { body, contentLength: Number.isFinite(declared) ? declared : undefined };
}

/** Maps the inspector's internal codes onto the public `invalid_apk` error. */
function mapApkError(error: unknown): unknown {
  if (error instanceof ApkInspectionError) {
    return new HttpError(400, "invalid_apk", error.message);
  }
  return error;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value;
}

function optionalNonBlank(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value;
}

function optionalNullablePositiveInt(
  value: unknown,
  label: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalPositiveInt(value, label);
}

function optionalNullableText(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value;
}

function optionalPublishedAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", "Invalid publishedAt");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "invalid_request", "Invalid publishedAt");
  }
  return date.toISOString();
}

function parseIconName(value: unknown): string | undefined {
  const name = optionalNonBlank(value, "icon");
  if (name === undefined) return undefined;
  if (!/\.(png|jpe?g|webp)$/i.test(name) || containedPath("/__icon__", name) === null) {
    throw new HttpError(400, "invalid_request", "Invalid icon");
  }
  return name;
}

function parseCreateApp(body: Record<string, unknown>): CreateAppInput {
  const id = body.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new HttpError(400, "invalid_request", "Invalid app id");
  }
  return {
    id,
    name: optionalNonBlank(body.name, "name"),
    packageName: optionalNonBlank(body.packageName, "packageName"),
    description: optionalText(body.description, "description"),
    developer: optionalText(body.developer, "developer"),
    icon: parseIconName(body.icon),
  };
}

function parseUpdateApp(body: Record<string, unknown>, appId: string): UpdateAppInput {
  if ("id" in body && body.id !== appId) {
    throw new HttpError(400, "invalid_request", "id cannot be changed");
  }
  const patch: UpdateAppInput = {
    name: optionalNonBlank(body.name, "name"),
    packageName: optionalNonBlank(body.packageName, "packageName"),
    description: optionalText(body.description, "description"),
    developer: optionalText(body.developer, "developer"),
    icon: parseIconName(body.icon),
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new HttpError(400, "invalid_request", "No fields to update");
  }
  return patch;
}

function rejectManagedVersionFields(body: Record<string, unknown>): void {
  for (const field of MANAGED_VERSION_FIELDS) {
    if (field in body) {
      throw new HttpError(
        400,
        "invalid_request",
        `${field} is managed by the artifact endpoints`,
      );
    }
  }
}

function parseCreateVersion(body: Record<string, unknown>): CreateVersionInput {
  rejectManagedVersionFields(body);
  const versionName = body.versionName;
  if (typeof versionName !== "string" || !ID_PATTERN.test(versionName)) {
    throw new HttpError(400, "invalid_request", "Invalid versionName");
  }
  const versionCode = optionalPositiveInt(body.versionCode, "versionCode");
  if (versionCode === undefined) {
    throw new HttpError(400, "invalid_request", "versionCode is required");
  }
  return {
    versionName,
    versionCode,
    minSdk: optionalNullablePositiveInt(body.minSdk, "minSdk"),
    releaseNotes: optionalNullableText(body.releaseNotes, "releaseNotes"),
    publishedAt: optionalPublishedAt(body.publishedAt),
  };
}

function parseUpdateVersion(
  body: Record<string, unknown>,
  versionName: string,
): UpdateVersionInput {
  rejectManagedVersionFields(body);
  if ("versionName" in body && body.versionName !== versionName) {
    throw new HttpError(400, "invalid_request", "versionName cannot be changed");
  }
  const patch: UpdateVersionInput = {
    versionCode: optionalPositiveInt(body.versionCode, "versionCode"),
    minSdk: optionalNullablePositiveInt(body.minSdk, "minSdk"),
    releaseNotes: optionalNullableText(body.releaseNotes, "releaseNotes"),
    publishedAt: optionalPublishedAt(body.publishedAt),
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new HttpError(400, "invalid_request", "No fields to update");
  }
  return patch;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions,
): Promise<void> {
  const { config, service, writer } = options;

  app.addHook("onRequest", async (request, reply) => {
    if (READ_METHODS.has(request.method)) return;
    try {
      await requireManagementKey(config.dataDir, request.headers[MANAGEMENT_KEY_HEADER]);
    } catch (error) {
      reply.header("connection", "close");
      throw error;
    }
  });

  app.addContentTypeParser(
    ["application/vnd.android.package-archive", "application/octet-stream"],
    (request, payload, done) => {
      const type = mediaType(request);
      if (!APK_CONTENT_TYPES.has(type)) {
        done(new HttpError(415, "unsupported_media_type", `Unsupported content type "${type}"`));
        return;
      }
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > config.maxApkBytes) {
        done(
          new HttpError(413, "payload_too_large", `APK exceeds ${config.maxApkBytes} bytes`),
        );
        return;
      }
      done(null, payload);
    },
  );

  app.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp"],
    (request, payload, done) => {
      const type = mediaType(request);
      if (!ICON_EXTENSIONS[type]) {
        done(new HttpError(415, "unsupported_media_type", `Unsupported content type "${type}"`));
        return;
      }
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
        done(
          new HttpError(413, "payload_too_large", `Icon exceeds ${MAX_ICON_BYTES} bytes`),
        );
        return;
      }
      done(null, payload);
    },
  );

  app.post<{ Body: unknown }>("/api/v1/apps", async (request, reply) => {
    const input = parseCreateApp(bodyObject(request.body));
    await writer.createApp(input);
    const detail = await service.getApp(input.id);
    if (!detail) {
      throw new HttpError(500, "internal_error", "App disappeared after creation");
    }
    reply.code(201).header("location", `/api/v1/apps/${input.id}`);
    return { app: detail };
  });

  app.put<{ Params: { appId: string }; Body: unknown }>(
    "/api/v1/apps/:appId",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const patch = parseUpdateApp(bodyObject(request.body), appId);
      await writer.updateApp(appId, patch);
      const detail = await service.getApp(appId);
      if (!detail) {
        throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
      }
      return { app: detail };
    },
  );

  app.delete<{ Params: { appId: string } }>("/api/v1/apps/:appId", async (request, reply) => {
    const appId = requireValidId(request.params.appId, "app id");
    await writer.deleteApp(appId);
    return reply.code(204).send();
  });

  app.put<{ Params: { appId: string } }>(
    "/api/v1/apps/:appId/icon",
    async (request, reply) => {
      try {
        const appId = requireValidId(request.params.appId, "app id");
        const type = mediaType(request);
        if (!ICON_EXTENSIONS[type]) {
          throw new HttpError(415, "unsupported_media_type", `Unsupported content type "${type}"`);
        }
        const body = request.body;
        if (!(body instanceof Readable)) {
          throw new HttpError(400, "invalid_request", "Missing icon body");
        }
        await writer.putIcon(appId, type, body);
        return { iconPath: `/api/v1/apps/${appId}/icon` };
      } catch (error) {
        request.raw.resume();
        throw error;
      }
    },
  );

  app.delete<{ Params: { appId: string } }>(
    "/api/v1/apps/:appId/icon",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      await writer.deleteIcon(appId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { appId: string } }>(
    "/api/v1/apps/:appId/versions",
    async (request) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versions = await service.listVersionsAdmin(appId);
      if (!versions) {
        throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
      }
      return { versions };
    },
  );

  app.get<{ Params: { appId: string; versionName: string } }>(
    "/api/v1/apps/:appId/versions/:versionName",
    async (request) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      const versions = await service.listVersionsAdmin(appId);
      if (!versions) {
        throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
      }
      const version = versions.find((candidate) => candidate.versionName === versionName);
      if (!version) {
        throw new HttpError(
          404,
          "version_not_found",
          `Unknown version "${versionName}"`,
        );
      }
      return { version };
    },
  );

  app.post<{ Params: { appId: string }; Body: unknown }>(
    "/api/v1/apps/:appId/versions",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const input = parseCreateVersion(bodyObject(request.body));
      await writer.createVersion(appId, input);
      const version = await service.getVersionAdmin(appId, input.versionName);
      if (!version) {
        throw new HttpError(500, "internal_error", "Version disappeared after creation");
      }
      reply
        .code(201)
        .header("location", `/api/v1/apps/${appId}/versions/${input.versionName}`);
      return { version };
    },
  );

  app.put<{ Params: { appId: string; versionName: string }; Body: unknown }>(
    "/api/v1/apps/:appId/versions/:versionName",
    async (request) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      const patch = parseUpdateVersion(bodyObject(request.body), versionName);
      await writer.updateVersion(appId, versionName, patch);
      const version = await service.getVersionAdmin(appId, versionName);
      if (!version) {
        throw new HttpError(
          404,
          "version_not_found",
          `Unknown version "${versionName}"`,
        );
      }
      return { version };
    },
  );

  app.delete<{ Params: { appId: string; versionName: string } }>(
    "/api/v1/apps/:appId/versions/:versionName",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      await writer.deleteVersion(appId, versionName);
      return reply.code(204).send();
    },
  );

  app.put<{
    Params: { appId: string; versionName: string };
    Querystring: { allow_mismatch?: unknown };
  }>(
    "/api/v1/apps/:appId/versions/:versionName/artifacts",
    async (request, reply) => {
      try {
        const appId = requireValidId(request.params.appId, "app id");
        const versionName = requireValidId(request.params.versionName, "version name");
        const allowMismatch = parseAllowMismatchQuery(request.query.allow_mismatch);
        const { body, contentLength } = readApkBody(request);
        const result = await writer.putArtifact(
          appId,
          versionName,
          body,
          contentLength,
          { abi: null, allowMismatch },
        );
        const version = await service.getVersionAdmin(appId, versionName);
        if (!version) {
          throw new HttpError(500, "internal_error", "Version disappeared after upload");
        }
        return reply
          .code(result.created ? 201 : 200)
          .send({ version, detected: result.detected });
      } catch (error) {
        request.raw.resume();
        throw mapApkError(error);
      }
    },
  );

  app.put<{
    Params: { appId: string; versionName: string; abi: string };
    Querystring: { allow_mismatch?: unknown };
  }>(
    "/api/v1/apps/:appId/versions/:versionName/artifacts/:abi",
    async (request, reply) => {
      try {
        const appId = requireValidId(request.params.appId, "app id");
        const versionName = requireValidId(request.params.versionName, "version name");
        const abi = requireValidAbi(request.params.abi);
        const allowMismatch = parseAllowMismatchQuery(request.query.allow_mismatch);
        const { body, contentLength } = readApkBody(request);
        const result = await writer.putArtifact(
          appId,
          versionName,
          body,
          contentLength,
          { abi, allowMismatch },
        );
        const version = await service.getVersionAdmin(appId, versionName);
        if (!version) {
          throw new HttpError(500, "internal_error", "Version disappeared after upload");
        }
        return reply
          .code(result.created ? 201 : 200)
          .send({ version, detected: result.detected });
      } catch (error) {
        request.raw.resume();
        throw mapApkError(error);
      }
    },
  );

  app.post<{
    Querystring: {
      create?: unknown;
      appId?: unknown;
      version?: unknown;
      versionCode?: unknown;
      name?: unknown;
      releaseNotes?: unknown;
      publishedAt?: unknown;
      allow_mismatch?: unknown;
    };
  }>("/api/v1/import", async (request, reply) => {
    try {
      const query = request.query;
      const create = parseCreateQuery(query.create);
      const appIdValue = parseOptionalQueryText(query.appId, "appId");
      const appId =
        appIdValue === undefined ? undefined : requireValidId(appIdValue, "app id");
      const versionValue = parseOptionalQueryText(query.version, "version");
      const version =
        versionValue === undefined
          ? undefined
          : requireValidId(versionValue, "version name");
      const versionCode = parsePositiveIntQuery(query.versionCode, "versionCode");
      const name = parseOptionalQueryText(query.name, "name");
      const releaseNotes = parseOptionalQueryText(query.releaseNotes, "releaseNotes");
      const publishedAt = parsePublishedAtQuery(query.publishedAt);
      const allowMismatch = parseAllowMismatchQuery(query.allow_mismatch);
      const { body, contentLength } = readApkBody(request);

      const outcome = await writer.importApk(body, contentLength, {
        create,
        appId,
        version,
        versionCode,
        name,
        releaseNotes,
        publishedAt,
        allowMismatch,
      });
      return reply
        .code(outcome.created ? 201 : 200)
        .send(outcome.result);
    } catch (error) {
      request.raw.resume();
      throw mapApkError(error);
    }
  });

  app.delete<{ Params: { appId: string; versionName: string; abi: string } }>(
    "/api/v1/apps/:appId/versions/:versionName/artifacts/:abi",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      const abi = requireValidAbi(request.params.abi);
      await writer.deleteArtifact(appId, versionName, abi);
      return reply.code(204).send();
    },
  );
}
