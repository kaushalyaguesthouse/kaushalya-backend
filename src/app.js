const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createAnalyticsSummary, createAvailabilityReport, validateAvailabilityQuery, validateBooking, validateReview, verifySignature, signAdminToken, verifyAdminToken } = require("./core");

function createRateLimiter(limit = 120, windowMs = 60000) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip; const entry = clients.get(key);
    if (!entry || entry.reset < now) clients.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > limit) return res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
    return next();
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = ["Pending", "Confirmed", "Cancelled", "Completed"];
const ADMIN_BOOKING_FIELDS = ["id", "booking_id", "customer_name", "phone", "email", "room_type", "check_in", "check_out", "adults", "children", "booking_status", "payment_status", "amount", "advance_amount", "created_at"];
const OPERATIONAL_STATUSES = ["operational", "maintenance", "out_of_service"];
const HOUSEKEEPING_STATUSES = ["clean", "dirty", "cleaning"];
const ROOM_FIELDS = ["id", "room_number", "floor", "operational_status", "housekeeping_status", "notes", "is_active", "created_at", "updated_at"];

function deriveRoomStatus(room) {
  if (!room.is_active || room.operational_status === "out_of_service") return "Out of Service";
  if (room.operational_status === "maintenance") return "Maintenance";
  if (room.housekeeping_status !== "clean") return "Cleaning";
  return "Available";
}

function publicRoom(room) {
  const roomType = room.room_type || room.room_types;
  return { ...Object.fromEntries(ROOM_FIELDS.map((field) => [field, room[field]])), room_type: typeof roomType === "string" ? roomType : roomType?.name, derived_status: deriveRoomStatus(room) };
}

function validateRoomsQuery(query) {
  const errors = {};
  const integer = (name, fallback, maximum) => {
    if (query[name] == null || query[name] === "") return fallback;
    if (!/^\d+$/.test(String(query[name])) || Number(query[name]) < 1) errors[name] = `${name} must be an integer greater than or equal to 1.`;
    else if (maximum && Number(query[name]) > maximum) errors[name] = `${name} must not exceed ${maximum}.`;
    return Number(query[name]);
  };
  const filters = { room_type: String(query.room_type || "").trim(), operational_status: String(query.operational_status || "").trim(), housekeeping_status: String(query.housekeeping_status || "").trim(), is_active: query.is_active == null || query.is_active === "" ? "" : String(query.is_active).toLowerCase(), page: integer("page", 1), limit: integer("limit", 25, 100) };
  if (filters.operational_status && !OPERATIONAL_STATUSES.includes(filters.operational_status)) errors.operational_status = "Invalid operational status.";
  if (filters.housekeeping_status && !HOUSEKEEPING_STATUSES.includes(filters.housekeeping_status)) errors.housekeeping_status = "Invalid housekeeping status.";
  if (filters.is_active && !["true", "false"].includes(filters.is_active)) errors.is_active = "is_active must be true or false.";
  return { valid: Object.keys(errors).length === 0, errors, filters };
}

function isDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateAdminBookingsQuery(query, rooms) {
  const errors = {};
  const integer = (name, fallback, maximum) => {
    if (query[name] == null || query[name] === "") return fallback;
    if (!/^\d+$/.test(String(query[name])) || Number(query[name]) < 1) errors[name] = `${name} must be an integer greater than or equal to 1.`;
    else if (maximum && Number(query[name]) > maximum) errors[name] = `${name} must not exceed ${maximum}.`;
    return Number(query[name]);
  };
  const filters = {
    search: String(query.search || "").trim(),
    status: String(query.status || "").trim(),
    room_type: String(query.room_type || "").trim(),
    check_in_from: String(query.check_in_from || "").trim(),
    check_in_to: String(query.check_in_to || "").trim(),
    page: integer("page", 1),
    limit: integer("limit", 25, 100)
  };
  if (filters.status && !BOOKING_STATUSES.includes(filters.status)) errors.status = "Invalid booking status.";
  if (filters.room_type && !rooms[filters.room_type]) errors.room_type = "Unknown room type.";
  for (const name of ["check_in_from", "check_in_to"]) if (filters[name] && !isDate(filters[name])) errors[name] = `${name} must be a valid date in YYYY-MM-DD format.`;
  if (!errors.check_in_from && !errors.check_in_to && filters.check_in_from && filters.check_in_to && filters.check_in_from > filters.check_in_to) errors.check_in_to = "check_in_to must be on or after check_in_from.";
  return { valid: Object.keys(errors).length === 0, errors, filters };
}

function validateUuid(req, res, next) {
  if (!UUID_RE.test(String(req.params.id || ""))) return res.status(400).json({ success: false, message: "Invalid ID." });
  return next();
}

function createApp({ config, db, razorpay, mailer, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" }); next(); });
  app.use(cors({ origin(origin, callback) { callback(null, !origin || config.origins.includes(origin)); }, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Key"] }));
  app.use(express.json({ limit: "100kb" }));
  app.use(createRateLimiter());

  const fail = (res, status, message, errors) => res.status(status).json({ success: false, message, ...(errors && { errors }) });
  const admin = (req, res, next) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return verifyAdminToken(token, config.adminSecret) ? next() : fail(res, 401, "Admin authentication required.");
  };
  const validate = (body) => validateBooking(body, config);

  app.get("/", (_req, res) => res.status(200).send("Kaushalya Guest House Backend Running"));
  app.get("/health", async (_req, res) => {
    const healthy = await db.health();
    res.status(healthy ? 200 : 503).json({ success: healthy, status: healthy ? "ok" : "degraded" });
  });
  app.get("/rooms", (_req, res) => res.json({ success: true, rooms: config.rooms }));
  app.post("/quote", (req, res) => {
    const result = validate(req.body);
    if (!result.valid) return fail(res, 422, "Invalid booking information.", result.errors);
    return res.json({ success: true, quote: result.value });
  });
  app.post("/availability", async (req, res, next) => {
    try {
      const result = validate({ ...req.body, customer_name: req.body.customer_name || "Availability", email: req.body.email || "availability@example.com", phone: req.body.phone || "9999999999", adults: req.body.adults || 1, payment_type: req.body.payment_type || "Pay Later" });
      if (result.errors.room_type || result.errors.check_in || result.errors.check_out) return fail(res, 422, "Invalid availability request.", result.errors);
      const remaining = await db.availability(result.value.room_type, result.value.check_in, result.value.check_out, config.rooms[result.value.room_type].inventory);
      return res.json({ success: true, available: remaining > 0, remaining, room_type: result.value.room_type, check_in: result.value.check_in, check_out: result.value.check_out });
    } catch (error) { next(error); }
  });

  app.post("/create-order", async (req, res, next) => {
    try {
      const result = validate(req.body);
      if (!result.valid) return fail(res, 422, "Invalid booking information.", result.errors);
      const advance = Math.round(result.value.total_amount * 0.3);
      const key = String(req.headers["idempotency-key"] || crypto.randomUUID()).slice(0, 100);
      const old = await db.findOrderByKey(key);
      if (old) return res.json({ success: true, order_id: old.razorpay_order_id, amount: old.amount_paise, currency: "INR", key_id: config.razorpayKeyId, quote: result.value });
      const order = await razorpay.orders.create({ amount: advance * 100, currency: "INR", receipt: `KGH_${Date.now()}`, notes: { room_type: result.value.room_type, check_in: result.value.check_in, check_out: result.value.check_out } });
      await db.saveOrder({ idempotency_key: key, razorpay_order_id: order.id, amount_paise: order.amount, booking_payload: result.value, status: "created" });
      return res.status(201).json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: config.razorpayKeyId, quote: result.value });
    } catch (error) { next(error); }
  });

  app.post("/verify-payment", async (req, res, next) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, config.razorpaySecret)) return fail(res, 400, "Payment signature verification failed.");
      const order = await db.verifyOrder({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
      if (!order) return fail(res, 404, "Payment order was not created by this server.");
      return res.json({ success: true, message: "Payment verified successfully.", payment_status: "verified" });
    } catch (error) { next(error); }
  });

  app.post("/create-booking", async (req, res, next) => {
    try {
      const result = validate(req.body);
      if (!result.valid) return fail(res, 422, "Invalid booking information.", result.errors);
      if (req.body.amount != null && Number(req.body.amount) !== result.value.total_amount) return fail(res, 409, "Booking amount does not match the authoritative price.", { amount: `Expected ${result.value.total_amount}.` });
      let payment = { status: "pending" };
      if (result.value.payment_type === "Razorpay") {
        payment = await db.getVerifiedOrder(req.body.razorpay_order_id, req.body.razorpay_payment_id);
        if (!payment) return fail(res, 402, "A server-verified Razorpay payment is required.");
        if (payment.booking_payload.room_type !== result.value.room_type || payment.booking_payload.check_in !== result.value.check_in || payment.booking_payload.check_out !== result.value.check_out) return fail(res, 409, "Payment order does not match booking details.");
      }
      const idempotencyKey = String(req.headers["idempotency-key"] || req.body.idempotency_key || (payment.razorpay_payment_id ? `payment:${payment.razorpay_payment_id}` : "")).slice(0, 100);
      if (!idempotencyKey) return fail(res, 400, "Idempotency-Key header is required for pay-later bookings.");
      const booking = await db.createBookingAtomic(
  {
    ...result.value,
    booking_id: `KGH-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    idempotency_key: idempotencyKey,
    amount: result.value.total_amount,
    advance_amount: payment.amount_paise
      ? payment.amount_paise / 100
      : 0,
    payment_status:
      payment.status === "verified" ? "Verified" : "Pending",

    refund_status: "Not Requested",

    razorpay_order_id: payment.razorpay_order_id || null,
    razorpay_payment_id: payment.razorpay_payment_id || null
  },
  config.rooms[result.value.room_type].inventory
);
      if (!booking) return fail(res, 409, "The selected room is no longer available.");
      if (!booking.email_sent_at && mailer) mailer.sendBooking(booking, config.contact).then(() => db.markEmailSent(booking.id)).catch((error) => logger.error("BOOKING_EMAIL_FAILED", { booking_id: booking.booking_id, message: error.message }));
      return res.status(201).json({ success: true, booking_id: booking.booking_id, booking: [booking] });
    } catch (error) { next(error); }
  });

  app.post("/create-review", async (req, res, next) => { try { const result = validateReview(req.body); if (!result.valid) return fail(res, 422, "Invalid review.", result.errors); await db.createReview(result.value); return res.status(201).json({ success: true, message: "Review submitted successfully." }); } catch (error) { next(error); } });
  app.get("/reviews", async (_req, res, next) => { try { res.json({ success: true, reviews: await db.approvedReviews() }); } catch (error) { next(error); } });
  app.post("/admin/login", createRateLimiter(5, 15 * 60000), (req, res) => {
    const requestHasBootstrapKey = typeof req.body?.bootstrapKey === "string";
    const supplied = String(req.headers["x-admin-key"] || req.body?.bootstrapKey || req.body?.admin_key || "").trim();
    const expected = String(config.adminBootstrapKey || "").trim();
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    const comparisonSucceeded = expectedBytes.length > 0 && suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
    logger.info?.("ADMIN_LOGIN_CHECK", {
      bootstrapKeyConfigured: expectedBytes.length > 0,
      requestHasBootstrapKey,
      comparisonSucceeded
    });
    if (!comparisonSucceeded) return fail(res, 401, "Invalid admin credentials.");
    res.json({ success: true, accessToken: signAdminToken(config.adminSecret) });
  });
  app.get("/admin/bookings", admin, async (req, res, next) => {
    try {
      const validation = validateAdminBookingsQuery(req.query, config.rooms);
      if (!validation.valid) return fail(res, 422, "Invalid booking filters.", validation.errors);
      const result = await db.bookings(validation.filters);
      const rows = Array.isArray(result) ? result : result.items;
      const items = rows.map((booking) => Object.fromEntries(ADMIN_BOOKING_FIELDS.filter((field) => Object.hasOwn(booking, field)).map((field) => [field, booking[field]])));
      const total = Array.isArray(result) ? items.length : result.total;
      const { page, limit, ...filters } = validation.filters;
      return res.json({ success: true, items, bookings: items, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }, filters });
    } catch (e) { next(e); }
  });
  app.get("/admin/rooms", admin, async (req, res, next) => {
    try {
      const validation = validateRoomsQuery(req.query);
      if (!validation.valid) return fail(res, 422, "Invalid room filters.", validation.errors);
      const result = await db.rooms(validation.filters);
      const items = result.items.map(publicRoom);
      const { page, limit, ...filters } = validation.filters;
      return res.json({ success: true, items, rooms: items, pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) }, filters });
    } catch (e) { next(e); }
  });
  app.get("/admin/rooms/status", admin, async (_req, res, next) => {
    try {
      const rooms = (await db.roomStatus()).map(publicRoom);
      const summary = { available: 0, occupied: 0, reserved: 0, maintenance: 0, cleaning: 0, out_of_service: 0 };
      const keys = { Available: "available", Occupied: "occupied", Reserved: "reserved", Maintenance: "maintenance", Cleaning: "cleaning", "Out of Service": "out_of_service" };
      for (const room of rooms) summary[keys[room.derived_status]] += 1;
      return res.json({ success: true, rooms, summary, available_count: summary.available, occupied_count: summary.occupied, reserved_count: summary.reserved, maintenance_count: summary.maintenance, cleaning_count: summary.cleaning, out_of_service_count: summary.out_of_service });
    } catch (e) { next(e); }
  });
  app.get("/admin/availability", admin, async (req, res, next) => {
    try {
      const validation = validateAvailabilityQuery(req.query);
      if (req.query.room_type != null && !config.rooms[req.query.room_type]) validation.errors.room_type = "Unknown room type.";
      if (!validation.valid || validation.errors.room_type) return fail(res, 422, "Invalid availability range.", validation.errors);
      const bookings = await db.adminAvailability(req.query.start_date, req.query.end_date, req.query.room_type);
      return res.json({ success: true, ...createAvailabilityReport(bookings, config.rooms, req.query.start_date, req.query.end_date, req.query.room_type) });
    } catch (e) { next(e); }
  });
  app.get("/admin/analytics/summary", admin, async (_req, res, next) => {
    try { return res.json({ success: true, ...createAnalyticsSummary(await db.analyticsBookings(), config.rooms) }); }
    catch (e) { next(e); }
  });
  app.post("/admin/bookings/:id/assign-room", admin, validateUuid, async (req, res, next) => {
    try {
      if (!UUID_RE.test(String(req.body?.room_id || ""))) return fail(res, 422, "A valid room_id is required.", { room_id: "room_id must be a UUID." });
      const result = await db.assignRoom(req.params.id, req.body.room_id, "admin");
      if (!result?.success) {
        const failures = {
          booking_not_found: [404, "Booking not found."], room_not_found: [404, "Room not found."],
          booking_status: [409, "Only Pending or Confirmed bookings may be assigned a room."],
          room_inactive: [409, "The room is inactive."], room_not_operational: [409, "The room is not operational."],
          room_type_mismatch: [409, "The room type does not match the booking."], already_assigned: [409, "The booking already has an active room assignment."]
        };
        const [status, message] = failures[result?.reason] || [409, "The room could not be assigned."];
        return fail(res, status, message);
      }
      return res.status(201).json({ success: true, booking_id: req.params.id, room: result.room, assigned_at: result.assigned_at, assignment_status: "active" });
    } catch (e) { next(e); }
  });
  app.delete("/admin/bookings/:id/assign-room", admin, validateUuid, async (req, res, next) => {
    try {
      const result = await db.releaseRoom(req.params.id, "admin", typeof req.body?.release_reason === "string" ? req.body.release_reason.slice(0, 500) : null);
      if (!result?.success) return fail(res, result?.reason === "booking_not_found" ? 404 : 409, result?.reason === "booking_not_found" ? "Booking not found." : "The booking has no active room assignment.");
      return res.json({ success: true });
    } catch (e) { next(e); }
  });
  app.get("/admin/bookings/:id/assignment", admin, validateUuid, async (req, res, next) => {
    try {
      const result = await db.roomAssignments(req.params.id);
      if (!result) return fail(res, 404, "Booking not found.");
      return res.json({ success: true, current: result.current, history: result.history });
    } catch (e) { next(e); }
  });
  app.get("/admin/bookings/:id", admin, validateUuid, async (req, res, next) => { try { const booking = await db.booking(req.params.id); return booking ? res.json({ success: true, booking }) : fail(res, 404, "Booking not found."); } catch (e) { next(e); } });
  app.patch("/admin/bookings/:id/status", admin, validateUuid, async (req, res, next) => { try { if (!BOOKING_STATUSES.includes(req.body?.status)) return fail(res, 422, "Invalid booking status.", { status: "Status must be Pending, Confirmed, Cancelled, or Completed." }); const booking = await db.updateBooking(req.params.id, req.body.status); return booking ? res.json({ success: true, booking }) : fail(res, 404, "Booking not found."); } catch (e) { next(e); } });
  app.get("/admin/reviews", admin, async (_req, res, next) => { try { res.json({ success: true, reviews: await db.reviews() }); } catch (e) { next(e); } });
  app.patch("/admin/reviews/:id", admin, validateUuid, async (req, res, next) => { try { if (!["approved", "rejected"].includes(req.body?.status)) return fail(res, 422, "Status must be approved or rejected.", { status: "Status must be approved or rejected." }); const review = await db.moderateReview(req.params.id, req.body.status); return review ? res.json({ success: true, review }) : fail(res, 404, "Review not found."); } catch (e) { next(e); } });
  app.delete("/admin/reviews/:id", admin, validateUuid, async (req, res, next) => { try { const review = await db.deleteReview(req.params.id); return review ? res.json({ success: true, message: "Review deleted successfully.", review }) : fail(res, 404, "Review not found."); } catch (e) { next(e); } });
  app.use((_req, res) => fail(res, 404, "Route not found."));
  app.use((error, _req, res, _next) => { logger.error("REQUEST_FAILED", { message: error.message }); return fail(res, 500, "An internal server error occurred."); });
  return app;
}
module.exports = { createApp };
