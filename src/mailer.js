function createMailer(config) {
  if (!config.email.webhookUrl) return null;
  return { async sendBooking(booking, contact) {
    const remaining = Number(booking.amount) - Number(booking.advance_amount);
    const details = { booking_id: booking.booking_id, guest_name: booking.customer_name, email: booking.email, phone: booking.phone, room_type: booking.room_type, check_in: booking.check_in, check_out: booking.check_out, nights: booking.nights, adults: booking.adults, children: booking.children, total_amount: booking.amount, advance_paid: booking.advance_amount, remaining_amount: remaining, payment_reference: booking.razorpay_payment_id || "Pay at guest house", payment_status: booking.payment_status, contact };
    const response = await fetch(config.email.webhookUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.email.token}` }, body: JSON.stringify({ event: "booking.confirmed", from: config.email.from, guest: { to: booking.email, details }, admin: { to: config.email.admin, details } }) });
    if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
  } };
}
module.exports = { createMailer };
