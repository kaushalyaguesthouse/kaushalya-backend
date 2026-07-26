function clean(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1).trim();
  return trimmed;
}
function positiveInt(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }

function validateConfig(config) {
  const errors = [];
  if (!Number.isInteger(config.port) || config.port > 65535) errors.push("PORT must be between 1 and 65535.");
  if (!["development", "test", "production"].includes(config.nodeEnv)) errors.push("NODE_ENV must be development, test, or production.");
  if (config.supabaseUrl && !/^https:\/\/[a-z0-9.-]+$/i.test(config.supabaseUrl)) errors.push("SUPABASE_URL must be a valid HTTPS URL without a path.");
  if (config.supabaseUrl && /^https:\/\/[a-z0-9.-]+$/i.test(config.supabaseUrl) && !/\.supabase\.co$/i.test(new URL(config.supabaseUrl).hostname)) errors.push("SUPABASE_URL must be a Supabase project URL.");
  if (!config.origins.length || config.origins.some((origin) => !/^https?:\/\/[^/]+$/i.test(origin))) errors.push("ALLOWED_ORIGINS must contain valid origins without paths.");
  if (config.nodeEnv === "production" && config.origins.some((origin) => !origin.startsWith("https://"))) errors.push("Production ALLOWED_ORIGINS must use HTTPS.");
  return errors;
}

function loadConfig(env = process.env) {
  const roomNames = clean(env.ROOM_TYPES || "Standard,Deluxe").split(",").map((x) => x.trim()).filter(Boolean);
  const rooms = Object.fromEntries(roomNames.map((name) => {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return [name, { price: positiveInt(env[`ROOM_PRICE_${key}`], name === "Deluxe" ? 2500 : 1800), inventory: positiveInt(env[`ROOM_INVENTORY_${key}`], 1) }];
  }));
  return {
    port: positiveInt(env.PORT, 10000), nodeEnv: clean(env.NODE_ENV || "development"),
    supabaseUrl: clean(env.SUPABASE_URL),
    supabaseServiceRoleKey: clean(env.SUPABASE_SERVICE_ROLE_KEY), supabaseAnonKey: clean(env.SUPABASE_ANON_KEY),
    supabaseKey: clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.SUPABASE_ANON_KEY),
    supabaseKeySource: clean(env.SUPABASE_SERVICE_ROLE_KEY) ? "service_role" : clean(env.SUPABASE_ANON_KEY) ? "anon" : "missing",
    razorpayKeyId: clean(env.RAZORPAY_KEY_ID), razorpaySecret: clean(env.RAZORPAY_KEY_SECRET),
    adminSecret: clean(env.ADMIN_SESSION_SECRET || env.JWT_SECRET || env.ADMIN_TOKEN_SECRET), adminBootstrapKey: clean(env.ADMIN_BOOTSTRAP_KEY),
    origins: clean(env.ALLOWED_ORIGINS || "https://kaushalyaguesthouse.github.io,http://localhost:3000,http://127.0.0.1:5500").split(",").map((x) => x.trim()),
    rooms, maxStayNights: positiveInt(env.MAX_STAY_NIGHTS, 90), maxGuests: positiveInt(env.MAX_GUESTS_PER_BOOKING, 10),
    paymentMethods: clean(env.PAYMENT_METHODS || "Pay Later,Razorpay").split(",").map((x) => x.trim()),
    bodyLimit: clean(env.REQUEST_BODY_LIMIT || "100kb"), rateLimit: positiveInt(env.RATE_LIMIT_MAX, 120), rateWindowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60000),
    contact: { email: clean(env.GUEST_HOUSE_EMAIL), phone: clean(env.GUEST_HOUSE_PHONE), address: clean(env.GUEST_HOUSE_ADDRESS) },
    email: { webhookUrl: clean(env.EMAIL_WEBHOOK_URL), token: clean(env.EMAIL_WEBHOOK_TOKEN), from: clean(env.EMAIL_FROM), admin: clean(env.ADMIN_EMAIL) }
  };
}
module.exports = { loadConfig, validateConfig };
