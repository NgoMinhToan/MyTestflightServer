import { HttpError } from "./http-errors";

/** UTF-8 byte limit for a version name, matching Play Console's 200-character cap. */
export const MAX_VERSION_NAME_BYTES = 200;

const CONTROL_RANGE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A version name is a human label, not a path segment: directories use the raw
 * value, so only path-unsafe characters are rejected. Spaces, `+`, `()`,
 * `[]`, `~`, `#`, and Unicode are allowed.
 */
export function isValidVersionName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_VERSION_NAME_BYTES) return false;
  if (value === "." || value === "..") return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("\u0000")) return false;
  if (CONTROL_RANGE.test(value)) return false;
  return true;
}

export function requireValidVersionName(value: unknown, label = "version name"): string {
  if (!isValidVersionName(value)) {
    throw new HttpError(400, "version_name_invalid", `Invalid ${label} "${String(value)}"`);
  }
  return value;
}
