import { createReadStream } from "node:fs";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { AppsService, ID_PATTERN } from "./apps-service";
import type { Config } from "./config";
import { HttpError, sendError } from "./http-errors";

export interface BuildAppOptions {
  logger?: boolean | { level: string };
}

function requireValidId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value;
}

export function buildApp(config: Config, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? { level: config.logLevel } });
  const service = new AppsService(config, app.log);

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
    reply.type(icon.contentType);
    return reply.send(createReadStream(icon.path));
  });

  app.get<{ Params: { appId: string; versionName: string } }>(
    "/api/v1/apps/:appId/versions/:versionName/download",
    async (request, reply) => {
      const appId = requireValidId(request.params.appId, "app id");
      const versionName = requireValidId(request.params.versionName, "version name");
      const download = await service.getDownload(appId, versionName);
      if (!download) {
        const detail = await service.getApp(appId);
        if (!detail) throw new HttpError(404, "app_not_found", `Unknown app "${appId}"`);
        throw new HttpError(404, "version_not_found", `Unknown version "${versionName}"`);
      }
      reply.header("Content-Type", "application/vnd.android.package-archive");
      reply.header("Content-Disposition", `attachment; filename="${download.filename}"`);
      reply.header("Content-Length", String(download.fileSize));
      reply.header("Cache-Control", "no-store");
      if (download.sha256) reply.header("X-Checksum-Sha256", download.sha256);
      return reply.send(createReadStream(download.path));
    },
  );

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, "not_found", "Route not found");
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      sendError(reply, error.statusCode, error.code, error.message);
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
