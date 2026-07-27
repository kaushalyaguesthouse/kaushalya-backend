const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createAnalyticsSummary, signAdminToken } = require("../src/core");

const now = new Date("2026-07-26T12:34:56.000Z");
const rooms = { Standard: { inventory: 3, price: 1800 }, Deluxe: { inventory: 0, price: 2500 } };
const bookings = [
  { customer_name: "Private Guest", email: "private@example.com", phone: "9999999999", special_request: "secret", booking_payload: { private: true }, razorpay_payment_id: "pay_secret", room_type: "Standard", check_in: "2026-07-25", check_out: "2026-07-28", adults: 2, children: 1, booking_status: "Confirmed", payment_status: "Verified", amount: 1000, advance_amount: 300, created_at: "2026-07-26T01:00:00Z" },
  { room_type: "Standard", check_in: "2026-07-26", check_out: "2026-07-27", adults: 4, children: 0, booking_status: "Pending", payment_status: "Pending", amount: 2000, advance_amount: 0, created_at: "2026-07-26T02:00:00Z" },
  { room_type: "Standard", check_in: "2026-07-20", check_out: "2026-07-21", adults: 1, children: 0, booking_status: "Completed", payment_status: "Verified", amount: 1500, advance_amount: 450, created_at: "2026-07-20T02:00:00Z" },
  { room_type: "Deluxe", check_in: "2026-07-26", check_out: "2026-07-29", adults: 2, children: 0, booking_status: "Cancelled", payment_status: "Verified", amount: 5000, advance_amount: 500, created_at: "2026-07-01T02:00:00Z" }
];

test("analytics applies booking, occupancy, revenue, and payment rules", () => {
  const result = createAnalyticsSummary(bookings, rooms, now);
  assert.deepEqual(result.summary, { today_bookings: 2, today_revenue: 300, current_guests: 3, rooms: 3 });
  assert.deepEqual(result.revenue_totals.today, { verified_online_collections: 300, gross_booked_value: 1000 });
  assert.deepEqual(result.revenue_totals.current_week, { verified_online_collections: 750, gross_booked_value: 2500 });
  assert.deepEqual(result.revenue_totals.current_month, { verified_online_collections: 1250, gross_booked_value: 2500 });
  assert.deepEqual(result.booking_status_totals, { Pending: 1, Confirmed: 1, Cancelled: 1, Completed: 1 });
  assert.deepEqual(result.occupancy.by_room_type.Standard, { inventory: 3, blocked: 2, occupied: 1, available: 1, occupancy_rate: 33.33 });
  assert.deepEqual(result.occupancy.by_room_type.Deluxe, { inventory: 0, blocked: 0, occupied: 0, available: 0, occupancy_rate: 0 });
  assert.deepEqual(result.payment_statistics, { by_status: { Verified: 3, Pending: 1 }, verified_online_collections: 1250 });
  assert.equal(result.room_type_performance.Standard.gross_booked_value, 2500);
  assert.equal(result.room_type_performance.Deluxe.gross_booked_value, 0);
  assert.equal(result.daily_trends.length, 30);
  assert.deepEqual(result.daily_trends.at(-1), { date: "2026-07-26", bookings: 2, gross_booked_value: 1000, verified_online_collections: 300 });
  assert.equal(result.generated_at, now.toISOString());
  assert.equal(result.timezone, "Asia/Kolkata");
  for (const forbidden of ["Private Guest", "private@example.com", "9999999999", "secret", "pay_secret", "booking_payload"]) assert.equal(JSON.stringify(result).includes(forbidden), false);
});

test("analytics handles an empty database and zero inventory", () => {
  const result = createAnalyticsSummary([], { Standard: { inventory: 0 } }, now);
  assert.deepEqual(result.summary, { today_bookings: 0, today_revenue: 0, current_guests: 0, rooms: 0 });
  assert.deepEqual(result.revenue_totals.current_year, { verified_online_collections: 0, gross_booked_value: 0 });
  assert.deepEqual(result.payment_statistics, { by_status: {}, verified_online_collections: 0 });
  assert.equal(result.occupancy.by_room_type.Standard.occupancy_rate, 0);
  assert.equal(result.daily_trends.length, 30);
});

test("a new Pay Later booking appears with fewer than 1,000 analytics rows", () => {
  const payLater = {
    room_type: "Standard", check_in: "2026-07-27", check_out: "2026-07-28",
    adults: 1, children: 0, booking_status: "Confirmed", payment_status: "Pending",
    amount: 1800, advance_amount: 0, created_at: "2026-07-26T11:00:00Z"
  };
  const result = createAnalyticsSummary([payLater], rooms, now);
  assert.equal(result.summary.today_bookings, 1);
  assert.equal(result.revenue_totals.today.gross_booked_value, 1800);
  assert.equal(result.revenue_totals.today.verified_online_collections, 0);
  assert.equal(result.booking_status_totals.Confirmed, 1);
  assert.equal(result.payment_statistics.by_status.Pending, 1);
  assert.deepEqual(result.daily_trends.at(-1), { date: "2026-07-26", bookings: 1, gross_booked_value: 1800, verified_online_collections: 0 });
});

test("analytics assigns UTC timestamps to the Asia/Kolkata business date", () => {
  const nearMidnightUtc = {
    room_type: "Standard", check_in: "2026-07-27", check_out: "2026-07-28",
    adults: 2, children: 1, booking_status: "Confirmed", payment_status: "Pending",
    amount: 1800, advance_amount: 0, created_at: "2026-07-26T20:00:00Z"
  };
  const result = createAnalyticsSummary([nearMidnightUtc], rooms, new Date("2026-07-26T20:30:00Z"));
  assert.deepEqual(result.summary, { today_bookings: 1, today_revenue: 0, current_guests: 3, rooms: 3 });
  assert.deepEqual(result.revenue_totals.today, { verified_online_collections: 0, gross_booked_value: 1800 });
  assert.deepEqual(result.daily_trends.at(-1), { date: "2026-07-27", bookings: 1, gross_booked_value: 1800, verified_online_collections: 0 });
  assert.equal(result.timezone, "Asia/Kolkata");
});

test("analytics summary route requires existing admin authentication and returns no PII", async () => {
  const config = { origins: [], rooms, adminSecret: "analytics-secret", paymentMethods: [] };
  const createdToday = new Date().toISOString();
  const routeBookings = [{ ...bookings[1], booking_status: "Confirmed", created_at: createdToday }];
  const db = { analyticsBookings: async () => routeBookings };
  const server = createApp({ config, db, razorpay: {}, logger: { error() {} } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/analytics/summary`;
    let response = await fetch(url);
    assert.equal(response.status, 401);
    response = await fetch(url, { headers: { authorization: `Bearer ${signAdminToken(config.adminSecret)}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["analytics", "booking_status_totals", "daily_trends", "generated_at", "occupancy", "payment_statistics", "revenue_totals", "room_type_performance", "success", "summary", "timezone"]);
    assert.equal(body.success, true);
    assert.deepEqual(body.analytics.summary, body.summary);
    assert.deepEqual(body.analytics.summary, { today_bookings: 1, today_revenue: 0, current_guests: 0, rooms: 3 });
    assert.equal(body.analytics.revenue_totals.today.gross_booked_value, 2000);
    assert.equal(body.analytics.payment_statistics.by_status.Pending, 1);
    assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.timezone, "Asia/Kolkata");
    for (const forbidden of ["Private Guest", "private@example.com", "9999999999", "secret", "pay_secret", "razorpay"]) assert.equal(JSON.stringify(body).toLowerCase().includes(forbidden.toLowerCase()), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
