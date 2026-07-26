const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { redact } = require("../src/logger");
const { loadConfig, validateConfig } = require("../src/config");

const config = { origins: ["https://allowed.example"], rooms: {}, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later"], adminSecret: "a".repeat(32), adminBootstrapKey: "b".repeat(32), bodyLimit: "1kb", rateLimit: 100, rateWindowMs: 60000 };
const db = { health: async () => true };

async function serverFor(run, overrides = {}) {
  const server = createApp({ config: { ...config, ...overrides }, db, razorpay: {}, logger: { info() {}, error() {} } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("health endpoints expose monitoring fields without secrets", () => serverFor(async (url) => {
  for (const endpoint of ["/health", "/health/database", "/health/application"]) {
    const response = await fetch(url + endpoint);
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const field of ["status", "uptime", "version", "database", "memory", "timestamp"]) assert.ok(Object.hasOwn(body, field), `${endpoint}: ${field}`);
    assert.equal(JSON.stringify(body).includes(config.adminSecret), false);
  }
}));

test("security policy rejects untrusted origins and sends hardened headers", () => serverFor(async (url) => {
  let response = await fetch(`${url}/health/application`, { headers: { origin: "https://evil.example" } });
  assert.equal(response.status, 403); assert.equal((await response.json()).code, "CORS_DENIED");
  response = await fetch(`${url}/health/application`, { headers: { origin: "https://allowed.example" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("strict-transport-security"), /max-age/);
  assert.equal(response.headers.get("x-powered-by"), null);
}));

test("invalid JSON, oversized bodies, and dangerous input use consistent private errors", () => serverFor(async (url) => {
  let response = await fetch(`${url}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { success: false, message: "Request body is not valid JSON.", code: "INVALID_JSON" });
  response = await fetch(`${url}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(2000) }) });
  assert.equal(response.status, 413); assert.equal((await response.json()).code, "PAYLOAD_TOO_LARGE");
  response = await fetch(`${url}/quote?search=${encodeURIComponent("bad\u0001value")}`);
  assert.equal(response.status, 400); assert.equal((await response.json()).code, "INVALID_REQUEST");
}));

test("structured logger redacts credential-bearing keys", () => {
  const safe = redact({ authorization: "Bearer jwt", nested: { razorpay_key_secret: "secret", ordinary: "ok" } });
  assert.deepEqual(safe, { authorization: "[REDACTED]", nested: { razorpay_key_secret: "[REDACTED]", ordinary: "ok" } });
});

test("startup configuration validation catches insecure production values", () => {
  const loaded = loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "http://insecure.example", PORT: "70000" });
  assert.deepEqual(validateConfig(loaded), ["PORT must be between 1 and 65535.", "Production ALLOWED_ORIGINS must use HTTPS."]);
});
