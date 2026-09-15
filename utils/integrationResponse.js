/**
 * Response envelope for the server-to-server integration API (/api/integration).
 *
 *   success  { "success": true,  "data": …, "meta"?: {…}, "warnings"?: [{code,message}] }
 *   failure  { "success": false, "error": { "code", "message", "details"? } }
 *
 * `error.code` is the contract: stable, UPPER_SNAKE, documented in
 * postman/README.md. Clients branch on it; `message` is for humans and may change.
 */
const { isServiceError } = require("./serviceError");

function ok(res, data, { status = 200, meta, warnings } = {}) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  if (warnings && warnings.length) body.warnings = warnings;
  return res.status(status).json(body);
}

function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details && Object.keys(details).length) error.details = details;
  return res.status(status).json({ success: false, error });
}

/** Wrap an async handler so a thrown error reaches the integration error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Error middleware for /api/integration. Mounted on the app (not only inside the
 * router) so a malformed JSON body — rejected by the app-level express.json()
 * before any integration route runs — still answers in the envelope.
 */
// eslint-disable-next-line no-unused-vars
function integrationErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (isServiceError(err)) return fail(res, err.status, err.code, err.message, err.details);
  if (err && err.type === "entity.parse.failed") {
    return fail(res, 400, "INVALID_JSON", "The request body is not valid JSON");
  }
  if (err && err.type === "entity.too.large") {
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "The request body is too large");
  }
  if (err && err.name === "ValidationError" && err.errors) {
    return fail(res, 400, "VALIDATION_ERROR", Object.values(err.errors).map((e) => e.message).join("; "));
  }
  if (err && err.name === "CastError") {
    return fail(res, 400, "VALIDATION_ERROR", `Invalid value for ${err.path}`, { field: err.path });
  }
  console.error(`[integration] ${req.method} ${req.originalUrl} failed:`, err);
  return fail(res, 500, "INTERNAL_ERROR", "Something went wrong on our end");
}

module.exports = { ok, fail, handle, integrationErrorHandler };
