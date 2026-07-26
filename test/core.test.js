const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { calculatePrice, createAvailabilityReport, nightsBetween, overlaps, signAdminToken, validateAvailabilityQuery, validateBooking, validateReview, verifyAdminToken, verifySignature } = require("../src/core");
const config = { rooms: { Standard: { price: 1800, inventory: 2 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"] };

test("date and complimentary-night calculations", () => { assert.equal(nightsBetween("2026-08-01", "2026-08-08"), 7); assert.deepEqual(calculatePrice(1800, 7), { nights: 7, complimentary_nights: 1, paid_nights: 6, total_amount: 10800 }); });
test("booking validation rejects past dates and untrusted values", () => { const result = validateBooking({ customer_name: "A", email: "bad", phone: "123", room_type: "Fake", check_in: "2025-01-01", check_out: "2025-01-01", adults: 0 }, config, new Date("2026-07-25T00:00:00Z")); assert.equal(result.valid, false); assert.ok(Object.keys(result.errors).length >= 6); });
test("booking validation produces authoritative price", () => { const result = validateBooking({ customer_name: "Guest Name", email: "guest@example.com", phone: "+919876543210", room_type: "Standard", check_in: "2026-08-01", check_out: "2026-08-09", adults: 2, children: 1, payment_type: "Razorpay" }, config, new Date("2026-07-25T00:00:00Z")); assert.equal(result.valid, true); assert.equal(result.value.total_amount, 12600); });
test("half-open overlap permits same-day turnover", () => { assert.equal(overlaps("2026-08-01", "2026-08-03", "2026-08-03", "2026-08-05"), false); assert.equal(overlaps("2026-08-01", "2026-08-04", "2026-08-03", "2026-08-05"), true); });
test("reviews are validated and HTML delimiters removed", () => { const good = validateReview({ name: "Guest", email: "g@example.com", rating: 5, review: "<b>Wonderful stay</b>" }); assert.equal(good.valid, true); assert.equal(good.value.review.includes("<"), false); assert.equal(validateReview({ name: "x", email: "bad", rating: 6, review: "short" }).valid, false); });
test("Razorpay signature uses constant-time HMAC comparison", () => { const signature = crypto.createHmac("sha256", "secret").update("order|payment").digest("hex"); assert.equal(verifySignature("order", "payment", signature, "secret"), true); assert.equal(verifySignature("order", "payment", "bad", "secret"), false); });
test("admin tokens expire and reject tampering", () => { const token = signAdminToken("long-secret", 60, 1000); assert.equal(verifyAdminToken(token, "long-secret", 2000), true); assert.equal(verifyAdminToken(`${token}x`, "long-secret", 2000), false); assert.equal(verifyAdminToken(token, "long-secret", 62000), false); });

test("availability ranges contain at most 366 inclusive days", () => {
  assert.equal(validateAvailabilityQuery({ start_date: "2024-01-01", end_date: "2024-12-31" }).valid, true);
  assert.equal(validateAvailabilityQuery({ start_date: "2024-01-01", end_date: "2025-01-01" }).valid, false);
});

test("availability report emits every room/date and only active statuses block inventory", () => {
  const rooms = { Standard: { inventory: 2 }, Deluxe: { inventory: 1 } };
  const base = { room_type: "Standard", check_in: "2026-08-01", check_out: "2026-08-02" };
  const bookings = ["Pending", "Confirmed", "Cancelled", "Completed"].map((booking_status, index) => ({ ...base, id: String(index), booking_id: `KGH-${index}`, booking_status }));
  const report = createAvailabilityReport(bookings, rooms, "2026-08-01", "2026-08-02", undefined, new Date("2026-01-01T00:00:00Z"));
  assert.equal(report.days.length, 4);
  assert.deepEqual(report.days[0], { date: "2026-08-01", room_type: "Standard", inventory: 2, blocked: 2, available: 0 });
  assert.deepEqual(report.days.map((day) => [day.date, day.room_type]), [["2026-08-01", "Standard"], ["2026-08-01", "Deluxe"], ["2026-08-02", "Standard"], ["2026-08-02", "Deluxe"]]);
});
