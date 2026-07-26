const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyHealthFailure, createSupabaseDb } = require("../src/supabase-db");

function clientReturning(result) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        calls.push(["from", table]);
        return {
          select(columns, options) {
            calls.push(["select", columns, options]);
            return {
              async limit(value) {
                calls.push(["limit", value]);
                if (result instanceof Error) throw result;
                return result;
              }
            };
          }
        };
      }
    }
  };
}

test("database health uses a minimal Supabase GET query", async () => {
  const fake = clientReturning({ data: [], error: null });

  assert.equal(await createSupabaseDb(fake.client).health(), true);
  assert.deepEqual(fake.calls, [
    ["from", "bookings"],
    ["select", "id", undefined],
    ["limit", 1]
  ]);
});

test("database health reports Supabase errors and transport failures", async () => {
  const entries = [];
  const logger = { error(event, details) { entries.push({ event, details }); } };
  const providerFailure = clientReturning({ data: null, error: { code: "42P01", message: "relation does not exist", details: "Missing public.bookings" }, status: 404 });
  const transportFailure = clientReturning(Object.assign(new Error("fetch failed for https://example.supabase.co/rest/v1/bookings?apikey=secret"), { cause: { code: "ENOTFOUND" } }));

  assert.equal(await createSupabaseDb(providerFailure.client, logger).health(), false);
  assert.equal(await createSupabaseDb(transportFailure.client, logger).health(), false);
  assert.deepEqual(entries[0], {
    event: "DATABASE_HEALTH_CHECK_FAILED",
    details: {
      failure_type: "missing_table",
      error: { code: "42P01", message: "relation does not exist", details: "Missing public.bookings" },
      http_status: 404
    }
  });
  assert.equal(entries[1].details.failure_type, "network_error");
  assert.equal(entries[1].details.error.code, "ENOTFOUND");
  assert.match(entries[1].details.error.message, /apikey=\[REDACTED\]/);
  assert.doesNotMatch(entries[1].details.error.message, /apikey=secret/);
});

test("database health classifies actionable Supabase failures", () => {
  assert.equal(classifyHealthFailure({ code: "PGRST301", message: "Invalid JWT" }, 401), "invalid_credentials");
  assert.equal(classifyHealthFailure({ code: "42501", message: "new row violates row-level security policy" }, 403), "rls");
  assert.equal(classifyHealthFailure({ code: "42501", message: "permission denied for table bookings" }, 403), "permission_denied");
  assert.equal(classifyHealthFailure({ code: "PGRST100", message: "failed to parse query" }, 400), "query_error");
  assert.equal(classifyHealthFailure(new TypeError("unexpected client failure"), null), "transport_error");
});
