const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { signAdminToken } = require("../src/core");

const bookingId = "123e4567-e89b-12d3-a456-426614174045";
const config = { origins: [], rooms: {}, adminSecret: "checkout-secret" };
const token = signAdminToken(config.adminSecret);

async function request(db, path, options = {}) {
  const server = createApp({ config, db, razorpay: {}, logger: { error() {}, info() {} } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

const checkoutResult = { success: true, booking_status: "Completed", stay_status: "checked_out", checked_out_at: "2026-07-26T12:00:00.000Z", room_number: "101", housekeeping_status: "dirty", task_type: "turnover", task_status: "pending", email: "private@example.com", phone: "9999999999", razorpay_payment_id: "pay_private", special_request: "private request", operational_status: "maintenance", allocation_range: "[2026-07-25,2026-07-27)" };

test("checkout returns the completed stay, dirty room, cleaning derivation, and turnover task without private data", async () => {
  const response = await request({ async checkOut() { return checkoutResult; } }, `/admin/bookings/${bookingId}/check-out`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { success: true, booking: { booking_status: "Completed", stay_status: "checked_out", checked_out_at: "2026-07-26T12:00:00.000Z" }, room: { room_number: "101", housekeeping_status: "dirty", derived_status: "cleaning" }, housekeeping_task: { task_type: "turnover", status: "pending" } });
  for (const secret of ["private@example.com", "9999999999", "pay_private", "private request", "allocation_range"]) assert.equal(JSON.stringify(body).includes(secret), false);
});

test("checkout requires admin authentication", async () => {
  const response = await request({ async checkOut() { throw new Error("must not run"); } }, `/admin/bookings/${bookingId}/check-out`, { method: "POST", headers: { authorization: "" }, body: "{}" });
  assert.equal(response.status, 401);
});

test("checkout rejects duplicates, unchecked-in stays, non-confirmed bookings, and invalid assignments", async () => {
  const cases = [
    ["already_checked_out", /already been checked out/i], ["not_checked_in", /must be checked in/i],
    ["booking_not_confirmed", /Confirmed/i], ["no_room_assigned", /no active room/i],
    ["multiple_rooms_assigned", /exactly one active room/i]
  ];
  for (const [reason, message] of cases) {
    const response = await request({ async checkOut() { return { success: false, reason }; } }, `/admin/bookings/${bookingId}/check-out`, { method: "POST", body: "{}" });
    assert.equal(response.status, 409, reason);
    assert.match((await response.json()).message, message, reason);
  }
});

test("housekeeping endpoint returns task history through a privacy-safe projection", async () => {
  const task = { id: "task-1", booking_id: bookingId, room_id: "room-1", rooms: { room_number: "101" }, task_type: "turnover", status: "pending", assigned_to: null, notes: null, created_at: "2026-07-26T12:00:00Z", completed_at: null, updated_at: "2026-07-26T12:00:00Z", email: "private@example.com", razorpay_order_id: "order_private", special_request: "private" };
  let response = await request({ async housekeepingTasks() { return [task]; } }, `/admin/bookings/${bookingId}/housekeeping`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.housekeeping_tasks[0].room_number, "101");
  assert.equal(body.housekeeping_tasks[0].task_type, "turnover");
  for (const secret of ["private@example.com", "order_private", "special_request"]) assert.equal(JSON.stringify(body).includes(secret), false);
  response = await request({ async housekeepingTasks() { return null; } }, `/admin/bookings/${bookingId}/housekeeping`);
  assert.equal(response.status, 404);
});
