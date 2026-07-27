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
