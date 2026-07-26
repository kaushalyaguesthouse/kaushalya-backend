const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_SCHEMA, classifyHealthFailure, createSupabaseDb, postgrestConnectivityProbe } = require("../src/supabase-db");

const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

test("connectivity probe uses authenticated PostgREST root and no application table", async () => {
  let request;
  const result = await postgrestConnectivityProbe("https://project.supabase.co", "service-secret", async (...args) => { request = args; return response(200); });
  assert.equal(result.success, true); assert.equal(request[0], "https://project.supabase.co/rest/v1/");
  assert.equal(request[1].headers.apikey, "service-secret"); assert.doesNotMatch(request[0], /bookings/);
});

test("connectivity distinguishes invalid credentials and network transport failures", async () => {
  const invalid = await postgrestConnectivityProbe("https://project.supabase.co", "bad", async () => response(401, { code: "PGRST301", message: "Invalid JWT" }));
  assert.equal(invalid.failure_type, "invalid_credentials"); assert.equal(invalid.status, 401);
  const network = await postgrestConnectivityProbe("https://project.supabase.co", "key", async () => { throw Object.assign(new Error("fetch failed?apikey=secret"), { cause: { code: "ENOTFOUND" } }); });
  assert.equal(network.failure_type, "network_error"); assert.doesNotMatch(network.message, /apikey=secret/);
});

test("database health is independent from empty data and schema readiness", async () => {
  const calls = [];
  const client = { from(table) { return { select(columns) { return { async limit(limit) { calls.push({ table, columns, limit }); return table === "reviews" ? { error: { code: "42P01", message: "relation missing" }, status: 404 } : { data: [], error: null, status: 200 }; } }; } }; } };
  const db = createSupabaseDb(client, { error() {} }, { url: "https://project.supabase.co", key: "service", fetch: async () => response(200) });
  assert.equal(await db.health(), true);
  const schema = await db.schemaDiagnostic(); assert.equal(schema.ready, false); assert.equal(schema.checked, Object.keys(REQUIRED_SCHEMA).length);
  assert.deepEqual(schema.failures.map((x) => x.resource), ["reviews"]); assert.ok(calls.every((x) => x.limit === 0));
});

test("failed health logs only sanitized diagnostics", async () => {
  const entries = []; const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature";
  const db = createSupabaseDb({}, { error(event, details) { entries.push({ event, details }); } }, { url: "https://project.supabase.co", key: jwt, fetch: async () => response(401, { code: "PGRST301", message: `Authorization: Bearer ${jwt}` }) });
  assert.equal(await db.health(), false); assert.equal(entries[0].details.failure_type, "invalid_credentials"); assert.doesNotMatch(JSON.stringify(entries), new RegExp(jwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("health failure classifier covers schema, permissions, network, and query errors", () => {
  assert.equal(classifyHealthFailure({ code: "PGRST301", message: "Invalid JWT" }, 401), "invalid_credentials");
  assert.equal(classifyHealthFailure({ code: "42P01", message: "relation does not exist" }, 404), "missing_table");
  assert.equal(classifyHealthFailure({ code: "42501", message: "row-level security" }, 403), "rls");
  assert.equal(classifyHealthFailure({ code: "42501", message: "permission denied" }, 403), "permission_denied");
  assert.equal(classifyHealthFailure(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), null), "network_error");
});
