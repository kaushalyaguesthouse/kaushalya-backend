const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const packageInfo = require("../package.json");
const { helmet, requestContext, validateRequest } = require("./security");
const { createAnalyticsSummary, createAvailabilityReport, validateAvailabilityQuery, validateBooking, validateReview, verifySignature, signAdminToken, verifyAdminToken } = require("./core");
const { SETTING_FIELDS, csv, dateRange, invoiceFrom, occupancySummary, pdf, revenueSummary } = require("./business");

function createRateLimiter(limit = 120, windowMs = 60000) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip; const entry = clients.get(key);
    if (clients.size > 10000) for (const [client, value] of clients) if (value.reset < now) clients.delete(client);
    if (!entry || entry.reset < now) clients.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > limit) { res.set("Retry-After", String(Math.max(1, Math.ceil((entry.reset - now) / 1000)))); return res.status(429).json({ success: false, message: "Too many requests. Please try again later.", code: "RATE_LIMITED" }); }
    return next();
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = ["Pending", "Confirmed", "Cancelled", "Completed"];
const ADMIN_BOOKING_FIELDS = ["id", "booking_id", "customer_name", "phone", "email", "room_type", "check_in", "check_out", "adults", "children", "booking_status", "payment_status", "amount", "advance_amount", "created_at"];
const OPERATIONAL_STATUSES = ["operational", "maintenance", "out_of_service"];
const HOUSEKEEPING_STATUSES = ["clean", "dirty", "cleaning", "inspected"];
const HOUSEKEEPING_TASK_STATUSES = ["pending", "cleaning", "completed", "inspected", "cancelled"];
const ROOM_FIELDS = ["id", "room_number", "floor", "operational_status", "housekeeping_status", "notes", "is_active", "created_at", "updated_at"];
const HOUSEKEEPING_TASK_FIELDS = ["id", "booking_id", "room_id", "task_type", "status", "assigned_to", "notes", "created_at", "completed_at", "updated_at"];

function deriveRoomStatus(room) {
  if (!room.is_active || room.operational_status === "out_of_service") return "Out of Service";
  if (room.operational_status === "maintenance") return "Maintenance";
  if (room.stay_status === "checked_in") return "Occupied";
  if (!["clean", "inspected"].includes(room.housekeeping_status)) return "Cleaning";
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

function validateHousekeepingQuery(query) {
  const errors = {};
  const integer = (name, fallback, maximum) => {
    if (query[name] == null || query[name] === "") return fallback;
    if (!/^\d+$/.test(String(query[name])) || Number(query[name]) < 1) errors[name] = `${name} must be an integer greater than or equal to 1.`;
    else if (maximum && Number(query[name]) > maximum) errors[name] = `${name} must not exceed ${maximum}.`;
    return Number(query[name]);
  };
  const room = String(query.room || query.room_id || "").trim();
  const filters = { status: String(query.status || "").trim(), room, page: integer("page", 1), limit: integer("limit", 25, 100) };
  if (filters.status && !HOUSEKEEPING_TASK_STATUSES.includes(filters.status)) errors.status = "Invalid housekeeping task status.";
  if (room && !UUID_RE.test(room)) errors.room = "room must be a UUID.";
  return { valid: Object.keys(errors).length === 0, errors, filters };
}

function publicHousekeepingTask(task) {
  return { ...Object.fromEntries(HOUSEKEEPING_TASK_FIELDS.filter((field) => Object.hasOwn(task, field)).map((field) => [field, task[field]])), room_number: task.room_number ?? task.rooms?.room_number };
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
  if (filters.search.length > 100 || (filters.search && !/^[\p{L}\p{N}@.+ _-]+$/u.test(filters.search))) errors.search = "Search contains unsupported characters.";
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
  app.use(helmet());
  app.use(requestContext(logger));
  app.use(cors({ origin(origin, callback) { if (!origin || config.origins.includes(origin)) return callback(null, true); const error = new Error("Origin not allowed."); error.status = 403; error.code = "CORS_DENIED"; return callback(error); }, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Key", "X-Request-Id"], exposedHeaders: ["X-Request-Id"], credentials: false, maxAge: 600 }));
  app.use(express.json({ limit: config.bodyLimit || "100kb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit || "100kb", parameterLimit: 100 }));
  app.use(validateRequest);
  app.use(createRateLimiter(config.rateLimit || 120, config.rateWindowMs || 60000));
  app.use((req, res, next) => {
    const category = req.path.startsWith("/admin/login") ? "AUTHENTICATION" : req.path.includes("housekeeping") ? "HOUSEKEEPING" : req.path.includes("maintenance") ? "MAINTENANCE" : req.path.includes("invoice") ? "INVOICE" : req.path.includes("review") ? "REVIEW" : req.path.includes("payment") || req.path.includes("order") ? "PAYMENT" : req.path.includes("booking") || req.path.includes("availability") ? "BOOKING" : null;
    if (category && req.method !== "GET") res.on("finish", () => logger.info?.(`${category}_ACTIVITY`, { request_id: req.id, method: req.method, path: req.path, status: res.statusCode }));
    next();
  });

  const fail = (res, status, message, errors, code) => res.status(status).json({ success: false, message, ...(errors && { errors }), ...(code && { code }) });
  const admin = (req, res, next) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return verifyAdminToken(token, config.adminSecret) ? next() : fail(res, 401, "Admin authentication required.");
  };
  const validate = (body) => validateBooking(body, config);
  const audit = (req, action, entity, entityId = null, details = {}) => {
    if (typeof db.createAuditLog !== "function") return;
    db.createAuditLog({ user_name: "admin", action, entity, entity_id: entityId, ip: req.ip, details }).catch(() => logger.error("AUDIT_LOG_FAILED", { action }));
  };

  app.get("/", (_req, res) => res.status(200).send("Kaushalya Guest House Backend Running"));
  const healthPayload = (database, status = database === true ? "ok" : database === false ? "degraded" : "ok") => ({ success: status === "ok", status, uptime: process.uptime(), version: packageInfo.version, database: database === true ? "connected" : database === false ? "unavailable" : "not_checked", memory: process.memoryUsage(), timestamp: new Date().toISOString() });
  app.get("/health", async (_req, res, next) => { try { const healthy = await db.health(); return res.status(healthy ? 200 : 503).json(healthPayload(healthy)); } catch (error) { return next(error); } });
  app.get("/health/database", async (_req, res, next) => { try { const healthy = await db.health(); return res.status(healthy ? 200 : 503).json(healthPayload(healthy)); } catch (error) { return next(error); } });
  app.get("/health/application", (_req, res) => res.json(healthPayload(null)));
  app.get("/health/schema", async (_req, res, next) => {
    try {
      const diagnostic = await db.schemaDiagnostic();
      const failures = diagnostic.failures.map(({ resource, failure_type, code, status }) => ({ resource, failure_type, code, status }));
      return res.status(diagnostic.ready ? 200 : 503).json({ success: diagnostic.ready, status: diagnostic.ready ? "ok" : "not_ready", schema: diagnostic.ready ? "ready" : "unavailable", checked: diagnostic.checked, failures, timestamp: new Date().toISOString() });
    } catch (error) { return next(error); }
  });
  app.get("/admin/diagnostics/database", admin, async (_req, res, next) => {
    try { return res.json(await db.databaseDiagnostic()); } catch (error) { return next(error); }
  });
  app.get("/admin/diagnostics/schema", admin, async (_req, res, next) => {
    try { return res.json(await db.schemaDiagnostic()); } catch (error) { return next(error); }
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
    let stage = "validation";
    const bookingFail = (status, message, errors, code) => {
      const response = { success: false, message, ...(errors && { errors }), ...(code && { code }) };
      if (status === 409) logger.info?.("BOOKING_CONFLICT", { request_id: req.id, stage, code: response.code, message: response.message });
      return res.status(status).json(response);
    };
    try {
      const result = validate(req.body);
      if (!result.valid) return bookingFail(422, "Invalid booking information.", result.errors);
      stage = "authoritative_price";
      if (req.body.amount != null && Number(req.body.amount) !== result.value.total_amount) return bookingFail(409, "Booking amount does not match the authoritative price.", { amount: `Expected ${result.value.total_amount}.` }, "BOOKING_AMOUNT_MISMATCH");
      let payment = { status: "pending" };
      if (result.value.payment_type === "Razorpay") {
        stage = "payment_verification";
        payment = await db.getVerifiedOrder(req.body.razorpay_order_id, req.body.razorpay_payment_id);
        if (!payment) return bookingFail(402, "A server-verified Razorpay payment is required.");
        stage = "payment_booking_match";
        if (payment.booking_payload.room_type !== result.value.room_type || payment.booking_payload.check_in !== result.value.check_in || payment.booking_payload.check_out !== result.value.check_out) return bookingFail(409, "Payment order does not match booking details.", undefined, "PAYMENT_BOOKING_MISMATCH");
      }
      stage = "idempotency";
      const idempotencyKey = String(req.headers["idempotency-key"] || req.body.idempotency_key || (payment.razorpay_payment_id ? `payment:${payment.razorpay_payment_id}` : "")).slice(0, 100);
      if (!idempotencyKey) return bookingFail(400, "Idempotency-Key header is required for pay-later bookings.");
      stage = "booking_insert";
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

    razorpay_order_id: payment.razorpay_order_id || null,
    razorpay_payment_id: payment.razorpay_payment_id || null
  },
  config.rooms[result.value.room_type].inventory
);
      if (!booking) {
        stage = "availability_commit";
        return bookingFail(409, "The selected room is no longer available.", undefined, "ROOM_NO_LONGER_AVAILABLE");
      }
      if (!booking.email_sent_at && mailer) mailer.sendBooking(booking, config.contact).then(() => db.markEmailSent(booking.id)).catch(() => logger.error("BOOKING_EMAIL_FAILED", { booking_id: booking.booking_id }));
      return res.status(201).json({ success: true, booking_id: booking.booking_id, booking: [booking] });
    } catch (error) {
      logger.error("BOOKING_CREATE_FAILED", { request_id: req.id, stage, operation: error.operation, database_code: error.code, error_name: error.name });
      if (stage === "payment_verification") return bookingFail(503, "Payment verification is temporarily unavailable. Please contact support before retrying payment.", undefined, "PAYMENT_LOOKUP_FAILED");
      if (stage === "booking_insert") {
        if (error.code === "23505") return bookingFail(409, "This booking or payment has already been submitted.", undefined, "BOOKING_ALREADY_EXISTS");
        if (error.code === "23502" || error.code === "23503" || error.code === "23514" || error.code === "42883" || String(error.code || "").startsWith("PGRST")) return bookingFail(503, "Booking could not be saved because the booking service schema is not ready. Please contact support.", undefined, "BOOKING_SCHEMA_ERROR");
        return bookingFail(503, "Booking storage is temporarily unavailable. Please try again shortly.", undefined, "BOOKING_STORAGE_FAILED");
      }
      next(error);
    }
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
    audit(req, "login", "session");
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
  app.get("/admin/housekeeping", admin, async (req, res, next) => {
    try {
      const validation = validateHousekeepingQuery(req.query);
      if (!validation.valid) return fail(res, 422, "Invalid housekeeping filters.", validation.errors);
      const result = await db.listHousekeepingTasks(validation.filters);
      const items = result.items.map(publicHousekeepingTask);
      const { page, limit, ...filters } = validation.filters;
      return res.json({ success: true, items, housekeeping_tasks: items, pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) }, filters });
    } catch (e) { next(e); }
  });
  const transitionHousekeeping = (action) => async (req, res, next) => {
    try {
      const result = await db.transitionHousekeepingTask(req.params.taskId, action);
      if (!result?.success) {
        const failures = {
          task_not_found: [404, "Housekeeping task not found."], room_not_found: [404, "Room not found."],
          room_inactive: [409, "The room is inactive."], task_cancelled: [409, "Cancelled housekeeping tasks cannot be updated."],
          invalid_transition: [409, "Invalid housekeeping task state transition."]
        };
        const [status, message] = failures[result?.reason] || [409, "The housekeeping task could not be updated."];
        return fail(res, status, message);
      }
      const response = { success: true, task: publicHousekeepingTask(result.task) };
      if (result.room) response.room = publicRoom(result.room);
      if (action === "inspect") response.derived_status = result.derived_status;
      audit(req, `housekeeping.${action}`, "housekeeping_task", req.params.taskId);
      return res.json(response);
    } catch (e) { next(e); }
  };
  const validateTaskId = (req, res, next) => UUID_RE.test(String(req.params.taskId || "")) ? next() : fail(res, 400, "Invalid ID.");
  app.post("/admin/housekeeping/:taskId/start", admin, validateTaskId, transitionHousekeeping("start"));
  app.post("/admin/housekeeping/:taskId/complete", admin, validateTaskId, transitionHousekeeping("complete"));
  app.post("/admin/housekeeping/:taskId/inspect", admin, validateTaskId, transitionHousekeeping("inspect"));
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
        if (result?.reason === "room_assignment_conflict") return res.status(409).json({ success: false, code: "ROOM_ASSIGNMENT_CONFLICT", message: "The room is already assigned for an overlapping stay." });
        const failures = {
          booking_not_found: [404, "Booking not found."], room_not_found: [404, "Room not found."],
          booking_status: [409, "Only Pending or Confirmed bookings may be assigned a room."],
          room_inactive: [409, "The room is inactive."], room_not_operational: [409, "The room is not operational."],
          room_type_mismatch: [409, "The room type does not match the booking."], already_assigned: [409, "The booking already has an active room assignment."]
        };
        const [status, message] = failures[result?.reason] || [409, "The room could not be assigned."];
        return fail(res, status, message);
      }
      audit(req, "room.assign", "booking", req.params.id, { room_id: req.body.room_id });
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
  app.post("/admin/bookings/:id/check-in", admin, validateUuid, async (req, res, next) => {
    try {
      const result = await db.checkIn(req.params.id);
      if (!result?.success) {
        const failures = {
          booking_not_found: [404, "Booking not found."], booking_not_confirmed: [409, "Only a Confirmed booking may be checked in."],
          no_room_assigned: [409, "The booking has no active room assignment."], multiple_rooms_assigned: [409, "The booking must have exactly one active room assignment."],
          already_checked_in: [409, "The guest is already checked in."], room_inactive: [409, "The assigned room is inactive."],
          room_not_operational: [409, "The assigned room is not operational."], room_not_ready: [409, "The assigned room must be clean or inspected."]
        };
        const [status, message] = failures[result?.reason] || [409, "The guest could not be checked in."];
        return fail(res, status, message);
      }
      audit(req, "booking.check_in", "booking", req.params.id);
      return res.json({
        success: true,
        booking: { booking_id: result.booking_id, booking_status: result.booking_status, stay_status: result.stay_status, checked_in_at: result.checked_in_at },
        room: { room_number: result.room_number, derived_status: "occupied" }
      });
    } catch (e) { next(e); }
  });
  app.post("/admin/bookings/:id/check-out", admin, validateUuid, async (req, res, next) => {
    try {
      const result = await db.checkOut(req.params.id);
      if (!result?.success) {
        const failures = {
          booking_not_found: [404, "Booking not found."], booking_not_confirmed: [409, "Only a Confirmed booking may be checked out."],
          not_checked_in: [409, "The guest must be checked in before check-out."], already_checked_out: [409, "The guest has already been checked out."],
          no_room_assigned: [409, "The booking has no active room assignment."], multiple_rooms_assigned: [409, "The booking must have exactly one active room assignment."]
        };
        const [status, message] = failures[result?.reason] || [409, "The guest could not be checked out."];
        return fail(res, status, message);
      }
      audit(req, "booking.check_out", "booking", req.params.id);
      return res.json({
        success: true,
        booking: { booking_status: result.booking_status, stay_status: result.stay_status, checked_out_at: result.checked_out_at },
        room: { room_number: result.room_number, housekeeping_status: result.housekeeping_status, derived_status: "cleaning" },
        housekeeping_task: { task_type: result.task_type, status: result.task_status }
      });
    } catch (e) { next(e); }
  });
  app.get("/admin/bookings/:id/housekeeping", admin, validateUuid, async (req, res, next) => {
    try {
      const tasks = await db.housekeepingTasks(req.params.id);
      if (!tasks) return fail(res, 404, "Booking not found.");
      return res.json({ success: true, housekeeping_tasks: tasks.map((task) => ({ id: task.id, booking_id: task.booking_id, room_id: task.room_id, room_number: task.rooms?.room_number, task_type: task.task_type, status: task.status, assigned_to: task.assigned_to, notes: task.notes, created_at: task.created_at, completed_at: task.completed_at, updated_at: task.updated_at })) });
    } catch (e) { next(e); }
  });
  app.get("/admin/bookings/:id/stay", admin, validateUuid, async (req, res, next) => {
    try {
      const stay = await db.bookingStay(req.params.id);
      return stay ? res.json({ success: true, stay }) : fail(res, 404, "Booking not found.");
    } catch (e) { next(e); }
  });
  app.get("/admin/bookings/:id", admin, validateUuid, async (req, res, next) => { try { const booking = await db.booking(req.params.id); const safe = booking && Object.fromEntries(Object.entries(booking).filter(([key]) => !["razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "idempotency_key", "payment_secret", "jwt"].includes(key))); return safe ? res.json({ success: true, booking: safe }) : fail(res, 404, "Booking not found."); } catch (e) { next(e); } });
  app.patch("/admin/bookings/:id/status", admin, validateUuid, async (req, res, next) => { try { if (!BOOKING_STATUSES.includes(req.body?.status)) return fail(res, 422, "Invalid booking status.", { status: "Status must be Pending, Confirmed, Cancelled, or Completed." }); const booking = await db.updateBooking(req.params.id, req.body.status); if (booking) audit(req, "booking.edit", "booking", req.params.id, { field: "status" }); return booking ? res.json({ success: true, booking }) : fail(res, 404, "Booking not found."); } catch (e) { next(e); } });
  app.get("/admin/reviews", admin, async (_req, res, next) => { try { res.json({ success: true, reviews: await db.reviews() }); } catch (e) { next(e); } });
  app.patch("/admin/reviews/:id", admin, validateUuid, async (req, res, next) => { try { if (!["approved", "rejected"].includes(req.body?.status)) return fail(res, 422, "Status must be approved or rejected.", { status: "Status must be approved or rejected." }); const review = await db.moderateReview(req.params.id, req.body.status); return review ? res.json({ success: true, review }) : fail(res, 404, "Review not found."); } catch (e) { next(e); } });
  app.delete("/admin/reviews/:id", admin, validateUuid, async (req, res, next) => { try { const review = await db.deleteReview(req.params.id); return review ? res.json({ success: true, message: "Review deleted successfully.", review }) : fail(res, 404, "Review not found."); } catch (e) { next(e); } });

  app.get("/admin/settings", admin, async (_req, res, next) => { try { return res.json({ success: true, settings: await db.getSettings() }); } catch (e) { next(e); } });
  app.put("/admin/settings", admin, async (req, res, next) => {
    try {
      const values = Object.fromEntries(SETTING_FIELDS.filter((key) => Object.hasOwn(req.body || {}, key)).map((key) => [key, req.body[key]]));
      if (!Object.keys(values).length) return fail(res, 422, "No supported settings were supplied.");
      if (values.gst_percent != null && (!Number.isFinite(Number(values.gst_percent)) || Number(values.gst_percent) < 0 || Number(values.gst_percent) > 100)) return fail(res, 422, "GST percent must be between 0 and 100.", { gst_percent: "Invalid GST percent." });
      const settings = await db.updateSettings(values); audit(req, "settings.update", "settings", null, { fields: Object.keys(values) });
      return res.json({ success: true, settings });
    } catch (e) { next(e); }
  });
  app.patch("/admin/settings", admin, async (req, res, next) => {
    try {
      const values = Object.fromEntries(SETTING_FIELDS.filter((key) => Object.hasOwn(req.body || {}, key)).map((key) => [key, req.body[key]]));
      if (!Object.keys(values).length) return fail(res, 422, "No supported settings were supplied.");
      if (values.gst_percent != null && (!Number.isFinite(Number(values.gst_percent)) || Number(values.gst_percent) < 0 || Number(values.gst_percent) > 100)) return fail(res, 422, "GST percent must be between 0 and 100.", { gst_percent: "Invalid GST percent." });
      const settings = await db.updateSettings(values); audit(req, "settings.update", "settings", null, { fields: Object.keys(values) }); return res.json({ success: true, settings });
    } catch (e) { next(e); }
  });

  app.get("/admin/invoices", admin, async (req, res, next) => {
    try { const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)); const result = await db.listInvoices({ page, limit, start_date: req.query.start_date, end_date: req.query.end_date }); return res.json({ success: true, items: result.items, pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) } }); } catch (e) { next(e); }
  });
  const loadInvoice = async (bookingId, req) => {
    const row = await db.invoiceBooking(bookingId); if (!row || row.booking_status !== "Completed") return null;
    const settings = await db.getSettings(); const saved = row.invoice_number ? row : { ...row, ...(await db.createInvoice(row.id, settings.invoice_prefix || "KGH")) };
    if (!row.invoice_number) audit(req, "invoice.generate", "booking", row.id, { invoice_number: saved.invoice_number });
    return invoiceFrom(saved, saved.business_details || settings);
  };
  app.get("/admin/invoices/:bookingId", admin, async (req, res, next) => { try { const invoice = await loadInvoice(req.params.bookingId, req); return invoice ? res.json({ success: true, invoice }) : fail(res, 404, "Completed booking not found."); } catch (e) { next(e); } });
  app.get("/admin/invoices/:bookingId/pdf", admin, async (req, res, next) => { try { const invoice = await loadInvoice(req.params.bookingId, req); if (!invoice) return fail(res, 404, "Completed booking not found."); const document = pdf(`Invoice ${invoice.invoice_number}`, Object.entries(invoice).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)); res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${invoice.invoice_number}.pdf"`, "Content-Length": document.length }); return res.send(document); } catch (e) { next(e); } });

  app.get("/admin/reports/revenue", admin, async (req, res, next) => { try { const range = dateRange(req.query); if (!range) return fail(res, 422, "Invalid reporting range."); return res.json({ success: true, range, ...revenueSummary(await db.reportingBookings(range)) }); } catch (e) { next(e); } });
  app.get("/admin/reports/occupancy", admin, async (req, res, next) => { try { const range = dateRange(req.query); if (!range) return fail(res, 422, "Invalid reporting range."); const data = await db.occupancyData(range); return res.json({ success: true, range, ...occupancySummary(data.bookings, data.room_count, range) }); } catch (e) { next(e); } });
  app.get("/admin/audit-logs", admin, async (req, res, next) => { try { const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25)); const result = await db.auditLogs({ page, limit, action: req.query.action, entity: req.query.entity, start_date: req.query.start_date, end_date: req.query.end_date }); return res.json({ success: true, items: result.items, pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) } }); } catch (e) { next(e); } });
  app.get("/admin/exports/:dataset", admin, async (req, res, next) => {
    try {
      const datasets = ["bookings", "revenue", "occupancy", "housekeeping", "maintenance", "reviews"]; const format = String(req.query.format || "csv").toLowerCase();
      if (!datasets.includes(req.params.dataset) || !["csv", "excel", "pdf"].includes(format)) return fail(res, 422, "Unsupported export dataset or format.");
      const range = dateRange(req.query); if (!range) return fail(res, 422, "Invalid reporting range."); const rows = await db.exportRows(req.params.dataset, range);
      let body; let type; let extension = format;
      if (format === "pdf") { body = pdf(`${req.params.dataset} report`, rows.map((row) => Object.values(row).join(" | "))); type = "application/pdf"; }
      else { body = Buffer.from(`\uFEFF${csv(rows)}`); type = format === "excel" ? "application/vnd.ms-excel" : "text/csv; charset=utf-8"; extension = format === "excel" ? "xls" : "csv"; }
      res.set({ "Content-Type": type, "Content-Disposition": `attachment; filename="${req.params.dataset}-${range.start_date}-${range.end_date}.${extension}"` }); return res.send(body);
    } catch (e) { next(e); }
  });
  app.use((_req, res) => fail(res, 404, "Route not found."));
  app.use((error, req, res, _next) => {
    const clientError = error.type === "entity.parse.failed" || error.type === "entity.too.large" || error.status === 403;
    const status = error.type === "entity.too.large" ? 413 : error.status === 403 ? 403 : clientError ? 400 : 500;
    const code = error.code === "CORS_DENIED" ? "CORS_DENIED" : error.type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : error.type === "entity.parse.failed" ? "INVALID_JSON" : "INTERNAL_ERROR";
    logger.error("REQUEST_FAILED", { request_id: req.id, method: req.method, path: req.path, status, error_name: error.name, code });
    return res.status(status).json({ success: false, message: status === 500 ? "An internal server error occurred." : status === 413 ? "Request body is too large." : status === 403 ? "Origin is not allowed." : "Request body is not valid JSON.", code });
  });
  return app;
}
module.exports = { createApp };
