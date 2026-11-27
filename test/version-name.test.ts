import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VERSION_NAME_BYTES,
  isValidVersionName,
  requireValidVersionName,
} from "../src/version-name";
import { HttpError } from "../src/http-errors";

test("accepts Play Console style version names", () => {
  const valid = [
    "1.0.0",
    "1.0.0+42",
    "0.2.0 (beta)+1",
    "Bản nội bộ (beta)",
    "release [2026] ~#ready",
    "v 1.2.3",
    "x".repeat(MAX_VERSION_NAME_BYTES),
  ];
  for (const value of valid) {
    assert.equal(isValidVersionName(value), true, value);
  }
});

test("rejects path-unsafe, control, and overlong version names", () => {
  const invalid = [
    "",
    " leading",
    "trailing ",
    ".dotted",
    "dotted.",
    ".",
    "..",
    "a/b",
    "a\\b",
    "a\u0000b",
    "a\u0001b",
    "a\u007fb",
    "a\u0085b",
    "x".repeat(MAX_VERSION_NAME_BYTES + 1),
    "ệ".repeat(101),
  ];
  for (const value of invalid) {
    assert.equal(isValidVersionName(value), false, JSON.stringify(value));
  }
  assert.equal(isValidVersionName(42), false);
});

test("requireValidVersionName throws version_name_invalid", () => {
  assert.equal(requireValidVersionName("1.0.0 (beta)"), "1.0.0 (beta)");
  assert.throws(
    () => requireValidVersionName("bad/name"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "version_name_invalid",
  );
});
