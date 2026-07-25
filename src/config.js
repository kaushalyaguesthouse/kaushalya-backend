function clean(value) { return String(value || "").trim().replace(/^["']|["']$/g, ""); }
function positiveInt(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }

function loadConfig(env = process.env) {
  const roomNames = clean(env.ROOM_TYPES || "Standard,Deluxe").split(",").map((x) => x.trim()).filter(Boolean);
  const rooms = Object.fromEntries(roomNames.map((name) => {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return [name, { price: positiveInt(env[`ROOM_PRICE_${key}`], name === "Deluxe" ? 2500 : 1800), inventory: positiveInt(env[`ROOM_INVENTORY_${key}`], 1) }];
  }));
  return {
    port: positiveInt(env.PORT, 10000), nodeEnv: clean(env.NODE_ENV || "development"),
    supabaseUrl: clean(env.SUPABASE_URL), supabaseKey: clean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY),
    razorpayKeyId: clean(env.RAZORPAY_KEY_ID), razorpaySecret: clean(env.RAZORPAY_KEY_SECRET),
    adminSecret: clean(env.ADMIN_TOKEN_SECRET), adminBootstrapKey: clean(env.ADMIN_BOOTSTRAP_KEY),
    origins: clean(env.ALLOWED_ORIGINS || "https://kaushalyaguesthouse.github.io,http://localhost:3000,http://127.0.0.1:5500").split(",").map((x) => x.trim()),
    rooms, maxStayNights: positiveInt(env.MAX_STAY_NIGHTS, 90), maxGuests: positiveInt(env.MAX_GUESTS_PER_BOOKING, 10),
    paymentMethods: clean(env.PAYMENT_METHODS || "Pay Later,Razorpay").split(",").map((x) => x.trim()),
    contact: { email: clean(env.GUEST_HOUSE_EMAIL), phone: clean(env.GUEST_HOUSE_PHONE), address: clean(env.GUEST_HOUSE_ADDRESS) },
    email: { webhookUrl: clean(env.EMAIL_WEBHOOK_URL), token: clean(env.EMAIL_WEBHOOK_TOKEN), from: clean(env.EMAIL_FROM), admin: clean(env.ADMIN_EMAIL) }
  };
}
module.exports = { loadConfig };
