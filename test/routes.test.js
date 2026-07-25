const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

const config = { origins: ["http://localhost:3000"], rooms: { Standard: { price: 1800, inventory: 2 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"], adminSecret: "admin-signing-secret", adminBootstrapKey: "bootstrap-secret", razorpaySecret: "razorpay-secret", razorpayKeyId: "rzp_test_key", contact: {} };
const db = { health: async () => true, approvedReviews: async () => [{ id: "1", customer_name: "Guest", rating: 5, review: "Excellent stay", created_at: "2026-01-01" }], availability: async () => 1 };
const razorpay = { orders: { create: async () => ({ id: "order_1", amount: 100, currency: "INR" }) } };

async function withServer(run) {
  const server = createApp({ config, db, razorpay, logger: { error() {} } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("health, public reviews, validation, and 404 routes smoke test", () => withServer(async (url) => {
  let response = await fetch(`${url}/health`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true, status: "ok" });
  response = await fetch(`${url}/reviews`); const reviews = await response.json(); assert.equal(reviews.reviews[0].customer_email, undefined);
  response = await fetch(`${url}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(response.status, 422);
  response = await fetch(`${url}/missing`); assert.equal(response.status, 404);
}));

test("admin login rejects a bad key and issues a signed token", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin_key: "wrong" }) }); assert.equal(response.status, 401);
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin_key: "bootstrap-secret" }) }); assert.equal(response.status, 200); assert.match((await response.json()).token, /^[^.]+\.[^.]+$/);
}));
