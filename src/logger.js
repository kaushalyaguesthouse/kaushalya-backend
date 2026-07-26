const REDACTED_KEYS = /authorization|cookie|secret|token|password|signature|service.role|razorpay.*key|environment/i;

function redact(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, REDACTED_KEYS.test(key) ? "[REDACTED]" : redact(item, seen)]));
}

function write(level, event, details = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...redact(details) };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

module.exports = { error: (event, details) => write("error", event, details), info: (event, details) => write("info", event, details), redact };
