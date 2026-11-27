import { HttpError } from "./http-errors";
import { MISMATCH_KINDS, type MismatchKind } from "./apk-verify";
import type { ApkAbi } from "./types";
import { ID_PATTERN, normalizeAbi } from "./volume";

export function requireValidId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return value;
}

export function requireValidAbi(value: string, label = "abi"): ApkAbi {
  const abi = normalizeAbi(value);
  if (abi === null) {
    throw new HttpError(400, "invalid_request", `Invalid ${label} "${value}"`);
  }
  return abi;
}

export function parseAbiQuery(value: unknown): ApkAbi | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid abi");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return requireValidAbi(trimmed);
}

/**
 * Parses `?allow_mismatch=package,version,sdk,abi`. Unknown entries are a
 * request error, not a silent no-op.
 */
export function parseAllowMismatchQuery(value: unknown): MismatchKind[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_request", "Invalid allow_mismatch");
  }

  const allowed: MismatchKind[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (!MISMATCH_KINDS.includes(trimmed as MismatchKind)) {
      throw new HttpError(
        400,
        "invalid_request",
        `Invalid allow_mismatch value "${trimmed}"`,
      );
    }
    const kind = trimmed as MismatchKind;
    if (!allowed.includes(kind)) allowed.push(kind);
  }
  return allowed;
}

/** `create` accepts only `true`, `false`, `1`, or `0`. */
export function parseCreateQuery(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new HttpError(400, "invalid_request", "Invalid create (expected true or false)");
}

export function parsePositiveIntQuery(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  return parsed;
}

export function parseOptionalQueryText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_request", `Invalid ${label}`);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Parses an ISO 8601 `publishedAt` query value into a canonical ISO string. */
export function parsePublishedAtQuery(value: unknown): string | undefined {
  const text = parseOptionalQueryText(value, "publishedAt");
  if (text === undefined) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "invalid_request", "Invalid publishedAt");
  }
  return date.toISOString();
}
