require("dotenv").config();
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const { createApp } = require("./src/app");
const { loadConfig } = require("./src/config");
const { createSupabaseDb } = require("./src/supabase-db");
const { createMailer } = require("./src/mailer");

const config = loadConfig();
const required = { SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.supabaseKey, RAZORPAY_KEY_ID: config.razorpayKeyId, RAZORPAY_KEY_SECRET: config.razorpaySecret, ADMIN_SESSION_SECRET: config.adminSecret, ADMIN_BOOTSTRAP_KEY: config.adminBootstrapKey };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) { console.error(`Missing required environment variables: ${missing.join(", ")}`); process.exit(1); }
if (config.adminSecret.length < 32) { console.error("ADMIN_SESSION_SECRET (or JWT_SECRET) must be at least 32 characters."); process.exit(1); }
if (config.nodeEnv === "production" && process.env.SUPABASE_SERVICE_ROLE_KEY == null) { console.error("SUPABASE_SERVICE_ROLE_KEY is required in production."); process.exit(1); }

// This REST-only backend never opens Supabase Realtime sockets. Supplying a
// transport prevents newer clients from requiring a WebSocket implementation
// during startup on the Node.js 20 runtime used in production.
class DisabledRealtimeTransport {}
const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: DisabledRealtimeTransport }
});
const razorpay = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpaySecret });
const app = createApp({ config, db: createSupabaseDb(supabase), razorpay, mailer: createMailer(config) });
if (require.main === module) app.listen(config.port, "0.0.0.0", () => console.log(`Kaushalya backend listening on port ${config.port}`));
module.exports = app;
