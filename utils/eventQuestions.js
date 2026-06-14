// utils/eventQuestions.js
//
// Helpers for an event's custom registration questions (the "dynamic" part).
// Shared by the admin controller (normalising questions on save) and the public
// controller (validating a registrant's answers against those questions).

const VALID_TYPES = ["text", "textarea", "select", "checkbox", "number", "email", "phone"];

/** Turn a human label into a stable, URL-safe key (e.g. "T-Shirt Size" -> "t_shirt_size"). */
function slugifyKey(label) {
  return String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

/**
 * Sanitise an incoming questions array (from the admin form). Accepts a JSON
 * string or an array. Guarantees a unique, non-empty `key` for every question
 * and drops anything malformed.
 */
function normalizeQuestions(input) {
  let arr = input;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch (_) {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];

  const used = new Set();
  const out = [];
  arr.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const label = String(q.label || "").trim();
    if (!label) return;

    const type = VALID_TYPES.includes(q.type) ? q.type : "text";

    // Stable key: prefer the provided key, else derive from the label; ensure unique.
    let key = slugifyKey(q.key || label) || `q_${i + 1}`;
    while (used.has(key)) key = `${key}_${i + 1}`;
    used.add(key);

    const options = Array.isArray(q.options)
      ? q.options.map((o) => String(o).trim()).filter(Boolean)
      : [];

    out.push({
      key,
      label,
      type,
      required: !!q.required,
      options: type === "select" || type === "checkbox" ? options : [],
      help: q.help ? String(q.help).trim() : "",
    });
  });
  return out;
}

/**
 * Validate a registrant's answers against the event's questions.
 * Returns { ok: true, answers } with a cleaned answers object keyed by question
 * key, or { ok: false, error } describing the first problem.
 */
function validateAnswers(questions, rawAnswers) {
  const questionList = Array.isArray(questions) ? questions : [];
  const answers = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const cleaned = {};

  for (const q of questionList) {
    const val = answers[q.key];
    const isEmpty =
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "") ||
      (Array.isArray(val) && val.length === 0);

    if (isEmpty) {
      if (q.required) {
        return { ok: false, error: `"${q.label}" is required` };
      }
      continue;
    }

    if (q.type === "select" && q.options.length && !q.options.includes(val)) {
      return { ok: false, error: `Invalid option for "${q.label}"` };
    }
    if (q.type === "checkbox" && q.options.length) {
      const picked = Array.isArray(val) ? val : [val];
      const bad = picked.find((p) => !q.options.includes(p));
      if (bad) return { ok: false, error: `Invalid option for "${q.label}"` };
      cleaned[q.key] = picked;
      continue;
    }
    if (q.type === "number" && isNaN(Number(val))) {
      return { ok: false, error: `"${q.label}" must be a number` };
    }

    cleaned[q.key] = q.type === "number" ? Number(val) : val;
  }

  return { ok: true, answers: cleaned };
}

module.exports = { VALID_TYPES, slugifyKey, normalizeQuestions, validateAnswers };
