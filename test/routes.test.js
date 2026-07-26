const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { verifyAdminToken } = require("../src/core");

const config = { origins: ["http://localhost:3000"], rooms: { Standard: { price: 1800, inventory: 2 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"], adminSecret: "admin-signing-secret", adminBootstrapKey: "bootstrap-secret", razorpaySecret: "razorpay-secret", razorpayKeyId: "rzp_test_key", contact: {} };
const bookingId = "123e4567-e89b-12d3-a456-426614174000";
const reviewId = "123e4567-e89b-12d3-a456-426614174001";
let receivedBookingFilters;
const db = {
  health: async () => true,
  approvedReviews: async () => [{ id: "1", customer_name: "Guest", rating: 5, review: "Excellent stay", created_at: "2026-01-01" }],
  availability: async () => 1,
  bookings: async (filters) => {
    receivedBookingFilters = filters;
    return { items: [{ id: bookingId, booking_id: "KGH-1", customer_name: "Guest", phone: "9999999999", special_request: "private", razorpay_payment_id: "pay_private" }], total: 51 };
  },
  adminAvailability: async () => [{ id: bookingId, booking_id: "KGH-1", room_type: "Standard", check_in: "2026-08-01", check_out: "2026-08-03", booking_status: "Confirmed", customer_name: "Must not leak" }],
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

test("admin bookings validates, filters, paginates, and projects the listing", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
  const { accessToken } = await response.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  for (const query of ["page=0", "limit=101", "limit=2.5", "status=Unknown", "room_type=Unknown", "check_in_from=2026-02-30", "check_in_from=2026-08-03&check_in_to=2026-08-01"]) {
    response = await fetch(`${url}/admin/bookings?${query}`, { headers });
    assert.equal(response.status, 422, query);
  }

  response = await fetch(`${url}/admin/bookings?search=guest&status=Confirmed&room_type=Standard&check_in_from=2026-08-01&check_in_to=2026-08-03&page=2&limit=25`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(receivedBookingFilters, { search: "guest", status: "Confirmed", room_type: "Standard", check_in_from: "2026-08-01", check_in_to: "2026-08-03", page: 2, limit: 25 });
  assert.deepEqual(body.pagination, { page: 2, limit: 25, total: 51, total_pages: 3 });
  assert.deepEqual(body.filters, { search: "guest", status: "Confirmed", room_type: "Standard", check_in_from: "2026-08-01", check_in_to: "2026-08-03" });
  assert.deepEqual(body.bookings, body.items);
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["booking_id", "customer_name", "id", "phone"]);
  assert.equal(JSON.stringify(body).includes("private"), false);
}));

test("admin availability requires auth, validates its range, and returns a privacy-safe inventory report", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/availability?start_date=2026-08-01&end_date=2026-08-03`);
  assert.equal(response.status, 401);
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
  const { accessToken } = await response.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  for (const query of ["start_date=2026-08-03&end_date=2026-08-01", "start_date=2026-08-01&end_date=2027-08-02", "start_date=2026-02-30&end_date=2026-03-01", "start_date=2026-08-01&end_date=2026-08-03&room_type=Unknown"]) {
    response = await fetch(`${url}/admin/availability?${query}`, { headers }); assert.equal(response.status, 422);
  }
  response = await fetch(`${url}/admin/availability?start_date=2026-08-01&end_date=2026-08-03&room_type=Standard`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.range, { start_date: "2026-08-01", end_date: "2026-08-03", room_type: "Standard" });
  assert.deepEqual(body.blocking_statuses, ["Pending", "Confirmed"]);
  assert.deepEqual(body.days.map(({ blocked, available }) => ({ blocked, available })), [{ blocked: 1, available: 1 }, { blocked: 1, available: 1 }, { blocked: 0, available: 2 }]);
  assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(body.bookings[0]).sort(), ["booking_id", "booking_status", "check_in", "check_out", "id", "room_type"]);
  assert.equal(JSON.stringify(body).includes("Must not leak"), false);
}));

test("admin login is rate limited", () => withServer(async (url) => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin_key: "wrong" }) });
  }
  assert.equal(response.status, 429);
}));
