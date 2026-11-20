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
test/apps.test.ts    # node:test + fastify.inject, 30 cases
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
$DATA_DIR/apps/<appId>/versions/<versionName>/<apk file>   # one or more
```

A version publishes one or more APKs. `version.json` declares them either with the legacy
single-file fields or with an `artifacts` array:

```json
{
  "versionCode": 142,
  "versionName": "1.4.2",
  "file": "app.apk",
  "sha256": "0123...64 hex chars"
}
```

```json
{
  "versionCode": 142,
  "versionName": "1.4.2",
  "artifacts": [
    { "abi": "arm64-v8a", "file": "app-arm64-v8a.apk", "sha256": "0123...64 hex chars" },
    { "abi": "armeabi-v7a", "file": "app-armeabi-v7a.apk", "sha256": "4567...64 hex chars" },
    { "abi": "universal", "file": "app-universal.apk", "sha256": "89ab...64 hex chars" }
  ]
}
```

- Missing `app.json` and `versions/` are created on read (`writeFile` with flag `wx`); existing
  manifests are never overwritten.
- `versionCode` must be a positive integer. `versionName` defaults to the directory name, but the
  API addresses a version by the manifest `versionName`; duplicates resolve to the first
  directory in ascending order.
- Allowed `abi` labels: `universal`, `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`, `riscv64`,
  `armeabi` (case-insensitive, normalized to lowercase). Artifacts are listed in that priority
  order and the first one is the **default artifact**.
- `artifacts` is authoritative when it is an array; `file` and the version-level `sha256` are then
  ignored with a warning. Each artifact carries its own optional `sha256`; the version-level digest
  is never applied to artifacts.
- Without `artifacts`, `file` names a single APK and it becomes one `universal` artifact. Without
  either field, the version directory must contain exactly one `.apk`, which also becomes
  `universal`.
- Invalid artifact entries (unknown `abi`, missing or unresolvable `file`, duplicate `abi`,
  non-`.apk`, path escaping the version directory, symlink) are skipped with a warning. A version
  with no valid artifact is skipped like any other unreadable version.
- APK paths must stay inside their version directory; symlinked files are rejected (`lstat`).
- `publishedAt` falls back to the default artifact's mtime when missing or unparseable. `sha256`
  must be 64 hex characters; invalid values become `null`. The service never hashes APKs.
- Read-only volumes: scaffolding failures only warn and the derived manifest is used for the
  request.

## API

```text
GET /api/v1/health
GET /api/v1/apps
GET /api/v1/apps/:appId
GET /api/v1/apps/:appId/icon
GET /api/v1/apps/:appId/versions/:versionName/download[?abi=<abi>]
```

Every version summary in `GET /api/v1/apps` and `GET /api/v1/apps/:appId` includes the artifact
set:

```json
{
  "versionName": "1.4.2",
  "sizeBytes": 11157977,
  "sha256": "0123...64 hex chars",
  "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download",
  "abis": ["universal", "arm64-v8a"],
  "universal": true,
  "artifacts": [
    {
      "abi": "universal",
      "sizeBytes": 11157977,
      "sha256": "0123...64 hex chars",
      "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download?abi=universal"
    },
    {
      "abi": "arm64-v8a",
      "sizeBytes": 8123456,
      "sha256": "4567...64 hex chars",
      "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download?abi=arm64-v8a"
    }
  ]
}
```

`sizeBytes`, `sha256`, and `downloadPath` always describe the default artifact, so older clients
keep working. Without `?abi`, the download route serves that default artifact with
`filename="<appId>-<versionName>.apk"`. With `?abi=<abi>`, it serves exactly that artifact — there
is no universal fallback — with `filename="<appId>-<versionName>-<abi>.apk"`.

Errors: `{ "error": { "code", "message" } }` with `invalid_request` (400), `app_not_found`,
`icon_not_found`, `version_not_found`, `abi_not_found`, `not_found` (404), and `internal_error`
(500). A malformed `abi` (outside the allowlist, or repeated) is `400 invalid_request`; a valid ABI
the version does not publish is `404 abi_not_found`.

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
