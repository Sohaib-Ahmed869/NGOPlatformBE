const Lead = require("../models/lead");
const CrmTask = require("../models/crmTask");
const input = require("../utils/operatorInput");

/**
 * The CRM's front page: what the pipeline is worth, what is stalling, and what
 * the signed-in operator owes today.
 *
 * One endpoint rather than the six the screen would otherwise make, because the
 * whole value of an overview is that its numbers agree with each other. Six
 * independent requests answer from six different instants, and a screen where
 * "12 leads need attention" sits beside a list of eleven is a screen nobody
 * trusts twice.
 */

const OPEN_STATUSES = CrmTask.STATUSES.filter((s) => !CrmTask.TERMINAL_STATUSES.includes(s));
const ACTIVE_STAGES = Lead.STAGES.filter((s) => s !== "won" && s !== "lost");

/** Leads with no follow-up scheduled are only interesting if they're still live. */
const ACTIVE_LEAD_MATCH = { stage: { $in: ACTIVE_STAGES }, flaggedSpam: { $ne: true } };

/**
 * How long a live lead may sit untouched before it counts as going quiet.
 * Fourteen days is a fortnight of silence — long enough not to nag about a
 * lead contacted last Tuesday, short enough that a deal cannot rot for a month
 * without anybody being told.
 */
const STALE_DAYS = 14;

/** The operator's local day, as UTC instants — see crmTaskController. */
function localDayBounds(offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  const shifted = new Date(Date.now() - off * 60000);
  const midnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = new Date(midnightAsUtc + off * 60000);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

const tzOffsetOf = (query) => {
  const n = parseInt(input.filterValue(query?.tzOffset), 10);
  return Number.isFinite(n) && Math.abs(n) <= 840 ? n : 0;
};

/** Fields every lead card on this screen renders. */
const LEAD_CARD = "orgName contactName contactEmail stage dealValue currency priority tags assignee lastMessageAt expectedCloseAt createdAt";

const leadCardProjection = (extra = {}) => ({
  ...LEAD_CARD.split(" ").reduce((p, f) => ({ ...p, [f]: 1 }), {}),
  ...extra,
});

/**
 * The same card, plus the two counts that explain why the lead is on the list.
 *
 * The `attention` facets used to emit whole lead documents: an unprojected
 * `$facet` branch inherits every field, so eight rows carried `stageHistory`,
 * the whole message `thread`, the anti-spam fields and the submitter's IP —
 * none of which the screen renders, and the last of which has no business
 * being on an overview at all.
 */
const ATTENTION_CARD = leadCardProjection({ openCount: 1, overdueCount: 1 });

/** GET /api/superadmin/crm/overview */
exports.overview = async (req, res) => {
  try {
    const now = new Date();
    const { start, end } = localDayBounds(tzOffsetOf(req.query));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const staleBefore = new Date(now.getTime() - STALE_DAYS * 24 * 3600 * 1000);
    const me = req.user._id;

    // ── Leads: one pass, several questions ────────────────────────────────
    const [leadFacets] = await Lead.aggregate([
      { $match: { flaggedSpam: { $ne: true } } },
      {
        $facet: {
          byStage: [
            { $group: { _id: "$stage", count: { $sum: 1 }, value: { $sum: { $ifNull: ["$dealValue", 0] } } } },
          ],
          newThisMonth: [{ $match: { createdAt: { $gte: monthStart } } }, { $count: "n" }],
          wonThisMonth: [
            { $match: { stage: "won", convertedAt: { $gte: monthStart } } },
            { $group: { _id: null, n: { $sum: 1 }, value: { $sum: { $ifNull: ["$dealValue", 0] } } } },
          ],
          lostThisMonth: [{ $match: { stage: "lost", lostAt: { $gte: monthStart } } }, { $count: "n" }],
          untriaged: [{ $match: { stage: "new" } }, { $count: "n" }],
          unassigned: [{ $match: { ...ACTIVE_LEAD_MATCH, "assignee.userId": null } }, { $count: "n" }],
          // Closing soon, so the forecast has something behind it.
          closingSoon: [
            {
              $match: {
                ...ACTIVE_LEAD_MATCH,
                expectedCloseAt: { $ne: null, $lte: new Date(now.getTime() + 30 * 24 * 3600 * 1000) },
              },
            },
            { $sort: { expectedCloseAt: 1 } },
            { $limit: 6 },
            { $project: LEAD_CARD.split(" ").reduce((p, f) => ({ ...p, [f]: 1 }), {}) },
          ],
          // Biggest live deals, which is what a forecast conversation opens on.
          topDeals: [
            { $match: { ...ACTIVE_LEAD_MATCH, dealValue: { $gt: 0 } } },
            { $sort: { dealValue: -1 } },
            { $limit: 6 },
            { $project: LEAD_CARD.split(" ").reduce((p, f) => ({ ...p, [f]: 1 }), {}) },
          ],
          recent: [
            { $sort: { createdAt: -1 } },
            { $limit: 6 },
            { $project: LEAD_CARD.split(" ").reduce((p, f) => ({ ...p, [f]: 1 }), {}) },
          ],
        },
      },
    ]);

    const one = (k) => leadFacets?.[k]?.[0]?.n || 0;
    const byStage = Object.fromEntries(
      (leadFacets?.byStage || []).map((r) => [r._id, { count: r.count, value: r.value }]),
    );

    // ── Tasks ─────────────────────────────────────────────────────────────
    const openMatch = { status: { $in: OPEN_STATUSES } };
    const [taskFacets] = await CrmTask.aggregate([
      {
        $facet: {
          open: [{ $match: openMatch }, { $count: "n" }],
          overdue: [{ $match: { ...openMatch, dueAt: { $ne: null, $lt: now } } }, { $count: "n" }],
          dueToday: [{ $match: { ...openMatch, dueAt: { $gte: start, $lt: end } } }, { $count: "n" }],
          completedWeek: [
            { $match: { status: "done", completedAt: { $gte: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } } },
            { $count: "n" },
          ],
          mineOpen: [{ $match: { ...openMatch, "assignee.userId": me } }, { $count: "n" }],
          // What the operator personally owes before the day is out — the list
          // the screen actually opens on.
          myDay: [
            { $match: { ...openMatch, "assignee.userId": me, dueAt: { $ne: null, $lt: end } } },
            { $sort: { dueAt: 1 } },
            { $limit: 8 },
            {
              $lookup: {
                from: "leads",
                let: { lid: "$lead" },
                pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$lid"] } } }, { $project: { orgName: 1 } }],
                as: "leadRef",
              },
            },
            {
              $addFields: { leadRef: { $arrayElemAt: ["$leadRef", 0] } },
            },
            { $project: { title: 1, type: 1, priority: 1, status: 1, dueAt: 1, leadRef: 1 } },
          ],
          // Who is carrying what, so an overloaded operator is visible.
          byAssignee: [
            { $match: { ...openMatch, "assignee.userId": { $ne: null } } },
            {
              $group: {
                _id: "$assignee.userId",
                name: { $first: "$assignee.name" },
                open: { $sum: 1 },
                overdue: { $sum: { $cond: [{ $and: [{ $ne: ["$dueAt", null] }, { $lt: ["$dueAt", now] }] }, 1, 0] } },
              },
            },
            { $sort: { open: -1 } },
            { $limit: 8 },
          ],
        },
      },
    ]);
    const taskOne = (k) => taskFacets?.[k]?.[0]?.n || 0;

    // ── Leads needing attention ───────────────────────────────────────────
    // Three distinct failures, and they are NOT the same list: a lead with an
    // overdue task has been forgotten by someone; a lead with no task at all
    // was never picked up; a quiet lead may have both a task and an owner and
    // still be dying. Reported separately so the fix for each is obvious.
    const [attention] = await Lead.aggregate([
      { $match: ACTIVE_LEAD_MATCH },
      {
        $lookup: {
          from: "crmtasks",
          let: { lid: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$lead", "$$lid"] }, { $in: ["$status", OPEN_STATUSES] }] } } },
            { $project: { dueAt: 1 } },
          ],
          as: "openTasks",
        },
      },
      {
        $addFields: {
          openCount: { $size: "$openTasks" },
          overdueCount: {
            $size: {
              $filter: {
                input: "$openTasks",
                as: "t",
                cond: { $and: [{ $ne: ["$$t.dueAt", null] }, { $lt: ["$$t.dueAt", now] }] },
              },
            },
          },
        },
      },
      { $project: { openTasks: 0 } },
      {
        $facet: {
          overdue: [
            { $match: { overdueCount: { $gt: 0 } } },
            { $sort: { overdueCount: -1, lastMessageAt: 1 } },
            { $limit: 8 },
            { $project: ATTENTION_CARD },
          ],
          noFollowUp: [
            { $match: { openCount: 0 } },
            { $sort: { lastMessageAt: -1 } },
            { $limit: 8 },
            { $project: ATTENTION_CARD },
          ],
          stale: [
            { $match: { openCount: 0, lastMessageAt: { $lt: staleBefore } } },
            { $sort: { lastMessageAt: 1 } },
            { $limit: 8 },
            { $project: ATTENTION_CARD },
          ],
          counts: [
            {
              $group: {
                _id: null,
                overdue: { $sum: { $cond: [{ $gt: ["$overdueCount", 0] }, 1, 0] } },
                noFollowUp: { $sum: { $cond: [{ $eq: ["$openCount", 0] }, 1, 0] } },
                stale: {
                  $sum: {
                    $cond: [{ $and: [{ $eq: ["$openCount", 0] }, { $lt: ["$lastMessageAt", staleBefore] }] }, 1, 0],
                  },
                },
              },
            },
          ],
        },
      },
    ]);

    const attentionCounts = attention?.counts?.[0] || { overdue: 0, noFollowUp: 0, stale: 0 };
    const openLeads = ACTIVE_STAGES.reduce((n, s) => n + (byStage[s]?.count || 0), 0);
    const pipelineValue = ACTIVE_STAGES.reduce((n, s) => n + (byStage[s]?.value || 0), 0);

    res.json({
      overview: {
        pipeline: {
          // Every stage present, in order, including the empty ones — a funnel
          // that silently omits "Demo scheduled" because nobody is in it reads
          // as a funnel without that step.
          stages: Lead.STAGES.map((s) => ({
            stage: s,
            count: byStage[s]?.count || 0,
            value: byStage[s]?.value || 0,
          })),
          openLeads,
          pipelineValue,
          untriaged: one("untriaged"),
          unassigned: one("unassigned"),
          newThisMonth: one("newThisMonth"),
          wonThisMonth: leadFacets?.wonThisMonth?.[0]?.n || 0,
          wonValueThisMonth: leadFacets?.wonThisMonth?.[0]?.value || 0,
          lostThisMonth: one("lostThisMonth"),
        },
        tasks: {
          open: taskOne("open"),
          overdue: taskOne("overdue"),
          dueToday: taskOne("dueToday"),
          completedWeek: taskOne("completedWeek"),
          mineOpen: taskOne("mineOpen"),
          myDay: taskFacets?.myDay || [],
          byAssignee: taskFacets?.byAssignee || [],
        },
        attention: {
          counts: {
            overdue: attentionCounts.overdue || 0,
            noFollowUp: attentionCounts.noFollowUp || 0,
            stale: attentionCounts.stale || 0,
          },
          overdue: attention?.overdue || [],
          noFollowUp: attention?.noFollowUp || [],
          stale: attention?.stale || [],
          staleDays: STALE_DAYS,
        },
        deals: {
          top: leadFacets?.topDeals || [],
          closingSoon: leadFacets?.closingSoon || [],
        },
        recentLeads: leadFacets?.recent || [],
        generatedAt: now,
      },
    });
  } catch (err) {
    console.error("CRM overview error:", err);
    res.status(500).json({ error: "Failed to build the CRM overview" });
  }
};
