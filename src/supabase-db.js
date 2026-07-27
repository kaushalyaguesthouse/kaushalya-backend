class DatabaseError extends Error {
  constructor(error, operation) {
    super(error?.message || "Database operation failed.");
    this.name = "DatabaseError";
    this.code = error?.code;
    this.details = error?.details;
    this.hint = error?.hint;
    this.status = error?.status;
    this.operation = operation;
  }
}

function assert(result, operation) { if (result.error) throw new DatabaseError(result.error, operation); return result.data; }

function allocationDates(range) {
  const match = /^\[([^,]+),([^\)]+)\)$/.exec(String(range || ""));
  return match ? { from: match[1], until: match[2] } : { from: null, until: null };
}

function safeDiagnostic(value) {
  if (value == null) return null;
  return String(value)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|cookie|apikey|api[_-]?key|service[_-]?role[_-]?key|token|secret|password|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:apikey|key|token|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:postgres(?:ql)?):\/\/[^\s]+/gi, "[REDACTED_CONNECTION_STRING]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function classifyHealthFailure(error, status) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  if (status === 401 || ["PGRST301", "PGRST302"].includes(code) || /invalid (?:api )?key|invalid jwt|jwt expired|unauthorized/.test(message)) return "invalid_credentials";
  if (/row.level security|rls/.test(message)) return "rls";
  if (code === "42P01" || code === "PGRST205" || /relation .* does not exist|table .*not found|schema cache/.test(message)) return "missing_table";
  if (code === "42501" || status === 403 || /permission denied|insufficient privilege/.test(message)) return "permission_denied";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code) || /fetch failed|network|dns|socket|timed? ?out/.test(message)) return "network_error";
  if (status != null || error?.code) return "query_error";
  return "transport_error";
}

function healthDiagnostic(error, result = {}) {
  const status = result.status ?? error?.status ?? error?.context?.status ?? error?.cause?.status ?? null;
  return {
    failure_type: classifyHealthFailure(error, status),
    error: {
      code: safeDiagnostic(error?.code ?? error?.cause?.code),
      message: safeDiagnostic(error?.message),
      details: safeDiagnostic(error?.details)
    },
    http_status: status
  };
}

function publicHealthDiagnostic(error, result = {}) {
  if (!error) return { success: true, failure_type: null, code: null, message: null, details: null, status: result.status ?? 200 };
  const diagnostic = healthDiagnostic(error, result);
  return {
    success: false,
    failure_type: diagnostic.failure_type,
    code: diagnostic.error.code,
    message: diagnostic.error.message,
    details: diagnostic.error.details,
    status: diagnostic.http_status
  };
}

const REQUIRED_SCHEMA = Object.freeze({
  bookings: "id,booking_id,customer_name,phone,email,room_type,check_in,check_out,booking_status,payment_status,amount,advance_amount,refund_amount,created_at",
  payment_orders: "id,idempotency_key,razorpay_order_id,razorpay_payment_id,status",
  reviews: "id,customer_name,customer_email,rating,review,status,created_at",
  room_types: "id,name,is_active,inventory_count", rooms: "id,room_number,room_type_id,floor,operational_status,housekeeping_status,is_active",
  booking_room_assignments: "id,booking_id,room_id,allocation_range,assignment_status",
  booking_stays: "booking_id,stay_status,checked_in_at,checked_out_at",
  housekeeping_tasks: "id,booking_id,room_id,task_type,status",
  invoices: "id,invoice_number,booking_id,issued_at,grand_total", business_settings: "id,business_name,gst_percent,currency,timezone",
  audit_logs: "id,user_name,action,entity,created_at"
});

async function postgrestConnectivityProbe(url, key, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${url}/rest/v1/`, { method: "GET", headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/openapi+json" }, signal: AbortSignal.timeout(10000) });
    if (response.ok) return publicHealthDiagnostic(null, { status: response.status });
    let error;
    try { error = await response.json(); } catch { error = { message: `Supabase returned HTTP ${response.status}.` }; }
    return publicHealthDiagnostic(error, { status: response.status });
  } catch (error) { return publicHealthDiagnostic(error); }
}

function createSupabaseDb(supabase, logger = console, connection = {}) {
  const databaseDiagnostic = async () => {
    return postgrestConnectivityProbe(connection.url, connection.key, connection.fetch);
  };
  const schemaDiagnostic = async () => {
    const failures = [];
    for (const [resource, columns] of Object.entries(REQUIRED_SCHEMA)) {
      try {
        const result = await supabase.from(resource).select(columns).limit(0);
        if (result.error) {
          const failure = { resource, ...publicHealthDiagnostic(result.error, result) };
          failures.push(failure);
          logger.error?.("SCHEMA_HEALTH_CHECK_FAILED", { resource, ...healthDiagnostic(result.error, result) });
        }
      } catch (error) {
        failures.push({ resource, ...publicHealthDiagnostic(error) });
        logger.error?.("SCHEMA_HEALTH_CHECK_FAILED", { resource, ...healthDiagnostic(error) });
      }
    }
    return { ready: failures.length === 0, checked: Object.keys(REQUIRED_SCHEMA).length, failures };
  };
  return {
    databaseDiagnostic, schemaDiagnostic,
    async health() {
      // Both health and the authenticated diagnostic endpoint execute this same
      // minimal GET query. Log synchronously before reporting an unhealthy DB.
      const diagnostic = await databaseDiagnostic();
      if (!diagnostic.success) logger.error?.("DATABASE_HEALTH_CHECK_FAILED", {
        failure_type: diagnostic.failure_type,
        error: { code: diagnostic.code, message: diagnostic.message, details: diagnostic.details },
        http_status: diagnostic.status
      });
      return diagnostic.success;
    },
    async availability(room, start, end) { const data = assert(await supabase.rpc("room_availability", { requested_room_type: room, requested_check_in: start, requested_check_out: end }), "room_availability"); const result = Array.isArray(data) ? data[0] : data; return Math.max(0, Number(result?.remaining) || 0); },
    async findOrderByKey(key) { return assert(await supabase.from("payment_orders").select("*").eq("idempotency_key", key).maybeSingle()); },
    async saveOrder(order) { return assert(await supabase.from("payment_orders").insert(order).select().single()); },
    async verifyOrder(fields) { const existing = assert(await supabase.from("payment_orders").select("*").eq("razorpay_order_id", fields.razorpay_order_id).maybeSingle()); if (!existing) return null; return assert(await supabase.from("payment_orders").update({ ...fields, status: "verified", verified_at: new Date().toISOString() }).eq("id", existing.id).select().single()); },
    async getVerifiedOrder(orderId, paymentId) { if (!orderId || !paymentId) return null; return assert(await supabase.from("payment_orders").select("*").eq("razorpay_order_id", orderId).eq("razorpay_payment_id", paymentId).eq("status", "verified").maybeSingle(), "verified_order_lookup"); },
    async createBookingAtomic(booking) { const data = assert(await supabase.rpc("create_booking_atomic", { booking_data: booking }), "create_booking_atomic"); return Array.isArray(data) ? data[0] : data; },
    async markEmailSent(id) { return assert(await supabase.from("bookings").update({ email_sent_at: new Date().toISOString() }).eq("id", id).is("email_sent_at", null)); },
    async createReview(review) { return assert(await supabase.from("reviews").insert({ ...review, status: "pending" })); },
    async approvedReviews() { return assert(await supabase.from("reviews").select("id,customer_name,rating,review,created_at").eq("status", "approved").order("created_at", { ascending: false }).limit(100)); },
    async bookings(filters) {
      const fields = "id,booking_id,customer_name,phone,email,room_type,check_in,check_out,adults,children,booking_status,payment_status,amount,advance_amount,created_at";
      const offset = (filters.page - 1) * filters.limit;
      let q = supabase.from("bookings").select(fields, { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + filters.limit - 1);
      if (filters.status) q = q.eq("booking_status", filters.status);
      if (filters.room_type) q = q.eq("room_type", filters.room_type);
      if (filters.check_in_from) q = q.gte("check_in", filters.check_in_from);
      if (filters.check_in_to) q = q.lte("check_in", filters.check_in_to);
      if (filters.search) {
        const term = filters.search.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        q = q.or(`booking_id.ilike."%${term}%",customer_name.ilike."%${term}%",phone.ilike."%${term}%"`);
      }
      const result = await q;
      if (result.error) throw new Error(result.error.message);
      return { items: result.data, total: result.count || 0 };
    },
    async rooms(filters) {
      const offset = (filters.page - 1) * filters.limit;
      let q = supabase.from("rooms").select("id,room_number,floor,operational_status,housekeeping_status,notes,is_active,created_at,updated_at,room_types!inner(name)", { count: "exact" }).order("room_number", { ascending: true }).range(offset, offset + filters.limit - 1);
      if (filters.room_type) q = q.eq("room_types.name", filters.room_type);
      if (filters.operational_status) q = q.eq("operational_status", filters.operational_status);
      if (filters.housekeeping_status) q = q.eq("housekeeping_status", filters.housekeeping_status);
      if (filters.is_active) q = q.eq("is_active", filters.is_active === "true");
      const result = await q;
      if (result.error) throw new Error(result.error.message);
      return { items: result.data, total: result.count || 0 };
    },
    async roomStatus() {
      const rooms = assert(await supabase.from("rooms").select("id,room_number,floor,operational_status,housekeeping_status,notes,is_active,created_at,updated_at,room_types!inner(name)").order("room_number", { ascending: true }));
      const occupied = assert(await supabase.from("booking_room_assignments").select("room_id,bookings!inner(booking_stays!inner(stay_status))").eq("assignment_status", "active").eq("bookings.booking_stays.stay_status", "checked_in"));
      const occupiedIds = new Set(occupied.map((row) => row.room_id));
      return rooms.map((room) => ({ ...room, ...(occupiedIds.has(room.id) && { stay_status: "checked_in" }) }));
    },
    async adminAvailability(start, end, roomType) { const exclusiveEnd = new Date(`${end}T00:00:00.000Z`); exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1); let q = supabase.from("bookings").select("id,booking_id,room_type,check_in,check_out,booking_status").lt("check_in", exclusiveEnd.toISOString().slice(0, 10)).gt("check_out", start).order("check_in", { ascending: true }); if (roomType) q = q.eq("room_type", roomType); return assert(await q); },
    async analyticsBookings() { return assert(await supabase.from("bookings").select("room_type,check_in,check_out,adults,children,booking_status,payment_status,amount,advance_amount,created_at")); },
    async assignRoom(bookingId, roomId, actor) { return assert(await supabase.rpc("assign_booking_room", { target_booking_id: bookingId, target_room_id: roomId, actor })); },
    async releaseRoom(bookingId, actor, reason) { return assert(await supabase.rpc("release_booking_room", { target_booking_id: bookingId, actor, reason })); },
    async roomAssignments(bookingId) {
      const booking = assert(await supabase.from("bookings").select("id").eq("id", bookingId).maybeSingle());
      if (!booking) return null;
      const rows = assert(await supabase.from("booking_room_assignments").select("id,booking_id,room_id,allocation_range,assignment_status,assigned_at,assigned_by,released_at,released_by,release_reason,created_at,updated_at,rooms!inner(id,room_number,room_types!inner(name))").eq("booking_id", bookingId).order("assigned_at", { ascending: false }));
      const history = rows.map((row) => ({ id: row.id, booking_id: row.booking_id, ...allocationDates(row.allocation_range), assignment_status: row.assignment_status, assigned_at: row.assigned_at, assigned_by: row.assigned_by, released_at: row.released_at, released_by: row.released_by, release_reason: row.release_reason, created_at: row.created_at, updated_at: row.updated_at, room: { id: row.rooms.id, room_number: row.rooms.room_number, room_type: row.rooms.room_types.name } }));
      return { current: history.find((row) => row.assignment_status === "active") || null, history };
    },
    async checkIn(bookingId) { return assert(await supabase.rpc("check_in_booking", { target_booking_id: bookingId })); },
    async checkOut(bookingId) { return assert(await supabase.rpc("check_out_booking", { target_booking_id: bookingId })); },
    async housekeepingTasks(bookingId) {
      const booking = assert(await supabase.from("bookings").select("id").eq("id", bookingId).maybeSingle());
      if (!booking) return null;
      return assert(await supabase.from("housekeeping_tasks").select("id,booking_id,room_id,task_type,status,assigned_to,notes,created_at,completed_at,updated_at,rooms!inner(room_number)").eq("booking_id", bookingId).order("created_at", { ascending: false }));
    },
    async listHousekeepingTasks(filters) {
      const offset = (filters.page - 1) * filters.limit;
      let q = supabase.from("housekeeping_tasks").select("id,booking_id,room_id,task_type,status,assigned_to,notes,created_at,completed_at,updated_at,rooms!inner(room_number)", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + filters.limit - 1);
      if (filters.status) q = q.eq("status", filters.status);
      if (filters.room) q = q.eq("room_id", filters.room);
      const result = await q;
      if (result.error) throw new Error(result.error.message);
      return { items: result.data, total: result.count || 0 };
    },
    async transitionHousekeepingTask(taskId, action) { return assert(await supabase.rpc("transition_housekeeping_task", { target_task_id: taskId, target_action: action })); },
    async bookingStay(bookingId) {
      const booking = assert(await supabase.from("bookings").select("id").eq("id", bookingId).maybeSingle());
      if (!booking) return null;
      const stay = assert(await supabase.from("booking_stays").select("stay_status,checked_in_at,checked_out_at").eq("booking_id", bookingId).maybeSingle());
      const assignment = assert(await supabase.from("booking_room_assignments").select("rooms!inner(room_number)").eq("booking_id", bookingId).eq("assignment_status", "active").maybeSingle());
      return { stay_status: stay?.stay_status || "not_checked_in", checked_in_at: stay?.checked_in_at || null, checked_out_at: stay?.checked_out_at || null, room_number: assignment?.rooms?.room_number || null };
    },
    async booking(id) { return assert(await supabase.from("bookings").select("*").eq("id", id).maybeSingle()); },
    async updateBooking(id, status) { return assert(await supabase.from("bookings").update({ booking_status: status, updated_at: new Date().toISOString() }).eq("id", id).select().single()); },
    async reviews() { return assert(await supabase.from("reviews").select("*").order("created_at", { ascending: false })); },
    async moderateReview(id, status) { return assert(await supabase.from("reviews").update({ status, moderated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle()); },
    async deleteReview(id) { return assert(await supabase.from("reviews").delete().eq("id", id).select().maybeSingle()); }
    ,async getSettings() { return assert(await supabase.from("business_settings").select("business_name,gst_number,gst_percent,address,phone,email,invoice_footer,invoice_prefix,currency,timezone,logo_metadata,updated_at").eq("id", true).single()); }
    ,async updateSettings(values) { return assert(await supabase.from("business_settings").update(values).eq("id", true).select("business_name,gst_number,gst_percent,address,phone,email,invoice_footer,invoice_prefix,currency,timezone,logo_metadata,updated_at").single()); }
    ,async createAuditLog(log) { return assert(await supabase.from("audit_logs").insert(log).select("id").single()); }
    ,async auditLogs(filters) {
      const offset = (filters.page - 1) * filters.limit; let q = supabase.from("audit_logs").select("id,user_name,action,entity,entity_id,created_at,ip,details", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + filters.limit - 1);
      if (filters.action) q = q.eq("action", filters.action); if (filters.entity) q = q.eq("entity", filters.entity); if (filters.start_date) q = q.gte("created_at", `${filters.start_date}T00:00:00Z`); if (filters.end_date) q = q.lte("created_at", `${filters.end_date}T23:59:59Z`);
      const result = await q; if (result.error) throw new Error(result.error.message); return { items: result.data, total: result.count || 0 };
    }
    ,async listInvoices(filters) {
      const offset = (filters.page - 1) * filters.limit; let q = supabase.from("invoices").select("id,invoice_number,booking_id,issued_at,grand_total,gst_amount,currency,created_at", { count: "exact" }).order("issued_at", { ascending: false }).range(offset, offset + filters.limit - 1);
      if (filters.start_date) q = q.gte("issued_at", `${filters.start_date}T00:00:00Z`); if (filters.end_date) q = q.lte("issued_at", `${filters.end_date}T23:59:59Z`); const result = await q; if (result.error) throw new Error(result.error.message); return { items: result.data, total: result.count || 0 };
    }
    ,async invoiceBooking(bookingId) {
      let q = supabase.from("bookings").select("id,booking_id,customer_name,room_type,check_in,check_out,booking_status,payment_status,payment_type,amount,advance_amount");
      q = /^[0-9a-f-]{36}$/i.test(bookingId) ? q.eq("id", bookingId) : q.eq("booking_id", bookingId); const booking = assert(await q.maybeSingle()); if (!booking) return null;
      const invoice = assert(await supabase.from("invoices").select("invoice_number,issued_at,extra_charges,discount,gst_amount,grand_total,business_details").eq("booking_id", booking.id).maybeSingle());
      const assignment = assert(await supabase.from("booking_room_assignments").select("rooms(room_number)").eq("booking_id", booking.id).order("assigned_at", { ascending: false }).limit(1).maybeSingle()); return { ...booking, ...invoice, room_number: assignment?.rooms?.room_number || null };
    }
    ,async createInvoice(bookingId, prefix) { return assert(await supabase.rpc("generate_booking_invoice", { target_booking_id: bookingId, invoice_prefix: prefix })); }
    ,async reportingBookings(range) { return assert(await supabase.from("bookings").select("id,check_in,check_out,booking_status,payment_status,amount,advance_amount,refund_amount,created_at").gte("created_at", `${range.start_date}T00:00:00Z`).lte("created_at", `${range.end_date}T23:59:59Z`)); }
    ,async occupancyData(range) {
      const bookings = assert(await supabase.from("bookings").select("check_in,check_out,booking_status,amount,booking_stays(stay_status)").lt("check_in", range.end_date).gt("check_out", range.start_date));
      const rooms = await supabase.from("rooms").select("id", { head: true, count: "exact" }).eq("is_active", true); if (rooms.error) throw new Error(rooms.error.message); return { bookings: bookings.map((b) => ({ ...b, stay_status: b.booking_stays?.[0]?.stay_status })), room_count: rooms.count || 0 };
    }
    ,async exportRows(dataset, range) {
      const tables = { bookings: ["bookings", "booking_id,customer_name,room_type,check_in,check_out,booking_status,payment_status,amount"], housekeeping: ["housekeeping_tasks", "task_type,status,assigned_to,created_at,completed_at"], maintenance: ["rooms", "room_number,operational_status,notes,updated_at"], reviews: ["reviews", "customer_name,rating,review,status,created_at"] };
      if (dataset === "revenue") return this.reportingBookings(range); if (dataset === "occupancy") return (await this.occupancyData(range)).bookings;
      const [table, fields] = tables[dataset]; let q = supabase.from(table).select(fields); const dateField = dataset === "maintenance" ? "updated_at" : "created_at"; q = q.gte(dateField, `${range.start_date}T00:00:00Z`).lte(dateField, `${range.end_date}T23:59:59Z`).limit(10000); return assert(await q);
    }
  };
}
module.exports = { DatabaseError, REQUIRED_SCHEMA, classifyHealthFailure, createSupabaseDb, healthDiagnostic, postgrestConnectivityProbe, publicHealthDiagnostic, safeDiagnostic };
