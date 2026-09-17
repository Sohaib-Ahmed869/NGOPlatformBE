/**
 * Who is performing an operator action, for the records that name a person
 * inline (a lead's stage history, a thread entry) rather than via the audit log.
 *
 * Console requests carry a User; integration requests (middleware/integrationAuth.js)
 * carry no User, so they are labelled "integration:<key> (<x-actor-email>)" —
 * the same label writeAudit() records — instead of an empty name.
 *
 * @param {object} req
 * @returns {{ id: import("mongoose").Types.ObjectId|null, name: string }}
 */
function actorOf(req) {
  return {
    id: req?.user?._id || null,
    name: req?.user?.name || req?.user?.email || req?.integration?.actorLabel || "",
  };
}

module.exports = { actorOf };
