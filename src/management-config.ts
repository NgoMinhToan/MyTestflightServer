import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "./http-errors";
import {
  errorCode,
  nonBlankString,
  readJsonObject,
  writeJsonExclusive,
} from "./volume";

export const MANAGEMENT_KEY_HEADER = "x-management-key";
export const MANAGEMENT_CONFIG_FILENAME = "config.json";

const MANAGEMENT_KEY_FIELD = "management_key";

export function managementConfigPath(dataDir: string): string {
  return path.join(dataDir, MANAGEMENT_CONFIG_FILENAME);
}

export function generateManagementKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Creates `$DATA_DIR/config.json` with a generated key when it is missing.
 * Never overwrites and never throws: a read-only volume must not take the read
 * API down. Write requests fail closed with 503 until the file exists.
 */
export async function ensureManagementConfig(
  dataDir: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const file = managementConfigPath(dataDir);
  try {
    await writeJsonExclusive(
      file,
      { [MANAGEMENT_KEY_FIELD]: generateManagementKey() },
      0o600,
    );
    logger.warn(
      { file },
      "created config.json with a generated management_key; read it from the mounted volume",
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    logger.warn(
      { err: error, file },
      "could not create config.json; write endpoints will return 503 until it exists",
    );
  }
}

/**
 * Reads the configured key fresh from disk. Returns null for every unusable
 * state (missing, unreadable, symlinked, invalid JSON, blank/non-string key) so
 * callers fail closed without leaking which state was hit.
 */
export async function readManagementKey(dataDir: string): Promise<string | null> {
  try {
    const raw = await readJsonObject(managementConfigPath(dataDir));
    return nonBlankString(raw[MANAGEMENT_KEY_FIELD]);
  } catch {
    return null;
  }
}

export async function requireManagementKey(
  dataDir: string,
  provided: string | string[] | undefined,
): Promise<void> {
  const configured = await readManagementKey(dataDir);
  if (configured === null) {
    throw new HttpError(
      503,
      "management_key_not_configured",
      "management_key is not configured in config.json",
    );
  }

  if (typeof provided !== "string" || provided.length === 0) {
    throw new HttpError(
      401,
      "invalid_management_key",
      "A valid X-Management-Key header is required",
    );
  }

  const expected = createHash("sha256").update(configured, "utf8").digest();
  const actual = createHash("sha256").update(provided, "utf8").digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new HttpError(
      401,
      "invalid_management_key",
      "A valid X-Management-Key header is required",
    );
  }
}
