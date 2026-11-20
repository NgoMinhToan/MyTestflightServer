# MyTestflightServer

Internal Android app distribution service. Node 22 + TypeScript + Fastify 5.

> **Warning**
> Read routes are public. Write routes require an `X-Management-Key` header matching
> `management_key` in `$DATA_DIR/config.json`; without it they return 401, and when the key is not
> configured they return 503. The key is stored in plaintext in the mounted volume, so use a
> trusted network or TLS and keep the volume private.

## Layout

```text
src/
├── config.ts        # env parsing (HOST, PORT, DATA_DIR, LOG_LEVEL, MAX_APK_BYTES)
├── types.ts         # manifest/record/API types
├── volume.ts        # shared path/manifest helpers, atomic writes, keyed lock
├── apps-service.ts  # volume scan, version resolution, read model
├── apps-writer.ts   # app/version/artifact/icon mutations, streaming upload
├── admin-routes.ts  # write routes and upload content-type parsers
├── management-config.ts # $DATA_DIR/config.json creation and key checks
├── params.ts        # id/abi request validation
├── http-errors.ts   # HttpError + sendError
├── app.ts           # Fastify factory, read routes, error handling
└── main.ts          # listen + graceful shutdown
test/
├── harness.ts       # temp-volume harness, fixtures, auth headers
├── apps.test.ts     # 30 read cases
├── admin.test.ts    # 18 write cases
└── management-key.test.ts # 8 auth/config cases
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
$DATA_DIR/config.json                                      # management_key
$DATA_DIR/apps/<appId>/app.json
$DATA_DIR/apps/<appId>/<icon file>
$DATA_DIR/apps/<appId>/versions/<versionName>/version.json
$DATA_DIR/apps/<appId>/versions/<versionName>/<apk file>   # one or more
$DATA_DIR/.uploads/                                        # transient upload files
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
  manifests are never overwritten by the read path.
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
- `publishedAt` falls back to the default artifact's mtime when missing or unparseable (or to
  `version.json`'s mtime for a draft). `sha256` must be 64 hex characters; invalid values become
  `null`. The read path never hashes APKs.
- Read-only volumes: scaffolding failures only warn and the derived manifest is used for the
  request. The write API, by contrast, needs a writable volume.

### Files written by the API

- APK uploads are stored as `<abi>-<sha256[0:16]>.apk`; `version.json.artifacts[].file` points at
  the server-owned name. Re-uploading an ABI writes a new file and removes the old one once no
  artifact references it.
- Uploads stream to `$DATA_DIR/.uploads/` and are renamed into place; that directory is ignored by
  the catalog and should be empty after a request finishes.
- `app.json` and `version.json` are rewritten atomically (hidden temp file + `rename`). Unknown
  fields in either manifest are preserved.
- The first artifact upload migrates a legacy `file`/`sha256` manifest to `artifacts[]`, keeping the
  legacy APK as the `universal` artifact unless the upload itself is `universal`. Legacy APK files
  that are no longer referenced are left on disk unless the artifact was explicitly replaced or
  deleted through the API.

## Management key

The write API is protected by a single operator secret stored in the mounted volume:

```json
{
  "management_key": "0123456789abcdef...64 hex chars"
}
```

- Path: `$DATA_DIR/config.json` (`/data/config.json` in the container), next to `apps/`.
- Created automatically on startup when missing, with a generated 256-bit random key (64 lowercase
  hex characters) and mode `0600`. An existing file is never overwritten.
- The key is **not** logged. Read it with `docker compose exec server cat /data/config.json` (the
  file is owned by the container's `node` user); on Linux with a mismatched host uid use
  `sudo cat data/config.json`.
- The file is read fresh on every mutating request. Editing or rotating `management_key` in the
  mounted volume applies immediately; no restart is needed.
- Read routes (catalog, icon, download, and the two admin version GETs) stay public. Mutating routes
  require `X-Management-Key: <management_key>`.
- Missing, unreadable, symlinked, malformed, or blank config → 503 `management_key_not_configured`
  for writes. Missing/wrong header → 401 `invalid_management_key`. Reads keep working.
- The key is compared timing-safely. It travels in a header over plain HTTP by default; use a
  trusted network or TLS. A reverse proxy must forward `X-Management-Key`.
- If the volume is read-only the config cannot be created; the server still starts and writes fail
  closed until the file exists.
- Edit the file atomically (write a temp file and rename) to avoid a transient 503 during the edit.

## API

All responses are JSON except the APK download and icon. Errors use
`{ "error": { "code": string, "message": string } }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | `{ "status": "ok" }` |
| GET | `/api/v1/apps` | `{ "apps": AppSummary[] }` |
| GET | `/api/v1/apps/:appId` | `{ "app": AppDetail }`; 404 `app_not_found` |
| GET | `/api/v1/apps/:appId/icon` | image bytes; 404 `icon_not_found`; cached 60 s |
| GET | `/api/v1/apps/:appId/versions/:versionName/download` | APK stream; optional `?abi=<abi>` |

Every `VersionSummary` carries `abis`, `universal`, and
`artifacts: [{ abi, sizeBytes, sha256, downloadPath }]`; its `sizeBytes`, `sha256`, and
`downloadPath` describe the default artifact. Without `?abi` the download route serves that
default; with `?abi=<abi>` it serves exactly that artifact (no universal fallback).

Download headers: `Content-Type: application/vnd.android.package-archive`,
`Content-Disposition: attachment; filename="<appId>-<versionName>.apk"` for the default artifact
(`"<appId>-<versionName>-<abi>.apk"` for a non-default one), `Content-Length`,
`Cache-Control: no-store`, and `X-Checksum-Sha256` when that artifact declares a digest. A
malformed `abi` is 400 `invalid_request`; a valid ABI the version does not publish is 404
`abi_not_found`.

The newest build is the highest `versionCode`, with numeric-aware `versionName` ordering as the
tie-break.

## Write API

These routes mutate the volume. Every `POST`, `PUT`, and `DELETE` requires
`X-Management-Key: <management_key>` from `$DATA_DIR/config.json`; the two `GET` routes below stay
public. See [Management key](#management-key).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/apps` | JSON `{ id, name?, packageName?, description?, developer?, icon? }`; 201 `{ app }`; 409 `app_exists` |
| PUT | `/api/v1/apps/:appId` | Partial JSON with the same metadata fields; 200 `{ app }`; 404 `app_not_found` |
| DELETE | `/api/v1/apps/:appId` | 204; removes the app directory recursively |
| PUT | `/api/v1/apps/:appId/icon` | Raw `image/png`, `image/jpeg`, or `image/webp` (max 2 MiB); 200 `{ iconPath }` |
| DELETE | `/api/v1/apps/:appId/icon` | 204; 404 `icon_not_found` |
| GET | `/api/v1/apps/:appId/versions` | `{ versions: VersionAdmin[] }`; includes drafts |
| GET | `/api/v1/apps/:appId/versions/:versionName` | `{ version: VersionAdmin }` |
| POST | `/api/v1/apps/:appId/versions` | JSON `{ versionName, versionCode, minSdk?, releaseNotes?, publishedAt? }`; 201 draft; 409 `version_exists` |
| PUT | `/api/v1/apps/:appId/versions/:versionName` | Partial metadata (`versionCode`, `minSdk`, `releaseNotes`, `publishedAt`); 200 |
| DELETE | `/api/v1/apps/:appId/versions/:versionName` | 204 |
| PUT | `/api/v1/apps/:appId/versions/:versionName/artifacts/:abi` | Raw APK; 201 new / 200 replaced; body `{ version }` |
| DELETE | `/api/v1/apps/:appId/versions/:versionName/artifacts/:abi` | 204; 404 `artifact_not_found` |

`POST` responses set `Location`. `DELETE` responses are `204` with no body.

### Draft versions

`POST .../versions` creates `version.json` with `artifacts: []`. The version is a **draft**: it is
visible through the admin `GET` routes but omitted from `GET /api/v1/apps` and
`GET /api/v1/apps/:appId` until the first APK upload. Deleting the last artifact returns the
version to draft; deleting the version removes it entirely.

`VersionAdmin` is the same shape as `VersionSummary` plus `draft`, a nullable `defaultArtifact`, and
a `filename` on each artifact:

```json
{
  "versionName": "1.4.2",
  "versionCode": 142,
  "minSdk": 26,
  "releaseNotes": "Fixes login timeout",
  "publishedAt": "2026-11-19T08:00:00.000Z",
  "draft": false,
  "abis": ["arm64-v8a", "x86_64"],
  "universal": false,
  "artifacts": [
    {
      "abi": "arm64-v8a",
      "filename": "arm64-v8a-1a2b3c4d5e6f7788.apk",
      "sizeBytes": 8123456,
      "sha256": "4567...64 hex chars",
      "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download?abi=arm64-v8a"
    }
  ],
  "defaultArtifact": { "abi": "arm64-v8a", "filename": "arm64-v8a-1a2b3c4d5e6f7788.apk", "sizeBytes": 8123456, "sha256": "4567...64 hex chars", "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download?abi=arm64-v8a" },
  "sizeBytes": 8123456,
  "sha256": "4567...64 hex chars",
  "downloadPath": "/api/v1/apps/crm/versions/1.4.2/download"
}
```

For a draft, `draft` is `true`, `artifacts` is `[]`, and `defaultArtifact`, `sizeBytes`, `sha256`,
and `downloadPath` are `null`.

### Uploading an APK

```bash
KEY=$(docker compose exec -T server node -p 'require("/data/config.json").management_key')
# Local run instead: KEY=$(node -p 'require("./data/config.json").management_key')

curl -X POST http://127.0.0.1:8080/api/v1/apps \
  -H 'content-type: application/json' \
  -H "X-Management-Key: $KEY" \
  -d '{"id":"crm","name":"Internal CRM","packageName":"com.company.crm"}'

curl -X POST http://127.0.0.1:8080/api/v1/apps/crm/versions \
  -H 'content-type: application/json' \
  -H "X-Management-Key: $KEY" \
  -d '{"versionName":"1.4.2","versionCode":142,"minSdk":26}'

curl -X PUT http://127.0.0.1:8080/api/v1/apps/crm/versions/1.4.2/artifacts/arm64-v8a \
  -H 'content-type: application/vnd.android.package-archive' \
  -H "X-Management-Key: $KEY" \
  --data-binary @app-arm64-v8a.apk

curl -X PUT http://127.0.0.1:8080/api/v1/apps/crm/icon \
  -H 'content-type: image/png' \
  -H "X-Management-Key: $KEY" \
  --data-binary @icon.png
```

- APK content types: `application/vnd.android.package-archive` and `application/octet-stream`.
  Icon content types: `image/png`, `image/jpeg`, `image/webp`.
- The server computes the SHA-256 while streaming and stores it in `version.json`. Clients cannot
  supply `artifacts`, `file`, or `sha256` in a version body (400); artifacts are managed only by the
  artifact routes.
- `MAX_APK_BYTES` (default `536870912`, 512 MiB) caps one APK upload; icons are capped at 2 MiB.
- Replacing an ABI is an upsert: `PUT` returns 200 and deletes the previous server-owned file once
  nothing references it. A new ABI returns 201.
- `versionName` is immutable; a `versionName` in a `PUT` body must match the path.
- `publishedAt` accepts an ISO 8601 string; `null` removes it so the mtime fallback applies.

### Write errors

| Status | Codes |
|---|---|
| 400 | `invalid_request` (bad id, ABI, body, JSON, or content length) |
| 401 | `invalid_management_key` (missing or wrong `X-Management-Key`) |
| 404 | `app_not_found`, `version_not_found`, `artifact_not_found`, `icon_not_found` |
| 409 | `app_exists`, `version_exists`, `app_invalid` (existing `app.json` is unreadable) |
| 413 | `payload_too_large` (APK or icon limit, or JSON body over 1 MiB) |
| 415 | `unsupported_media_type` |
| 503 | `management_key_not_configured` (config.json missing, invalid, or blank) |

## Docker

```bash
docker build -t my-testflight-server:local .
docker run --rm -p 8080:8080 -v "$PWD/../data:/data" my-testflight-server:local
```

The image runs as `node` (via `su-exec`), creates `/data/apps`, and best-effort chowns the volume
only when ownership differs. Startup never fails because `mkdir`/`chown` was rejected. On first start
the server creates `/data/config.json` with a generated key; read it with
`docker compose exec server cat /data/config.json`. The write API requires the mounted volume to be
writable by that user.

## CI

`.github/workflows/build-image.yml` runs typecheck + tests, then builds and pushes a multi-arch
image (`linux/amd64`, `linux/arm64`, `linux/arm/v7`, `linux/arm/v6`) to
`ghcr.io/<lowercase-owner>/<lowercase-repo>`. Pull requests build without pushing; `latest` is
published only from the default branch.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `./data` | Volume root |
| `LOG_LEVEL` | `info` | Pino level |
| `MAX_APK_BYTES` | `536870912` | Maximum size of one APK upload |

`$DATA_DIR/config.json` is file-based configuration (`management_key`), not an environment variable.
It is created on first start and read fresh on every write request.
