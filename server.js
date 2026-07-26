require("dotenv").config();
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const { createApp } = require("./src/app");
const { loadConfig, validateConfig } = require("./src/config");
const { createSupabaseDb } = require("./src/supabase-db");
const { createMailer } = require("./src/mailer");
const logger = require("./src/logger");

const config = loadConfig();
const required = { SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.supabaseServiceRoleKey, RAZORPAY_KEY_ID: config.razorpayKeyId, RAZORPAY_KEY_SECRET: config.razorpaySecret, ADMIN_SESSION_SECRET: config.adminSecret, ADMIN_BOOTSTRAP_KEY: config.adminBootstrapKey };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) { console.error(`Missing required environment variables: ${missing.join(", ")}`); process.exit(1); }
const invalid = validateConfig(config);
if (invalid.length) { console.error(`Invalid production configuration: ${invalid.join(" ")}`); process.exit(1); }
if (config.adminSecret.length < 32) { console.error("ADMIN_SESSION_SECRET (or JWT_SECRET) must be at least 32 characters."); process.exit(1); }

// This REST-only backend never opens Supabase Realtime sockets. Supplying a
// transport prevents newer clients from requiring a WebSocket implementation
// during startup on the Node.js 20 runtime used in production.
class DisabledRealtimeTransport {}
const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { transport: DisabledRealtimeTransport }
});
const razorpay = new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpaySecret });
const app = createApp({ config, db: createSupabaseDb(supabase, logger, { url: config.supabaseUrl, key: config.supabaseKey }), razorpay, mailer: createMailer(config), logger });
if (require.main === module) {
  const server = app.listen(config.port, "0.0.0.0", () => logger.info("APPLICATION_STARTED", { port: config.port, environment: config.nodeEnv }));
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("APPLICATION_SHUTDOWN", { signal });
    server.close(async () => {
      try { await supabase.removeAllChannels(); } catch { /* REST-only client normally has no channels. */ }
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => { server.closeAllConnections?.(); process.exit(1); }, 10000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("uncaughtException", (error) => { logger.error("UNEXPECTED_ERROR", { error_name: error.name }); shutdown("uncaughtException"); });
  process.on("unhandledRejection", (error) => { logger.error("UNEXPECTED_REJECTION", { error_name: error?.name || "Error" }); shutdown("unhandledRejection"); });
}
module.exports = app;
