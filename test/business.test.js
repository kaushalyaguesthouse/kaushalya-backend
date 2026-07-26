const test = require("node:test");
const assert = require("node:assert/strict");
const { csv, dateRange, invoiceFrom, occupancySummary, pdf, revenueSummary } = require("../src/business");

test("reporting ranges support named and bounded custom periods", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  assert.deepEqual(dateRange({ period: "last 7 days" }, now), { start_date: "2026-07-20", end_date: "2026-07-26", period: "last_7_days" });
  assert.deepEqual(dateRange({ start_date: "2026-01-01", end_date: "2026-01-31" }, now), { start_date: "2026-01-01", end_date: "2026-01-31", period: "custom" });
  assert.equal(dateRange({ start_date: "2026-02-02", end_date: "2026-01-01" }, now), null);
});

test("revenue and occupancy aggregates use completed, sold, cancelled and no-show rules", () => {
  const rows = [
    { check_in: "2026-07-01", check_out: "2026-07-03", booking_status: "Completed", payment_status: "Paid", amount: 2000, extra_charges: 100, gst_amount: 180, refund_amount: 50 },
    { check_in: "2026-07-03", check_out: "2026-07-04", booking_status: "Confirmed", payment_status: "Pending", amount: 1000, advance_amount: 200, stay_status: "no_show" },
    { check_in: "2026-07-04", check_out: "2026-07-05", booking_status: "Cancelled", payment_status: "Pending", amount: 500 }
  ];
  assert.deepEqual(revenueSummary(rows), { gross_revenue: 2100, net_revenue: 1870, gst: 180, pending_payments: 800, refunds: 50, average_booking: 2100, average_stay: 2 });
  const result = occupancySummary(rows, 2, { start_date: "2026-07-01", end_date: "2026-07-05" });
  assert.equal(result.available_nights, 10); assert.equal(result.sold_nights, 3); assert.equal(result.occupancy_percent, 30); assert.ok(Math.abs(result.cancellation_percent - 100 / 3) < 1e-10); assert.ok(Math.abs(result.no_show_percent - 100 / 3) < 1e-10);
});

test("invoices calculate GST without exposing payment provider secrets and exports escape cells", () => {
  const invoice = invoiceFrom({ invoice_number: "KGH-2026-000001", issued_at: "2026-07-26", customer_name: "Guest", booking_id: "KGH-1", room_number: "101", room_type: "Standard", check_in: "2026-07-01", check_out: "2026-07-03", amount: 2000, extra_charges: 100, discount: 100, payment_status: "Paid", payment_type: "Cash", razorpay_payment_id: "secret" }, { business_name: "KGH", gst_percent: 18, currency: "INR" });
  assert.equal(invoice.gst, 360); assert.equal(invoice.grand_total, 2360); assert.equal(JSON.stringify(invoice).includes("secret"), false);
  assert.equal(csv([{ name: 'Guest, "One"', total: 2360 }]), '"name","total"\n"Guest, ""One""","2360"');
  const document = pdf("Invoice", ["Grand total: 2360"]); assert.equal(document.subarray(0, 8).toString(), "%PDF-1.4"); assert.equal(document.includes(Buffer.from("startxref")), true);
});
