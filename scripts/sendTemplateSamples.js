/**
 * scripts/sendTemplateSamples.js
 *
 *   npm run mail:samples -- --to=you@example.com
 *   npm run mail:samples -- --to=you@example.com --scope=all
 *   npm run mail:samples -- --to=you@example.com --dry
 *
 * Sends one sample of every email template to a single address, so the whole
 * set can be reviewed in a real inbox rather than in the console's iframe.
 * Rendering in Gmail, Outlook and Apple Mail is the only thing that settles a
 * design argument about email -- the preview pane is a browser, and a browser
 * renders things (background images, border-radius, flexbox) that half the
 * clients this mail lands in will drop.
 *
 * It takes the same path as the console's "send test": previewTemplate() for
 * the resolved layout + content with the catalog's sample context, then
 * sendEmail() with `preRendered: true`. It deliberately ignores each template's
 * enabled switch -- you review a design before deciding to turn it on.
 *
 * Sends are SEQUENTIAL with a delay. Fifteen messages fired at once through one
 * SMTP account is the shape of a spam run, and providers rate-limit or block it.
 *
 * Flags:
 *   --to=<address>    required
 *   --scope=platform  (default) operator/SaaS mail | tenant | all
 *   --only=a,b        specific catalog keys, ignoring --scope
 *   --delay=<ms>      between sends (default 1500)
 *   --dry             render and report, send nothing
 */
require("dotenv").config();
const mongoose = require("mongoose");

const catalog = require("../config/emailCatalog");
const emailTemplates = require("../services/emailTemplates");
const { sendEmail } = require("../services/emailUtil");

const MONGODB_URI = process.env.MONGODB_URI;

/* -- arguments ------------------------------------------------------------ */

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const TO = flag("to").trim();
const SCOPE = flag("scope", "platform").trim().toLowerCase();
const ONLY = flag("only")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DELAY = Number(flag("delay", "1500")) || 0;
const DRY = has("dry");

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!TO || !/\S+@\S+\.\S+/.test(TO)) fail("Pass a recipient: --to=you@example.com");
if (!["platform", "tenant", "all"].includes(SCOPE)) fail(`Unknown --scope=${SCOPE}`);
if (!MONGODB_URI) fail("MONGODB_URI is not set — the script reads saved overrides from the database.");

const unknown = ONLY.filter((k) => !catalog.has(k));
if (unknown.length) fail(`Unknown template key(s): ${unknown.join(", ")}`);

const keys = ONLY.length
  ? ONLY
  : catalog.allKeys().filter((k) => SCOPE === "all" || catalog.get(k).scope === SCOPE);

if (!keys.length) fail(`No templates matched --scope=${SCOPE}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -- run ------------------------------------------------------------------ */

async function run() {
  await mongoose.connect(MONGODB_URI);

  const width = String(keys.length).length;
  const results = [];

  console.log(
    `\n  ${DRY ? "Rendering" : "Sending"} ${keys.length} ${SCOPE === "all" ? "" : `${SCOPE} `}` +
      `template${keys.length === 1 ? "" : "s"} to ${TO}\n`,
  );

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const n = String(i + 1).padStart(width, "0");
    const label = `${n}/${keys.length}  ${key.padEnd(28)}`;

    try {
      // Platform-scope mail resolves against the platform layer (organisationId
      // null); tenant-scope templates fall back to the shipped catalog defaults,
      // which is what an un-customised charity actually receives.
      const rendered = await emailTemplates.previewTemplate(key, {
        organisationId: null,
      });

      // The counter goes in the subject so fifteen near-identical rows in an
      // inbox are still tellable apart, and so the set stays in order.
      const subject = `[Sample ${n}/${keys.length}] ${rendered.subject}`;

      if (DRY) {
        console.log(`  ${label}  ${(rendered.html.length / 1024).toFixed(1)}kb  ${rendered.subject}`);
        results.push({ key, ok: true });
        continue;
      }

      const result = await sendEmail(TO, rendered.html, subject, [], {
        text: rendered.text,
        preRendered: true,
        log: { templateKey: key, source: rendered.source, meta: { test: true, sample: true } },
      });

      if (result.success) {
        console.log(`  ${label}  sent`);
        results.push({ key, ok: true });
      } else {
        const detail = String(result.error?.response || result.error?.message || result.error || "");
        console.log(`  ${label}  FAILED  ${detail.slice(0, 120)}`);
        results.push({ key, ok: false, detail });
      }
    } catch (error) {
      // A template that throws is a real bug, not a delivery problem -- keep
      // going so one broken entry doesn't hide the state of the other fourteen.
      console.log(`  ${label}  ERROR   ${error.message}`);
      results.push({ key, ok: false, detail: error.message });
    }

    if (!DRY && DELAY && i < keys.length - 1) await sleep(DELAY);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n  ${results.length - failed.length}/${results.length} ${DRY ? "rendered" : "sent"}` +
      `${failed.length ? `, ${failed.length} failed` : ""}.\n`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`    ${f.key}: ${f.detail}`);
    console.log("");
  }

  // logSend() is fire-and-forget by design -- a logging problem must never turn
  // a delivered email into a reported failure -- so the last row is still in
  // flight here. A server never disconnects; a script does, and without this
  // pause the final send loses its audit row to "Client must be connected".
  if (!DRY) await sleep(500);

  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
