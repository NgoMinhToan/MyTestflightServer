# MyTestflightServer

[![build-image](https://github.com/NgoMinhToan/MyTestflightServer/actions/workflows/build-image.yml/badge.svg)](https://github.com/NgoMinhToan/MyTestflightServer/actions/workflows/build-image.yml)

Catalog và write API tự host để phân phối APK Android nội bộ. Server đọc trực tiếp
`AndroidManifest.xml` và `resources.arsc` của APK, lưu từng phiên bản vào volume dạng file, rồi
phục vụ catalog, icon và download cho dashboard/CLI/CI. Không cần Google Play Console, Firebase,
tài khoản Google, hay dịch vụ ngoài.

**Trạng thái:** dùng nội bộ, đang được bảo trì. API đọc công khai; mọi thao tác ghi cần
`X-Management-Key`. Kho mã nguồn này không kèm giấy phép mã nguồn mở (xem [Trạng thái và phạm
vi](#trạng-thái-và-phạm-vi)).

## Vì sao dùng cái này thay Play internal testing / Firebase App Distribution

| Tiêu chí | MyTestflightServer | Google Play internal testing | Firebase App Distribution |
|---|---|---|---|
| Hạ tầng | Docker Compose, volume file tự quản | Google Play Console | Firebase/Google Cloud |
| Tài khoản để phát hành | `X-Management-Key` của bạn | Tài khoản Google + Play Console | Tài khoản Google + project Firebase |
| Đơn vị phát hành | APK gốc bạn tải lên | AAB/APK qua Play | APK/AAB qua Firebase |
| Nguồn sự thật | File APK trên volume | Play Console | Firebase console |
| API/CLI | REST + CLI + dashboard cùng repo workspace | Play Developer API | Firebase App Distribution API |
| Đọc metadata/icon | Parse ARSC ngay trên server | Play xử lý | Firebase xử lý |
| Dữ liệu rời khỏi mạng nội bộ | Không (mặc định) | Có | Có |

Điểm mạnh cụ thể: một APK là nguồn dữ liệu duy nhất cho package, version, minSdk và icon; volume
chỉ gồm JSON + APK + file icon nên backup/restore bằng `rsync`/`tar`; server không cần JDK, Android
SDK hay thư viện render ảnh.

**Cố ý không làm:** không thay thế Play Store (không AAB, staged rollout, review, quản lý quyền
theo tài khoản), không có đăng nhập/SSO cho người đọc, không render vector/adaptive icon thành
PNG, không multi-tenant. Nếu bạn cần phân phối công khai, quản lý tester theo tài khoản Google, hay
rollout theo tỷ lệ phần trăm, hãy dùng Play internal testing hoặc Firebase App Distribution.

## Bắt đầu trong một phút

Từ **workspace root** (nơi có `docker-compose.yml` và volume `data/`):

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/api/v1/health
KEY=$(docker compose exec -T server node -p 'require("/data/config.json").management_key')
```

Từ **repo server** (chạy độc lập, không cần compose):

```bash
docker build -t my-testflight-server:local .
docker run --rm -p 8080:8080 -v "$PWD/data:/data" my-testflight-server:local
```

Phát triển local cần **Node.js >= 22** (khai báo trong `package.json`):

```bash
npm ci
npm run dev          # tsx watch src/main.ts, mặc định http://0.0.0.0:8080
```

`DATA_DIR` mặc định là `./data` theo thư mục làm việc hiện tại. Khi chạy server từ
`MyTestflightServer/` và muốn dùng volume của workspace, đặt `DATA_DIR=../data`.

## Yêu cầu

- Node.js **>= 22** để chạy dev/test/build; image Docker đã đóng gói Node 22 Alpine.
- Docker (tùy chọn) cho cách chạy container.
- Volume `$DATA_DIR` phải ghi được bởi user chạy server (image dùng user `node`).
- Không cần JDK, Android SDK, `aapt2`, hay công cụ Google nào.

## Volume

```text
$DATA_DIR/config.json                                           # management_key
$DATA_DIR/apps/<appId>/app.json                                 # metadata app
$DATA_DIR/apps/<appId>/app_icon.<png|jpg|webp>                  # icon app-level (tùy chọn)
$DATA_DIR/apps/<appId>/versions/<versionName>/version.json
$DATA_DIR/apps/<appId>/versions/<versionName>/<abi>-<sha16>.apk # một hoặc nhiều APK
$DATA_DIR/apps/<appId>/versions/<versionName>/version_icon.<ext># icon raster tách từ APK
$DATA_DIR/.uploads/                                             # file tạm khi upload
```

`<versionName>` là **nguyên văn** tên phiên bản, kể cả dấu cách, `+`, `()`, chữ Unicode. Client
phải `encodeURIComponent` khi đưa tên vào URL; server dùng đúng giá trị đã decode làm tên thư mục.

`app.json`:

```json
{
  "schemaVersion": 1,
  "name": "Internal CRM",
  "packageName": "com.company.crm",
  "packageBound": true,
  "description": "",
  "developer": "",
  "icon": "app_icon.png"
}
```

`version.json` (một artifact):

```json
{
  "versionCode": 142,
  "versionName": "1.4.2 (beta)+1",
  "minSdk": 26,
  "releaseNotes": "Sửa lỗi đăng nhập",
  "publishedAt": "2026-11-19T08:00:00.000Z",
  "detectedPackageName": "com.company.crm",
  "icon": "version_icon.png",
  "artifacts": [
    {
      "abi": "arm64-v8a",
      "file": "arm64-v8a-1a2b3c4d5e6f7788.apk",
      "sha256": "4567...64 ký tự hex"
    }
  ]
}
```

- Manifest cũ dùng `file`/`sha256` vẫn đọc được: APK đơn đó trở thành artifact `universal`. Khi
  `artifacts` là mảng, nó là nguồn sự thật và `file`/`sha256` cấp version bị bỏ qua.
- Thứ tự ABI: `universal`, `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`, `riscv64`, `armeabi`.
  Artifact đầu tiên là mặc định cho download không có `?abi=`.
- `version.json.icon` chỉ là tên file; `version_icon.<ext>` do server tạo khi tách icon raster.
- `detectedPackageName` là package đọc từ APK đã tạo ra version đó.
- Đọc volume có thể tạo `app.json`/`versions/` còn thiếu bằng cờ `wx`; manifest đã có không bao
  giờ bị ghi đè bởi đường đọc. Volume chỉ đọc vẫn phục vụ catalog với manifest suy ra trong RAM.
- `app.json`/`version.json` được ghi atomically (file tạm + `rename`); field lạ được giữ nguyên.
- Đường dẫn APK/icon phải nằm trong thư mục của nó; symlink và đường dẫn thoát ra ngoài bị bỏ qua.

## Đọc APK: metadata, versionName, label, icon

Mỗi APK tải lên được mở bằng range read trên ZIP central directory và parse binary XML/ARSC thuần
`node:zlib` (không thêm dependency). Kết quả `detected` trả về từ upload/import:

```json
{
  "packageName": "com.company.crm",
  "versionCode": 142,
  "versionName": "1.4.2 (beta)+1",
  "versionNameSource": "literal",
  "label": "Internal CRM",
  "icon": {
    "kind": "raster",
    "entry": "res/mipmap-hdpi/ic_launcher.png",
    "contentType": "image/png",
    "resourceId": 2131427328,
    "density": 240
  },
  "minSdk": 26,
  "targetSdk": 37,
  "abis": ["arm64-v8a"],
  "universal": false,
  "debuggable": false,
  "testOnly": false,
  "split": null,
  "configSplit": false,
  "artifactAbi": "arm64-v8a"
}
```

- `versionNameSource` là `literal` (chuỗi trong manifest), `resource` (resolve được qua
  `resources.arsc`) hoặc `none` (không có/không resolve được; consumer dùng `String(versionCode)`).
- `label` là `android:label`, resolve resource reference nếu có.
- `icon` là **descriptor**, không chứa byte ảnh: `raster` (PNG/JPEG/WebP, density cao nhất),
  `adaptive` (`<adaptive-icon>`) hoặc `vector` (`<vector>`). Server không render vector/adaptive.
- ARSC/XML lỗi, thiếu, hoặc vượt giới hạn chỉ làm giá trị đó không khả dụng; upload vẫn thành công.
- APK config split (`android:split="config.*"` hoặc `configForSplit`) bị từ chối `400 invalid_apk`.
  ZIP64 cũng bị từ chối.

Giới hạn parser: ARSC 32 MiB nén / 64 MiB giải nén, string pool 1 triệu, 256 type và 100 000 entry
mỗi type, icon XML 2 MiB nén / 4 MiB giải nén, ảnh raster 2 MiB.

### Icon theo version và fallback icon app

1. Khi upload, server tách **raster** density cao nhất (PNG/WebP/JPEG, <= 2 MiB) và ghi
   `<versionDir>/version_icon.<ext>` + `version.json.icon`.
2. `GET /api/v1/apps/:appId/icon` trả icon hiệu lực theo thứ tự:
   - file app-level mà `app.json.icon` trỏ tới, nếu tồn tại;
   - icon của version **published** có `versionCode` cao nhất có icon;
   - không có → `404 icon_not_found`.
3. `AppSummary.iconPath` phản ánh icon hiệu lực (kể cả fallback); không có icon thì `null`.
4. `PUT /api/v1/apps/:appId/icon?if_missing=1` không ghi nếu app đã có icon app-level và trả
   `{ "iconPath": "...", "skipped": true }`.
5. `DELETE /api/v1/apps/:appId/icon` chỉ xóa icon app-level, đặt lại `app.json.icon =
   "app_icon.png"`. `GET` sau đó fallback sang icon version mới nhất (nếu có).

Tách icon là best-effort: APK lỗi icon, icon adaptive/vector, hoặc ảnh quá lớn không làm upload
thất bại; version chỉ đơn giản không có `version_icon.*`.

## Package binding và tên phiên bản

### Package

`app.json.packageBound` là nguồn sự thật cho việc verify package:

- `packageBound: true`: `packageName` là package thật; mọi upload/import phải khớp, khác → `422
  apk_metadata_mismatch` (trừ khi bật `allow_mismatch=package`).
- `packageBound: false`: `packageName` chỉ là giá trị tạm (thường bằng `id`). Lần upload/import APK
  **thành công đầu tiên** ghi package thật vào `app.json.packageName`, đặt `packageBound: true`, và
  ghi `version.json.detectedPackageName`.

Quy tắc tạo/bind:

- `POST /api/v1/apps` có `packageName` → `packageBound: true`, **kể cả khi packageName trùng `id`**.
- Bỏ `packageName` → `packageBound: false` và dùng `id` làm giá trị tạm.
- `POST /api/v1/import?create=true` luôn tạo app ở trạng thái bound (nó luôn có package từ APK).
- `app.json` cũ không có `packageBound` được suy luận: bound khi `packageName` khác rỗng và khác
  `id`; unbound khi rỗng hoặc bằng `id`. Đây chỉ là tương thích ngược — app auto-create kiểu mới
  luôn lưu cờ tường minh.
- `AppSummary`/`AppDetail` trả thêm `packageBound` để dashboard phân biệt app đã bind và app còn
  chờ APK đầu tiên.

Các ràng buộc:

- `allow_mismatch=package` vẫn là escape hatch cho API/CLI: nó chấp nhận artifact lệch package
  nhưng **không bao giờ** ghi lại `app.json.packageName` của app đã bind.
- Package của app bound là duy nhất: tạo app/bind trùng → `409 package_in_use`. App unbound không
  giữ chỗ package.
- Đổi `packageName` qua `PUT /api/v1/apps/:appId` khi bất kỳ version nào đã có artifact →
  `409 package_locked`; khi chưa có artifact thì được phép (và vẫn phải duy nhất). Gửi packageName
  không rỗng đặt `packageBound: true`.
- `POST /api/v1/import` mặc định `appId = appIdFromPackage(packageName)`, tên app lấy từ
  `?name=` hoặc `label` của APK; version mặc định là `versionName` đã resolve, nếu vẫn rỗng thì dùng
  `String(versionCode)`. Import kiểm tra package của app bound **trước khi** tạo version/draft.

Package do operator nhập vào `POST/PUT /apps` được kiểm tra dạng Android package (các segment chữ,
số, `_`; tối đa 255 ký tự). Package đọc từ APK không bị áp quy tắc này.

### Tên phiên bản

`versionName` linh hoạt như Play Console. Hợp lệ khi:

- không rỗng, `value === value.trim()`, không bắt đầu/kết thúc bằng `.`;
- không phải `.` hoặc `..`;
- dài tối đa **200 byte UTF-8**;
- không chứa `/`, `\`, NUL, control `0x00–0x1F` hoặc `0x7F–0x9F`;
- cho phép dấu cách, `+`, `()`, `[]`, `~`, `#`, chữ Unicode.

Ví dụ hợp lệ: `1.0.0`, `1.0.0+42`, `0.2.0 (beta)+1`, `Bản nội bộ (beta)`. Không hợp lệ → `400
version_name_invalid` (ở query import hoặc path version). App id vẫn dùng quy tắc cũ
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.

Vì thư mục version dùng nguyên văn tên, hãy encode khi gọi API:

```bash
VERSION='0.2.0 (beta)+1'
ENC=$(node -p 'encodeURIComponent(process.argv[1])' "$VERSION")
curl "http://127.0.0.1:8080/api/v1/apps/crm/versions/$ENC/download"
```

## API

Mọi response là JSON, trừ download APK và icon. Lỗi có dạng
`{ "error": { "code": string, "message": string } }`.

### Đọc (công khai)

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/v1/health` | `{ "status": "ok" }`, `cache-control: no-store` |
| GET | `/api/v1/apps` | `{ "apps": AppSummary[] }`; `iconPath`, `latestVersion` |
| GET | `/api/v1/apps/:appId` | `{ "app": AppDetail }`; 404 `app_not_found` |
| GET | `/api/v1/apps/:appId/icon` | byte ảnh; 404 `icon_not_found`; cache 60 s |
| GET | `/api/v1/apps/:appId/versions/:versionName/download` | stream APK; tùy chọn `?abi=<abi>` |

`VersionSummary` gồm `abis`, `universal`, `artifacts[]`; `sizeBytes`, `sha256`, `downloadPath` mô
tả artifact mặc định. `?abi=` yêu cầu đúng artifact đó (không fallback universal). Header download:
`Content-Type: application/vnd.android.package-archive`, `Content-Disposition` dạng
`<appId>-<versionName>.apk` (hoặc thêm `-<abi>`), `Content-Length`, `Cache-Control: no-store`,
`X-Checksum-Sha256` khi artifact có digest. Phiên bản mới nhất là `versionCode` cao nhất, tie-break
theo tên số học.

### Ghi (cần `X-Management-Key`)

`POST`, `PUT`, `DELETE` đều yêu cầu header khớp `management_key` trong `$DATA_DIR/config.json`;
hai `GET` version dưới đây vẫn công khai.

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/api/v1/apps` | JSON `{ id, name?, packageName?, description?, developer?, icon? }`; 201 `{ app }`; 409 `app_exists`, `package_in_use` |
| PUT | `/api/v1/apps/:appId` | Partial JSON cùng field; 200 `{ app }`; 409 `package_in_use`, `package_locked` |
| DELETE | `/api/v1/apps/:appId` | 204; xóa đệ quy thư mục app |
| PUT | `/api/v1/apps/:appId/icon` | Raw `image/png`, `image/jpeg`, `image/webp` (<= 2 MiB); `?if_missing=1` để không ghi đè; 200 `{ iconPath }` hoặc `{ iconPath, skipped: true }` |
| DELETE | `/api/v1/apps/:appId/icon` | 204; 404 `icon_not_found` |
| GET | `/api/v1/apps/:appId/versions` | `{ versions: VersionAdmin[] }`; gồm cả draft |
| GET | `/api/v1/apps/:appId/versions/:versionName` | `{ version: VersionAdmin }` |
| POST | `/api/v1/apps/:appId/versions` | JSON `{ versionName, versionCode, minSdk?, releaseNotes?, publishedAt? }`; 201 draft; 409 `version_exists`; 400 `version_name_invalid` |
| PUT | `/api/v1/apps/:appId/versions/:versionName` | Partial `versionCode`, `minSdk`, `releaseNotes`, `publishedAt`; tên không đổi; 200 |
| DELETE | `/api/v1/apps/:appId/versions/:versionName` | 204 |
| PUT | `/api/v1/apps/:appId/versions/:versionName/artifacts/:abi` | Raw APK; `?allow_mismatch=`; 201 mới / 200 thay thế; body `{ version, detected }` |
| PUT | `/api/v1/apps/:appId/versions/:versionName/artifacts` | Raw APK; tự suy ABI; `?allow_mismatch=`; 201/200; body `{ version, detected }` |
| DELETE | `/api/v1/apps/:appId/versions/:versionName/artifacts/:abi` | 204; 404 `artifact_not_found` |
| POST | `/api/v1/import` | Chỉ raw APK; query `create`, `appId`, `version`, `versionCode`, `name`, `releaseNotes`, `publishedAt`, `allow_mismatch`; 201 tạo / 200 thay thế; body `{ app, version, detected, artifact, createdApp, createdVersion }` |

`POST` trả `Location`; `DELETE` trả `204` không body. Version mới tạo bằng `POST .../versions` là
**draft** (`artifacts: []`), chỉ hiện trong admin GET cho tới lần upload APK đầu tiên. Xóa artifact
cuối cùng đưa version về draft; xóa version xóa hẳn thư mục.

### Kiểm tra metadata khi upload

| Field | Kỳ vọng | Bỏ qua bởi |
|---|---|---|
| `packageName` | `app.json.packageName` (hoặc package APK ở lần bind đầu) | `allow_mismatch=package` |
| `versionCode` | `version.json.versionCode` hoặc query import | `allow_mismatch=version` |
| `versionName` | tên version (chỉ khi APK khai báo được tên) | `allow_mismatch=version` |
| `minSdk` | `version.json.minSdk`; nếu thiếu thì tự điền từ APK | `allow_mismatch=sdk` |
| ABI | `:abi` trên route (chỉ route có `:abi`) | `allow_mismatch=abi` |

`allow_mismatch` là danh sách con của `package,version,sdk,abi`; giá trị lạ → `400 invalid_request`.
Sai lệch không được bỏ qua → `422 apk_metadata_mismatch`, message liệt kê từng field.

### Ví dụ upload

```bash
KEY=$(docker compose exec -T server node -p 'require("/data/config.json").management_key')
BASE=http://127.0.0.1:8080

# Tạo app và version (draft), rồi upload APK.
curl -X POST "$BASE/api/v1/apps" -H 'content-type: application/json' \
  -H "X-Management-Key: $KEY" -d '{"id":"crm","name":"Internal CRM"}'

curl -X POST "$BASE/api/v1/apps/crm/versions" -H 'content-type: application/json' \
  -H "X-Management-Key: $KEY" -d '{"versionName":"1.4.2 (beta)+1","versionCode":142}'

curl -X PUT "$BASE/api/v1/apps/crm/versions/1.4.2%20(beta)%2B1/artifacts/arm64-v8a" \
  -H 'content-type: application/vnd.android.package-archive' \
  -H "X-Management-Key: $KEY" --data-binary @app-arm64-v8a.apk

# Hoặc để server tự tạo app/version từ APK.
curl -X POST "$BASE/api/v1/import?create=true" \
  -H 'content-type: application/vnd.android.package-archive' \
  -H "X-Management-Key: $KEY" --data-binary @app-arm64-v8a.apk
```

- Content type APK: `application/vnd.android.package-archive` hoặc `application/octet-stream`.
  Icon: `image/png`, `image/jpeg`, `image/webp`.
- Server tính SHA-256 khi stream; client không được gửi `artifacts`, `file`, `sha256` trong body
  version (400).
- `MAX_APK_BYTES` (mặc định `536870912` = 512 MiB) chặn một APK; icon tối đa 2 MiB. Giới hạn được
  kiểm tra từ `Content-Length` trước khi inspect.
- Upload lại cùng ABI là upsert: 200, xóa file cũ khi không còn artifact tham chiếu. ABI mới: 201.
- `publishedAt` nhận ISO 8601; `null` để dùng mtime fallback.

### Import

`POST /api/v1/import` chỉ nhận body APK và suy ra phần còn lại:

- `appId` mặc định `appIdFromPackage(packageName)`; `version` mặc định `versionName` đã resolve,
  nếu không có thì `String(versionCode)`; `versionCode` mặc định từ APK.
- Không có `create=true` và app chưa tồn tại → `404 app_not_found`. Có `create=true` → tạo app với
  `packageName` từ APK và tên từ `?name=`, `label`, hoặc segment cuối của package.
- Metadata được kiểm tra trước khi ghi bất cứ thứ gì, nên 422 không để lại app/version mồ côi.
- 201 khi app/version/artifact mới; 200 khi chỉ thay thế. Nhiều APK split cùng versionName/versionCode
  nằm trong một version, mỗi ABI một artifact.

## Management key

```json
{ "management_key": "0123456789abcdef...64 ký tự hex" }
```

- File `$DATA_DIR/config.json` (`/data/config.json` trong container), cạnh `apps/`.
- Tự tạo khi khởi động nếu thiếu, key 256-bit ngẫu nhiên (64 hex thường), mode `0600`; không ghi đè
  file đã có và không log key.
- Đọc lại trên **mỗi** request ghi: đổi key trong volume có hiệu lực ngay, không cần restart.
- Thiếu/sai header → `401 invalid_management_key`. File thiếu, hỏng, symlink, hoặc key rỗng → ghi
  fail-closed `503 management_key_not_configured`; đọc vẫn hoạt động.
- So sánh timing-safe. Key đi qua HTTP thường theo mặc định; dùng mạng tin cậy hoặc TLS và giữ
  volume riêng tư. Reverse proxy phải chuyển tiếp `X-Management-Key`.
- Đọc key: `docker compose exec server cat /data/config.json` (file thuộc user `node`).

## Lỗi

| Status | Codes |
|---|---|
| 400 | `invalid_request` (id/ABI/query/body/JSON/content-length sai); `version_name_invalid`; `invalid_apk` (không phải ZIP/APK, manifest hỏng, versionCode không phải số nguyên dương, ZIP64, config split) |
| 401 | `invalid_management_key` |
| 404 | `app_not_found`, `version_not_found`, `artifact_not_found`, `icon_not_found` |
| 409 | `app_exists`, `version_exists`, `app_invalid`, `package_in_use`, `package_locked` |
| 413 | `payload_too_large` (APK, icon, hoặc JSON body > 1 MiB) |
| 415 | `unsupported_media_type` |
| 422 | `apk_metadata_mismatch` (message liệt kê package/version/versionName/minSdk/ABI lệch) |
| 503 | `management_key_not_configured` |

## Docker, CI và CORS

- `docker compose up -d --build` (workspace root) rebuild image và tạo lại container; `docker
  compose up` không có `--build` tái sử dụng image cũ.
- Image chạy user `node`, tạo `/data/apps`, best-effort `chown` volume; startup không fail vì
  `mkdir`/`chown` bị từ chối.
- `.github/workflows/build-image.yml` chạy `npm ci`, typecheck, test rồi build/push image đa kiến
  trúc (`linux/amd64`, `linux/arm64`, `linux/arm/v7`, `linux/arm/v6`) lên GHCR. PR chỉ build, không
  push; tag `latest` chỉ từ nhánh mặc định.
- Dashboard là client cross-origin tĩnh. Bật CORS bằng `CORS_ORIGINS` (danh sách origin hoặc `*`):

```bash
CORS_ORIGINS=https://<owner>.github.io npm start
CORS_ORIGINS=https://<owner>.github.io,http://localhost:5173 npm run dev
```

- Entry CORS chỉ gồm scheme + host + port; path/query/credential bị từ chối lúc khởi động. Preflight
  trả `204`, cho `content-type` và `x-management-key` trên `GET,HEAD,POST,PUT,DELETE,OPTIONS`.
- CORS không thay management key. Dashboard HTTPS không gọi được server HTTP thường (mixed content).

## Kiểm thử

```bash
npm ci
npm run typecheck
npm test            # node --test qua tsx: parser, API, upload/import, icon, package binding
npm run build       # tsc -> dist/
```

Test dùng fixture thật `test/fixtures/resources.arsc`, `icon-adaptive.xml`, `icon-vector.xml` và
manifest base64; không cần Android build. Fixture tổng hợp được tạo bằng encoder ARSC trong
`test/apk-fixtures.ts`.

## Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `PORT` | `8080` | Cổng, số nguyên 1–65535 |
| `DATA_DIR` | `./data` | Gốc volume |
| `LOG_LEVEL` | `info` | Pino level |
| `MAX_APK_BYTES` | `536870912` | Kích thước tối đa một APK |
| `CORS_ORIGINS` | *(rỗng)* | Origin browser được phép, hoặc `*`; rỗng tắt CORS |

`$DATA_DIR/config.json` là cấu hình file (`management_key`), không phải biến môi trường; tạo ở lần
khởi động đầu và đọc lại mỗi request ghi.

## Trạng thái và phạm vi

- Repo này là **dịch vụ nội bộ**, không phát hành như package mã nguồn mở. Không có file `LICENSE`
  trong repo; không phân phối lại mã nguồn/volume ra ngoài tổ chức khi chưa được phép.
- Chỉ hỗ trợ APK (không AAB). Không render vector/adaptive icon thành PNG; dashboard/CLI hiển thị
  descriptor hoặc dùng raster có sẵn.
- Một management key cho toàn bộ write API; không có người dùng, vai trò, hay audit log.
- API có thể thay đổi giữa các đợt nội bộ; xem git log của repo này làm changelog.
