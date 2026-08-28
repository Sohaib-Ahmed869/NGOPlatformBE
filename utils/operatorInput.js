/**
 * Input handling shared by the SuperAdmin (platform operator) API.
 *
 * The console is authenticated and trusted, but "trusted" is not the same as
 * "correct": the failure mode here isn't an attacker, it's an operator typing
 * `abc` into a price field or a screen sending `""` for a limit. Before this
 * module the controllers coerced with `Number(v) || 0`, which turned a typo
 * into a FREE plan, and passed raw ids/filter values straight into Mongo, which
 * turned a malformed id into a 500 and `?plan[$ne]=null` into "every tenant".
 *
 * Every helper here is total: it either returns a clean value or an
 * {error} object the caller turns into a 400. Nothing throws.
 */
const mongoose = require("mongoose");

/** Reject query values that arrive as objects/arrays — `?plan[$ne]=null`. */
const isScalar = (v) => v === null || v === undefined || (typeof v !== "object" && typeof v !== "function");

/**
 * A query-string filter value, forced to a plain string.
 * Express's extended query parser turns `?plan[$ne]=null` into an object, which
 * Mongo happily treats as an operator. Anything non-scalar becomes "" so the
 * filter matches nothing instead of everything.
 */
function filterValue(v) {
  if (!isScalar(v)) return "";
  return v === null || v === undefined ? "" : String(v);
}

/**
 * A query-string filter that must be a plain scalar, reported rather than
 * silently dropped. Ignoring `?plan[$ne]=null` keeps it out of Mongo but then
 * answers with EVERY row, which reads as "the filter matched everything".
 * @returns {{error:string}|{value:string}}
 */
function scalarFilter(v, label) {
  if (v === undefined || v === null) return { value: "" };
  if (!isScalar(v)) return { error: `That ${label} filter is not valid` };
  return { value: String(v) };
}

/** Regex metacharacters escaped so a literal search stays literal. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A case-insensitive literal-match regex for a user-typed search term. */
function searchRegex(raw) {
  const term = filterValue(raw).trim();
  if (!term) return null;
  return { $regex: escapeRegex(term), $options: "i" };
}

/** page/limit with sane clamping — never NaN, never negative, never unbounded. */
function paging(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(filterValue(query.page), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(filterValue(query.limit), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * A Mongo sort spec built from a column the client asked for.
 *
 * The client sends a COLUMN NAME, never a field path — `?sort=name&dir=asc`.
 * The caller supplies the map from column names to the paths they mean, and
 * anything not in that map falls back to the default. That whitelist is the
 * whole point: passing `req.query.sort` into `.sort()` would let a caller sort
 * by any field in the document, including ones with no index (a collection
 * scan on demand) and ones the projection deliberately withholds — sorting by
 * a hidden field leaks its ordering even when the value never ships.
 *
 * A column may map to several paths, so "contact" can mean
 * `["contactName", "contactEmail"]` and sort sensibly when the first is blank.
 *
 * `tiebreak` is not decoration. Skip/limit paging over a non-unique sort key
 * is unstable: two rows with the same `status` have no defined order, so the
 * same document can appear on page 1 and again on page 2 while another is
 * never shown at all. Appending a unique field makes the total order
 * deterministic, which is what makes paging trustworthy.
 *
 * @param query    req.query
 * @param allowed  { columnName: "path" | ["path", …] }
 * @returns {{ sort: object, key: string, dir: "asc"|"desc" }}
 */
function sorting(query = {}, allowed = {}, { defaultKey, defaultDir = "desc", tiebreak = "_id" } = {}) {
  const asked = filterValue(query.sort);
  const key = Object.prototype.hasOwnProperty.call(allowed, asked) ? asked : defaultKey;

  const askedDir = filterValue(query.dir);
  const dir = askedDir === "asc" ? 1 : askedDir === "desc" ? -1 : defaultDir === "asc" ? 1 : -1;

  const sort = {};
  for (const path of [].concat(allowed[key] || [])) sort[path] = dir;
  if (tiebreak && !(tiebreak in sort)) sort[tiebreak] = -1;

  return { sort, key: key || null, dir: dir === 1 ? "asc" : "desc" };
}

/** True for a string Mongo can cast to an ObjectId. */
const isObjectId = (v) => typeof v === "string" && mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === v;

/**
 * An ObjectId from a route param or body field.
 * @returns {{error:string}|{value:string}}
 */
function objectId(v, label = "id") {
  if (!isScalar(v) || !String(v || "").trim()) return { error: `${label} is required` };
  const s = String(v).trim();
  if (!isObjectId(s)) return { error: `That ${label} is not valid` };
  return { value: s };
}

/**
 * A number with real bounds. `Number(v) || 0` is the bug this replaces: it
 * silently converts "abc" and "" to 0, which on a price field publishes a
 * paid plan as free.
 * @returns {{error:string}|{value:number|null}}
 */
function number(v, label, { min = 0, max = Number.MAX_SAFE_INTEGER, allowNull = false, integer = false, decimals = null } = {}) {
  if (v === "" || v === null || v === undefined) {
    if (allowNull) return { value: null };
    return { error: `${label} is required` };
  }
  if (!isScalar(v)) return { error: `${label} must be a number` };
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (integer && !Number.isInteger(n)) return { error: `${label} must be a whole number` };
  if (n < min) return { error: `${label} cannot be less than ${min}` };
  if (n > max) return { error: `${label} cannot be more than ${max.toLocaleString()}` };
  if (decimals !== null) {
    const factor = 10 ** decimals;
    if (Math.round(n * factor) !== n * factor) {
      return { error: decimals === 2 ? `${label} cannot have fractions of a cent` : `${label} allows at most ${decimals} decimal places` };
    }
  }
  return { value: n };
}

/**
 * A trimmed string with a hard length cap. Unbounded text is not a cosmetic
 * problem: a 20 000-character plan name saves here and then permanently breaks
 * the Stripe product sync, which caps names at 5 000.
 * @returns {{error:string}|{value:string}}
 */
function text(v, label, { max = 500, required = false, allowEmpty = !required } = {}) {
  if (v === undefined || v === null) {
    if (required) return { error: `${label} is required` };
    return { value: "" };
  }
  if (!isScalar(v)) return { error: `${label} must be text` };
  const s = String(v).trim();
  if (!s && !allowEmpty) return { error: `${label} is required` };
  if (s.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { value: s };
}

/** One of a fixed set. @returns {{error:string}|{value:string}} */
function oneOf(v, label, allowed, { required = true } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) return { error: `${label} is required` };
    return { value: undefined };
  }
  if (!isScalar(v)) return { error: `${label} is not valid` };
  const s = String(v);
  if (!allowed.includes(s)) return { error: `${label} must be one of: ${allowed.join(", ")}` };
  return { value: s };
}

/**
 * A date, rejecting both garbage and the values Mongoose would choke on.
 * `new Date("nonsense")` is an Invalid Date, which reaches the driver and comes
 * back as a 500 rather than a validation message.
 * @returns {{error:string}|{value:Date|null}}
 */
function date(v, label, { allowNull = true, future = false, past = true } = {}) {
  if (v === "" || v === null || v === undefined) {
    if (allowNull) return { value: null };
    return { error: `${label} is required` };
  }
  if (!isScalar(v)) return { error: `${label} is not a valid date` };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { error: `${label} is not a valid date` };
  // Guard the ±100-year band; beyond that the value is a typo, not an intent.
  const YEAR = 365.25 * 24 * 3600 * 1000;
  if (Math.abs(d.getTime() - Date.now()) > 100 * YEAR) return { error: `${label} is out of range` };
  if (future && d.getTime() < Date.now() - 24 * 3600 * 1000) return { error: `${label} cannot be in the past` };
  if (!past && d.getTime() > Date.now()) return { error: `${label} cannot be in the future` };
  return { value: d };
}

/** An array of non-empty trimmed strings. @returns {{error:string}|{value:string[]}} */
function stringList(v, label, { max = 50, maxLength = 200, required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) return { error: `${label} is required` };
    return { value: [] };
  }
  if (!Array.isArray(v)) return { error: `${label} must be a list` };
  if (v.length > max) return { error: `${label} is limited to ${max} entries` };
  const out = [];
  for (const item of v) {
    if (!isScalar(item)) return { error: `${label} contains an entry that isn't text` };
    const s = String(item ?? "").trim();
    if (s) out.push(s.slice(0, maxLength));
  }
  return { value: out };
}

/**
 * Runs a set of field checks and returns the first error, or the clean values.
 * Usage:
 *   const v = collect({ name: text(b.name, "Name", {required:true}) });
 *   if (v.error) return res.status(400).json({ error: v.error });
 *   v.values.name
 */
function collect(fields) {
  const values = {};
  for (const [key, result] of Object.entries(fields)) {
    if (result && result.error) return { error: result.error, field: key };
    values[key] = result ? result.value : undefined;
  }
  return { values };
}

/**
 * True when a Mongo write failed the unique index. Two operators saving the
 * same new plan code milliseconds apart both clear the "does this exist?" read,
 * and the loser used to surface as a 500.
 */
const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

/**
 * Express middleware: reject a malformed :param before it reaches Mongo.
 * Every operator route that takes an id used to answer 500 for `/organisations/abc`
 * because the CastError escaped the controller's try/catch as a generic failure.
 */
const requireObjectId = (param = "id", label = "id") => (req, res, next) => {
  const r = objectId(req.params[param], label);
  if (r.error) return res.status(400).json({ error: r.error });
  next();
};

module.exports = {
  isScalar,
  filterValue,
  scalarFilter,
  escapeRegex,
  searchRegex,
  paging,
  sorting,
  isObjectId,
  objectId,
  number,
  text,
  oneOf,
  date,
  stringList,
  collect,
  isDuplicateKey,
  requireObjectId,
};
