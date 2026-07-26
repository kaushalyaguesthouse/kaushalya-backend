function assert(result) { if (result.error) throw new Error(result.error.message); return result.data; }

function allocationDates(range) {
  const match = /^\[([^,]+),([^\)]+)\)$/.exec(String(range || ""));
  return match ? { from: match[1], until: match[2] } : { from: null, until: null };
}

function createSupabaseDb(supabase) {
  return {
    async health() { try { return !((await supabase.from("bookings").select("id", { head: true, count: "exact" }).limit(1)).error); } catch { return false; } },
    async availability(room, start, end, inventory) { const data = assert(await supabase.from("bookings").select("id").eq("room_type", room).in("booking_status", ["Pending", "Confirmed"]).lt("check_in", end).gt("check_out", start)); return Math.max(0, inventory - data.length); },
    async findOrderByKey(key) { return assert(await supabase.from("payment_orders").select("*").eq("idempotency_key", key).maybeSingle()); },
    async saveOrder(order) { return assert(await supabase.from("payment_orders").insert(order).select().single()); },
    async verifyOrder(fields) { const existing = assert(await supabase.from("payment_orders").select("*").eq("razorpay_order_id", fields.razorpay_order_id).maybeSingle()); if (!existing) return null; return assert(await supabase.from("payment_orders").update({ ...fields, status: "verified", verified_at: new Date().toISOString() }).eq("id", existing.id).select().single()); },
    async getVerifiedOrder(orderId, paymentId) { if (!orderId || !paymentId) return null; return assert(await supabase.from("payment_orders").select("*").eq("razorpay_order_id", orderId).eq("razorpay_payment_id", paymentId).eq("status", "verified").maybeSingle()); },
    async createBookingAtomic(booking, inventory) { const data = assert(await supabase.rpc("create_booking_atomic", { booking_data: booking, room_inventory: inventory })); return Array.isArray(data) ? data[0] : data; },
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
  };
}
module.exports = { createSupabaseDb };
