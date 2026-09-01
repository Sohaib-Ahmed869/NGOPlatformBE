const mongoose = require("mongoose");
const CrmTask = require("../models/crmTask");
const Lead = require("../models/lead");
const User = require("../models/user");
const input = require("../utils/operatorInput");
const writeAudit = require("../utils/writeAudit");
const { emitToSuperAdmins } = require("../services/socket");
const { sendTemplateEmail } = require("../services/emailUtil");
const { listAssignableStaff } = require("../utils/platformStaff");
const { platformConsoleUrl } = require("../utils/tenantUrls");

const { STATUSES, TERMINAL_STATUSES, TYPES, PRIORITIES } = CrmTask;
const OPEN_STATUSES = STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

/**
 * Stand-in due date for a task that has none, used only for ordering.
 *
 * Mongo sorts null BEFORE every date ascending, so "soonest first" would open
 * with every undated task — the exact rows the operator is not being asked
 * about. Substituting a far-future date pushes them to the end without needing
 * a second stored field to keep in sync. Far future rather than JS's maximum
 * date because the maximum is only representable by accident and formats as
 * nonsense anywhere it leaks.
 */
const NO_DUE_SENTINEL = new Date("9999-12-31T00:00:00.000Z");

/** Ascending urgency, so `$indexOfArray` yields a rank that sorts correctly. */
const PRIORITY_ORDER = ["low", "normal", "high", "urgent"];

/**
 * Sortable columns. `due` and `priority` name fields COMPUTED in the pipeline
 * below, not stored ones — see NO_DUE_SENTINEL and PRIORITY_ORDER for why
 * neither can be sorted on directly.
 */
const TASK_SORTS = {
  due: "dueSort",
  priority: "priorityRank",
  title: "title",
  status: "status",
  created: "createdAt",
  updated: "updatedAt",
};

/**
 * The operator's local day as a pair of UTC instants.
 *
 * "Due today" and "overdue" are questions about the wall clock in front of the
 * person asking, and this platform sells in Australia off servers that run in
 * UTC — a ten-hour gap during which a Sydney operator's "today" and the
 * server's disagree, every single day. The client sends its own
 * `Date.getTimezoneOffset()` and the boundary is computed from that; with no
 * offset supplied this degrades to UTC rather than guessing.
 *
 * @param offsetMinutes getTimezoneOffset() — minutes to ADD to local to get UTC
 */
function localDayBounds(offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  // Shift "now" so the local wall clock can be read off the UTC accessors.
  const shifted = new Date(Date.now() - off * 60000);
  const midnightAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = new Date(midnightAsUtc + off * 60000); // back to a real instant
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

const tzOffsetOf = (query) => {
  const n = parseInt(input.filterValue(query?.tzOffset), 10);
  // ±14h is the real-world span of UTC offsets; anything else is a broken client.
  return Number.isFinite(n) && Math.abs(n) <= 840 ? n : 0;
};

/** Build the Mongo filter for a task list/board/count request. */
function buildFilter(req) {
  const filter = {};

  const status = input.filterValue(req.query.status);
  if (status === "open") filter.status = { $in: OPEN_STATUSES };
  else if (status && status !== "all" && STATUSES.includes(status)) filter.status = status;

  const priority = input.filterValue(req.query.priority);
  if (priority && priority !== "all" && PRIORITIES.includes(priority)) filter.priority = priority;

  const type = input.filterValue(req.query.type);
  if (type && type !== "all" && TYPES.includes(type)) filter.type = type;

  const assignee = input.filterValue(req.query.assignee);
  if (assignee === "unassigned") filter["assignee.userId"] = null;
  else if (assignee === "me") filter["assignee.userId"] = req.user._id;
  else if (assignee && assignee !== "all" && input.isObjectId(assignee)) filter["assignee.userId"] = assignee;

  const lead = input.filterValue(req.query.lead);
  if (lead && input.isObjectId(lead)) filter.lead = lead;

  const org = input.filterValue(req.query.organisation);
  if (org && input.isObjectId(org)) filter.organisation = org;

  const tag = input.filterValue(req.query.tag);
  if (tag) filter.tags = tag;

  // Due windows. `overdue` also excludes finished work — a task closed late is
  // history, not something still owed, and counting it would leave the badge
  // permanently lit.
  const due = input.filterValue(req.query.due);
  if (due && due !== "all") {
    const { start, end } = localDayBounds(tzOffsetOf(req.query));
    if (due === "overdue") {
      filter.dueAt = { $ne: null, $lt: new Date() };
      filter.status = { $in: OPEN_STATUSES };
    } else if (due === "today") {
      filter.dueAt = { $gte: start, $lt: end };
    } else if (due === "week") {
      filter.dueAt = { $gte: start, $lt: new Date(start.getTime() + 7 * 24 * 3600 * 1000) };
    } else if (due === "none") {
      filter.dueAt = null;
    }
  }

  const rx = input.searchRegex(req.query.search);
  if (rx) filter.$or = [{ title: rx }, { tags: rx }];

  return filter;
}

/**
 * Pipeline stages shared by the list and the board: the two computed sort keys,
 * the two joins, and a projection that drops the heavy arrays.
 *
 * The joins use the `let`/`pipeline` form rather than `localField`/`foreignField`
 * so each one can `$project` before the documents are attached. That is not a
 * micro-optimisation: a plain `$lookup` on `users` pulls WHOLE user documents —
 * password hash, MFA secret, token version — into the pipeline, and the only
 * thing standing between those and the response is remembering to strip them
 * afterwards. Projecting inside the lookup means they are never fetched.
 */
function decorateStages() {
  return [
    {
      $addFields: {
        dueSort: { $ifNull: ["$dueAt", NO_DUE_SENTINEL] },
        priorityRank: { $indexOfArray: [PRIORITY_ORDER, "$priority"] },
      },
    },
    {
      $lookup: {
        from: "users",
        let: { uid: "$assignee.userId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$uid"] } } },
          { $project: { name: 1, email: 1, profileImage: 1 } },
        ],
        as: "assigneeUser",
      },
    },
    {
      $lookup: {
        from: "leads",
        let: { lid: "$lead" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$lid"] } } },
          { $project: { orgName: 1, contactName: 1, stage: 1 } },
        ],
        as: "leadRef",
      },
    },
    {
      $addFields: {
        assigneeUser: { $arrayElemAt: ["$assigneeUser", 0] },
        leadRef: { $arrayElemAt: ["$leadRef", 0] },
        // Progress, not the steps themselves — a 40-item checklist has no place
        // in a table row, but "3/8" does.
        checklistTotal: { $size: { $ifNull: ["$checklist", []] } },
        checklistDone: {
          $size: {
            $filter: { input: { $ifNull: ["$checklist", []] }, as: "c", cond: { $eq: ["$$c.done", true] } },
          },
        },
        commentCount: { $size: { $ifNull: ["$comments", []] } },
      },
    },
    // The heavy arrays and the two sort-only fields. dueSort and priorityRank
    // exist purely to make $sort work (see NO_DUE_SENTINEL) and would otherwise
    // ship to the client as two fields that look like data and aren't.
    { $project: { checklist: 0, comments: 0, events: 0, description: 0, dueSort: 0, priorityRank: 0 } },
  ];
}

/** GET /api/superadmin/tasks */
exports.list = async (req, res) => {
  try {
    const filter = buildFilter(req);
    const { page, limit, skip } = input.paging(req.query, { defaultLimit: 25, maxLimit: 100 });
    const { sort, key: sortKey, dir: sortDir } = input.sorting(req.query, TASK_SORTS, {
      defaultKey: "due",
      defaultDir: "asc",
    });

    const [rows, total] = await Promise.all([
      CrmTask.aggregate([
        { $match: filter },
        // Ahead of $sort: two of the sortable keys do not exist until here.
        ...decorateStages().slice(0, 1),
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        ...decorateStages().slice(1),
      ]),
      CrmTask.countDocuments(filter),
    ]);

    res.json({
      tasks: rows,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      sort: { key: sortKey, dir: sortDir },
    });
  } catch (err) {
    console.error("List tasks error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
};

/** GET /api/superadmin/tasks/board — grouped by status, for the kanban view */
exports.board = async (req, res) => {
  try {
    // The board ignores the status filter by definition — status IS the axis.
    const filter = buildFilter(req);
    delete filter.status;

    const rows = await CrmTask.aggregate([
      { $match: filter },
      ...decorateStages().slice(0, 1),
      { $sort: { dueSort: 1, _id: -1 } },
      // A board is a glance, not an archive. Cancelled work is excluded from
      // the columns entirely (it has its own list filter), and the cap keeps a
      // year of history from being shipped to draw five columns.
      { $match: { status: { $ne: "cancelled" } } },
      { $limit: 500 },
      ...decorateStages().slice(1),
    ]);

    const board = {};
    STATUSES.filter((s) => s !== "cancelled").forEach((s) => (board[s] = []));
    rows.forEach((t) => (board[t.status] || board.todo).push(t));
    res.json({ board });
  } catch (err) {
    console.error("Task board error:", err);
    res.status(500).json({ error: "Failed to fetch the task board" });
  }
};

/**
 * GET /api/superadmin/tasks/stats — the header tiles and the sidebar badge.
 *
 * One `$facet` rather than eight `countDocuments` calls: the collection is
 * scanned once and every tile is answered from the same instant, so the numbers
 * cannot disagree with each other the way independently-timed counts can.
 */
exports.stats = async (req, res) => {
  try {
    const { start, end } = localDayBounds(tzOffsetOf(req.query));
    const now = new Date();
    const weekAgo = new Date(start.getTime() - 7 * 24 * 3600 * 1000);
    const me = req.user._id;
    const openMatch = { status: { $in: OPEN_STATUSES } };

    const [facets] = await CrmTask.aggregate([
      {
        $facet: {
          open: [{ $match: openMatch }, { $count: "n" }],
          overdue: [{ $match: { ...openMatch, dueAt: { $ne: null, $lt: now } } }, { $count: "n" }],
          dueToday: [{ $match: { ...openMatch, dueAt: { $gte: start, $lt: end } } }, { $count: "n" }],
          dueWeek: [
            { $match: { ...openMatch, dueAt: { $gte: start, $lt: new Date(start.getTime() + 7 * 24 * 3600 * 1000) } } },
            { $count: "n" },
          ],
          unassigned: [{ $match: { ...openMatch, "assignee.userId": null } }, { $count: "n" }],
          completedWeek: [{ $match: { status: "done", completedAt: { $gte: weekAgo } } }, { $count: "n" }],
          mineOpen: [{ $match: { ...openMatch, "assignee.userId": me } }, { $count: "n" }],
          mineDue: [
            { $match: { ...openMatch, "assignee.userId": me, dueAt: { $ne: null, $lt: end } } },
            { $count: "n" },
          ],
          byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
          byPriority: [{ $match: openMatch }, { $group: { _id: "$priority", n: { $sum: 1 } } }],
        },
      },
    ]);

    const one = (k) => facets?.[k]?.[0]?.n || 0;
    const group = (k) => Object.fromEntries((facets?.[k] || []).map((r) => [r._id, r.n]));

    res.json({
      stats: {
        open: one("open"),
        overdue: one("overdue"),
        dueToday: one("dueToday"),
        dueWeek: one("dueWeek"),
        unassigned: one("unassigned"),
        completedWeek: one("completedWeek"),
        mineOpen: one("mineOpen"),
        // What the sidebar badge counts: MY work that is late or due before
        // the day is out. A team-wide number there would never reach zero.
        mineDue: one("mineDue"),
        byStatus: group("byStatus"),
        byPriority: group("byPriority"),
      },
    });
  } catch (err) {
    console.error("Task stats error:", err);
    res.status(500).json({ error: "Failed to fetch task stats" });
  }
};

/** GET /api/superadmin/tasks/staff — operators a task can be assigned to */
exports.getStaff = async (req, res) => {
  try {
    res.json({ staff: await listAssignableStaff("tenants") });
  } catch (err) {
    console.error("Get task staff error:", err);
    res.status(500).json({ error: "Failed to fetch staff" });
  }
};

/** GET /api/superadmin/tasks/:id */
exports.get = async (req, res) => {
  try {
    const task = await CrmTask.findById(req.params.id)
      .populate("assignee.userId", "name email profileImage")
      .populate("comments.author", "name email")
      .populate("lead", "orgName contactName contactEmail stage")
      .populate("organisation", "name slug");
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  } catch (err) {
    console.error("Get task error:", err);
    res.status(500).json({ error: "Failed to fetch task" });
  }
};

/** Re-read a task with everything the detail screen needs populated. */
const populated = (id) =>
  CrmTask.findById(id)
    .populate("assignee.userId", "name email profileImage")
    .populate("comments.author", "name email")
    .populate("lead", "orgName contactName contactEmail stage")
    .populate("organisation", "name slug");

const actorName = (req) => req.user?.name || req.user?.email || "";

/** Resolve an assignee id to the operator it names, or null for "unassigned". */
async function resolveAssignee(userId) {
  if (!userId) return { value: { userId: null, name: "", assignedAt: null } };
  if (!input.isObjectId(String(userId))) return { error: "That assignee is not valid" };
  const u = await User.findById(userId).select("name email role platformStatus");
  if (!u || u.role !== "superadmin") return { error: "That assignee is not a platform operator" };
  if (u.platformStatus === "suspended") return { error: "That operator's account is suspended" };
  return { value: { userId: u._id, name: u.name || u.email, assignedAt: new Date() }, user: u };
}

/**
 * Tell an operator that work has landed on their plate.
 *
 * Best-effort and never awaited into the response path's failure modes: a task
 * that saved but whose notification bounced is still a saved task, and failing
 * the request would tell the operator the opposite of what happened.
 */
async function notifyAssignee(task, assigneeUser, req) {
  if (!assigneeUser?.email) return;
  // Assigning yourself something is not news.
  if (String(assigneeUser._id) === String(req.user?._id)) return;
  try {
    await sendTemplateEmail("crm.taskAssigned", {
      to: assigneeUser.email,
      data: {
        recipient: { name: assigneeUser.name || "", email: assigneeUser.email },
        task: {
          title: task.title,
          type: task.type,
          priority: task.priority,
          dueAt: task.dueAt ? task.dueAt.toISOString() : "",
          url: platformConsoleUrl(`/tasks/${task._id}`),
        },
        lead: { orgName: task.lead?.orgName || "" },
        staff: { name: actorName(req) },
      },
      meta: { taskId: String(task._id) },
    });
  } catch (err) {
    console.error("[tasks] assignee notification failed:", err.message);
  }
}

/** POST /api/superadmin/tasks */
exports.create = async (req, res) => {
  try {
    const b = req.body || {};
    const v = input.collect({
      title: input.text(b.title, "Title", { max: 200, required: true, allowEmpty: false }),
      description: input.text(b.description, "Description", { max: 20000 }),
      type: input.oneOf(b.type, "Type", TYPES, { required: false }),
      priority: input.oneOf(b.priority, "Priority", PRIORITIES, { required: false }),
      status: input.oneOf(b.status, "Status", STATUSES, { required: false }),
      dueAt: input.date(b.dueAt, "Due date"),
      outcome: input.text(b.outcome, "Outcome", { max: 4000 }),
      tags: input.stringList(b.tags, "Tags", { max: 20, maxLength: 40 }),
      checklist: input.stringList(b.checklist, "Checklist", { max: 50, maxLength: 200 }),
    });
    if (v.error) return res.status(400).json({ error: v.error });

    const assigned = await resolveAssignee(b.assigneeUserId);
    if (assigned.error) return res.status(400).json({ error: assigned.error });

    // A task may name a lead, but only one that exists — a dangling reference
    // would render as a task about nothing on every screen that joins it.
    let lead = null;
    if (b.leadId) {
      const idc = input.objectId(b.leadId, "lead");
      if (idc.error) return res.status(400).json({ error: idc.error });
      lead = await Lead.findById(idc.value).select("_id orgName");
      if (!lead) return res.status(400).json({ error: "That lead no longer exists" });
    }

    const status = v.values.status || "todo";
    const closing = TERMINAL_STATUSES.includes(status);

    const task = await CrmTask.create({
      title: v.values.title,
      description: v.values.description || "",
      type: v.values.type || "todo",
      priority: v.values.priority || "normal",
      status,
      dueAt: v.values.dueAt,
      outcome: v.values.outcome || "",
      tags: v.values.tags,
      checklist: (v.values.checklist || []).map((text) => ({ text })),
      assignee: assigned.value,
      createdBy: { userId: req.user._id, name: actorName(req) },
      lead: lead?._id || null,
      // Logging a call that already happened is a create-as-done, so the
      // completion stamps have to be set here as well as on the status route.
      completedAt: closing ? new Date() : null,
      completedBy: closing ? req.user._id : null,
      events: [{ kind: "created", to: status, by: req.user._id, byName: actorName(req), at: new Date() }],
    });

    if (assigned.user) await notifyAssignee({ ...task.toObject(), lead }, assigned.user, req);

    await writeAudit(req, "task.created", {
      targetType: "task",
      targetId: String(task._id),
      meta: { leadId: lead ? String(lead._id) : undefined, status },
    });
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: lead ? String(lead._id) : null });

    res.status(201).json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Create task error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
};

/**
 * PATCH /api/superadmin/tasks/:id
 *
 * Only keys PRESENT in the body are touched. An absent field must stay as it
 * is, which a `collect()` of every field cannot express — its optional
 * validators return "" for a missing value, and the patch would blank whatever
 * the caller simply didn't mention.
 */
exports.update = async (req, res) => {
  try {
    const b = req.body || {};
    const validators = {
      title: () => input.text(b.title, "Title", { max: 200, required: true, allowEmpty: false }),
      description: () => input.text(b.description, "Description", { max: 20000 }),
      type: () => input.oneOf(b.type, "Type", TYPES),
      priority: () => input.oneOf(b.priority, "Priority", PRIORITIES),
      dueAt: () => input.date(b.dueAt, "Due date"),
      outcome: () => input.text(b.outcome, "Outcome", { max: 4000 }),
      tags: () => input.stringList(b.tags, "Tags", { max: 20, maxLength: 40 }),
    };

    const patch = {};
    for (const [key, validate] of Object.entries(validators)) {
      if (!(key in b)) continue;
      const r = validate();
      if (r.error) return res.status(400).json({ error: r.error });
      patch[key] = r.value;
    }

    if ("leadId" in b) {
      if (!b.leadId) patch.lead = null;
      else {
        const idc = input.objectId(b.leadId, "lead");
        if (idc.error) return res.status(400).json({ error: idc.error });
        const lead = await Lead.findById(idc.value).select("_id");
        if (!lead) return res.status(400).json({ error: "That lead no longer exists" });
        patch.lead = lead._id;
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No fields to update" });

    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Named separately in the timeline: these two are the ones a watching
    // operator needs to notice, and "edited" would bury them.
    const changed = [];
    if ("dueAt" in patch && String(task.dueAt || "") !== String(patch.dueAt || "")) {
      changed.push({
        kind: "due",
        from: task.dueAt ? task.dueAt.toISOString() : "",
        to: patch.dueAt ? patch.dueAt.toISOString() : "",
      });
    }
    if ("priority" in patch && task.priority !== patch.priority) {
      changed.push({ kind: "priority", from: task.priority, to: patch.priority });
    }
    const otherEdits = Object.keys(patch).filter((k) => !["dueAt", "priority"].includes(k));
    if (otherEdits.length) changed.push({ kind: "edited", note: otherEdits.join(", ") });

    Object.assign(task, patch);
    const at = new Date();
    changed.forEach((c) => task.events.push({ ...c, by: req.user._id, byName: actorName(req), at }));
    await task.save();

    await writeAudit(req, "task.updated", { targetType: "task", targetId: String(task._id), meta: { fields: Object.keys(patch) } });
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Update task error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
};

/** PATCH /api/superadmin/tasks/:id/status  { status, outcome? } */
exports.changeStatus = async (req, res) => {
  try {
    const r = input.oneOf(req.body?.status, "Status", STATUSES);
    if (r.error) return res.status(400).json({ error: r.error });
    const outcome = input.text(req.body?.outcome, "Outcome", { max: 4000 });
    if (outcome.error) return res.status(400).json({ error: outcome.error });

    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const from = task.status;
    const next = r.value;
    if (from === next && !outcome.value) return res.json({ task: await populated(task._id) });

    task.status = next;
    if (TERMINAL_STATUSES.includes(next)) {
      // Only stamp the first close. Re-closing something already closed (a
      // done→cancelled correction) must not rewrite when the work was finished.
      if (!task.completedAt) {
        task.completedAt = new Date();
        task.completedBy = req.user._id;
      }
    } else {
      // Reopened: the completion stamps now describe something that isn't
      // true, and leaving them would put the task in "completed this week".
      task.completedAt = null;
      task.completedBy = null;
    }
    if (outcome.value) task.outcome = outcome.value;

    task.events.push({
      kind: "status",
      from,
      to: next,
      note: outcome.value || "",
      by: req.user._id,
      byName: actorName(req),
      at: new Date(),
    });
    await task.save();

    await writeAudit(req, "task.status_changed", {
      targetType: "task",
      targetId: String(task._id),
      meta: { from, to: next },
    });
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Change task status error:", err);
    res.status(500).json({ error: "Failed to change status" });
  }
};

/** PATCH /api/superadmin/tasks/:id/assign  { userId } */
exports.assign = async (req, res) => {
  try {
    const assigned = await resolveAssignee(req.body?.userId);
    if (assigned.error) return res.status(400).json({ error: assigned.error });

    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const from = task.assignee?.name || "";
    task.assignee = assigned.value;
    task.events.push({
      kind: "assigned",
      from,
      to: assigned.value.name || "Unassigned",
      by: req.user._id,
      byName: actorName(req),
      at: new Date(),
    });
    await task.save();

    const withLead = await populated(task._id);
    if (assigned.user) await notifyAssignee(withLead, assigned.user, req);

    await writeAudit(req, "task.assigned", {
      targetType: "task",
      targetId: String(task._id),
      meta: { userId: assigned.value.userId ? String(assigned.value.userId) : null },
    });
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: withLead });
  } catch (err) {
    console.error("Assign task error:", err);
    res.status(500).json({ error: "Failed to assign task" });
  }
};

/** POST /api/superadmin/tasks/:id/comments  { body, mentions } */
exports.addComment = async (req, res) => {
  try {
    const parsed = input.text(req.body?.body, "Comment", { max: 20000, required: true, allowEmpty: false });
    if (parsed.error) return res.status(400).json({ error: "A comment is required" });

    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    task.comments.push({
      body: parsed.value,
      author: req.user._id,
      authorName: actorName(req),
      mentions: Array.isArray(req.body?.mentions) ? req.body.mentions.filter((m) => input.isObjectId(String(m))) : [],
    });
    task.events.push({ kind: "comment", by: req.user._id, byName: actorName(req), at: new Date() });
    await task.save();

    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Add task comment error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
};

/** POST /api/superadmin/tasks/:id/checklist  { text } */
exports.addChecklistItem = async (req, res) => {
  try {
    const parsed = input.text(req.body?.text, "Checklist item", { max: 200, required: true, allowEmpty: false });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.checklist.length >= 50) return res.status(400).json({ error: "A task is limited to 50 checklist items" });

    task.checklist.push({ text: parsed.value });
    await task.save();
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Add checklist item error:", err);
    res.status(500).json({ error: "Failed to add checklist item" });
  }
};

/** PATCH /api/superadmin/tasks/:id/checklist/:itemId  { done?, text? } */
exports.updateChecklistItem = async (req, res) => {
  try {
    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const item = task.checklist.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Checklist item not found" });

    if ("text" in req.body) {
      const parsed = input.text(req.body.text, "Checklist item", { max: 200, required: true, allowEmpty: false });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      item.text = parsed.value;
    }
    if ("done" in req.body) {
      const done = req.body.done === true || req.body.done === "true";
      if (done !== item.done) {
        item.done = done;
        item.doneAt = done ? new Date() : null;
        item.doneBy = done ? req.user._id : null;
        task.events.push({
          kind: "checklist",
          to: done ? "done" : "reopened",
          note: item.text,
          by: req.user._id,
          byName: actorName(req),
          at: new Date(),
        });
      }
    }
    await task.save();
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Update checklist item error:", err);
    res.status(500).json({ error: "Failed to update checklist item" });
  }
};

/** DELETE /api/superadmin/tasks/:id/checklist/:itemId */
exports.removeChecklistItem = async (req, res) => {
  try {
    const task = await CrmTask.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const item = task.checklist.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Checklist item not found" });
    item.deleteOne();
    await task.save();
    emitToSuperAdmins("task:updated", { id: String(task._id), leadId: task.lead ? String(task.lead) : null });
    res.json({ task: await populated(task._id) });
  } catch (err) {
    console.error("Remove checklist item error:", err);
    res.status(500).json({ error: "Failed to remove checklist item" });
  }
};

/**
 * POST /api/superadmin/tasks/bulk  { ids, action, value }
 * Acting on a filtered selection — the reason a list screen beats opening
 * twenty tasks one at a time.
 */
exports.bulk = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((i) => input.isObjectId(String(i))) : [];
    if (!ids.length) return res.status(400).json({ error: "Select at least one task" });
    if (ids.length > 200) return res.status(400).json({ error: "Up to 200 tasks at a time" });

    const action = input.oneOf(req.body?.action, "Action", ["status", "assign", "priority", "delete"]);
    if (action.error) return res.status(400).json({ error: action.error });

    let result;
    if (action.value === "delete") {
      result = await CrmTask.deleteMany({ _id: { $in: ids } });
    } else if (action.value === "status") {
      const r = input.oneOf(req.body?.value, "Status", STATUSES);
      if (r.error) return res.status(400).json({ error: r.error });
      const closing = TERMINAL_STATUSES.includes(r.value);
      const at = new Date();
      const event = { kind: "status", to: r.value, by: req.user._id, byName: actorName(req), at };
      // Two writes rather than one $set: only tasks that are not already closed
      // should have their completion stamped now, or a bulk "done" would
      // rewrite the completion date of work finished last month.
      await CrmTask.updateMany(
        { _id: { $in: ids }, completedAt: null },
        closing
          ? { $set: { status: r.value, completedAt: at, completedBy: req.user._id }, $push: { events: event } }
          : { $set: { status: r.value }, $push: { events: event } },
      );
      result = await CrmTask.updateMany(
        { _id: { $in: ids }, completedAt: { $ne: null } },
        closing
          ? { $set: { status: r.value }, $push: { events: event } }
          : { $set: { status: r.value, completedAt: null, completedBy: null }, $push: { events: event } },
      );
    } else if (action.value === "priority") {
      const r = input.oneOf(req.body?.value, "Priority", PRIORITIES);
      if (r.error) return res.status(400).json({ error: r.error });
      result = await CrmTask.updateMany(
        { _id: { $in: ids } },
        {
          $set: { priority: r.value },
          $push: { events: { kind: "priority", to: r.value, by: req.user._id, byName: actorName(req), at: new Date() } },
        },
      );
    } else {
      const assigned = await resolveAssignee(req.body?.value);
      if (assigned.error) return res.status(400).json({ error: assigned.error });
      result = await CrmTask.updateMany(
        { _id: { $in: ids } },
        {
          $set: { assignee: assigned.value },
          $push: {
            events: {
              kind: "assigned",
              to: assigned.value.name || "Unassigned",
              by: req.user._id,
              byName: actorName(req),
              at: new Date(),
            },
          },
        },
      );
    }

    await writeAudit(req, "task.bulk_updated", {
      targetType: "task",
      meta: { action: action.value, count: ids.length },
    });
    emitToSuperAdmins("task:updated", { bulk: true });
    res.json({
      message: `${result.modifiedCount ?? result.deletedCount ?? ids.length} task(s) updated`,
      count: result.modifiedCount ?? result.deletedCount ?? 0,
    });
  } catch (err) {
    console.error("Bulk task action error:", err);
    res.status(500).json({ error: "Failed to apply the bulk action" });
  }
};

/** DELETE /api/superadmin/tasks/:id */
exports.remove = async (req, res) => {
  try {
    const task = await CrmTask.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    await writeAudit(req, "task.deleted", { targetType: "task", targetId: String(req.params.id) });
    emitToSuperAdmins("task:updated", { id: String(req.params.id), deleted: true, leadId: task.lead ? String(task.lead) : null });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("Delete task error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
};

/**
 * Open-task counts for a set of leads, as { leadId: { open, overdue, nextDueAt } }.
 * Exported for leadController's list, which joins it onto the rows so the
 * pipeline table can show what is outstanding without N+1 queries.
 */
exports.taskSummaryForLeads = async function taskSummaryForLeads(leadIds) {
  const ids = (leadIds || []).filter(Boolean).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return {};
  const now = new Date();
  const rows = await CrmTask.aggregate([
    { $match: { lead: { $in: ids }, status: { $in: OPEN_STATUSES } } },
    {
      $group: {
        _id: "$lead",
        open: { $sum: 1 },
        overdue: { $sum: { $cond: [{ $and: [{ $ne: ["$dueAt", null] }, { $lt: ["$dueAt", now] }] }, 1, 0] } },
        // $min ignores nulls, so this is the soonest REAL deadline rather than
        // null the moment one undated task exists.
        nextDueAt: { $min: "$dueAt" },
      },
    },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), { open: r.open, overdue: r.overdue, nextDueAt: r.nextDueAt }]));
};
