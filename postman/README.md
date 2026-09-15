# Donexus integration API (for Calcite Hyper)

Server-to-server API that lets the Calcite Hyper master portal manage Donexus
tenants, plans, subscriptions and support tickets. It follows the ecosystem
contract used by Hyyve and Stewardex; where Donexus differs, this file says so.

- Collection: `Donexus.postman_collection.json` (Postman schema v2.1). Every request carries a description with fields, enums and side effects.
- Environment: `Donexus-Local.postman_environment.json` (**Donexus — Local**): `donexus_base_url` = `http://localhost:5000/api` (the API base — requests add `/integration/...`, like the Hyyve/Stewardex folders), `donexus_api_key` (secret, local dev key), `actor_email` (optional).
- Layout matches the Hyper ecosystem collection: one **Donexus** folder with `x-api-key` auth, **Ping** at its root, then **Tenants → Plans → Subscriptions (change plan) → Tickets**. The folder can be dropped straight into `Hyper-Ecosystem.postman_collection.json`; add `donexus_base_url` and `donexus_api_key` to the Hyper environment.
- Code: `routes/integration/`, `controllers/integration/`, `middleware/integrationAuth.js`. The lifecycle rules live in `services/tenantLifecycle.js`, `services/planService.js` and `services/tenantProvisioning.js`, and the SuperAdmin console uses the same services, so the two tools can't disagree.

---

## Running it

1. Set `INTEGRATION_API_KEYS` in `NGOPlatformBE/.env` (a local dev key is already there) and start the backend (`node server.js`, port 5000).
2. In Postman, import both JSON files and select **Donexus — Local**.
3. Optional: set `actor_email` in the environment. It's sent as `x-actor-email` on every request.
4. Run **Donexus → Ping**, then the folders top to bottom: Tenants, Plans, Subscriptions (change plan), Tickets. Create requests save `donexusTenantId`, `donexusPlanCode`, `donexusForkPlanCode`, `donexusTicketId` and `donexusAssigneeId` (the new tenant's owner) into collection variables. They carry a `donexus` prefix so they can't overwrite Stewardex's `planCode` / `ticketId` when both folders share one collection. Codes and emails get a per-run suffix, so the collection can be run again.

> **Port clash:** Donexus and Stewardex both default to `:5000` locally. To run both, start Donexus with `PORT=5002` and set `donexus_base_url` to `http://localhost:5002/api`.

From the command line:

```bash
npx newman run postman/Donexus.postman_collection.json -e postman/Donexus-Local.postman_environment.json
```

The whole collection passes against a local server: 33 requests, 68 assertions.

> The local run makes real side effects, all on your local database: it creates a plan (and, if Stripe is configured, a Stripe product in that account), provisions a tenant and opens a ticket. The *Add comment (visible to customer)* request tries to email the reporter address in the example body, which is `@example.org`.

---

## Auth

| | |
|---|---|
| Header | `x-api-key: <key>` |
| Optional header | `x-actor-email: person@calcite.live`. This is the staff member behind the call. It only attributes the action and grants nothing. An invalid address gets `400 INVALID_ACTOR_EMAIL`. |
| Server config | `INTEGRATION_API_KEYS=name:key[,name:key…]` |

| Situation | Response |
|---|---|
| Valid key | the endpoint runs |
| Missing key | `401 API_KEY_MISSING` |
| Unknown key | `401 API_KEY_INVALID` |
| `INTEGRATION_API_KEYS` unset, or no valid pair in it | `503 INTEGRATION_DISABLED`. Nothing else in the app is affected. |

- The **name** is not secret. It identifies the caller in logs and audit rows, and `/ping` echoes it back. Every key is compared in constant time.
- A pair whose key is shorter than 24 characters is **ignored** and a warning is logged, so `hyper:test` never works.
- Generate a key:
  ```bash
  node -e "console.log('dnx_live_' + require('crypto').randomBytes(32).toString('base64url'))"
  ```
  Use `dnx_live_` for production and `dnx_test_` for local keys.
- **Rotation without downtime:** set `hyper:NEW,hyper-old:OLD` and redeploy. Hyper switches to the new key, then you remove `hyper-old` and redeploy again. Both keys work in between.
- There is no CORS, OAuth or session. `x-api-key` is deliberately not in the browser CORS allow-list.

### Audit attribution

Every write through this API adds a row to the Donexus platform audit log, which is the same log the SuperAdmin console writes to and shows at `/audit` and on each tenant.

- `actorEmail` = `integration:hyper (sohaib@calcite.live)` when `x-actor-email` is sent, and `integration:hyper` when it isn't.
- `meta.via = "integration"`, `meta.integrationKey`, `meta.actorEmail` and, when you send one, `meta.reason`.

---

## Conventions

| | |
|---|---|
| Base path | `{{donexus_base_url}}/integration`, where `donexus_base_url` = `{api_base}/api`. Donexus uses no version segment (Stewardex's base ends `/api/v1`). |
| Success | `{ "success": true, "data": …, "meta"?: {…}, "warnings"?: [{ "code", "message" }] }` |
| Failure | `{ "success": false, "error": { "code", "message", "details"? } }`. Branch on `code`, not `message`. |
| Warnings | Warnings are non-fatal facts on a 2xx response, such as `STRIPE_CANCEL_FAILED` or `BILLING_NOT_RESTARTED`. Show them to staff. |
| Status codes | `200` read or update, `201` create, `400` validation, `401` bad key, `404` unknown id, `409` conflict or illegal transition, `502`/`503` Stripe problems, `503` integration disabled |
| Field names | snake_case. Keys inside `limits` and `feature_flags` are feature-catalogue keys and pass through unchanged, e.g. `eventsQuota` and `adminSeats`. |
| Dates | ISO 8601 UTC, or `null` |
| Money | numbers in whole currency units, next to a `currency` field (platform-wide, `AUD`). Example: `"pricing": { "currency": "AUD", "monthly": 149, "yearly": 1490 }`. |
| Billing cycle | `monthly` or `yearly`. Internally it's stored as `annual`, and `annual` is also accepted as input. |
| Unknown fields | refused with `400 UNKNOWN_FIELD`, which lists the allowed fields. Sending `featureFlags` where `feature_flags` was meant fails loudly. |
| Tenant ids | `/tenants/:id` accepts the tenant id **or** its slug |
| Pagination | `GET /tenants` (default 100, max 500) and both ticket lists (default 50, max 200) take `?page=&limit=` and return `meta: { page, limit, total, pages }`. `GET /plans` isn't paginated. |
| Caching | every response is `Cache-Control: no-store` |

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/ping` | key check: `{ service, key, actor, time }` |
| GET | `/feature-flags` | `flags[]` / `limits[]` / `categories[]`, each `{ code, category, name, … }` |
| GET | `/plans?status=` | `active` \| `archived` \| `all` |
| POST | `/plans` | create, or fork with `fork_from` |
| GET | `/plans/:code` | plan + `price_history` + last 50 `revisions` (`revisions[].diff`) |
| PATCH | `/plans/:code` | **merge** semantics (see below); `status: "archived"` archives (as DELETE), `"active"` restores |
| DELETE | `/plans/:code?confirm=true` | archive; response has `active_subscriptions` |
| GET | `/tenants?status=&plan_code=&search=` | subscription inline on every row |
| POST | `/tenants` | provision organisation + owner |
| GET | `/tenants/:id` | + override, effective entitlements, `recent_events` (20), `recent_invoices` (10) |
| PATCH | `/tenants/:id` | `name`, `status` (`active` \| `suspended` \| `deleted`), `reason` |
| DELETE | `/tenants/:id` | soft delete |
| POST | `/tenants/:id/assign-plan` | `{ plan_code, billing_cycle?, reason? }` |
| PUT | `/tenants/:id/override` | replaces the whole override; `reason` required |
| DELETE | `/tenants/:id/override` | clear; response has `cleared` |
| GET | `/tickets?status=&priority=&category=&assignee=&tenant_id=&search=` | cross-tenant queue |
| GET / POST | `/tenants/:id/tickets` | list / create |
| GET | `/tenants/:id/tickets/stats` | counts by status and priority |
| GET / PUT / DELETE | `/tenants/:id/tickets/:ticketId` | get / update / **hard** delete |
| PATCH | `/tenants/:id/tickets/:ticketId/status` | `{ status, resolution_notes?, send_satisfaction_survey? }` |
| POST | `/tenants/:id/tickets/:ticketId/assign` | `{ assignee_id \| null }` |
| POST | `/tenants/:id/tickets/:ticketId/comments` | `{ message, is_internal?, visibility?, author_name? }` |

Field-level detail is in each request's description in the collection.

---

## Donexus domain notes (read before building the UI)

### Terminology

| Contract | Donexus |
|---|---|
| tenant | **Organisation**, a charity. Each one has a subdomain (`slug`). |
| `orgId` (Stewardex) | `id` |
| plan | **Plan**, the same thing. The `code` is stable. |
| subscription | fields on the organisation: `plan`, `billingCycle`, `subscriptionStatus`, plus an optional platform Stripe subscription |
| owner user | the organisation's primary **admin** user |
| ticket | **SupportTicket**: a tenant-to-platform helpdesk ticket raised by the charity's staff, its donors, or a public form |

### Tenant status

`active` · `suspended` · `deleted` · **`pending`**. Pending is specific to Donexus: a self-serve signup that never paid its first invoice, so no owner account exists yet. A pending tenant can't be suspended or activated (`409 TENANT_PENDING_PAYMENT`), but it can be deleted. `suspended` also covers tenants whose Stripe subscription was cancelled by Stripe, for example after failed payments.

### Billing: what Hyper needs to know

- **Self-serve signup charges a card in the browser.** A server-to-server call can't do that, so a tenant created with `POST /tenants` has **no Stripe subscription**. It is comped (`is_comp`, the default), on a trial, or billed outside Stripe. `subscription.billing` tells you which: `stripe` \| `comp` \| `none`.
- **`trial_ends_at` is informational.** Nothing locks a tenant when its trial ends.
- **Suspend and delete cancel the platform Stripe subscription.** Stripe cancellations are final, so **reactivating or restoring does not restart billing**. The tenant comes back with `subscription.billing: "none"` unless it's comped, and the response carries a `BILLING_NOT_RESTARTED` warning. *This answers "is the cancelled subscription still cancelled after a restore?": yes.* Assigning a plan afterwards doesn't restart card billing either.
- **`assign-plan` with a live Stripe subscription** swaps the price with `create_prorations`, so the difference is settled on the next invoice and nothing is charged immediately. A change within the same cycle keeps the renewal date. **A cycle change resets the billing period to today.** If Stripe rejects the change, nothing changes (`502`). Assigning never changes the tenant's status.
- **Override `pricing` is a recorded negotiated price** used for MRR reporting and shown as `subscription.price`. **It does not change what Stripe charges.** To change the actual charge for a Stripe-billed tenant, fork a plan and assign it.
- **A plan price change doesn't move existing paying tenants.** They stay on the old Stripe price until migrated in the Donexus console (Plans → Migrate subscribers). The response reports how many tenants that affects.

### Merge vs replace: the easy thing to get wrong

| Call | Nested objects |
|---|---|
| `PATCH /plans/:code` | `limits` and `feature_flags` **merge per key**. Keys you omit keep their value. `null` means unlimited, and a key can't be removed. `pricing` **merges per cycle**. `marketing_features` is **replaced**. |
| `POST /plans` with `fork_from` | the body merges per key or cycle over the copied plan |
| `PUT /tenants/:id/override` | **replaces the whole override**. Keys you omit are gone. |

### Overrides

- Body: `limits`, `feature_flags`, `pricing: { monthly, yearly }`, and `reason`, which is **required**.
- Limits and flags apply to entitlements immediately. Core flags (e.g. `donations`) can't be switched off.
- **`effective_from` and `effective_until` aren't supported.** Sending either gets `400 OVERRIDE_WINDOW_UNSUPPORTED` rather than being silently ignored. An override lasts until it's cleared.
- The stored override shows who set it (`set_by`) and when (`set_at`).

### Suspension is complete, not half-applied

`status: "suspended"` does all of the following:

1. Every tenant-scoped API request returns 402.
2. Sign-in is refused for the tenant's admins **and donors** (403).
3. Existing staff sessions are revoked, so a later reactivation doesn't revive them.
4. The Stripe subscription is cancelled. If Stripe fails, access stays locked and a `STRIPE_CANCEL_FAILED` warning says billing may continue.

The backend has no tenant cache to clear.

### Tickets

- Status and priority enums match Stewardex exactly. Categories also use the Stewardex values (`technical_error`, `access_issue`, `data_issue`, …) and are mapped internally.
- All tickets live in one database, so the queue can't partially fail. `meta.failed_tenants` is always `[]`.
- The cross-tenant queue leaves out tickets from soft-deleted tenants.
- **Comment visibility is enforced server-side:**

  | `visibility` | Who sees it |
  |---|---|
  | `platform` (`is_internal: true`) | Calcite staff only. It's hidden from the reporter **and** from the tenant's own admins, and stripped from every tenant helpdesk response. |
  | `tenant` | the tenant's admins and platform staff. This is the Donexus console's "internal note". |
  | `public` (`is_internal: false`) | everyone, and it's **emailed to the reporter** |

  **`is_internal` defaults to `true`**, so a note is never emailed to a customer or shown to one just because the field was left out.
- Side effects:
  - A public reply sends an email, sets `first_response_at`, and moves a `new` ticket to `in_progress`.
  - The first move to `solved` or `declined` sends a one-time satisfaction survey email unless `send_satisfaction_survey: false`.
  - Creating a ticket sends no email.
- `assignee_id` has to be an **admin user of that tenant**.

### Plan codes

Codes are 3–40 characters: lowercase letters, digits and hyphens (**no underscores**), with no hyphen at the start or end. Codes never change.

---

## Where Donexus differs from Stewardex

The Stewardex folder was the reference for **conventions** (auth, envelope, folder layout, endpoint set). Where the products genuinely differ, Donexus keeps its own behaviour rather than imitating Stewardex:

| Topic | Stewardex | Donexus |
|---|---|---|
| Tenant id | `orgId` (slug-like, e.g. `hope_street_foundation`) | `id` (ObjectId) + `slug` (subdomain); routes accept either |
| Create tenant body | `organizationName`, `firstName`, `lastName` | snake_case `organization_name`, `first_name`, `last_name`; also `plan_code`, `billing_cycle`, `trial_days`, `is_comp` in the same call |
| Generated password | `ownerPassword` | `credentials.generated_password` (+ `credentials.set_password_url`) |
| Tenant statuses | active / suspended / deleted | adds `pending` (signup that never paid) |
| Plan templates | unsaved in-code templates, "materialise" on first PATCH | none — default tiers are real plans (`npm run seed:plans`) |
| Plan fields | `visibility`, `trial_days`, `support`, `metadata`, camelCase `pricing` (`monthlyAUD`) | `is_public`, `sort_order`, `pricing: { currency, monthly, yearly, onboarding_fee }`; no plan-level trial or support terms |
| PATCH plan nested objects | **replace** | **merge** per key / per cycle (same as the Donexus console) |
| Assign plan | resets billing period, sets status `active` | Stripe proration; period resets only on a cycle change; **status unchanged** |
| Override window | `effective_from` / `effective_until` | not supported → 400 `OVERRIDE_WINDOW_UNSUPPORTED` |
| Override pricing | applied | recorded for reporting; doesn't change the Stripe charge |
| Tickets storage | per-tenant databases, active tenants only, `failed_tenants` possible | one database; any tenant readable; `failed_tenants` always `[]` |
| Ticket `module` | yes | no |
| Assign ticket | notifies assignee, `new` → `in_progress` | no email, status unchanged (as the Donexus helpdesk) |
| First response | any first comment | first customer-visible comment |
| Internal notes | `is_internal` | `is_internal: true` (default) = Calcite-only, also hidden from tenant admins; optional `visibility: "tenant"` |

## Delete semantics

| Action | Behaviour |
|---|---|
| `DELETE /tenants/:id` | **Soft delete.** Status becomes `deleted`, access and logins are blocked, sessions are revoked, the Stripe subscription is cancelled, and the tenant is hidden from default lists. **All data is kept.** `PATCH { "status": "active" }` restores it (`"suspended"` restores it without reopening). |
| `DELETE /plans/:code` | **Archive.** Existing tenants keep the plan, and any Stripe subscriptions on it keep renewing. The plan can't be newly assigned. When tenants are still active on it, send `?confirm=true`. `PATCH { "status": "active" }` restores it. |
| `DELETE /tenants/:id/override` | Clears the override. |
| `DELETE /tenants/:id/tickets/:ticketId` | **Permanent.** This is the only hard delete, and the audit log keeps a `ticket.deleted` row. |

Actually purging a tenant stays a manual, deliberate job on the Donexus side.

---

## Error codes

| HTTP | code |
|---|---|
| 400 | `VALIDATION_ERROR`, `UNKNOWN_FIELD`, `INVALID_JSON`, `INVALID_ACTOR_EMAIL`, `INVALID_PLAN_CODE`, `INVALID_SLUG`, `UNKNOWN_LIMIT_KEY`, `UNKNOWN_FEATURE_FLAG`, `CORE_FLAG_LOCKED`, `CURRENCY_MISMATCH`, `REASON_REQUIRED`, `OVERRIDE_WINDOW_UNSUPPORTED` |
| 401 | `API_KEY_MISSING`, `API_KEY_INVALID` |
| 404 | `TENANT_NOT_FOUND`, `PLAN_NOT_FOUND`, `FORK_SOURCE_NOT_FOUND`, `TICKET_NOT_FOUND`, `ASSIGNEE_NOT_IN_TENANT`, `ROUTE_NOT_FOUND` |
| 409 | `EMAIL_IN_USE`, `SLUG_TAKEN`, `PLAN_CODE_TAKEN`, `PLAN_ARCHIVED`, `PLAN_ALREADY_ARCHIVED`, `PLAN_HAS_ACTIVE_TENANTS`, `PLAN_NOT_BILLABLE`, `TENANT_DELETED`, `TENANT_ALREADY_DELETED`, `TENANT_PENDING_PAYMENT`, `TENANT_HAS_NO_OWNER` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |
| 502 | `STRIPE_UPDATE_FAILED` |
| 503 | `INTEGRATION_DISABLED`, `STRIPE_UNAVAILABLE` |

Warnings on 2xx responses: `STRIPE_NOT_SYNCED`, `SUBSCRIBERS_GRANDFATHERED`, `STRIPE_CANCEL_FAILED`, `BILLING_NOT_RESTARTED`, `NOT_BILLED`, `WELCOME_EMAIL_FAILED`.

---

## Production

- Generate **separate** production keys and set `INTEGRATION_API_KEYS=hyper:dnx_live_…` on the Render service (Environment tab). Don't reuse the local key, and share it only through the agreed secret channel.
- Production: `donexus_base_url` = `https://ngoplatformbe.onrender.com/api` (integration root `…/api/integration`). This is the backend's `PUBLIC_API_URL`; **confirm before handover.** For production, duplicate the environment, change `donexus_base_url` and use the production key.
- Smoke test: `GET /ping` with the production key should return `200` and `"key": "hyper"`.
- **Rate limits:** none are applied by the Donexus backend today.
- **Render instance type:** to be confirmed. On a free instance, expect cold starts of 30 seconds or more.
