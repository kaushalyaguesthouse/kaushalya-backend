const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");

test("admin signing secret supports the documented precedence and aliases", () => {
  assert.equal(loadConfig({ ADMIN_SESSION_SECRET: "session", JWT_SECRET: "jwt", ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "session");
  assert.equal(loadConfig({ JWT_SECRET: "jwt", ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "jwt");
  assert.equal(loadConfig({ ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "legacy");
});
