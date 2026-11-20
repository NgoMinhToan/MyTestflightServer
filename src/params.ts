import { HttpError } from "./http-errors";
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
