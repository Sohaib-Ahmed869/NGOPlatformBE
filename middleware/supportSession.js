const jwt = require("jsonwebtoken");
const SupportSession = require("../models/supportSession");
const PlatformAuditLog = require("../models/platformAuditLog");

// Friendlier names for common resource segments; anything not listed falls back
// to the de-pluralised segment, so this map only needs entries where that guess
// reads badly.
const RESOURCE_LABELS = {
  programs: "program",
  gofundme: "campaign",
  "support-tickets": "support ticket",
  donationtypes: "donation type",
  "payment-methods": "payment method",
  donors: "donor",
  pages: "page",
  events: "event",
  orders: "order",
  join: "volunteer application",
  partners: "partner",
  branding: "branding",
  settings: "settings",
  subscriptions: "subscription",
  "newsletter-campaigns": "newsletter campaign",
  newsletters: "newsletter subscriber",
  mailboxes: "mailbox",
};

const VERBS = { POST: "Created", PUT: "Updated", PATCH: "Updated", DELETE: "Deleted" };
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE = /(password|passcode|secret|token|cvv|cvc|card.?number|pan|otp|mfa|ssn|apikey|api.?key)/i;
const isId = (s) => /^[0-9a-f]{24}$/i.test(s) || /^\d+$/.test(s);

/** Human-readable label for a write, e.g. "Created program", "Deleted donor". */
function actionLabel(method, rawPath) {
  const path = String(rawPath || "").split("?")[0];
  let segs = path.split("/").filter(Boolean);
  if (segs[0] === "api") segs = segs.slice(1);
  if (segs[0] === "admin") segs = segs.slice(1);
  const resourceKey = segs[0] || "resource";
  const human = RESOURCE_LABELS[resourceKey] || resourceKey.replace(/-/g, " ").replace(/s$/, "");
  // A sub-action is a trailing non-id segment that sits AFTER a resource id
  // (e.g. /programs/:id/donate → "donate · program"). A lone trailing param
  // (/support-tickets/:idOrCode) is the record itself, not a sub-action — so
  // slug/code-keyed routes still read as "Updated …".
  const rest = segs.slice(1);
  const last = rest[rest.length - 1];
  if (rest.length >= 2 && last && !isId(last)) {
    return `${last.replace(/-/g, " ")} · ${human}`;
  }
  return `${(VERBS[method] || method)} ${human}`;
}

/** Strip secrets / truncate big values so the audit "what changed" is safe to store. */
function sanitizeBody(body, depth = 0) {
  if (body == null) return body;
  if (typeof body === "string") return body.length > 500 ? body.slice(0, 500) + "…" : body;
  if (typeof body !== "object") return body;
  if (depth > 4) return "[…]";
  if (Array.isArray(body)) return body.slice(0, 50).map((v) => sanitizeBody(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith("__")) continue;
    out[k] = SENSITIVE.test(k) ? "[redacted]" : sanitizeBody(v, depth + 1);
  }
  return out;
}

/**
 * Runs on EVERY tenant request (mounted right after tenantMiddleware). For a
 * normal token it's a no-op after a cheap JWT decode. For a platform-support
 * impersonation token it:
 *   1. looks the session up and rejects the moment it's not "active" — the real
 *      server-side kill switch for End session / Revoke / expiry,
 *   2. blocks all writes when the session is view-only,
 *   3. on a successful write, records a detailed PlatformAuditLog action.
 */
module.exports = async function supportSession(req, res, next) {
  let claims;
  try {
    const token = (req.header("Authorization") || "").replace("Bearer ", "");
    if (!token) return next();
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(); // not our concern — let per-route auth deal with bad/expired tokens
  }
  if (!claims || !claims.support_session || !claims.sessionId) return next();

  let session;
  try {
    session = await SupportSession.findOne({ sessionId: claims.sessionId });
  } catch (err) {
    console.error("supportSession lookup failed:", err.message);
    return res.status(503).json({ error: "Could not verify support session" });
  }

  if (!session) return res.status(401).json({ error: "Support session ended" });

  // Lazily flip an active-but-past-expiry row to expired (the JWT itself also
  // expires in 1h, but this keeps the record honest if it lingers).
  if (session.status === "active" && session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    session.status = "expired";
    session.save().catch(() => {});
  }
  if (session.status !== "active") {
    return res.status(401).json({ error: "Support session ended" });
  }

  req.support = {
    sessionId: session.sessionId,
    impersonatorId: session.impersonatorId,
    impersonatedBy: session.impersonatorEmail,
    actingAs: session.targetEmail,
    mode: session.mode,
    access: session.access,
    ticketId: session.ticketId,
    organisationId: session.organisationId,
  };

  const mutating = MUTATING.has(req.method);

  if (session.access === "view_only" && mutating) {
    return res.status(403).json({
      error: "View-only support session — changes are disabled",
      code: "VIEW_ONLY",
    });
  }

  if (mutating) {
    res.on("finish", () => {
      if (res.statusCode >= 400) return; // only record actions that actually took effect
      PlatformAuditLog.create({
        actorId: session.impersonatorId || null,
        actorEmail: session.impersonatorEmail || "",
        action: "support.action",
        organisationId: session.organisationId || null,
        targetType: "support_action",
        targetId: session.sessionId,
        meta: {
          sessionId: session.sessionId,
          method: req.method,
          path: (req.originalUrl || "").split("?")[0],
          status: res.statusCode,
          label: actionLabel(req.method, req.originalUrl),
          actingAs: session.targetEmail,
          changes: sanitizeBody(req.body),
        },
        ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "",
        userAgent: req.headers["user-agent"] || "",
      }).catch((e) => console.error("support action audit failed:", e.message));
      SupportSession.updateOne({ _id: session._id }, { $inc: { actionCount: 1 } }).catch(() => {});
    });
  }

  next();
};

module.exports.actionLabel = actionLabel;
module.exports.sanitizeBody = sanitizeBody;
