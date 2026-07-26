const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseDb } = require("../src/supabase-db");

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
  const providerFailure = clientReturning({ data: null, error: { message: "unavailable" } });
  const transportFailure = clientReturning(new Error("network failure"));

  assert.equal(await createSupabaseDb(providerFailure.client).health(), false);
  assert.equal(await createSupabaseDb(transportFailure.client).health(), false);
});
