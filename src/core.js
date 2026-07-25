const crypto = require("crypto");

const DAY_MS = 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(?:\+91|91)?[6-9]\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value, max) {
  return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, max);
}

function parseDate(value) {
  if (!DATE_RE.test(String(value))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function nightsBetween(checkIn, checkOut) {
  const start = parseDate(checkIn);
  const end = parseDate(checkOut);
  return start && end ? Math.round((end - start) / DAY_MS) : NaN;
}

function calculatePrice(roomPrice, nights) {
  const paidNights = nights - Math.floor(nights / 7);
  return { nights, complimentary_nights: nights - paidNights, paid_nights: paidNights, total_amount: roomPrice * paidNights };
}

function validateBooking(body, config, today = new Date()) {
  const errors = {};
  const customer_name = text(body.customer_name ?? body.guest_name, 100);
  const email = text(body.email, 254).toLowerCase();
  const phone = text(body.phone ?? body.mobile, 15).replace(/[\s-]/g, "");
  const room_type = text(body.room_type, 80);
  const check_in = String(body.check_in ?? "");
  const check_out = String(body.check_out ?? "");
  const adults = Number(body.adults);
  const children = Number(body.children ?? 0);
  const payment_type = text(body.payment_type ?? body.payment_method ?? "Pay Later", 30);
  if (customer_name.length < 2) errors.customer_name = "Guest name must be at least 2 characters.";
  if (!EMAIL_RE.test(email)) errors.email = "A valid email is required.";
  if (!PHONE_RE.test(phone)) errors.phone = "A valid Indian mobile number is required.";
  if (!config.rooms[room_type]) errors.room_type = "Unknown room type.";
  const nights = nightsBetween(check_in, check_out);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = parseDate(check_in);
  if (!start) errors.check_in = "Check-in must be a valid YYYY-MM-DD date.";
  else if (start.getTime() < todayUtc) errors.check_in = "Check-in cannot be in the past.";
  if (!parseDate(check_out) || !(nights > 0)) errors.check_out = "Check-out must be after check-in.";
  else if (nights > config.maxStayNights) errors.check_out = `Stay cannot exceed ${config.maxStayNights} nights.`;
  if (!Number.isInteger(adults) || adults < 1 || adults > config.maxGuests) errors.adults = "Adult count is invalid.";
  if (!Number.isInteger(children) || children < 0 || children > config.maxGuests) errors.children = "Child count is invalid.";
  if (Number.isInteger(adults) && Number.isInteger(children) && adults + children > config.maxGuests) errors.guests = `Guest count cannot exceed ${config.maxGuests}.`;
  if (!config.paymentMethods.includes(payment_type)) errors.payment_type = "Unsupported payment method.";
  const pricing = config.rooms[room_type] && nights > 0 ? calculatePrice(config.rooms[room_type].price, nights) : null;
  return { valid: Object.keys(errors).length === 0, errors, value: { customer_name, email, phone, room_type, check_in, check_out, adults, children, payment_type, special_request: text(body.special_request, 1000), ...pricing } };
}

function validateReview(body) {
  const value = { customer_name: text(body.customer_name ?? body.name, 100), customer_email: text(body.customer_email ?? body.email, 254).toLowerCase(), rating: Number(body.rating), review: text(body.review ?? body.review_text, 2000) };
  const errors = {};
  if (value.customer_name.length < 2) errors.customer_name = "Name must be at least 2 characters.";
  if (!EMAIL_RE.test(value.customer_email)) errors.customer_email = "A valid email is required.";
  if (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5) errors.rating = "Rating must be an integer from 1 to 5.";
  if (value.review.length < 10) errors.review = "Review must be between 10 and 2000 characters.";
  return { valid: Object.keys(errors).length === 0, errors, value };
}

function verifySignature(orderId, paymentId, signature, secret) {
  if (![orderId, paymentId, signature, secret].every(Boolean)) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  const received = String(signature);
  return expected.length === received.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function overlaps(existingStart, existingEnd, requestedStart, requestedEnd) {
  return existingStart < requestedEnd && existingEnd > requestedStart;
}

function signAdminToken(secret, ttlSeconds = 3600, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAdminToken(token, secret, now = Date.now()) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  try { const decoded = JSON.parse(Buffer.from(payload, "base64url")); return decoded.role === "admin" && decoded.exp > now / 1000; } catch { return false; }
}

module.exports = { calculatePrice, nightsBetween, overlaps, signAdminToken, validateBooking, validateReview, verifyAdminToken, verifySignature };
