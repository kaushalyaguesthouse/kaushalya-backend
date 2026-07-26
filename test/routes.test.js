const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { verifyAdminToken } = require("../src/core");

const config = { origins: ["http://localhost:3000"], rooms: { Standard: { price: 1800, inventory: 2 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"], adminSecret: "admin-signing-secret", adminBootstrapKey: "bootstrap-secret", razorpaySecret: "razorpay-secret", razorpayKeyId: "rzp_test_key", contact: {} };
const bookingId = "123e4567-e89b-12d3-a456-426614174000";
const reviewId = "123e4567-e89b-12d3-a456-426614174001";
const db = {
  health: async () => true,
  approvedReviews: async () => [{ id: "1", customer_name: "Guest", rating: 5, review: "Excellent stay", created_at: "2026-01-01" }],
  availability: async () => 1,
  bookings: async () => [{ id: bookingId }],
  booking: async (id) => id === bookingId ? { id } : null,
  updateBooking: async (id, status) => id === bookingId ? { id, booking_status: status } : null,
  reviews: async () => [{ id: reviewId, status: "pending" }, { id: "other", status: "approved" }],
  moderateReview: async (id, status) => id === reviewId ? { id, status } : null,
  deleteReview: async (id) => id === reviewId ? { id } : null
};
const razorpay = { orders: { create: async () => ({ id: "order_1", amount: 100, currency: "INR" }) } };

async function withServer(run) {
  const server = createApp({ config, db, razorpay, logger: { error() {}, info() {} } }).listen(0, "127.0.0.1");
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
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapKey: "  bootstrap-secret  " }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["accessToken", "success"]);
  assert.equal(body.success, true);
  assert.match(body.accessToken, /^[^.]+\.[^.]+$/);
  assert.equal(verifyAdminToken(body.accessToken, config.adminSecret), true);
  assert.equal(verifyAdminToken(body.accessToken, "different-session-secret"), false);
}));

test("admin login comparison is case-sensitive and safely rejects different UTF-8 byte lengths", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapKey: "BOOTSTRAP-SECRET" }) });
  assert.equal(response.status, 401);
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapKey: "बूटस्ट्रैप-सेक्रेट" }) });
  assert.equal(response.status, 401);
}));

test("admin login logs secret-safe diagnostics", async () => {
  const entries = [];
  const logger = { error() {}, info(event, details) { entries.push({ event, details }); } };
  const server = createApp({ config, db, razorpay, logger }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapKey: "bootstrap-secret" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(entries, [{ event: "ADMIN_LOGIN_CHECK", details: { bootstrapKeyConfigured: true, requestHasBootstrapKey: true, comparisonSucceeded: true } }]);
    assert.equal(JSON.stringify(entries).includes("bootstrap-secret"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("admin resources require auth and support booking and review moderation", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/bookings`); assert.equal(response.status, 401);
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
  const { accessToken } = await response.json();
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

  response = await fetch(`${url}/admin/bookings`, { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).bookings.length, 1);
  response = await fetch(`${url}/admin/bookings/not-an-id`, { headers }); assert.equal(response.status, 400);
  response = await fetch(`${url}/admin/bookings/${bookingId}`, { headers }); assert.equal((await response.json()).booking.id, bookingId);
  response = await fetch(`${url}/admin/bookings/${bookingId}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "Completed" }) }); assert.equal((await response.json()).booking.booking_status, "Completed");
  response = await fetch(`${url}/admin/bookings/${bookingId}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "invalid" }) }); assert.equal(response.status, 422);

  response = await fetch(`${url}/admin/reviews`, { headers }); assert.equal((await response.json()).reviews.length, 2);
  response = await fetch(`${url}/admin/reviews/${reviewId}`, { method: "PATCH", headers, body: JSON.stringify({ status: "approved" }) }); assert.equal((await response.json()).review.status, "approved");
  response = await fetch(`${url}/admin/reviews/${reviewId}`, { method: "DELETE", headers }); assert.equal(response.status, 200);
}));

test("admin login is rate limited", () => withServer(async (url) => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin_key: "wrong" }) });
  }
  assert.equal(response.status, 429);
}));
