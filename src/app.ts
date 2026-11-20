import { createReadStream } from "node:fs";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./admin-routes";
import { AppsService } from "./apps-service";
import { AppsWriter } from "./apps-writer";
import type { Config } from "./config";
import { HttpError, sendError } from "./http-errors";
import { parseAbiQuery, requireValidId } from "./params";

export interface BuildAppOptions {
  logger?: boolean | { level: string };
}

const FASTIFY_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: "payload_too_large",
    message: "Request body is too large",
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: "unsupported_media_type",
    message: "Unsupported content type",
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: "invalid_request",
    message: "Request body is empty",
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: "invalid_request",
    message: "Invalid JSON body",
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: "invalid_request",
    message: "Invalid content length",
  },
};

export function buildApp(config: Config, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? { level: config.logLevel } });
  const service = new AppsService(config, app.log);
  const writer = new AppsWriter(config, app.log, service);

  app.addHook("onReady", async () => {
    try {
      await service.ensureVolume();
    } catch (error) {
      app.log.warn(
        { err: error, dataDir: config.dataDir },
        "could not create the data directory; continuing",
      );
    }
  });

  app.get("/api/v1/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  app.get("/api/v1/apps", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { apps: await service.listApps() };
  });

  app.get<{ Params: { appId: string } }>("/api/v1/apps/:appId", async (request, reply) => {
    const appId = requireValidId(request.params.appId, "app id");
    const detail = await service.getApp(appId);
    if (!detail) throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
    reply.header("cache-control", "no-store");
    return { app: detail };
  });

  app.get<{ Params: { appId: string } }>("/api/v1/apps/:appId/icon", async (request, reply) => {
    const appId = requireValidId(request.params.appId, "app id");
    const detail = await service.getApp(appId);
    if (!detail) throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
    const icon = await service.getIcon(appId);
    if (!icon) throw new HttpError(404, "icon_not_found", `No icon for app "${appId}"`);
    reply.header("cache-control", "public, max-age=60");
    reply.header("x-content-type-options", "nosniff");
    reply.type(icon.contentType);
    return reply.send(createReadStream(icon.path));
  });

  app.get<{
    Params: { appId: string; versionName: string };
    Querystring: { abi?: unknown };
  }>(
    "/api/v1/apps/:appId/versions/:versionName/download",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      const abi = parseAbiQuery(request.query.abi);

      const lookup = await service.getDownload(appId, versionName, abi);
      if (!lookup.ok) {
        if (lookup.reason === "app_not_found") {
          throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
        }
        if (lookup.reason === "version_not_found") {
          throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
        }
        throw new HttpError(
          404,
          "abi_not_found",
          `Version "${versionName}" has no APK for ABI "${abi}"`,
        );
      }

      const download = lookup.download;
      reply.header("Content-Type", "application/vnd.android.package-archive");
      reply.header("Content-Disposition", `attachment; filename="${download.filename}"`);
      reply.header("Content-Length", String(download.fileSize));
      reply.header("Cache-Control", "no-store");
      if (download.sha256) reply.header("X-Checksum-Sha256", download.sha256);
      return reply.send(createReadStream(download.path));
    },
  );

  app.register(registerAdminRoutes, { config, service, writer });

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, "not_found", "Route not found");
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      sendError(reply, error.statusCode, error.code, error.message);
      return;
    }
    const mapped = FASTIFY_ERROR_MAP[error.code];
    if (mapped) {
      sendError(reply, mapped.status, mapped.code, mapped.message);
      return;
    }
    const statusCode = error.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      sendError(reply, statusCode, error.code ?? "invalid_request", error.message);
      return;
    }
    request.log.error({ err: error }, "unhandled request error");
    sendError(reply, 500, "internal_error", "Internal server error");
  });

  return app;
}
