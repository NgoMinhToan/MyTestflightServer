import { ID_PATTERN } from "./volume";

const PACKAGE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PACKAGE_LENGTH = 255;

/**
 * Android application id check. Segments are dot separated and start with a
 * letter or underscore; digits, letters, and underscores may follow. The APK
 * inspector does not apply this rule, but operator-supplied package names do.
 */
export function isValidPackageName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PACKAGE_LENGTH) return false;
  if (value !== value.trim()) return false;
  const segments = value.split(".");
  if (segments.length === 0) return false;
  return segments.every((segment) => PACKAGE_SEGMENT.test(segment));
}

/**
 * Deterministic app id for a package name. Normal package names are already
 * valid ids; anything else is sanitized into `ID_PATTERN`.
 */
export function appIdFromPackage(packageName: string): string {
  const trimmed = packageName.trim();
  if (ID_PATTERN.test(trimmed)) return trimmed;

  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 64);
  return ID_PATTERN.test(sanitized) ? sanitized : "app";
}
