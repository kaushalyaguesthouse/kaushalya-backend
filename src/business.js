const DAY_MS = 86400000;

const SETTING_FIELDS = ["business_name", "gst_number", "gst_percent", "address", "phone", "email", "invoice_footer", "invoice_prefix", "currency", "timezone", "logo_metadata"];

function dateRange(query = {}, now = new Date()) {
  const endToday = now.toISOString().slice(0, 10);
  const shift = (days) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)).toISOString().slice(0, 10);
  const periods = {
    today: [endToday, endToday], yesterday: [shift(-1), shift(-1)], last_7_days: [shift(-6), endToday],
    last_30_days: [shift(-29), endToday], monthly: [`${endToday.slice(0, 7)}-01`, endToday], yearly: [`${endToday.slice(0, 4)}-01-01`, endToday]
  };
  const period = String(query.period || ((query.start_date || query.end_date) ? "custom" : "today")).toLowerCase().replace(/\s+/g, "_");
  const [start, end] = periods[period] || [query.start_date, query.end_date];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(end || "") || start > end) return null;
  return { start_date: start, end_date: end, period: periods[period] ? period : "custom" };
}

function nights(row) { return Math.max(0, Math.round((new Date(`${row.check_out}T00:00:00Z`) - new Date(`${row.check_in}T00:00:00Z`)) / DAY_MS) || 0); }
function revenueSummary(rows) {
  const completed = rows.filter((r) => r.booking_status === "Completed");
  const gross = completed.reduce((s, r) => s + Number(r.amount || 0) + Number(r.extra_charges || 0), 0);
  const refunds = rows.reduce((s, r) => s + Number(r.refund_amount || 0), 0);
  const gst = completed.reduce((s, r) => s + Number(r.gst_amount || 0), 0);
  const pending = rows.filter((r) => r.booking_status !== "Cancelled" && !["Paid", "Verified"].includes(r.payment_status)).reduce((s, r) => s + Math.max(0, Number(r.amount || 0) - Number(r.advance_amount || 0)), 0);
  return { gross_revenue: gross, net_revenue: gross - gst - refunds, gst, pending_payments: pending, refunds, average_booking: completed.length ? gross / completed.length : 0, average_stay: completed.length ? completed.reduce((s, r) => s + nights(r), 0) / completed.length : 0 };
}

function occupancySummary(rows, roomCount, range) {
  const days = Math.round((new Date(`${range.end_date}T00:00:00Z`) - new Date(`${range.start_date}T00:00:00Z`)) / DAY_MS) + 1;
  const available = Math.max(0, roomCount * days);
  const active = rows.filter((r) => ["Confirmed", "Completed"].includes(r.booking_status));
  const sold = active.reduce((sum, r) => sum + Math.max(0, (Math.min(new Date(r.check_out), new Date(`${range.end_date}T23:59:59Z`)) - Math.max(new Date(r.check_in), new Date(range.start_date))) / DAY_MS), 0);
  const revenue = active.reduce((s, r) => s + Number(r.amount || 0), 0);
  const total = rows.length;
  return { occupancy_percent: available ? sold / available * 100 : 0, adr: sold ? revenue / sold : 0, revpar: available ? revenue / available : 0, available_nights: available, sold_nights: sold, cancellation_percent: total ? rows.filter((r) => r.booking_status === "Cancelled").length / total * 100 : 0, no_show_percent: total ? rows.filter((r) => r.stay_status === "no_show").length / total * 100 : 0, average_stay: active.length ? active.reduce((s, r) => s + nights(r), 0) / active.length : 0 };
}

function invoiceFrom(row, settings) {
  const charges = Number(row.amount || 0); const extra = Number(row.extra_charges || 0); const discount = Number(row.discount || 0);
  const taxable = Math.max(0, charges + extra - discount); const gst = row.gst_amount == null ? taxable * Number(settings.gst_percent || 0) / 100 : Number(row.gst_amount);
  return { invoice_number: row.invoice_number, issued_at: row.issued_at, guest_name: row.customer_name, booking_id: row.booking_id, room_number: row.room_number, room_type: row.room_type, nights: nights(row), charges, extra_charges: extra, discount, gst, grand_total: taxable + gst, payment_status: row.payment_status, payment_method: row.payment_method || row.payment_type, business_details: Object.fromEntries(SETTING_FIELDS.filter((k) => k !== "logo_metadata").map((k) => [k, settings[k]])) };
}

function csv(rows) {
  if (!rows.length) return ""; const keys = Object.keys(rows[0]); const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [keys.map(cell).join(","), ...rows.map((r) => keys.map((k) => cell(typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k])).join(","))].join("\n");
}
function pdf(title, lines) {
  const clean = [title, ...lines].map((x) => String(x).replace(/[()\\]/g, " ").slice(0, 110));
  const stream = `BT /F1 11 Tf 45 790 Td ${clean.map((x, i) => `${i ? "0 -16 Td " : ""}(${x}) Tj`).join(" ")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n", offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; }); const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

module.exports = { SETTING_FIELDS, csv, dateRange, invoiceFrom, occupancySummary, pdf, revenueSummary };
