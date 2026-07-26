const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");

test("admin signing secret supports the documented precedence and aliases", () => {
  assert.equal(loadConfig({ ADMIN_SESSION_SECRET: "session", JWT_SECRET: "jwt", ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "session");
  assert.equal(loadConfig({ JWT_SECRET: "jwt", ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "jwt");
  assert.equal(loadConfig({ ADMIN_TOKEN_SECRET: "legacy" }).adminSecret, "legacy");
});

test("admin bootstrap key is read from ADMIN_BOOTSTRAP_KEY and trimmed", () => {
  assert.equal(loadConfig({ ADMIN_BOOTSTRAP_KEY: "  bootstrap-secret  " }).adminBootstrapKey, "bootstrap-secret");
  assert.equal(loadConfig({}).adminBootstrapKey, "");
});

test("Supabase configuration uses the service role environment variables", () => {
  const config = loadConfig({
    SUPABASE_URL: "  https://project.supabase.co  ",
    SUPABASE_SERVICE_ROLE_KEY: "  service-role-key  ",
    SUPABASE_ANON_KEY: "anon-key"
  });

  assert.equal(config.supabaseUrl, "https://project.supabase.co");
  assert.equal(config.supabaseKey, "service-role-key");
  assert.equal(config.supabaseKeySource, "service_role");
});

test("configuration normalizes only matching surrounding quotes and never lets anon override service role", () => {
  const config = loadConfig({ SUPABASE_URL: '  "https://project.supabase.co"  ', SUPABASE_SERVICE_ROLE_KEY: " ' service ' ", SUPABASE_ANON_KEY: "anon" });
  assert.equal(config.supabaseUrl, "https://project.supabase.co"); assert.equal(config.supabaseKey, "service");
  assert.equal(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_ANON_KEY: " anon " }).supabaseKeySource, "anon");
  assert.equal(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: "'unmatched" }).supabaseKey, "'unmatched");
});
