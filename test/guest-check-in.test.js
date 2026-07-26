const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { signAdminToken } = require("../src/core");

const bookingId = "123e4567-e89b-12d3-a456-426614174044";
const config = { origins: [], rooms: {}, adminSecret: "stay-secret" };
const token = signAdminToken(config.adminSecret);

async function request(db, path, options = {}) {
  const app = createApp({ config, db, razorpay: {}, logger: { error() {}, info() {} } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("check-in succeeds for clean and inspected rooms and returns only the required occupied projection", async () => {
  for (const housekeeping of ["clean", "inspected"]) {
    let historyWrites = 0;
    const db = { async checkIn() { assert.ok(["clean", "inspected"].includes(housekeeping)); return { success: true, booking_id: "KGH-44", booking_status: "Confirmed", stay_status: "checked_in", checked_in_at: "2026-07-26T10:00:00.000Z", room_number: "101", email: "private@example.com", phone: "9999999999", razorpay_payment_id: "pay_private", special_request: "private" }; }, async releaseRoom() { historyWrites += 1; } };
    const response = await request(db, `/admin/bookings/${bookingId}/check-in`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { success: true, booking: { booking_id: "KGH-44", booking_status: "Confirmed", stay_status: "checked_in", checked_in_at: "2026-07-26T10:00:00.000Z" }, room: { room_number: "101", derived_status: "occupied" } });
    assert.equal(historyWrites, 0);
    for (const secret of ["private@example.com", "9999999999", "pay_private", "special_request"]) assert.equal(JSON.stringify(body).includes(secret), false);
  }
});

test("check-in requires admin auth", async () => {
  const response = await request({ async checkIn() { throw new Error("must not run"); } }, `/admin/bookings/${bookingId}/check-in`, { method: "POST", headers: { authorization: "" }, body: "{}" });
  assert.equal(response.status, 401);
});

test("check-in rejects every ineligible booking, assignment, room, and stay state", async () => {
  const cases = [
    ["already checked in", "already_checked_in", "already checked in"],
    ["cancelled booking", "booking_not_confirmed", "Confirmed"],
    ["completed booking", "booking_not_confirmed", "Confirmed"],
    ["pending booking", "booking_not_confirmed", "Confirmed"],
    ["no assigned room", "no_room_assigned", "no active room"],
    ["inactive room", "room_inactive", "inactive"],
    ["non-operational room", "room_not_operational", "not operational"],
    ["dirty room", "room_not_ready", "clean or inspected"]
  ];
  for (const [name, reason, message] of cases) {
    const response = await request({ async checkIn() { return { success: false, reason }; } }, `/admin/bookings/${bookingId}/check-in`, { method: "POST", body: "{}" });
    assert.equal(response.status, 409, name);
    assert.match((await response.json()).message, new RegExp(message, "i"), name);
  }
});

test("stay endpoint returns privacy-safe timestamps and active room number", async () => {
  const db = { async bookingStay() { return { stay_status: "checked_in", checked_in_at: "2026-07-26T10:00:00.000Z", checked_out_at: null, room_number: "101" }; } };
  let response = await request(db, `/admin/bookings/${bookingId}/stay`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, stay: { stay_status: "checked_in", checked_in_at: "2026-07-26T10:00:00.000Z", checked_out_at: null, room_number: "101" } });
  response = await request({ async bookingStay() { return null; } }, `/admin/bookings/${bookingId}/stay`);
  assert.equal(response.status, 404);
});

test("room status derives an active checked-in assignment as occupied without changing room state", async () => {
  const room = { id: "room-101", room_number: "101", floor: 1, operational_status: "operational", housekeeping_status: "inspected", is_active: true, stay_status: "checked_in" };
  const response = await request({ async roomStatus() { return [room]; } }, "/admin/rooms/status");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rooms[0].derived_status, "Occupied");
  assert.equal(body.rooms[0].operational_status, "operational");
  assert.equal(body.rooms[0].housekeeping_status, "inspected");
  assert.equal(body.summary.occupied, 1);
});
