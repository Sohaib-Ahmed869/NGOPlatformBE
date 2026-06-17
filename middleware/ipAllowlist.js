/**
 * Optional IP allowlist for the platform operator API (/api/superadmin/*).
 * Set SUPERADMIN_IP_ALLOWLIST to a comma-separated list of IPs to enforce it.
 * When the env var is empty/unset the guard is DISABLED (no-op) — safe for dev.
 * Runs BEFORE authentication.
 */
module.exports = function ipAllowlist(req, res, next) {
  const raw = process.env.SUPERADMIN_IP_ALLOWLIST || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.length === 0) return next(); // disabled

  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || req.ip || req.socket?.remoteAddress || "";
  const normalized = ip.replace(/^::ffff:/, ""); // unwrap IPv4-mapped IPv6

  if (list.includes(ip) || list.includes(normalized)) return next();

  return res.status(403).json({ error: "Access denied from this network" });
};
