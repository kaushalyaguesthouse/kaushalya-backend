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
  const suppliedPaymentType = text(body.payment_type ?? body.payment_method ?? "Pay Later", 30);
  // The public form historically calls the offline option "Pay at Hotel".
  // Keep one canonical database value while accepting that wire-level name.
  const payment_type = suppliedPaymentType === "Pay at Hotel" ? "Pay Later" : suppliedPaymentType;
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

function validateAvailabilityQuery(query) {
  const errors = {};
  const start = parseDate(query.start_date);
  const end = parseDate(query.end_date);
  if (!start) errors.start_date = "start_date must be a valid YYYY-MM-DD date.";
  if (!end) errors.end_date = "end_date must be a valid YYYY-MM-DD date.";
  if (start && end && start > end) errors.date_range = "start_date must be on or before end_date.";
  if (start && end && start <= end && Math.round((end - start) / DAY_MS) + 1 > 366) errors.date_range = "Date range cannot exceed 366 days.";
  return { valid: Object.keys(errors).length === 0, errors };
}

function createAvailabilityReport(bookings, rooms, startDate, endDate, roomType, generatedAt = new Date()) {
  const roomTypes = roomType ? [roomType] : Object.keys(rooms);
  const days = [];
  for (let date = parseDate(startDate); date <= parseDate(endDate); date = new Date(date.getTime() + DAY_MS)) {
    const dateString = date.toISOString().slice(0, 10);
    for (const type of roomTypes) {
      const blocked = bookings.filter((booking) => booking.room_type === type && ["Pending", "Confirmed"].includes(booking.booking_status) && booking.check_in <= dateString && booking.check_out > dateString).length;
      days.push({ date: dateString, room_type: type, inventory: rooms[type].inventory, blocked, available: Math.max(0, rooms[type].inventory - blocked) });
    }
  }
  return {
    range: { start_date: startDate, end_date: endDate, room_type: roomType || null },
    generated_at: generatedAt.toISOString(),
    blocking_statuses: ["Pending", "Confirmed"],
    days,
    bookings: bookings.map(({ id, booking_id, room_type, check_in, check_out, booking_status }) => ({ id, booking_id, room_type, check_in, check_out, booking_status }))
  };
}

function createAnalyticsSummary(bookings, rooms, generatedAt = new Date()) {
  const now = new Date(generatedAt);
  const today = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const monthStart = `${year}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const yearStart = `${year}-01-01`;
  const weekStartDate = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate()));
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - ((weekStartDate.getUTCDay() + 6) % 7));
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const trendStartDate = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate()));
  trendStartDate.setUTCDate(trendStartDate.getUTCDate() - 29);
  const trendStart = trendStartDate.toISOString().slice(0, 10);
  const rows = Array.isArray(bookings) ? bookings : [];
  const amount = (row) => Number(row.amount) || 0;
  const collected = (row) => row.payment_status === "Verified" ? Number(row.advance_amount) || 0 : 0;
  const booked = (row) => ["Confirmed", "Completed"].includes(row.booking_status) ? amount(row) : 0;
  const createdDate = (row) => String(row.created_at || "").slice(0, 10);
  const totalsSince = (start) => rows.reduce((totals, row) => {
    if (createdDate(row) >= start && createdDate(row) <= today) {
      totals.verified_online_collections += collected(row);
      totals.gross_booked_value += booked(row);
    }
    return totals;
  }, { verified_online_collections: 0, gross_booked_value: 0 });
  const roomEntries = Object.entries(rooms || {});
  const current = rows.filter((row) => row.booking_status === "Confirmed" && row.check_in <= today && row.check_out > today);
  const byStatus = Object.fromEntries(["Pending", "Confirmed", "Cancelled", "Completed"].map((status) => [status, rows.filter((row) => row.booking_status === status).length]));
  const paymentStatuses = {};
  for (const row of rows) paymentStatuses[row.payment_status || "Unknown"] = (paymentStatuses[row.payment_status || "Unknown"] || 0) + 1;
  const byRoomType = Object.fromEntries(roomEntries.map(([roomType, room]) => {
    const occupied = current.filter((row) => row.room_type === roomType).length;
    const blocked = rows.filter((row) => row.room_type === roomType && ["Pending", "Confirmed"].includes(row.booking_status) && row.check_in <= today && row.check_out > today).length;
    const inventory = Math.max(0, Number(room.inventory) || 0);
    return [roomType, { inventory, blocked, occupied, available: Math.max(0, inventory - blocked), occupancy_rate: inventory ? Number(((occupied / inventory) * 100).toFixed(2)) : 0 }];
  }));
  const roomTypePerformance = Object.fromEntries(roomEntries.map(([roomType]) => {
    const matching = rows.filter((row) => row.room_type === roomType);
    return [roomType, {
      bookings: matching.length,
      gross_booked_value: matching.reduce((sum, row) => sum + booked(row), 0),
      verified_online_collections: matching.reduce((sum, row) => sum + collected(row), 0)
    }];
  }));
  const dailyTrends = [];
  for (let date = new Date(`${trendStart}T00:00:00.000Z`); date <= new Date(`${today}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    const matching = rows.filter((row) => createdDate(row) === day);
    dailyTrends.push({ date: day, bookings: matching.length, gross_booked_value: matching.reduce((sum, row) => sum + booked(row), 0), verified_online_collections: matching.reduce((sum, row) => sum + collected(row), 0) });
  }
  const todayTotals = totalsSince(today);
  return {
    summary: {
      today_bookings: rows.filter((row) => createdDate(row) === today).length,
      today_revenue: todayTotals.verified_online_collections,
      current_guests: current.reduce((sum, row) => sum + (Number(row.adults) || 0) + (Number(row.children) || 0), 0),
      rooms: roomEntries.reduce((sum, [, room]) => sum + Math.max(0, Number(room.inventory) || 0), 0)
    },
    revenue_totals: { today: todayTotals, current_week: totalsSince(weekStart), current_month: totalsSince(monthStart), current_year: totalsSince(yearStart) },
    occupancy: { by_room_type: byRoomType },
    booking_status_totals: byStatus,
    payment_statistics: { by_status: paymentStatuses, verified_online_collections: rows.reduce((sum, row) => sum + collected(row), 0) },
    room_type_performance: roomTypePerformance,
    daily_trends: dailyTrends,
    generated_at: now.toISOString(),
    timezone: "UTC"
  };
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

module.exports = { calculatePrice, createAnalyticsSummary, createAvailabilityReport, nightsBetween, overlaps, signAdminToken, validateAvailabilityQuery, validateBooking, validateReview, verifyAdminToken, verifySignature };
