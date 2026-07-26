const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { signAdminToken } = require("../src/core");
const taskId = "123e4567-e89b-12d3-a456-426614174060";
const roomId = "123e4567-e89b-12d3-a456-426614174061";
const config = { origins: [], rooms: {}, adminSecret: "housekeeping-secret" };
const token = signAdminToken(config.adminSecret);
const secrets = ["guest@example.com", "9999999999", "pay_private", "order_private", "Keep private"];
const privateData = { email: secrets[0], phone: secrets[1], payment_id: secrets[2], razorpay_order_id: secrets[3], special_request: secrets[4] };
const task = { id: taskId, booking_id: "booking-1", room_id: roomId, task_type: "turnover", status: "pending", assigned_to: null, notes: "Change linen", created_at: "2026-07-26T12:00:00Z", completed_at: null, updated_at: "2026-07-26T12:00:00Z", rooms: { room_number: "101" }, ...privateData };
const room = { id: roomId, room_number: "101", floor: 1, operational_status: "operational", housekeeping_status: "completed", notes: null, is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-07-26T12:05:00Z", ...privateData };
async function request(db, path, options = {}) {
  const server = createApp({ config, db, razorpay: {}, logger: { error() {}, info() {} } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
test("lists housekeeping history with filtering, pagination, and privacy", async () => {
  let received;
  const response = await request({ async listHousekeepingTasks(filters) { received = filters; return { items: [task], total: 26 }; } }, `/admin/housekeeping?status=pending&room=${roomId}&page=2&limit=10`);
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(received, { status: "pending", room: roomId, page: 2, limit: 10 });
  assert.deepEqual(body.pagination, { page: 2, limit: 10, total: 26, total_pages: 3 });
  assert.equal(body.items[0].room_number, "101");
  for (const value of secrets) assert.equal(JSON.stringify(body).includes(value), false);
});
test("validates housekeeping filters and authentication", async () => {
  for (const query of ["status=dirty", "page=0", "limit=101", "room=invalid"]) assert.equal((await request({ async listHousekeepingTasks() { throw new Error("must not run"); } }, `/admin/housekeeping?${query}`)).status, 422, query);
  assert.equal((await request({}, "/admin/housekeeping", { headers: { authorization: "" } })).status, 401);
});
test("starts, completes, and inspects housekeeping with safe room transitions", async () => {
  const calls = []; const db = { async transitionHousekeepingTask(id, action) { calls.push([id, action]); if (action === "start") return { success: true, task: { ...task, status: "cleaning" } }; if (action === "complete") return { success: true, task: { ...task, status: "completed", completed_at: "2026-07-26T12:05:00Z" }, room }; return { success: true, task: { ...task, status: "inspected" }, room: { ...room, housekeeping_status: "inspected" }, derived_status: "available" }; } };
  let body = await (await request(db, `/admin/housekeeping/${taskId}/start`, { method: "POST" })).json(); assert.equal(body.task.status, "cleaning"); assert.equal(body.room, undefined);
  body = await (await request(db, `/admin/housekeeping/${taskId}/complete`, { method: "POST" })).json(); assert.equal(body.task.status, "completed"); assert.equal(body.task.completed_at, "2026-07-26T12:05:00Z"); assert.equal(body.room.housekeeping_status, "completed");
  body = await (await request(db, `/admin/housekeeping/${taskId}/inspect`, { method: "POST" })).json(); assert.equal(body.task.status, "inspected"); assert.equal(body.room.housekeeping_status, "inspected"); assert.equal(body.derived_status, "available");
  assert.deepEqual(calls, [[taskId, "start"], [taskId, "complete"], [taskId, "inspect"]]); for (const value of secrets) assert.equal(JSON.stringify(body).includes(value), false);
});
test("rejects missing, inactive, cancelled, and invalid housekeeping transitions", async () => {
  for (const action of ["start", "complete", "inspect"]) for (const [reason, status] of [["task_not_found", 404], ["room_inactive", 409], ["task_cancelled", 409], ["invalid_transition", 409]]) assert.equal((await request({ async transitionHousekeepingTask() { return { success: false, reason }; } }, `/admin/housekeeping/${taskId}/${action}`, { method: "POST" })).status, status, `${action}: ${reason}`);
});
