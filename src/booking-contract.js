const { canonicalRoomType } = require("./room-types");

const PAYMENT_TYPE_ALIASES = Object.freeze({
  later: "Pay Later",
  "pay later": "Pay Later",
  "pay at hotel": "Pay Later",
  advance: "Razorpay",
  razorpay: "Razorpay"
});

function canonicalPaymentType(value) {
  const supplied = String(value ?? "Pay Later").trim();
  return PAYMENT_TYPE_ALIASES[supplied.toLowerCase()] || supplied;
}

/** Normalize the public wire contract before any validation or pricing. */
function normalizeBookingRequest(body = {}) {
  return {
    ...body,
    customer_name: body.customer_name ?? body.guest_name,
    phone: body.phone ?? body.mobile,
    room_type: canonicalRoomType(body.room_type),
    payment_type: canonicalPaymentType(body.payment_type ?? body.payment_method),
    children: body.children ?? 0
  };
}

module.exports = { PAYMENT_TYPE_ALIASES, canonicalPaymentType, normalizeBookingRequest };
