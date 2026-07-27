const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailer, PROVIDER_TIMEOUT_MS } = require("../src/mailer");

const booking = {
  booking_id: "KGH-123", customer_name: "Guest", email: "guest@example.com", phone: "+919876543210",
  room_type: "Standard", check_in: "2026-08-01", check_out: "2026-08-02", nights: 1,
  adults: 2, children: 0, amount: 1800, advance_amount: 0, payment_status: "Pending"
};

function config(admin = "owner@example.com") {
  return { email: { webhookUrl: "https://email.example/webhook", token: "secret", from: "stay@example.com", admin } };
}

test("booking email uses separate guest and admin webhook requests", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  });

  await createMailer(config()).sendBooking(booking, { phone: "123" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.recipient_type, "guest");
  assert.equal(calls[0].body.guest.to, "guest@example.com");
  assert.equal(calls[0].body.admin, undefined);
  assert.equal(calls[1].body.recipient_type, "admin");
  assert.equal(calls[1].body.admin.to, "owner@example.com");
  assert.equal(calls[1].body.guest, undefined);
});

test("missing ADMIN_EMAIL is logged and does not prevent guest delivery", async (t) => {
  const calls = [];
  const warnings = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  });

  const mailer = createMailer(config(""), { warn: (...args) => warnings.push(args) });
  await mailer.sendBooking(booking, {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].guest.to, "guest@example.com");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "BOOKING_ADMIN_EMAIL_DISABLED");
  assert.match(warnings[0][1].message, /ADMIN_EMAIL is missing/);
});

test("both webhook deliveries are attempted when one fails", async (t) => {
  let attempts = 0;
  t.mock.method(global, "fetch", async () => ({ ok: ++attempts !== 1, status: 503 }));

  await assert.rejects(createMailer(config()).sendBooking(booking, {}), /booking email delivery request/);
  assert.equal(attempts, 2);
});

test("provider requests carry the strict timeout signal", async (t) => {
  const signals = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    signals.push(options.signal);
    return { ok: true, status: 200 };
  });
  await createMailer(config()).sendBooking(booking, {});
  assert.equal(PROVIDER_TIMEOUT_MS, 5000);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});
