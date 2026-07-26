const crypto = require("crypto");

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Helmet-compatible, dependency-free header policy. Keeping this local also makes
// the policy auditable and usable when production installs run without the npm registry.
function helmet() {
  return (_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Origin-Agent-Cluster": "?1",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "X-Download-Options": "noopen",
      "X-Frame-Options": "DENY",
      "X-Permitted-Cross-Domain-Policies": "none",
      "X-XSS-Protection": "0"
    });
    next();
  };
}

function validateRequest(req, res, next) {
  const invalid = (value, depth = 0) => {
    if (depth > 12) return "Request data is nested too deeply.";
    if (typeof value === "string") return value.length > 10000 ? "A request value is too long." : CONTROL_CHARACTERS.test(value) ? "Request data contains invalid control characters." : null;
    if (!value || typeof value !== "object") return null;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return "Request data contains a forbidden property.";
      const error = invalid(value[key], depth + 1);
      if (error) return error;
    }
    return null;
  };
  const message = invalid(req.body) || invalid(req.query) || invalid(req.params);
  return message ? res.status(400).json({ success: false, message, code: "INVALID_REQUEST" }) : next();
}

function requestContext(logger) {
  return (req, res, next) => {
    const supplied = String(req.headers["x-request-id"] || "");
    req.id = /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    const started = process.hrtime.bigint();
    res.on("finish", () => logger.info?.("HTTP_REQUEST", { request_id: req.id, method: req.method, path: req.path, status: res.statusCode, duration_ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    next();
  };
}

module.exports = { helmet, requestContext, validateRequest };
