const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

const config = { origins: ["http://localhost:3000"], rooms: { Standard: { price: 1800, inventory: 1 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"], contact: {} };
const request = { customer_name: "Guest", email: "g@example.com", phone: "9999999999", room_type: "Standard", check_in: "2026-08-01", check_out: "2026-08-02", adults: 1, payment_method: "Pay at Hotel" };

test("booking schema failures return an actionable safe response and diagnostic stage", async () => {
  const logs = [];
  const error = Object.assign(new Error("null value in column refund_status violates not-null constraint"), { name: "DatabaseError", code: "23502", operation: "create_booking_atomic" });
  const db = { async createBookingAtomic() { throw error; } };
  const server = createApp({ config, db, razorpay: {}, logger: { info() {}, error(event, fields) { logs.push({ event, fields }); } } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "booking-1" }, body: JSON.stringify(request) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { success: false, message: "Booking could not be saved because the booking service schema is not ready. Please contact support.", code: "BOOKING_SCHEMA_ERROR" });
    assert.deepEqual(logs.find(({ event }) => event === "BOOKING_CREATE_FAILED").fields.stage, "booking_insert");
    assert.equal(JSON.stringify(logs).includes("refund_status"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("every create-booking conflict logs its request ID, stage, response code, and message", async () => {
  const scenarios = [
    { name: "price", body: { ...request, amount: 1 }, db: {}, stage: "authoritative_price", code: "BOOKING_AMOUNT_MISMATCH" },
    { name: "payment", body: { ...request, payment_type: "Razorpay", razorpay_order_id: "order_1", razorpay_payment_id: "payment_1" }, db: { async getVerifiedOrder() { return { status: "verified", booking_payload: { room_type: "Standard", check_in: "2026-08-02", check_out: "2026-08-03" } }; } }, stage: "payment_booking_match", code: "PAYMENT_BOOKING_MISMATCH" },
    { name: "availability", body: request, db: { async createBookingAtomic() { return null; } }, stage: "availability_commit", code: "ROOM_NO_LONGER_AVAILABLE" },
    { name: "duplicate", body: request, db: { async createBookingAtomic() { throw Object.assign(new Error("sensitive database detail"), { code: "23505" }); } }, stage: "booking_insert", code: "BOOKING_ALREADY_EXISTS" }
  ];

  for (const scenario of scenarios) {
    const logs = [];
    const logger = { error() {}, info(event, fields) { logs.push({ event, fields }); } };
    const server = createApp({ config, db: scenario.db, razorpay: {}, logger }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `booking-${scenario.name}`, "x-request-id": `request-${scenario.name}` }, body: JSON.stringify(scenario.body) });
      assert.equal(response.status, 409, scenario.name);
      const payload = await response.json();
      const conflict = logs.find(({ event }) => event === "BOOKING_CONFLICT");
      assert.deepEqual(conflict, { event: "BOOKING_CONFLICT", fields: { request_id: `request-${scenario.name}`, stage: scenario.stage, code: scenario.code, message: payload.message } });
      assert.equal(payload.code, scenario.code);
      assert.deepEqual(Object.keys(conflict.fields).sort(), ["code", "message", "request_id", "stage"]);
      assert.equal(JSON.stringify(logs).includes("sensitive database detail"), false);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});

test("create-booking validation failures log complete sanitized diagnostics and the exact response", async () => {
  const logs = [];
  const logger = { error() {}, info(event, fields) { logs.push({ event, fields }); } };
  const body = { ...request, email: "not-an-email", password: "do-not-log", razorpay_signature: "also-secret" };
  const server = createApp({ config, db: {}, razorpay: {}, logger }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/create-booking`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "request-validation" }, body: JSON.stringify(body) });
    assert.equal(response.status, 422);
    const responseBody = await response.json();
    const diagnostic = logs.find(({ event }) => event === "BOOKING_VALIDATION_FAILED");
    assert.deepEqual(diagnostic, {
      event: "BOOKING_VALIDATION_FAILED",
      fields: {
        request_id: "request-validation",
        status: 422,
        validation_stage: "validation",
        validation_error_code: "BOOKING_VALIDATION_FAILED",
        validation_message: "Invalid booking information.",
        field_names: Object.keys(responseBody.errors),
        request_payload: { ...body, password: "[REDACTED]", razorpay_signature: "[REDACTED]" },
        response: responseBody
      }
    });
    assert.equal(JSON.stringify(logs).includes("do-not-log"), false);
    assert.equal(JSON.stringify(logs).includes("also-secret"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
