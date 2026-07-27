const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createSupabaseDb } = require("../src/supabase-db");
const { loadConfig } = require("../src/config");

const config = {
  origins: ["http://localhost:3000"],
  rooms: { Standard: { price: 1800, inventory: 2 }, Deluxe: { price: 2500, inventory: 2 } },
  maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"],
  adminSecret: "session-secret", adminBootstrapKey: "bootstrap-secret", razorpaySecret: "razorpay-secret", contact: {}
};
const base = { customer_name: "Production Guest", phone: "9876543210", email: "guest@example.com", check_in: "2026-07-28", check_out: "2026-07-29", adults: 1, children: 0 };

test("legacy production ROOM_TYPES configuration becomes canonical before validation", () => {
  const loaded = loadConfig({ ROOM_TYPES: "AC Room,Non AC Room", ROOM_PRICE_AC_ROOM: "1500", ROOM_PRICE_NON_AC_ROOM: "1000" });
  assert.deepEqual(Object.keys(loaded.rooms), ["Deluxe", "Standard"]);
  assert.equal(loaded.rooms.Deluxe.price, 1500); assert.equal(loaded.rooms.Standard.price, 1000);
});

async function withServer(dependencies, run) {
  const server = createApp({ config, razorpay: { orders: { create: async () => ({}) } }, mailer: null, ...dependencies }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

for (const [roomType, canonical] of [["AC Room", "Deluxe"], ["Non AC Room", "Standard"]]) {
  test(`${roomType} with Pay Later reaches the RPC as ${canonical}`, () => {
    const calls = [];
    const db = { async createBookingAtomic(value) { calls.push(value); return { ...value, id: "123e4567-e89b-12d3-a456-426614174000" }; } };
    return withServer({ db, logger: { info() {}, error() {} } }, async (url) => {
      const response = await fetch(`${url}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `test-${canonical}` }, body: JSON.stringify({ ...base, room_type: roomType, payment_type: "Pay Later", amount: canonical === "Deluxe" ? 2500 : 1800 }) });
      assert.equal(response.status, 201);
      assert.equal(calls[0].room_type, canonical);
      assert.equal(calls[0].total_amount, canonical === "Deluxe" ? 2500 : 1800);
    });
  });
}

test("AC Room with Razorpay reaches verification with normalized matching data", () => {
  let lookupCalled = false; let rpc;
  const db = {
    async getVerifiedOrder() { lookupCalled = true; return { status: "verified", amount_paise: 75000, razorpay_order_id: "order", razorpay_payment_id: "payment", booking_payload: { room_type: "Deluxe", check_in: base.check_in, check_out: base.check_out } }; },
    async createBookingAtomic(value) { rpc = value; return { ...value, id: "123e4567-e89b-12d3-a456-426614174000" }; }
  };
  return withServer({ db, logger: { info() {}, error() {} } }, async (url) => {
    const response = await fetch(`${url}/create-booking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, room_type: "AC Room", payment_type: "Razorpay", amount: 2500, razorpay_order_id: "order", razorpay_payment_id: "payment" }) });
    assert.equal(response.status, 201); assert.equal(lookupCalled, true); assert.equal(rpc.room_type, "Deluxe");
  });
});

test("booking normalization diagnostics contain only incoming and canonical room values", () => {
  const entries = [];
  const db = { async createBookingAtomic(value) { return { ...value, id: "123e4567-e89b-12d3-a456-426614174000" }; } };
  return withServer({ db, logger: { info(event, details) { entries.push({ event, details }); }, error() {} } }, async (url) => {
    await fetch(`${url}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "diagnostic" }, body: JSON.stringify({ ...base, room_type: "AC Room", payment_type: "Pay Later", amount: 2500 }) });
    const entry = entries.find(({ event }) => event === "BOOKING_ROOM_NORMALIZED");
    assert.equal(entry.details.incoming_room_type, "AC Room"); assert.equal(entry.details.normalized_room_type, "Deluxe");
  });
});

test("booking response does not await email and only confirmed delivery is persisted", async () => {
  let finishDelivery;
  const delivery = new Promise((resolve) => { finishDelivery = resolve; });
  const booking = { ...base, id: "123e4567-e89b-12d3-a456-426614174000", booking_id: "KGH-email", room_type: "Standard", booking_status: "Confirmed", payment_status: "Pending", amount: 1800, advance_amount: 0 };
  let marked = 0;
  const db = {
    async createBookingAtomic() { return booking; },
    async markEmailSent(id) { assert.equal(id, booking.id); marked += 1; }
  };
  const mailer = { async sendBooking() { await delivery; } };
  await withServer({ db, mailer, logger: { info() {}, error() {} } }, async (url) => {
    const response = await fetch(`${url}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "email-does-not-block" }, body: JSON.stringify({ ...base, room_type: "Standard", payment_type: "Pay Later" }) });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { success: true, booking_id: booking.booking_id, booking: [booking] });
    assert.equal(marked, 0);
    finishDelivery();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(marked, 1);
  });
});

test("successful admin login writes an audit record", () => {
  const records = [];
  const db = { async createAuditLog(record) { records.push(record); return { id: 1 }; } };
  return withServer({ db, logger: { info() {}, error() {} } }, async (url) => {
    const response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(records.length, 1); assert.equal(records[0].action, "login"); assert.equal(records[0].entity, "session");
  });
});

test("audit failure logs safe database diagnostics and does not break login", () => {
  const errors = []; const secret = "service-role-super-secret";
  const failure = Object.assign(new Error(`Authorization: Bearer ${secret}`), { code: "42501", operation: "audit_log_insert" });
  const db = { async createAuditLog() { throw failure; } };
  return withServer({ db, logger: { info() {}, error(event, details) { errors.push({ event, details }); } } }, async (url) => {
    const response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors[0].event, "AUDIT_LOG_FAILED"); assert.equal(errors[0].details.database_error_code, "42501");
    assert.equal(errors[0].details.operation, "audit_log_insert"); assert.doesNotMatch(JSON.stringify(errors), new RegExp(secret));
  });
});

test("migration establishes the repository-supported bookings id and complete audit schema", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/010_booking_identifier_and_audit_reconciliation.sql"), "utf8");
  assert.match(sql, /alter table public\.bookings add column if not exists id uuid/);
  assert.match(sql, /create unique index if not exists bookings_id_uidx/);
  assert.match(sql, /create table if not exists public\.audit_logs/);
  assert.match(sql, /grant select, insert on public\.audit_logs to service_role/);
  assert.match(sql, /grant usage, select on sequence/);
  assert.doesNotMatch(sql, /delete from public\.bookings|update public\.bookings set room_type/i);
});

test("admin bookings selects and returns the migration-backed booking identifier", async () => {
  let projection;
  const result = { data: [{ id: "123e4567-e89b-12d3-a456-426614174000", booking_id: "KGH-1" }], count: 1, error: null };
  const chain = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return (resolve) => resolve(result);
      return (...args) => { if (property === "select") projection = args[0]; return chain; };
    }
  });
  const db = createSupabaseDb({ from(table) { assert.equal(table, "bookings"); return chain; } });
  const response = await db.bookings({ page: 1, limit: 25 });
  assert.match(projection, /(^|,)id(,|$)/);
  assert.deepEqual(response.items, result.data);
});
