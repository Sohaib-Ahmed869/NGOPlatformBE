/**
 * A failure a service function wants its caller to report, not log.
 *
 * Services shared between the SuperAdmin console and the server-to-server
 * integration API (services/tenantLifecycle.js, services/planService.js,
 * services/tenantProvisioning.js) throw this instead of writing a response,
 * because the two callers answer in different shapes: the console with
 * `{ error: message }`, the integration API with a stable machine-readable
 * `code`. The code is part of the integration contract — rename one and a
 * client that branches on it breaks silently.
 */
class ServiceError extends Error {
  /**
   * @param {number} status  HTTP status the caller should answer with
   * @param {string} code    stable UPPER_SNAKE identifier, e.g. "PLAN_NOT_FOUND"
   * @param {string} message human-readable explanation
   * @param {object} [details] extra machine-readable context
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = details || undefined;
  }
}

const isServiceError = (err) => err instanceof ServiceError;

module.exports = { ServiceError, isServiceError };
