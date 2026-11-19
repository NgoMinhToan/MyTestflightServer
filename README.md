# MyTestflightServer

Read-only internal Android app distribution service. Node 22 + TypeScript + Fastify 5.

## Layout

```text
src/
├── config.ts        # env parsing (HOST, PORT, DATA_DIR, LOG_LEVEL)
├── types.ts         # manifest/record/API types
├── apps-service.ts  # volume scan, auto-scaffolding, version selection, path safety
├── http-errors.ts   # HttpError + sendError
├── app.ts           # Fastify factory, five routes, error/not-found handlers
└── main.ts          # listen + graceful shutdown
test/apps.test.ts    # node:test + fastify.inject, 15 cases
Dockerfile
docker-entrypoint.sh
.github/workflows/build-image.yml
```

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build      # tsc -> dist/
npm start          # node dist/main.js
npm run dev        # tsx watch src/main.ts
```

`DATA_DIR` defaults to `./data` relative to the current working directory. From this directory,
use `DATA_DIR=../data` to serve the workspace volume.

## Volume

```text
$DATA_DIR/apps/<appId>/app.json
$DATA_DIR/apps/<appId>/<icon file>
$DATA_DIR/apps/<appId>/versions/<versionName>/version.json
$DATA_DIR/apps/<appId>/versions/<versionName>/<apk file>
```

- Missing `app.json` and `versions/` are created on read (`writeFile` with flag `wx`); existing
  manifests are never overwritten.
- `versionCode` must be a positive integer. `versionName` defaults to the directory name, but the
  API addresses a version by the manifest `versionName`; duplicates resolve to the first
  directory in ascending order.
- APK paths must stay inside their version directory; symlinked files are rejected (`lstat`).
- `publishedAt` falls back to the APK mtime when missing or unparseable. `sha256` must be 64 hex
  characters; invalid values become `null`. The service never hashes APKs.
- Read-only volumes: scaffolding failures only warn and the derived manifest is used for the
  request.

## API

```text
GET /api/v1/health
GET /api/v1/apps
GET /api/v1/apps/:appId
GET /api/v1/apps/:appId/icon
GET /api/v1/apps/:appId/versions/:versionName/download
```

Errors: `{ "error": { "code", "message" } }` with `invalid_request` (400), `app_not_found`,
`icon_not_found`, `version_not_found`, `not_found` (404), and `internal_error` (500).

## Docker

```bash
docker build -t my-testflight-server:local .
docker run --rm -p 8080:8080 -v "$PWD/../data:/data" my-testflight-server:local
```

The image runs as `node` (via `su-exec`), creates `/data/apps`, and best-effort chowns the volume
only when ownership differs. Startup never fails because `mkdir`/`chown` was rejected.

## CI

`.github/workflows/build-image.yml` runs typecheck + tests, then builds and pushes a multi-arch
image (`linux/amd64`, `linux/arm64`, `linux/arm/v7`, `linux/arm/v6`) to
`ghcr.io/<lowercase-owner>/<lowercase-repo>`. Pull requests build without pushing; `latest` is
published only from the default branch.
