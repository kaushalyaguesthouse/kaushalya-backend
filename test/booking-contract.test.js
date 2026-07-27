const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBooking } = require("../src/core");
const { canonicalPaymentType, normalizeBookingRequest } = require("../src/booking-contract");

const config = { rooms: { Standard: { price: 1800 }, Deluxe: { price: 2500 } }, maxStayNights: 90, maxGuests: 10, paymentMethods: ["Pay Later", "Razorpay"] };
const base = { customer_name: "Production Guest", email: "guest@example.com", phone: "9876543210", check_in: "2026-08-01", check_out: "2026-08-03", adults: "2", children: "0" };
const validate = (extra) => validateBooking({ ...base, ...extra }, config, new Date("2026-07-27T00:00:00Z"));

test("the shared contract normalizes both public payment radio values", () => {
  assert.equal(canonicalPaymentType("later"), "Pay Later");
  assert.equal(canonicalPaymentType("advance"), "Razorpay");
});

for (const [room, canonical] of [["AC Room", "Deluxe"], ["Non AC Room", "Standard"], ["Deluxe", "Deluxe"], ["Standard", "Standard"]]) {
  for (const [payment, canonicalPayment] of [["later", "Pay Later"], ["advance", "Razorpay"]]) {
    test(`${room} with ${payment} produces the canonical booking contract`, () => {
      const result = validate({ room_type: room, payment_method: payment });
      assert.equal(result.valid, true);
      assert.equal(result.value.room_type, canonical);
      assert.equal(result.value.payment_type, canonicalPayment);
      assert.equal(result.value.nights, 2);
      assert.equal(result.value.paid_nights, 2);
      assert.equal(result.value.complimentary_nights, 0);
      assert.equal(result.value.total_amount, canonical === "Deluxe" ? 5000 : 3600);
    });
  }
}

test("normalization accepts alternate guest fields and preserves server-authoritative fields", () => {
  assert.deepEqual(normalizeBookingRequest({ guest_name: "Guest", mobile: "9999999999", room_type: "AC Room", payment_type: "advance" }), {
    guest_name: "Guest", mobile: "9999999999", customer_name: "Guest", phone: "9999999999", room_type: "Deluxe", payment_type: "Razorpay", children: 0
  });
});

test("invalid ranges, phones, and missing required fields remain field-specific", () => {
  assert.equal(validate({ room_type: "Standard", payment_type: "later", check_out: "2026-08-01" }).errors.check_out, "Check-out must be after check-in.");
  assert.equal(validate({ room_type: "Standard", payment_type: "later", phone: "123" }).errors.phone, "A valid Indian mobile number is required.");
  assert.equal(validate({ room_type: "Standard", payment_type: "later", customer_name: "" }).errors.customer_name, "Guest name must be at least 2 characters.");
});
