/**
 * middleware/emailAttachments.js
 *
 * File uploads for a MANUALLY triggered email — the composer in the email
 * console, where an operator types a recipient, fills in the variables and
 * attaches a document.
 *
 * These files are held in MEMORY and never written anywhere. That is a
 * deliberate departure from every other upload in this codebase, which goes to
 * S3 via config/s3.js: those objects are served `inline` from a public bucket,
 * so parking a donor's receipt, a grant letter or a signed agreement there
 * would leave it readable at a guessable URL forever. A manual attachment is
 * addressed to one person and has no reason to outlive the send, so it goes
 * straight from the request into the SMTP envelope and is then garbage.
 *
 * The consequence, which the console says out loud: the send log records that
 * N files went with an email and their names, but cannot offer them back.
 */
const path = require("path");
const multer = require("multer");

// Providers commonly bounce anything over ~25MB total once base64 encoding has
// inflated it by a third, so the real ceiling is lower than it looks: 20MB of
// payload is roughly 27MB on the wire. These are the numbers the UI shows.
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * What may be attached, by extension, with the MIME type we will DECLARE for it.
 *
 * The declared type comes from the extension rather than from the browser's
 * claim, for the same reason config/s3.js resolves it that way: a file the
 * client labels `application/octet-stream` arrives as a nameless blob in the
 * recipient's client. Executables, archives and scripts are absent on purpose —
 * they are what mail filters quarantine, and an email nobody receives is worse
 * than one that was never offered.
 */
const ALLOWED = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".ics": "text/calendar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const ALLOWED_LABEL = Object.keys(ALLOWED)
  .map((e) => e.slice(1).toUpperCase())
  .filter((e, i, all) => all.indexOf(e) === i)
  .join(", ");

const extOf = (name) => path.extname(String(name || "")).toLowerCase();

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 40 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED[extOf(file.originalname)]) {
      return cb(new Error(`"${file.originalname}" isn't an allowed attachment type. Allowed: ${ALLOWED_LABEL}`));
    }
    cb(null, true);
  },
}).array("attachments", MAX_FILES);

/**
 * Run the uploader and turn multer's own failures into a 400 with a sentence an
 * operator can act on. Multer surfaces size and count violations as errors on
 * the `next()` path, where the generic handler would report them as a 500 —
 * "something went wrong" for what is really "that file is too big".
 */
function emailAttachmentUpload(req, res, next) {
  uploader(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `Each attachment must be under ${MAX_FILE_BYTES / 1024 / 1024}MB.` });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: `You can attach at most ${MAX_FILES} files.` });
    }
    return res.status(400).json({ error: err.message || "Those attachments couldn't be read." });
  });
}

/**
 * Map multer's in-memory files onto nodemailer attachments.
 *
 * Returns `{ error }` rather than throwing, so the controller answers with a
 * 400 instead of a stack trace. The total is checked HERE and not by multer,
 * which only bounds each file individually — five 9MB PDFs pass every one of
 * its limits and then bounce at the provider.
 */
function toMailAttachments(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { attachments: [], summary: [] };

  const total = list.reduce((sum, f) => sum + (f.size || 0), 0);
  if (total > MAX_TOTAL_BYTES) {
    return { error: `Attachments come to ${(total / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_TOTAL_BYTES / 1024 / 1024}MB in total.` };
  }

  const attachments = list.map((f) => ({
    // Windows clients send a full path as the name; only the leaf is a filename.
    filename: path.basename(String(f.originalname || "attachment")).slice(0, 200),
    content: f.buffer,
    contentType: ALLOWED[extOf(f.originalname)] || "application/octet-stream",
  }));

  return {
    attachments,
    // Names + sizes for the audit row and the send log. The bytes are gone the
    // moment the response is written, so this is all that survives.
    summary: attachments.map((a, i) => ({ name: a.filename, size: list[i].size || 0 })),
  };
}

module.exports = {
  emailAttachmentUpload,
  toMailAttachments,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  ALLOWED_EXTENSIONS: Object.keys(ALLOWED),
};
