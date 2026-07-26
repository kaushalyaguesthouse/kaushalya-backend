const { createClient } = require("@supabase/supabase-js");
const { loadConfig, validateConfig } = require("./config");
const { createSupabaseDb } = require("./supabase-db");

function configurationErrors(config) {
  const errors = validateConfig(config);
  const required = {
    SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.supabaseServiceRoleKey,
    RAZORPAY_KEY_ID: config.razorpayKeyId, RAZORPAY_KEY_SECRET: config.razorpaySecret,
    ADMIN_SESSION_SECRET: config.adminSecret, ADMIN_BOOTSTRAP_KEY: config.adminBootstrapKey
  };
  for (const [name, value] of Object.entries(required)) if (!value) errors.push(`${name} is required.`);
  if (config.adminSecret && config.adminSecret.length < 32) errors.push("ADMIN_SESSION_SECRET must contain at least 32 characters.");
  if (config.supabaseKeySource !== "service_role") errors.push("The server must use SUPABASE_SERVICE_ROLE_KEY, not SUPABASE_ANON_KEY.");
  if (config.nodeEnv === "production" && config.origins.join(",") !== "https://kaushalyaguesthouse.github.io") errors.push("Production ALLOWED_ORIGINS must contain exactly https://kaushalyaguesthouse.github.io.");
  return errors;
}

async function runProductionAudit({ env = process.env, fetch: fetchImpl = globalThis.fetch, output = console } = {}) {
  const config = loadConfig(env);
  const errors = configurationErrors(config);
  if (errors.length) { for (const error of errors) output.error(`CONFIG: ${error}`); return false; }
  output.log("PASS: production environment names, presence, formats, and service-role precedence");
  class DisabledRealtimeTransport {}
  const client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchImpl }, realtime: { transport: DisabledRealtimeTransport } });
  output.log("PASS: server-only Supabase client initialized");
  const db = createSupabaseDb(client, output, { url: config.supabaseUrl, key: config.supabaseKey, fetch: fetchImpl });
  const connection = await db.databaseDiagnostic();
  if (!connection.success) { output.error(`CONNECTIVITY: ${connection.failure_type} (${connection.status ?? "no HTTP status"})`); return false; }
  output.log(`PASS: Supabase PostgREST connectivity and authorization (HTTP ${connection.status})`);
  const schema = await db.schemaDiagnostic();
  if (!schema.ready) {
    for (const failure of schema.failures) output.error(`SCHEMA: ${failure.resource}: ${failure.failure_type} (${failure.code || failure.status || "unknown"})`);
    return false;
  }
  output.log(`PASS: ${schema.checked} required schema resources and their queried columns`);
  if (!await db.health()) { output.error("HEALTH: connectivity health behavior failed"); return false; }
  output.log("PASS: database health behavior");
  return true;
}

module.exports = { configurationErrors, runProductionAudit };
