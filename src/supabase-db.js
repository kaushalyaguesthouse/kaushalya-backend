function assert(result) { if (result.error) throw new Error(result.error.message); return result.data; }

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
    async bookings(query) { let q = supabase.from("bookings").select("*").order("created_at", { ascending: false }).limit(Math.min(Number(query.limit) || 100, 500)); if (query.status) q = q.eq("booking_status", query.status); return assert(await q); },
    async adminAvailability(start, end, roomType) { const exclusiveEnd = new Date(`${end}T00:00:00.000Z`); exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1); let q = supabase.from("bookings").select("id,booking_id,room_type,check_in,check_out,booking_status").lt("check_in", exclusiveEnd.toISOString().slice(0, 10)).gt("check_out", start).order("check_in", { ascending: true }); if (roomType) q = q.eq("room_type", roomType); return assert(await q); },
    async booking(id) { return assert(await supabase.from("bookings").select("*").eq("id", id).maybeSingle()); },
    async updateBooking(id, status) { return assert(await supabase.from("bookings").update({ booking_status: status, updated_at: new Date().toISOString() }).eq("id", id).select().single()); },
    async reviews() { return assert(await supabase.from("reviews").select("*").order("created_at", { ascending: false })); },
    async moderateReview(id, status) { return assert(await supabase.from("reviews").update({ status, moderated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle()); },
    async deleteReview(id) { return assert(await supabase.from("reviews").delete().eq("id", id).select().maybeSingle()); }
  };
}
module.exports = { createSupabaseDb };
