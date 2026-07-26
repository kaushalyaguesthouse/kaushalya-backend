const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createMailer(config, logger = console) {
  if (!config.email.webhookUrl) return null;

  const adminEmail = config.email.admin;
  const hasAdminRecipient = EMAIL_RE.test(adminEmail);
  if (!hasAdminRecipient) {
    logger.warn("BOOKING_ADMIN_EMAIL_DISABLED", {
      message: adminEmail
        ? "ADMIN_EMAIL is not a valid email address; owner booking notifications will not be sent."
        : "ADMIN_EMAIL is missing; owner booking notifications will not be sent."
    });
  }

  async function post(payload, recipientType) {
    const response = await fetch(config.email.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.email.token}` },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`${recipientType} email provider returned HTTP ${response.status}`);
  }

  return { async sendBooking(booking, contact) {
    const remaining = Number(booking.amount) - Number(booking.advance_amount);
    const details = { booking_id: booking.booking_id, guest_name: booking.customer_name, email: booking.email, phone: booking.phone, room_type: booking.room_type, check_in: booking.check_in, check_out: booking.check_out, nights: booking.nights, adults: booking.adults, children: booking.children, total_amount: booking.amount, advance_paid: booking.advance_amount, remaining_amount: remaining, payment_reference: booking.razorpay_payment_id || "Pay at guest house", payment_status: booking.payment_status, contact };
    const common = { event: "booking.confirmed", from: config.email.from };
    const deliveries = [post({ ...common, recipient_type: "guest", guest: { to: booking.email, details } }, "Guest")];

    if (hasAdminRecipient) {
      deliveries.push(post({ ...common, recipient_type: "admin", admin: { to: adminEmail, details } }, "Admin"));
    }

    const results = await Promise.allSettled(deliveries);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), `${failures.length} booking email delivery request(s) failed`);
  } };
}
module.exports = { createMailer };
