const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { validateBooking, validateReview, verifySignature, signAdminToken, verifyAdminToken } = require("./core");

function createRateLimiter(limit = 120, windowMs = 60000) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip; const entry = clients.get(key);
    if (!entry || entry.reset < now) clients.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > limit) return res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
    return next();
  };
}

function createApp({ config, db, razorpay, mailer, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" }); next(); });
  app.use(cors({ origin(origin, callback) { callback(null, !origin || config.origins.includes(origin)); }, methods: ["GET", "POST", "PATCH", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Key"] }));
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
      const booking = await db.createBookingAtomic({ ...result.value, booking_id: `KGH-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, idempotency_key: idempotencyKey, amount: result.value.total_amount, advance_amount: payment.amount_paise ? payment.amount_paise / 100 : 0, payment_status: payment.status === "verified" ? "Verified" : "Pending", razorpay_order_id: payment.razorpay_order_id || null, razorpay_payment_id: payment.razorpay_payment_id || null }, config.rooms[result.value.room_type].inventory);
      if (!booking) return fail(res, 409, "The selected room is no longer available.");
      if (!booking.email_sent_at && mailer) mailer.sendBooking(booking, config.contact).then(() => db.markEmailSent(booking.id)).catch((error) => logger.error("BOOKING_EMAIL_FAILED", { booking_id: booking.booking_id, message: error.message }));
      return res.status(201).json({ success: true, booking_id: booking.booking_id, booking: [booking] });
    } catch (error) { next(error); }
  });

  app.post("/create-review", async (req, res, next) => { try { const result = validateReview(req.body); if (!result.valid) return fail(res, 422, "Invalid review.", result.errors); await db.createReview(result.value); return res.status(201).json({ success: true, message: "Review submitted successfully." }); } catch (error) { next(error); } });
  app.get("/reviews", async (_req, res, next) => { try { res.json({ success: true, reviews: await db.approvedReviews() }); } catch (error) { next(error); } });
  app.post("/admin/login", createRateLimiter(5, 15 * 60000), (req, res) => {
    const supplied = String(req.headers["x-admin-key"] || req.body.admin_key || ""); const expected = config.adminBootstrapKey;
    if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return fail(res, 401, "Invalid admin credentials.");
    res.json({ success: true, token: signAdminToken(config.adminSecret), expires_in: 3600 });
  });
  app.get("/admin/bookings", admin, async (req, res, next) => { try { res.json({ success: true, bookings: await db.bookings(req.query) }); } catch (e) { next(e); } });
  app.get("/admin/bookings/:id", admin, async (req, res, next) => { try { const booking = await db.booking(req.params.id); return booking ? res.json({ success: true, booking }) : fail(res, 404, "Booking not found."); } catch (e) { next(e); } });
  app.patch("/admin/bookings/:id/status", admin, async (req, res, next) => { try { if (!["Pending", "Confirmed", "Cancelled", "Completed"].includes(req.body.status)) return fail(res, 422, "Invalid booking status."); res.json({ success: true, booking: await db.updateBooking(req.params.id, req.body.status) }); } catch (e) { next(e); } });
  app.get("/admin/reviews", admin, async (_req, res, next) => { try { res.json({ success: true, reviews: await db.pendingReviews() }); } catch (e) { next(e); } });
  app.patch("/admin/reviews/:id", admin, async (req, res, next) => { try { if (!["approved", "rejected"].includes(req.body.status)) return fail(res, 422, "Status must be approved or rejected."); res.json({ success: true, review: await db.moderateReview(req.params.id, req.body.status) }); } catch (e) { next(e); } });
  app.use((_req, res) => fail(res, 404, "Route not found."));
  app.use((error, _req, res, _next) => { logger.error("REQUEST_FAILED", { message: error.message }); return fail(res, 500, "An internal server error occurred."); });
  return app;
}
module.exports = { createApp };
