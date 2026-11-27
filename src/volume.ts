import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppManifest, ApkAbi } from "./types";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
export const APK_EXTENSION = /\.apk$/i;
export const DEFAULT_ICON = "app_icon.png";
export const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** Upload content type -> extension for the icon route. */
export const ICON_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Supported ABI labels in display/priority order. `universal` first means it is
 * always the default artifact when present; the rest follow Android's current
 * device distribution so a split-only version still defaults to the most common
 * architecture.
 */
export const ABI_PRIORITY: readonly ApkAbi[] = [
  "universal",
  "arm64-v8a",
  "armeabi-v7a",
  "x86_64",
  "x86",
  "riscv64",
  "armeabi",
];
const ABI_RANK = new Map<ApkAbi, number>(ABI_PRIORITY.map((abi, index) => [abi, index]));
const ABI_SET = new Set<string>(ABI_PRIORITY);

export function normalizeAbi(value: unknown): ApkAbi | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ABI_SET.has(normalized) ? (normalized as ApkAbi) : null;
}

export function compareAbi(left: ApkAbi, right: ApkAbi): number {
  return ABI_RANK.get(left)! - ABI_RANK.get(right)!;
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isProvisioned(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "EISDIR" || code === "ENOTDIR";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function humanizeAppId(id: string): string {
  const parts = id.split(/[-_.]+/).filter((part) => part.length > 0);
  const name = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return name || id;
}

export function defaultAppManifest(id: string): AppManifest {
  return {
    schemaVersion: 1,
    name: humanizeAppId(id),
    packageName: id,
    packageBound: false,
    description: "",
    developer: "",
    icon: DEFAULT_ICON,
  };
}

/**
 * Bound-state for a raw `app.json` object. New manifests persist `packageBound`;
 * legacy manifests without it are inferred as bound only when the package is a
 * real value that differs from the app id.
 */
export function manifestPackageBound(
  record: Record<string, unknown>,
  id: string,
): boolean {
  if (typeof record.packageBound === "boolean") return record.packageBound;
  const packageName = nonBlankString(record.packageName);
  return packageName !== null && packageName !== id;
}

export function normalizeAppManifest(value: unknown, id: string): AppManifest {
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
    packageBound: manifestPackageBound(record, id),
    description: typeof record.description === "string" ? record.description : "",
    developer: typeof record.developer === "string" ? record.developer : "",
    icon: nonBlankString(record.icon) ?? DEFAULT_ICON,
  };
}

/**
 * Resolves `candidate` inside `base`, rejecting absolute paths and anything
 * that escapes `base` (including `..` segments).
 */
export function containedPath(base: string, candidate: string): string | null {
  if (candidate.length === 0 || path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export function resolvePublishedAt(value: unknown, mtime: Date): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return mtime.toISOString();
}

export function resolveSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SHA256_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

export async function readRegularJsonFileWithMtime(
  file: string,
): Promise<{ value: unknown; mtime: Date }> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  const text = await fs.readFile(file, "utf8");
  return { value: JSON.parse(text), mtime: stat.mtime };
}

export async function readRegularJsonFile(file: string): Promise<unknown> {
  return (await readRegularJsonFileWithMtime(file)).value;
}

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const value = await readRegularJsonFile(file);
  if (!isPlainObject(value)) {
    throw new Error(`${path.basename(file)} must contain a JSON object`);
  }
  return value;
}

export async function writeJsonExclusive(
  file: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });
}

/**
 * Writes JSON to a hidden sibling temp file and renames it over the target, so
 * readers never observe a partially written manifest. The temp file is removed
 * when the rename fails.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function unlinkIfExists(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Returns the app directory when `id` names a real directory inside `appsDir`.
 * Symlinks and files are rejected so a write can never escape through one.
 */
export async function resolveAppDir(appsDir: string, id: string): Promise<string | null> {
  if (!ID_PATTERN.test(id)) return null;
  const appDir = path.join(appsDir, id);
  try {
    const stat = await fs.lstat(appDir);
    return stat.isDirectory() ? appDir : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

const locks = new Map<string, Promise<void>>();

/**
 * Serializes async work per key. Used to protect read-modify-write cycles on
 * `app.json` and `version.json` inside one process.
 */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  return run.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
}
