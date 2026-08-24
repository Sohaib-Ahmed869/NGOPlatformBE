/**
 * A ceiling for "give me everything" endpoints.
 *
 * Export and no-pagination handlers were issuing `find(filter).sort(...)` with
 * no limit at all. Three things go wrong as a tenant's data grows, and all three
 * arrive at once:
 *
 *  1. A sort that isn't fully served by an index becomes a blocking in-memory
 *     sort, capped at 32MB. Past that MongoDB spills to disk and a millisecond
 *     query turns into a multi-second one under heavy I/O.
 *  2. Every matched document is materialised in Node's heap, plus whatever
 *     populate() pulls in alongside it.
 *  3. The whole result is serialised into one JSON or CSV response.
 *
 * A cap turns an unbounded failure into a bounded, *visible* one: the caller
 * still gets data, and is told plainly that it was cut short.
 *
 * Truncation is signalled with response HEADERS rather than a changed body, so
 * handlers returning a bare array keep their existing shape and no client
 * breaks. Handlers that already return an object envelope can additionally
 * surface the flag in the body.
 */
const EXPORT_MAX_ROWS = Math.max(1, Number(process.env.EXPORT_MAX_ROWS) || 50000);

/**
 * Run a Mongoose query with the export ceiling applied.
 *
 * Fetches one row beyond the cap purely to detect that more exist — that extra
 * row is dropped before returning, so callers always see at most the cap.
 *
 * @param {import("mongoose").Query} query  a query that has NOT had .limit() applied
 * @param {import("express").Response} [res] when given, truncation headers are set
 * @returns {Promise<{rows: any[], truncated: boolean, limit: number}>}
 */
async function runCappedExport(query, res) {
  const rows = await query.limit(EXPORT_MAX_ROWS + 1);
  const truncated = rows.length > EXPORT_MAX_ROWS;
  if (truncated) rows.length = EXPORT_MAX_ROWS;

  if (res && typeof res.setHeader === "function") {
    res.setHeader("X-Export-Limit", String(EXPORT_MAX_ROWS));
    res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
    if (truncated) {
      // Surfaced so a UI can say "showing the first 50,000 of more" instead of
      // presenting a partial file as if it were complete.
      res.setHeader("X-Export-Count", String(EXPORT_MAX_ROWS));
    }
  }
  return { rows, truncated, limit: EXPORT_MAX_ROWS };
}

/** RFC 4180 field escaping — quotes doubled, and quoted when it must be. */
function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows + headers to a CSV body. Prefixed with a BOM so Excel reads UTF-8. */
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

module.exports = { EXPORT_MAX_ROWS, runCappedExport, csvCell, toCsv };
