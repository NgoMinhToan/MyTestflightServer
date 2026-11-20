import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config";
import { createHarness } from "./harness";

const ORIGIN = "https://owner.github.io";

test("CORS is off by default", async (t) => {
  const { app } = await createHarness(t);
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { origin: ORIGIN },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("preflight from an allowed origin returns the CORS contract", async (t) => {
  const { app } = await createHarness(t, { corsOrigins: [ORIGIN] });
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/apps",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-management-key",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(response.headers.vary, "Origin");
  assert.match(String(response.headers["access-control-allow-methods"]), /POST/);
  assert.match(String(response.headers["access-control-allow-headers"]), /x-management-key/);
  assert.equal(response.headers["access-control-allow-private-network"], "true");
});

test("actual requests echo only an allowed origin", async (t) => {
  const { app } = await createHarness(t, { corsOrigins: [ORIGIN] });

  const allowed = await app.inject({
    method: "GET",
    url: "/api/v1/apps",
    headers: { origin: ORIGIN },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);
  assert.match(String(allowed.headers["access-control-expose-headers"]), /content-disposition/);

  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/apps",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("a wildcard origin is allowed without echoing the request origin", async (t) => {
  const { app } = await createHarness(t, { corsOrigins: ["*"] });
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/apps/demo/versions",
    headers: {
      origin: "https://anything.example",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers.vary, undefined);
});

test("CORS_ORIGINS parsing normalizes origins and rejects paths", () => {
  const config = readConfig({
    CORS_ORIGINS: " https://Owner.GitHub.io/ , http://localhost:3000, ",
  });
  assert.deepEqual(config.corsOrigins, [
    "https://owner.github.io",
    "http://localhost:3000",
  ]);

  assert.throws(
    () => readConfig({ CORS_ORIGINS: "https://owner.github.io/dashboard" }),
    /use an origin without a path/,
  );
  assert.throws(
    () => readConfig({ CORS_ORIGINS: "ftp://owner.github.io" }),
    /expected http\(s\)/,
  );
});
