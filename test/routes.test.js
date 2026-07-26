const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { verifyAdminToken } = require("../src/core");

const config = { origins: ["http://localhost:3000"], rooms: { Standard: { price: 1800, inventory: 2 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"], adminSecret: "admin-signing-secret", adminBootstrapKey: "bootstrap-secret", razorpaySecret: "razorpay-secret", razorpayKeyId: "rzp_test_key", contact: {} };
const bookingId = "123e4567-e89b-12d3-a456-426614174000";
const reviewId = "123e4567-e89b-12d3-a456-426614174001";
let receivedBookingFilters;
let receivedRoomFilters;
const roomRows = [
  { id: "room-101", room_number: "101", room_types: { name: "Standard" }, floor: 1, operational_status: "operational", housekeeping_status: "clean", notes: null, is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", guest_name: "Private Guest", payment_id: "pay_private" },
  { id: "room-102", room_number: "102", room_types: { name: "Standard" }, floor: 1, operational_status: "maintenance", housekeeping_status: "clean", notes: "Inspect lock", is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: "room-201", room_number: "201", rooms_types: { name: "Deluxe" }, room_type: "Deluxe", floor: 2, operational_status: "operational", housekeeping_status: "dirty", notes: null, is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: "room-202", room_number: "202", room_types: { name: "Deluxe" }, floor: 2, operational_status: "operational", housekeeping_status: "clean", notes: null, is_active: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }
];
const db = {
  health: async () => true,
  approvedReviews: async () => [{ id: "1", customer_name: "Guest", rating: 5, review: "Excellent stay", created_at: "2026-01-01" }],
  availability: async () => 1,
  bookings: async (filters) => {
    receivedBookingFilters = filters;
    return { items: [{ id: bookingId, booking_id: "KGH-1", customer_name: "Guest", phone: "9999999999", special_request: "private", razorpay_payment_id: "pay_private" }], total: 51 };
  },
  rooms: async (filters) => { receivedRoomFilters = filters; return { items: roomRows.slice(0, 2), total: 4 }; },
  roomStatus: async () => roomRows,
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
  let response = await fetch(`${url}/health`); assert.equal(response.status, 200); const health = await response.json(); assert.equal(health.success, true); assert.equal(health.status, "ok"); assert.equal(health.database, "connected"); assert.equal(health.version, "1.0.0");
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

test("database diagnostics require admin authentication and return only safe diagnostic fields", () => withServer(async (url) => {
  const original = db.databaseDiagnostic;
  db.databaseDiagnostic = async () => ({ success: false, failure_type: "permission_denied", code: "42501", message: "permission denied", details: null, status: 403 });
  try {
    let response = await fetch(`${url}/admin/diagnostics/database`);
    assert.equal(response.status, 401);
    response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
    const { accessToken } = await response.json();
    response = await fetch(`${url}/admin/diagnostics/database`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: false, failure_type: "permission_denied", code: "42501", message: "permission denied", details: null, status: 403 });
  } finally { db.databaseDiagnostic = original; }
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
    assert.deepEqual(entries.find(({ event }) => event === "ADMIN_LOGIN_CHECK"), { event: "ADMIN_LOGIN_CHECK", details: { bootstrapKeyConfigured: true, requestHasBootstrapKey: true, comparisonSucceeded: true } });
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

test("admin rooms requires authentication, validates filters, and paginates a privacy-safe projection", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/rooms`);
  assert.equal(response.status, 401);
  response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
  const { accessToken } = await response.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  for (const query of ["page=0", "page=1.5", "limit=101", "operational_status=closed", "housekeeping_status=unknown", "is_active=yes"]) {
    response = await fetch(`${url}/admin/rooms?${query}`, { headers });
    assert.equal(response.status, 422, query);
  }
  response = await fetch(`${url}/admin/rooms?housekeeping_status=inspected`, { headers });
  assert.equal(response.status, 200);
  response = await fetch(`${url}/admin/rooms?room_type=Standard&operational_status=operational&housekeeping_status=clean&is_active=true&page=2&limit=2`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(receivedRoomFilters, { room_type: "Standard", operational_status: "operational", housekeeping_status: "clean", is_active: "true", page: 2, limit: 2 });
  assert.deepEqual(body.pagination, { page: 2, limit: 2, total: 4, total_pages: 2 });
  assert.equal(body.items[0].room_type, "Standard");
  assert.equal(body.items[0].derived_status, "Available");
  assert.deepEqual(body.items, body.rooms);
  assert.equal(JSON.stringify(body).includes("Private Guest"), false);
  assert.equal(JSON.stringify(body).includes("pay_private"), false);
}));

test("admin room status derives operational and housekeeping states without booking data", () => withServer(async (url) => {
  let response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } });
  const { accessToken } = await response.json();
  response = await fetch(`${url}/admin/rooms/status`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.rooms.map((room) => room.derived_status), ["Available", "Maintenance", "Cleaning", "Out of Service"]);
  assert.deepEqual(body.summary, { available: 1, occupied: 0, reserved: 0, maintenance: 1, cleaning: 1, out_of_service: 1 });
  assert.deepEqual([body.available_count, body.occupied_count, body.reserved_count, body.maintenance_count, body.cleaning_count, body.out_of_service_count], [1, 0, 0, 1, 1, 1]);
  assert.equal(JSON.stringify(body).includes("Private Guest"), false);
}));

test("admin login is rate limited", () => withServer(async (url) => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin_key: "wrong" }) });
  }
  assert.equal(response.status, 429);
}));

test("manual room assignment enforces rules, releases history, and stays privacy-safe", () => {
  const roomId = "123e4567-e89b-12d3-a456-426614174010";
  const records = [];
  let forceOverlap = false;
  let bookingStatus = "Confirmed";
  let room = { id: roomId, room_number: "101", room_type: "Standard", is_active: true, operational_status: "operational" };
  const assignmentDb = {
    ...db,
    async assignRoom(id, requestedRoom) {
      if (forceOverlap) return { success: false, reason: "room_assignment_conflict" };
      if (bookingStatus === "Cancelled" || bookingStatus === "Completed") return { success: false, reason: "booking_status" };
      if (!room.is_active) return { success: false, reason: "room_inactive" };
      if (room.room_type !== "Standard") return { success: false, reason: "room_type_mismatch" };
      if (records.some((entry) => entry.assignment_status === "active")) return { success: false, reason: "already_assigned" };
      const assigned_at = "2026-07-26T12:00:00.000Z";
      records.push({ id: `assignment-${records.length}`, booking_id: id, from: "2026-08-01", until: "2026-08-03", assignment_status: "active", assigned_at, assigned_by: "admin", released_at: null, released_by: null, release_reason: null, room: { id: requestedRoom, room_number: room.room_number, room_type: room.room_type } });
      return { success: true, assigned_at, room: records.at(-1).room };
    },
    async releaseRoom() { const active = records.find((entry) => entry.assignment_status === "active"); if (!active) return { success: false, reason: "not_assigned" }; Object.assign(active, { assignment_status: "released", released_at: "2026-07-26T13:00:00.000Z", released_by: "admin" }); return { success: true }; },
    async roomAssignments() { const history = records.map((entry) => ({ ...entry })); return { current: history.find((entry) => entry.assignment_status === "active") || null, history }; }
  };
  return (async () => {
    const server = createApp({ config, db: assignmentDb, razorpay, logger: { error() {}, info() {} } }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      let response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 401);
      response = await fetch(`${url}/admin/login`, { method: "POST", headers: { "x-admin-key": "bootstrap-secret" } }); const { accessToken } = await response.json();
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      room = { ...room, room_type: "Deluxe" }; response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 409);
      room = { ...room, room_type: "Standard", is_active: false }; response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 409);
      room = { ...room, is_active: true }; bookingStatus = "Cancelled"; response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 409);
      bookingStatus = "Completed"; response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 409);
      bookingStatus = "Confirmed"; response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 201); assert.equal((await response.json()).assignment_status, "active");
      response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) }); assert.equal(response.status, 409);
      response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "DELETE", headers }); assert.deepEqual(await response.json(), { success: true });
      forceOverlap = true;
      response = await fetch(`${url}/admin/bookings/${bookingId}/assign-room`, { method: "POST", headers, body: JSON.stringify({ room_id: roomId }) });
      assert.equal(response.status, 409); assert.deepEqual(await response.json(), { success: false, code: "ROOM_ASSIGNMENT_CONFLICT", message: "The room is already assigned for an overlapping stay." });
      response = await fetch(`${url}/admin/bookings/${bookingId}/assignment`, { headers }); const body = await response.json(); assert.equal(body.current, null); assert.equal(body.history.length, 1); assert.equal(body.history[0].assignment_status, "released");
      assert.deepEqual({ from: body.history[0].from, until: body.history[0].until }, { from: "2026-08-01", until: "2026-08-03" });
      for (const secret of ["guest@example.com", "9999999999", "pay_private", "razorpay", "special_request"]) assert.equal(JSON.stringify(body).toLowerCase().includes(secret), false);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  })();
});
