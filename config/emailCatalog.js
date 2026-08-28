/**
 * config/emailCatalog.js
 *
 * THE single source of truth for every transactional email the platform sends.
 *
 * Nothing here is stored in the database. This file declares, for each email:
 *   - what it is and who receives it (so the SuperAdmin console can list it),
 *   - which variables a call site guarantees to provide (so the editor can offer
 *     a palette and reject a template referencing something that will never exist),
 *   - sample values (so the live preview shows a realistic email), and
 *   - the shipped default subject + block content.
 *
 * An EmailTemplate row in Mongo is only ever an OVERRIDE of an entry here. Delete
 * the row and the email reverts to this file, which is why "Reset to default" can
 * never leave a broken template behind and why a fresh install needs no seeding.
 *
 * Adding a new email = add an entry here + call sendTemplateEmail(key, ...).
 * The console picks it up automatically.
 */

/* -- block authoring helpers ---------------------------------------------- */

const h = (text, extra) => ({ type: "heading", text, level: 2, ...extra });
const h3 = (text, extra) => ({ type: "heading", text, level: 3, ...extra });
const p = (text, extra) => ({ type: "paragraph", text, ...extra });
const btn = (label, url, extra) => ({ type: "button", label, url, align: "center", ...extra });
const panel = (title, rows, extra) => ({ type: "panel", title, rows, ...extra });
const callout = (text, tone = "neutral", extra) => ({ type: "callout", text, tone, ...extra });
const table = (source, columns, extra) => ({ type: "table", source, columns, ...extra });
const rawHtml = (html) => ({ type: "html", html });
const hero = (label, figure, caption, extra) => ({
  type: "hero",
  label,
  figure,
  caption: caption || "",
  align: "center",
  ...extra,
});
const steps = (items, extra) => ({ type: "steps", items, ...extra });
const stats = (items, extra) => ({ type: "stats", items, ...extra });
const rule = () => ({ type: "divider", mark: true });

// Sign-off used by donor-facing tenant mail. Kept in one place so changing the
// house voice is a one-line edit rather than 30 — which is also why upgrading
// it from a paragraph to a signature block re-dressed every email at once.
const signOff = (who = "{{org.name}}", role = "") => ({
  type: "signature",
  note: "With gratitude,",
  name: who,
  role,
});

/* -- variable groups ------------------------------------------------------ */

const v = (key, label, sample, description) => ({ key, label, sample, description });

// Present in EVERY email -- the layout header/footer depends on them.
//
// The URLs are all ABSOLUTE and all real routes. A relative href in an email is
// dead (the client has no base URL), so any link a template offers has to come
// from here rather than being typed by hand. They resolve to "" for a tenant
// with no portal and no website, and the block compiler drops a button whose
// URL is empty rather than rendering a link to nowhere.
const SAMPLE_PORTAL = "https://hopetrust.donexus.app";
const ORG_VARS = [
  v("org.name", "Organisation name", "Hope Trust"),
  v("org.email", "Contact email", "hello@hopetrust.org.au"),
  v("org.phone", "Contact phone", "1300 000 000"),
  v("org.website", "Website", "https://hopetrust.org.au"),
  v("org.logo", "Logo (dark, for light backgrounds)", ""),
  v("org.logoLight", "Logo (light, for the header band)", ""),
  v("org.primaryColor", "Brand primary colour", "#2C2418"),
  v("org.accentColor", "Brand accent colour", "#C9A84C"),
  v("org.footer", "Contact line", "hopetrust.org.au | hello@hopetrust.org.au | 1300 000 000"),
  // public site
  v("org.portalUrl", "Portal home", SAMPLE_PORTAL),
  v("org.donateUrl", "Donate page", `${SAMPLE_PORTAL}/donate`),
  v("org.eventsUrl", "Events page", `${SAMPLE_PORTAL}/events`),
  v("org.programsUrl", "Programs page", `${SAMPLE_PORTAL}/programs`),
  v("org.campaignsUrl", "Fundraisers page", `${SAMPLE_PORTAL}/p2p-campaigns`),
  v("org.contactUrl", "Contact page", `${SAMPLE_PORTAL}/contact-us`),
  v("org.aboutUrl", "About page", `${SAMPLE_PORTAL}/about`),
  v("org.getInvolvedUrl", "Get involved page", `${SAMPLE_PORTAL}/get-involved`),
  // the donor's own portal
  v("org.loginUrl", "Log in", `${SAMPLE_PORTAL}/login`),
  v("org.dashboardUrl", "Donor dashboard", `${SAMPLE_PORTAL}/user/dashboard`),
  v("org.donationsUrl", "My donations", `${SAMPLE_PORTAL}/user/donations`),
  v("org.subscriptionsUrl", "My subscriptions", `${SAMPLE_PORTAL}/user/subscriptions`),
  v("org.paymentsUrl", "My payments", `${SAMPLE_PORTAL}/user/payments`),
  v("org.profileUrl", "My profile", `${SAMPLE_PORTAL}/user/settings/profile`),
  v("org.unsubscribeUrl", "Unsubscribe", `${SAMPLE_PORTAL}/unsubscribe`),
  // staff
  v("org.adminUrl", "Admin dashboard", `${SAMPLE_PORTAL}/admin/dashboard`),
];

const PLATFORM_VARS = [
  v("platform.name", "Platform name", "Donexus"),
  v("platform.url", "Platform URL", "https://donexus.app"),
  v("platform.supportEmail", "Platform support email", "support@donexus.app"),
];

const RECIPIENT_VARS = [
  v("recipient.name", "Recipient full name", "Sarah Whitfield"),
  v("recipient.firstName", "Recipient first name", "Sarah"),
  v("recipient.email", "Recipient email", "sarah@example.com"),
];

const DONOR_VARS = [
  v("donor.name", "Donor full name", "Sarah Whitfield"),
  v("donor.firstName", "Donor first name", "Sarah"),
  v("donor.email", "Donor email", "sarah@example.com"),
  v("donor.phone", "Donor phone", "0400 000 000"),
];

const DONATION_VARS = [
  v("donation.id", "Donation ID", "DN-48210"),
  v("donation.amount", "Amount", 250),
  v("donation.currency", "Currency", "AUD"),
  v("donation.date", "Date", "2026-08-14T02:30:00.000Z"),
  v("donation.type", "Donation type", "One-off"),
  v("donation.method", "Payment method", "Card"),
  v("donation.cause", "Cause / program", "Clean Water Wells"),
  v("donation.items", "Line items (list)", [
    { label: "Clean Water Wells", amount: 200, quantity: 1 },
    { label: "Where most needed", amount: 50, quantity: 1 },
  ]),
  v("donation.receiptUrl", "Receipt link", "https://hopetrust.donexus.app/user/donations"),
];

const SUBSCRIPTION_VARS = [
  v("subscription.id", "Subscription ID", "SUB-2041"),
  v("subscription.amount", "Amount per payment", 50),
  v("subscription.currency", "Currency", "AUD"),
  v("subscription.frequency", "Frequency", "Monthly"),
  v("subscription.cause", "Cause / program", "Clean Water Wells"),
  v("subscription.startDate", "Start date", "2026-01-14T00:00:00.000Z"),
  v("subscription.nextPaymentDate", "Next payment date", "2026-09-14T00:00:00.000Z"),
  v("subscription.paymentsMade", "Payments made", 8),
  v("subscription.totalGiven", "Total given", 400),
  v("subscription.manageUrl", "Manage link", "https://hopetrust.donexus.app/user/subscriptions"),
];

/* -- catalog -------------------------------------------------------------- */

/**
 * scope:    "tenant"   sent on an NGO's behalf -- tenants may override it
 *           "platform" sent by the SaaS platform itself -- SuperAdmin only
 * audience: who opens it, shown as a chip in the console
 * required: true means it cannot be switched off (receipts, password resets --
 *           turning these off breaks a legal or security obligation)
 */
const GROUPS = [
  { key: "donations", label: "Donations", description: "Receipts and the lifecycle of a single gift." },
  { key: "subscriptions", label: "Recurring giving", description: "Subscriptions, installments and cancellations." },
  { key: "accounts", label: "Donor accounts", description: "Sign-up, passwords and account security." },
  { key: "events", label: "Events", description: "Registrations and attendee communication." },
  { key: "volunteers", label: "Volunteers", description: "Volunteer applications and their outcomes." },
  { key: "partners", label: "Partners", description: "Partnership enquiries and listings." },
  { key: "fundraisers", label: "Peer-to-peer", description: "Supporter-created fundraising campaigns." },
  { key: "programs", label: "Programs", description: "Progress updates for programs donors backed." },
  { key: "enquiries", label: "Enquiries", description: "Replies to website contact forms." },
  { key: "tenant", label: "Tenant lifecycle", description: "Platform to charity: onboarding and billing." },
  { key: "sales", label: "Sales & leads", description: "Prospect nurture before a charity signs up." },
  { key: "support", label: "Helpdesk", description: "Support tickets and satisfaction surveys." },
  { key: "operators", label: "Platform team", description: "Invites and security for platform operators." },
];

const TEMPLATES = [
  /* ── Donations ───────────────────────────────────────────────────────── */
  {
    key: "donation.receipt",
    label: "Donation receipt",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    required: true,
    hasAttachment: "PDF receipt",
    description:
      "Sent immediately after a successful donation, with the PDF tax receipt attached. Legally significant — it cannot be disabled.",
    variables: [
      ...DONOR_VARS,
      ...DONATION_VARS,
      v("donation.isInstallment", "Is an installment?", false),
      v("donation.installmentNumber", "Installment number", 3),
      v("donation.installmentTotal", "Total installments", 12),
      v("donation.isRecurring", "Is recurring?", false),
      v("donation.isBankTransfer", "Paid by bank transfer?", false),
      v("bank.name", "Bank name", "Westpac"),
      v("bank.bsb", "BSB", "032 075"),
      v("bank.accountNumber", "Account number", "841783"),
      v("bank.accountName", "Account name", "Hope Trust Ltd"),
    ],
    defaults: {
      subject: "{{org.name}} — donation receipt {{donation.id}}",
      preheader: "Your receipt for {{donation.amount | money:donation.currency}}",
      blocks: [
        { ...h("Thank you, {{donor.firstName | default:\"friend\"}}"), eyebrow: "Your receipt" },
        p("Your gift to {{org.name}} has been received, and your official tax receipt is attached to this email."),
        // The figure led the email as a row inside a details panel, where it
        // read as a field rather than as the reason the email exists.
        hero(
          "Amount received",
          "{{donation.amount | money:donation.currency}}",
          "{{#if donation.cause}}for {{donation.cause}}{{/if}}",
        ),
        {
          ...p("This is installment {{donation.installmentNumber}} of {{donation.installmentTotal}}."),
          showIf: "donation.isInstallment",
        },
        panel("Receipt details", [
          { label: "Receipt no.", value: "{{donation.id}}", strong: true },
          { label: "Date", value: "{{donation.date | date}}" },
          { label: "Type", value: "{{donation.type}}" },
          { label: "Method", value: "{{donation.method}}" },
          { label: "Supporting", value: "{{donation.cause}}", showIf: "donation.cause" },
        ]),
        {
          ...table("donation.items", [
            { label: "Item", value: "{{this.label}}" },
            { label: "Amount", value: "{{this.amount | money:donation.currency}}", align: "right" },
          ], {
            showTotal: true,
            totalLabel: "Total",
            totalValue: "{{donation.amount | money:donation.currency}}",
          }),
          showIf: "donation.items",
        },
        {
          ...panel("Bank transfer details", [
            { label: "Bank", value: "{{bank.name}}", showIf: "bank.name" },
            { label: "Account name", value: "{{bank.accountName}}", showIf: "bank.accountName" },
            { label: "BSB", value: "{{bank.bsb}}" },
            { label: "Account no.", value: "{{bank.accountNumber}}" },
            { label: "Reference", value: "{{donation.id}}" },
          ]),
          showIf: "donation.isBankTransfer",
        },
        {
          ...callout(
            "Please include reference {{donation.id}} with your transfer. Your donation is marked complete once the payment reaches us.",
            "warning",
          ),
          showIf: "donation.isBankTransfer",
        },
        btn("View my giving history", "{{donation.receiptUrl}}", {
          note: "Keep this receipt for your tax records — you can always download it again from your account.",
        }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "donation.bankTransferPending",
    label: "Bank transfer pending",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    description:
      "Confirms an offline/bank-transfer donation was recorded, and tells the donor how to send proof of payment so it can be approved.",
    variables: [
      ...DONOR_VARS,
      ...DONATION_VARS,
      v("proof.uploadUrl", "Upload proof link", "https://hopetrust.donexus.app/upload-proof"),
    ],
    defaults: {
      subject: "Bank transfer pending — {{org.name}}",
      preheader: "One step left to complete your donation",
      blocks: [
        { ...h("Almost there, {{donor.firstName | default:\"friend\"}}"), eyebrow: "Awaiting your transfer" },
        p(
          "Thank you for your generous donation to {{org.name}}. It's recorded and waiting on your bank transfer before we can approve it.",
        ),
        hero("Amount to transfer", "{{donation.amount | money:donation.currency}}", "Reference {{donation.id}}"),
        panel("Your donation", [
          { label: "Reference", value: "{{donation.id}}", strong: true },
          { label: "Date", value: "{{donation.date | date}}" },
        ]),
        { ...h3("What happens next"), eyebrow: "Three steps" },
        steps([
          {
            title: "Make the transfer",
            text: "Quote reference <strong>{{donation.id}}</strong> so we can match it to your gift.",
          },
          {
            title: "Send us the proof",
            text: "Upload it on our website{{#if org.email}}, or email it to {{org.email}}{{/if}}.",
          },
          {
            title: "We issue your receipt",
            text: "The moment the funds are verified, your tax receipt lands in this inbox.",
          },
        ]),
        {
          ...btn("Upload proof of payment", "{{proof.uploadUrl}}", {
            note: "A photo of your banking confirmation is plenty.",
          }),
          showIf: "proof.uploadUrl",
        },
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "donation.approved",
    label: "Donation approved",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    description: "Sent when an admin manually approves a pending donation (bank transfer or offline gift).",
    variables: [...DONOR_VARS, ...DONATION_VARS],
    defaults: {
      subject: "Your donation is confirmed — {{org.name}}",
      preheader: "Donation {{donation.id}} has been confirmed",
      blocks: [
        { ...h("Your donation is confirmed"), eyebrow: "Confirmed" },
        p("Hi {{donor.firstName | default:\"there\"}}, we've received and confirmed your gift. Thank you for standing with us."),
        hero(
          "Amount received",
          "{{donation.amount | money:donation.currency}}",
          "{{#if donation.cause}}for {{donation.cause}}{{/if}}",
        ),
        panel("Donation", [
          { label: "Reference", value: "{{donation.id}}", strong: true },
          { label: "Supporting", value: "{{donation.cause}}", showIf: "donation.cause" },
        ]),
        btn("View my donations", "{{donation.receiptUrl}}", {
          note: "Your receipt lives there too, any time you need it again.",
        }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "donation.cancelled",
    label: "Donation cancelled",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    description: "Sent when a donation is cancelled by an admin, with the reason if one was given.",
    variables: [...DONOR_VARS, ...DONATION_VARS, v("reason", "Cancellation reason", "Duplicate transaction")],
    defaults: {
      subject: "Your donation has been cancelled — {{org.name}}",
      preheader: "About donation {{donation.id}}",
      blocks: [
        { ...h("Your donation has been cancelled"), eyebrow: "Cancelled" },
        p("Hi {{donor.firstName | default:\"there\"}}, we're writing to let you know that donation <strong>{{donation.id}}</strong> has been cancelled."),
        {
          ...panel("Reason", [{ label: "Reason", value: "{{reason}}", strong: true }]),
          showIf: "reason",
        },
        p("If you weren't expecting this, please reply to this email or contact us at {{org.email}} and we'll look into it right away."),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "donation.completed",
    label: "Donation completed / closed off",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    description: "Sent when a multi-payment donation finishes, or when an admin closes it off early.",
    variables: [
      ...DONOR_VARS,
      ...DONATION_VARS,
      v("isCloseOff", "Closed off early?", false),
      v("donation.totalPaid", "Total paid", 600),
      v("note", "Message from the team", "Thank you for completing your pledge."),
    ],
    defaults: {
      subject: "Your donation is complete — thank you",
      preheader: "{{donation.id}} is now complete",
      blocks: [
        { ...h("Your giving is complete"), eyebrow: "Thank you" },
        p("Hi {{donor.firstName | default:\"there\"}}, your commitment to {{org.name}} is now complete. Thank you for seeing it through."),
        hero(
          "Total given",
          "{{donation.totalPaid | money:donation.currency}}",
          "{{#if donation.cause}}towards {{donation.cause}}{{/if}}",
        ),
        panel("Summary", [
          { label: "Reference", value: "{{donation.id}}", strong: true },
          { label: "Supporting", value: "{{donation.cause}}", showIf: "donation.cause" },
        ]),
        { ...p("{{note | nl2br}}"), showIf: "note" },
        btn("See the impact", "{{org.programsUrl}}", { note: "This is where your giving went." }),
        rule(),
        signOff(),
      ],
    },
  },

  {
    key: "donation.update",
    label: "Update on a donation",
    group: "donations",
    scope: "tenant",
    audience: "Donor",
    description:
      "A progress note an admin posts against one donor's gift — the mid-flight sibling of the completion email.",
    variables: [
      ...DONOR_VARS,
      v("donation.id", "Donation ID", "DN-48210"),
      v("donation.cause", "Cause / program", "Clean Water Wells"),
      v("update.body", "Update text", "Your gift funded the survey work — drilling starts next month."),
      v("update.image", "Update image URL", ""),
      v("donation.receiptUrl", "My donations link", "https://hopetrust.donexus.app/user/donations"),
    ],
    defaults: {
      subject: "An update on your donation",
      preheader: "News about the cause you supported",
      blocks: [
        { ...h("An update on your donation"), eyebrow: "From the field" },
        p("Hi {{donor.firstName | default:\"there\"}}, we wanted to share an update on the cause you supported."),
        { ...{ type: "image", src: "{{update.image}}", alt: "Update", align: "center" }, showIf: "update.image" },
        { ...p("{{update.body | nl2br}}"), showIf: "update.body" },
        panel("Your donation", [
          { label: "Reference", value: "{{donation.id}}", strong: true },
          { label: "Supporting", value: "{{donation.cause}}", showIf: "donation.cause" },
        ]),
        btn("View my donations", "{{donation.receiptUrl}}", {
          note: "Receipts and past gifts are all in one place.",
        }),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Recurring giving ────────────────────────────────────────────────── */
  {
    key: "subscription.cancelled",
    label: "Subscription cancelled",
    group: "subscriptions",
    scope: "tenant",
    audience: "Donor",
    description: "Confirms a recurring donation has been stopped. No further payments will be taken.",
    variables: [...DONOR_VARS, ...SUBSCRIPTION_VARS, v("reason", "Reason", "Requested by donor")],
    defaults: {
      subject: "Your recurring donation has been cancelled — {{org.name}}",
      preheader: "No further payments will be taken",
      blocks: [
        { ...h("Your recurring gift has been cancelled"), eyebrow: "Confirmed" },
        p("Hi {{donor.firstName | default:\"there\"}}, your recurring donation to {{org.name}} has been cancelled and no further payments will be taken."),
        // What they gave deserves more room than the reference number does.
        stats([
          { label: "Total given", value: "{{subscription.totalGiven | money:subscription.currency}}" },
          { label: "Payments", value: "{{subscription.paymentsMade}}" },
        ]),
        panel("What was cancelled", [
          { label: "Reference", value: "{{subscription.id}}" },
          {
            label: "Amount",
            value: "{{subscription.amount | money:subscription.currency}} {{subscription.frequency | lower}}",
          },
        ]),
        p("Thank you for the difference you've already made. You're welcome back whenever you're ready."),
        btn("Give again", "{{org.donateUrl}}", { style: "outline" }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "subscription.cancellationApproved",
    label: "Cancellation request approved",
    group: "subscriptions",
    scope: "tenant",
    audience: "Donor",
    description: "Sent when an admin approves a donor's request to cancel their recurring gift.",
    variables: [...DONOR_VARS, ...SUBSCRIPTION_VARS],
    defaults: {
      subject: "Your cancellation request is approved — {{org.name}}",
      preheader: "Your recurring donation has been stopped",
      blocks: [
        { ...h("Your request has been approved"), eyebrow: "Approved" },
        p("Hi {{donor.firstName | default:\"there\"}}, we've processed your request and your recurring donation has been stopped. You won't be charged again."),
        stats([
          { label: "Total given", value: "{{subscription.totalGiven | money:subscription.currency}}" },
          { label: "Payments", value: "{{subscription.paymentsMade}}" },
        ]),
        panel("Cancelled subscription", [
          { label: "Reference", value: "{{subscription.id}}", strong: true },
          {
            label: "Amount",
            value: "{{subscription.amount | money:subscription.currency}} {{subscription.frequency | lower}}",
          },
        ]),
        p("We're grateful for every gift you gave. Thank you."),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "subscription.cancellationDeclined",
    label: "Cancellation request update",
    group: "subscriptions",
    scope: "tenant",
    audience: "Donor",
    description: "Sent when a cancellation request needs more information or could not be actioned as asked.",
    variables: [...DONOR_VARS, ...SUBSCRIPTION_VARS, v("note", "Message from the team", "We need to confirm a detail before we can cancel.")],
    defaults: {
      subject: "An update on your cancellation request — {{org.name}}",
      preheader: "We need one more thing",
      blocks: [
        { ...h("An update on your request"), eyebrow: "One more thing" },
        p("Hi {{donor.firstName | default:\"there\"}}, thank you for getting in touch about your recurring donation."),
        { ...callout("{{note | nl2br}}", "warning"), showIf: "note" },
        p("Please reply to this email or contact us at {{org.email}} and we'll sort it out straight away."),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "subscription.cancellationRequestAdmin",
    label: "Cancellation request (staff alert)",
    group: "subscriptions",
    scope: "tenant",
    audience: "Charity staff",
    description: "Internal alert telling the charity's team that a donor has asked to cancel a recurring gift.",
    variables: [
      ...DONOR_VARS,
      ...SUBSCRIPTION_VARS,
      v("reason", "Donor's reason", "Changing banks"),
      v("adminUrl", "Admin link", "https://hopetrust.donexus.app/admin/subscriptions"),
    ],
    defaults: {
      subject: "Cancellation request — {{donor.name}} ({{org.name}})",
      preheader: "A donor has asked to cancel their recurring gift",
      blocks: [
        { ...h("Cancellation request received"), eyebrow: "Action needed" },
        p("A donor has asked to cancel their recurring donation. Please review and action it in the admin portal."),
        panel("Donor", [
          { label: "Name", value: "{{donor.name}}", strong: true },
          { label: "Email", value: "{{donor.email}}" },
          { label: "Phone", value: "{{donor.phone}}", showIf: "donor.phone" },
        ]),
        panel("Subscription", [
          { label: "Reference", value: "{{subscription.id}}" },
          { label: "Amount", value: "{{subscription.amount | money:subscription.currency}} {{subscription.frequency | lower}}" },
          { label: "Started", value: "{{subscription.startDate | date}}" },
          { label: "Reason", value: "{{reason}}", showIf: "reason" },
        ]),
        btn("Review in admin portal", "{{adminUrl}}", {
          note: "Approving stops all future payments straight away.",
        }),
      ],
    },
  },
  {
    key: "subscription.cancellationRequestDonor",
    label: "Cancellation request received",
    group: "subscriptions",
    scope: "tenant",
    audience: "Donor",
    description: "Acknowledges that a donor's cancellation request has been logged and is being processed.",
    variables: [...DONOR_VARS, ...SUBSCRIPTION_VARS],
    defaults: {
      subject: "We've received your cancellation request — {{org.name}}",
      preheader: "We're processing your request",
      blocks: [
        { ...h("We've received your request"), eyebrow: "Received" },
        p("Hi {{donor.firstName | default:\"there\"}}, thanks for letting us know. We've logged your request to cancel your recurring donation and our team will process it shortly."),
        panel("Your subscription", [
          { label: "Reference", value: "{{subscription.id}}", strong: true },
          { label: "Amount", value: "{{subscription.amount | money:subscription.currency}} {{subscription.frequency | lower}}" },
        ]),
        p("You'll receive a confirmation email as soon as it's done. If anything changes in the meantime, just reply to this email."),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Donor accounts ──────────────────────────────────────────────────── */
  {
    key: "account.donorWelcome",
    label: "Donor account created",
    group: "accounts",
    scope: "tenant",
    audience: "Donor",
    required: true,
    description:
      "Sent after a first donation when we create an account for the donor. Contains their temporary password, so it cannot be disabled.",
    variables: [
      ...DONOR_VARS,
      v("donation.id", "Donation ID", "DN-48210"),
      v("account.password", "Temporary password", "Xk8-2mQp"),
      v("account.loginUrl", "Login link", "https://hopetrust.donexus.app/login"),
    ],
    defaults: {
      subject: "Welcome to {{org.name}} — your account details",
      preheader: "Your donor account is ready",
      blocks: [
        { ...h("Thank you, {{donor.firstName | default:\"friend\"}}"), eyebrow: "Your account is ready" },
        p("Your gift to {{org.name}} (reference <strong>{{donation.id}}</strong>) means a great deal. We've created an account so you can track your giving, download receipts and manage future donations."),
        panel("Your sign-in details", [
          { label: "Email", value: "{{donor.email}}", strong: true },
          { label: "Temporary password", value: "{{account.password}}" },
        ]),
        callout("Please change this password the first time you log in.", "warning"),
        btn("Log in to your account", "{{account.loginUrl}}", {
          note: "You can also reach it any time from the link in the footer below.",
        }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "account.passwordReset",
    label: "Password reset request",
    group: "accounts",
    scope: "tenant",
    audience: "Donor",
    required: true,
    description: "The password reset link. Security-critical — it cannot be disabled.",
    variables: [
      ...RECIPIENT_VARS,
      v("reset.url", "Reset link", "https://hopetrust.donexus.app/reset-password/abc123"),
      v("reset.expiresIn", "Link lifetime", "1 hour"),
    ],
    defaults: {
      subject: "Reset your {{org.name}} password",
      preheader: "This link expires in {{reset.expiresIn}}",
      blocks: [
        { ...h("Password reset request"), eyebrow: "Security" },
        p("We received a request to reset the password for your {{org.name}} account. Click the button below to choose a new one."),
        btn("Reset my password", "{{reset.url}}", {
          note: "For your security this link expires in {{reset.expiresIn}}.",
        }),
        callout(
          "If you didn't request this, you can safely ignore this email — your password won't change.",
          "neutral",
        ),
        rule(),
        p(
          "Button not working? Copy and paste this link into your browser:<br/>{{reset.url}}",
          { size: 13, color: "#6b7280" },
        ),
      ],
    },
  },
  {
    key: "account.passwordResetSuccess",
    label: "Password changed",
    group: "accounts",
    scope: "tenant",
    audience: "Donor",
    required: true,
    description: "Confirms a password was changed. A security notice — it cannot be disabled.",
    variables: [...RECIPIENT_VARS],
    defaults: {
      subject: "Your {{org.name}} password has been changed",
      preheader: "Security notice for your account",
      blocks: [
        { ...h("Your password was changed"), eyebrow: "Security notice" },
        p("The password for your {{org.name}} account was changed successfully."),
        btn("Log in", "{{org.loginUrl}}", { note: "You'll need your new password." }),
        callout(
          "If this wasn't you, contact us immediately at {{org.email}} — someone else may have access to your account.",
          "danger",
        ),
      ],
    },
  },

  /* ── Events ──────────────────────────────────────────────────────────── */
  {
    key: "event.registrationConfirmed",
    label: "Event registration confirmed",
    group: "events",
    scope: "tenant",
    audience: "Attendee",
    description: "Sent the moment someone registers for an event, free or paid.",
    variables: [
      ...RECIPIENT_VARS,
      v("event.title", "Event title", "Winter Gala Dinner"),
      v("event.date", "Event date", "2026-09-19T09:00:00.000Z"),
      v("event.time", "Event time", "6:00 pm – 10:00 pm"),
      v("event.venue", "Venue", "Riverside Hall, Melbourne"),
      v("event.url", "Event page", "https://hopetrust.donexus.app/events/winter-gala"),
      v("registration.guests", "Number of guests", 2),
      v("registration.isPaid", "Paid registration?", true),
      v("registration.amountPaid", "Amount paid", 120),
      v("registration.currency", "Currency", "AUD"),
      v("registration.reference", "Booking reference", "EV-3391"),
    ],
    defaults: {
      subject: "You're registered — {{event.title}}",
      preheader: "{{event.date | day}}",
      blocks: [
        { ...h("You're registered"), eyebrow: "See you there" },
        p("Hi {{recipient.firstName | default:\"there\"}}, your spot for <strong>{{event.title}}</strong> is confirmed."),
        hero("When", "{{event.date | day}}", "{{event.time}}"),
        panel("Event details", [
          { label: "Time", value: "{{event.time}}", showIf: "event.time" },
          { label: "Where", value: "{{event.venue}}", showIf: "event.venue" },
          { label: "Guests", value: "{{registration.guests}}", showIf: "registration.guests" },
          {
            label: "Amount paid",
            value: "{{registration.amountPaid | money:registration.currency}}",
            showIf: "registration.isPaid",
          },
          { label: "Reference", value: "{{registration.reference}}", showIf: "registration.reference" },
        ]),
        btn("View event details", "{{event.url}}", {
          note: "Add it to your calendar so it doesn't slip by.",
        }),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Volunteers ──────────────────────────────────────────────────────── */
  {
    key: "volunteer.applicationReceived",
    label: "Volunteer application received",
    group: "volunteers",
    scope: "tenant",
    audience: "Volunteer",
    description: "Acknowledges a volunteer application submitted through the website.",
    variables: [...RECIPIENT_VARS, v("volunteer.interests", "Areas of interest", "Events, Fundraising")],
    defaults: {
      subject: "We received your volunteer application — {{org.name}}",
      preheader: "Thank you for offering your time",
      blocks: [
        { ...h("Thank you for offering your time"), eyebrow: "Application received" },
        p("Hi {{recipient.firstName | default:\"there\"}}, thank you for offering to volunteer with <strong>{{org.name}}</strong>."),
        {
          ...panel("What you told us", [
            { label: "Interested in", value: "{{volunteer.interests}}", strong: true },
          ]),
          showIf: "volunteer.interests",
        },
        { ...h3("What happens next"), eyebrow: "No action needed" },
        steps([
          { title: "We read it properly", text: "A real person reviews every application, usually within a week." },
          { title: "We get in touch", text: "If it looks like a fit, we'll email you about a chat." },
          { title: "You get started", text: "We'll match you to the work that suits your time and skills." },
        ]),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "volunteer.shortlisted",
    label: "Volunteer shortlisted",
    group: "volunteers",
    scope: "tenant",
    audience: "Volunteer",
    description: "Tells an applicant they've been shortlisted and someone will be in contact.",
    variables: [...RECIPIENT_VARS],
    defaults: {
      subject: "You've been shortlisted — {{org.name}}",
      preheader: "Good news about your application",
      blocks: [
        { ...h("Good news"), eyebrow: "Shortlisted" },
        p("Hi {{recipient.firstName | default:\"there\"}}, you've been <strong>shortlisted</strong> to volunteer with {{org.name}}."),
        p("A member of our team will reach out soon with what happens next — nothing is needed from you in the meantime."),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "volunteer.approved",
    label: "Volunteer approved",
    group: "volunteers",
    scope: "tenant",
    audience: "Volunteer",
    description: "Welcomes an approved volunteer to the team.",
    variables: [...RECIPIENT_VARS],
    defaults: {
      subject: "Welcome aboard — your volunteer application was approved",
      preheader: "You're part of the team",
      blocks: [
        { ...h("Welcome to the team"), eyebrow: "Approved" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we're delighted to tell you your application to volunteer with <strong>{{org.name}}</strong> has been <strong>approved</strong>."),
        p("We'll follow up shortly with details about upcoming opportunities and how to get started."),
        btn("See what's coming up", "{{org.eventsUrl}}", {
          note: "We'll also email you directly when something suits your interests.",
        }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "volunteer.rejected",
    label: "Volunteer not progressing",
    group: "volunteers",
    scope: "tenant",
    audience: "Volunteer",
    description: "A kind decline. Worth keeping warm — many of these people donate.",
    variables: [...RECIPIENT_VARS],
    defaults: {
      subject: "An update on your volunteer application",
      preheader: "Thank you for applying",
      blocks: [
        { ...h("An update on your application"), eyebrow: "Your application" },
        p("Hi {{recipient.firstName | default:\"there\"}}, thank you for your interest in volunteering with {{org.name}} and for the time you put into your application."),
        p("After careful review we're unable to move forward at this time, but we'd genuinely love for you to apply again in the future."),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Partners ────────────────────────────────────────────────────────── */
  {
    key: "partner.enquiryReceived",
    label: "Partnership enquiry received",
    group: "partners",
    scope: "tenant",
    audience: "Prospective partner",
    description: "Acknowledges a 'become a partner' form submission.",
    variables: [
      ...RECIPIENT_VARS,
      v("partner.organisationName", "Their organisation", "Riverstone Group"),
      v("partner.type", "Partnership type", "Corporate"),
    ],
    defaults: {
      subject: "We received your partnership enquiry — {{org.name}}",
      preheader: "Thank you for reaching out",
      blocks: [
        { ...h("Thank you for reaching out"), eyebrow: "Enquiry received" },
        p("Hi {{recipient.firstName | default:\"there\"}}, thanks for your interest in partnering with {{org.name}}."),
        {
          ...panel("Your enquiry", [
            { label: "Organisation", value: "{{partner.organisationName}}", strong: true },
            { label: "Partnership type", value: "{{partner.type}}", showIf: "partner.type" },
          ]),
          showIf: "partner.organisationName",
        },
        p("A member of our team will be in touch soon to explore how we might work together."),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "partner.enquiryAdminAlert",
    label: "Partnership enquiry (staff alert)",
    group: "partners",
    scope: "tenant",
    audience: "Charity staff",
    description: "Internal alert with the full enquiry, sent to the charity's admins.",
    variables: [
      v("partner.name", "Contact name", "Dana Reyes"),
      v("partner.email", "Contact email", "dana@riverstone.com"),
      v("partner.phone", "Contact phone", "0400 111 222"),
      v("partner.organisationName", "Organisation", "Riverstone Group"),
      v("partner.website", "Website", "https://riverstone.com"),
      v("partner.type", "Partnership type", "Corporate"),
      v("partner.message", "Message", "We'd love to sponsor your winter appeal."),
      v("adminUrl", "Admin link", "https://hopetrust.donexus.app/admin/partners"),
    ],
    defaults: {
      subject: "New partnership enquiry — {{org.name}}",
      preheader: "{{partner.organisationName | default:partner.name}} wants to partner with you",
      blocks: [
        { ...h("New partnership enquiry"), eyebrow: "Action needed" },
        p("Someone wants to partner with you."),
        panel("Enquiry", [
          { label: "Name", value: "{{partner.name}}", strong: true },
          { label: "Organisation", value: "{{partner.organisationName}}", showIf: "partner.organisationName" },
          { label: "Type", value: "{{partner.type}}" },
          { label: "Email", value: "{{partner.email}}" },
          { label: "Phone", value: "{{partner.phone}}", showIf: "partner.phone" },
          { label: "Website", value: "{{partner.website}}", showIf: "partner.website" },
        ]),
        { ...p("<strong>Message</strong><br/>{{partner.message | nl2br}}"), showIf: "partner.message" },
        btn("Review in admin portal", "{{adminUrl}}", {
          note: "Approving can publish their logo to your public partners page.",
        }),
      ],
    },
  },
  {
    key: "partner.featured",
    label: "Partner now featured",
    group: "partners",
    scope: "tenant",
    audience: "Partner",
    description: "Tells an approved partner their logo is live on the public partners page.",
    variables: [
      ...RECIPIENT_VARS,
      v("partner.displayName", "Public name", "Riverstone Group"),
      v("partner.pageUrl", "Partners page", "https://hopetrust.org.au/partners"),
    ],
    defaults: {
      subject: "You're featured on our partners page — {{org.name}}",
      preheader: "{{partner.displayName}} is now live",
      blocks: [
        { ...h("You're on our partners page"), eyebrow: "Now live" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we're delighted to share that <strong>{{partner.displayName}}</strong> is now listed on the {{org.name}} partners page."),
        btn("See the partners page", "{{partner.pageUrl}}", {
          note: "Do share the link with your own network.",
        }),
        p("Thank you for standing with us — together we reach further."),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Peer-to-peer fundraisers ────────────────────────────────────────── */
  {
    key: "fundraiser.submittedAdminAlert",
    label: "Fundraiser submitted (staff alert)",
    group: "fundraisers",
    scope: "tenant",
    audience: "Charity staff",
    description: "Internal alert when a supporter submits a peer-to-peer fundraiser for approval.",
    variables: [
      v("fundraiser.title", "Fundraiser title", "Ellie's marathon for clean water"),
      v("fundraiser.goal", "Goal amount", 2000),
      v("fundraiser.currency", "Currency", "AUD"),
      v("fundraiser.organiser", "Organiser", "Ellie Nguyen"),
      v("fundraiser.organiserEmail", "Organiser email", "ellie@example.com"),
      v("fundraiser.story", "Story", "I'm running 42km to fund a well."),
      v("adminUrl", "Admin link", "https://hopetrust.donexus.app/admin/p2p-campaigns"),
    ],
    defaults: {
      subject: "New fundraiser request — {{org.name}}",
      preheader: "{{fundraiser.organiser}} wants to fundraise for you",
      blocks: [
        { ...h("New fundraiser request"), eyebrow: "Awaiting approval" },
        p("A supporter has created a fundraiser and is waiting for your approval."),
        hero("Their goal", "{{fundraiser.goal | money:fundraiser.currency}}", "{{fundraiser.title}}"),
        panel("Fundraiser", [
          { label: "Title", value: "{{fundraiser.title}}", strong: true },
          { label: "Organiser", value: "{{fundraiser.organiser}}" },
          { label: "Email", value: "{{fundraiser.organiserEmail}}" },
        ]),
        { ...p("<strong>Their story</strong><br/>{{fundraiser.story | nl2br}}"), showIf: "fundraiser.story" },
        btn("Review and approve", "{{adminUrl}}", {
          note: "Approved fundraisers go live on your site immediately.",
        }),
      ],
    },
  },
  {
    key: "fundraiser.statusUpdate",
    label: "Fundraiser approved or declined",
    group: "fundraisers",
    scope: "tenant",
    audience: "Fundraiser organiser",
    description: "Tells a supporter whether their fundraiser was approved. Use {{#if}} on the status to branch the wording.",
    variables: [
      ...RECIPIENT_VARS,
      v("fundraiser.title", "Fundraiser title", "Ellie's marathon for clean water"),
      v("fundraiser.status", "Status", "approved"),
      v("fundraiser.isApproved", "Approved?", true),
      v("fundraiser.url", "Public link", "https://hopetrust.org.au/p2p-campaigns/ellies-marathon"),
      v("reason", "Reason (if declined)", ""),
    ],
    defaults: {
      subject: "Your fundraiser has been {{fundraiser.status}} — {{org.name}}",
      preheader: "An update on {{fundraiser.title}}",
      blocks: [
        { ...h("Your fundraiser is live", { showIf: "fundraiser.isApproved" }), eyebrow: "Approved" },
        {
          ...p(
            "Hi {{recipient.firstName | default:\"there\"}}, great news — <strong>{{fundraiser.title}}</strong> has been approved and is now live. Share the link below to start raising.",
          ),
          showIf: "fundraiser.isApproved",
        },
        {
          ...btn("View your fundraiser", "{{fundraiser.url}}", {
            note: "Share this link — most fundraisers raise the bulk of their total in the first week.",
          }),
          showIf: "fundraiser.isApproved",
        },
        rawHtml(
          "{{#unless fundraiser.isApproved}}<h2 style=\"margin:0 0 12px;font-size:21px;\">An update on your fundraiser</h2>" +
            "<p style=\"margin:0 0 14px;line-height:1.65;\">Hi {{recipient.firstName | default:\"there\"}}, thank you for wanting to fundraise for {{org.name}}. " +
            "Unfortunately we're not able to approve <strong>{{fundraiser.title}}</strong> at this time.</p>" +
            "{{#if reason}}<p style=\"margin:0 0 14px;line-height:1.65;\"><strong>Reason:</strong> {{reason}}</p>{{/if}}" +
            "<p style=\"margin:0;line-height:1.65;\">Please reply to this email if you'd like to talk it through — we'd love to find a way forward.</p>{{/unless}}",
        ),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "fundraiser.donationThankYou",
    label: "Fundraiser donation thank-you",
    group: "fundraisers",
    scope: "tenant",
    audience: "Donor",
    description: "Thanks someone who donated to a supporter's peer-to-peer fundraiser.",
    variables: [
      ...DONOR_VARS,
      v("donation.amount", "Amount", 75),
      v("donation.currency", "Currency", "AUD"),
      v("fundraiser.title", "Fundraiser", "Ellie's marathon for clean water"),
      v("fundraiser.organiser", "Organiser", "Ellie Nguyen"),
      v("fundraiser.url", "Fundraiser link", "https://hopetrust.org.au/p2p-campaigns/ellies-marathon"),
      v("fundraiser.raised", "Total raised", 1450),
      v("fundraiser.goal", "Goal", 2000),
    ],
    defaults: {
      subject: "Thank you for your donation — {{org.name}}",
      preheader: "You supported {{fundraiser.title}}",
      blocks: [
        { ...h("Thank you, {{donor.firstName | default:\"friend\"}}"), eyebrow: "Gift received" },
        p("Your gift of <strong>{{donation.amount | money:donation.currency}}</strong> to <strong>{{fundraiser.title}}</strong> has been received."),
        stats([
          { label: "Raised so far", value: "{{fundraiser.raised | money:donation.currency}}" },
          { label: "Goal", value: "{{fundraiser.goal | money:donation.currency}}" },
        ]),
        panel("The fundraiser", [
          { label: "Organiser", value: "{{fundraiser.organiser}}", strong: true },
          { label: "Fundraiser", value: "{{fundraiser.title}}" },
        ]),
        btn("See the fundraiser", "{{fundraiser.url}}", {
          note: "Every gift moves this closer. Thank you for being part of it.",
        }),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Programs ────────────────────────────────────────────────────────── */
  {
    key: "program.update",
    label: "Program update",
    group: "programs",
    scope: "tenant",
    audience: "Donor",
    description: "Progress update sent to everyone who donated to a program.",
    variables: [
      ...RECIPIENT_VARS,
      v("program.title", "Program title", "Clean Water Wells"),
      v("program.url", "Program link", "https://hopetrust.org.au/programs/clean-water"),
      v("program.raised", "Raised", 18400),
      v("program.goal", "Goal", 25000),
      v("program.currency", "Currency", "AUD"),
      v("update.title", "Update title", "The first well is finished"),
      v("update.body", "Update body", "Thanks to you, 400 people now have safe water within a ten-minute walk."),
      v("update.image", "Update image URL", ""),
    ],
    defaults: {
      subject: "Update: {{program.title}}",
      preheader: "{{update.title}}",
      blocks: [
        { ...h("{{update.title | default:\"An update from the field\"}}"), eyebrow: "{{program.title}}" },
        p("Hi {{recipient.firstName | default:\"there\"}}, here's what your support for <strong>{{program.title}}</strong> has made possible."),
        { ...{ type: "image", src: "{{update.image}}", alt: "{{update.title}}", align: "center" }, showIf: "update.image" },
        p("{{update.body | nl2br}}"),
        stats([
          { label: "Raised", value: "{{program.raised | money:program.currency}}" },
          { label: "Goal", value: "{{program.goal | money:program.currency}}" },
        ]),
        btn("See the program", "{{program.url}}", {
          note: "Progress, photos and the full story live on the program page.",
        }),
        rule(),
        signOff(),
      ],
    },
  },
  {
    key: "program.completed",
    label: "Program completed",
    group: "programs",
    scope: "tenant",
    audience: "Donor",
    description: "Celebrates a finished program with the donors who funded it.",
    variables: [
      ...RECIPIENT_VARS,
      v("program.title", "Program title", "Clean Water Wells"),
      v("program.url", "Program link", "https://hopetrust.org.au/programs/clean-water"),
      v("program.raised", "Total raised", 25000),
      v("program.currency", "Currency", "AUD"),
      v("program.summary", "Closing summary", "Three wells built, 1,200 people reached."),
    ],
    defaults: {
      subject: "Completed: {{program.title}}",
      preheader: "You helped finish this",
      blocks: [
        { ...h("{{program.title}} is complete"), eyebrow: "Funded and finished" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we're thrilled to tell you that <strong>{{program.title}}</strong> has reached completion — because of supporters like you."),
        hero("Raised in total", "{{program.raised | money:program.currency}}", "{{program.title}}"),
        { ...p("{{program.summary | nl2br}}"), showIf: "program.summary" },
        btn("See the results", "{{program.url}}", {
          note: "Photos and the closing report are on the program page.",
        }),
        rule(),
        signOff(),
      ],
    },
  },

  /* ── Enquiries ───────────────────────────────────────────────────────── */
  {
    key: "contact.reply",
    label: "Reply to a website enquiry",
    group: "enquiries",
    scope: "tenant",
    audience: "Website visitor",
    description:
      "The wrapper around a staff member's typed reply to a contact-form message. Edit the framing, not the reply itself — that comes from {{message.body}}.",
    variables: [
      ...RECIPIENT_VARS,
      v("message.body", "Staff reply", "Thanks for getting in touch — we run tours on the first Saturday of each month."),
      v("message.originalSubject", "Original subject", "Visiting your centre"),
      v("staff.name", "Replying staff member", "Marcus Hill"),
    ],
    defaults: {
      subject: "Re: {{message.originalSubject}}",
      preheader: "A reply from {{org.name}}",
      blocks: [
        p("Hi {{recipient.firstName | default:\"there\"}},"),
        p("{{{message.body}}}"),
        rule(),
        {
          type: "signature",
          note: "",
          name: "{{staff.name}}",
          role: "{{org.name}}",
          showIf: "staff.name",
        },
        { ...signOff(), showIf: "!staff.name" },
      ],
    },
  },
  {
    key: "contactQuery.reply",
    label: "Reply to a platform enquiry",
    group: "enquiries",
    scope: "platform",
    audience: "Website visitor",
    description: "The wrapper around an operator's reply to an enquiry from the platform's own marketing site.",
    variables: [
      ...RECIPIENT_VARS,
      v("message.body", "Operator reply", "Happy to walk you through pricing — are you free Thursday?"),
      v("message.originalSubject", "Original subject", "Pricing question"),
      v("staff.name", "Replying operator", "Aisha Khan"),
    ],
    defaults: {
      subject: "Re: {{message.originalSubject}}",
      preheader: "A reply from {{platform.name}}",
      blocks: [
        p("Hi {{recipient.firstName | default:\"there\"}},"),
        p("{{{message.body}}}"),
        rule(),
        {
          type: "signature",
          note: "",
          name: "{{staff.name}}",
          role: "{{platform.name}}",
          showIf: "staff.name",
        },
        { ...signOff("The {{platform.name}} team"), showIf: "!staff.name" },
      ],
    },
  },

  /* ── Tenant lifecycle (platform → charity) ───────────────────────────── */
  {
    key: "tenant.welcome",
    label: "Charity portal is ready",
    group: "tenant",
    scope: "platform",
    audience: "Charity admin",
    required: true,
    description:
      "The activation email — the new charity's admin gets their portal URL and credentials. Cannot be disabled: without it a paying customer can't log in.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Hope Trust"),
      v("tenant.portalUrl", "Portal URL", "https://hopetrust.donexus.app"),
      v("tenant.loginUrl", "Login URL", "https://hopetrust.donexus.app/admin"),
      v("tenant.adminEmail", "Admin email", "admin@hopetrust.org.au"),
      v("tenant.password", "Temporary password", "Xk8-2mQp"),
      v("tenant.setPasswordUrl", "Set-password link", ""),
      v("tenant.plan", "Plan", "Growth"),
      v("tenant.billingCycle", "Billing cycle", "Monthly"),
    ],
    defaults: {
      subject: "Welcome to {{tenant.name}} — your portal is ready!",
      preheader: "Log in and make it yours",
      blocks: [
        { ...h("Your portal is ready"), eyebrow: "Welcome to {{platform.name}}" },
        p("<strong>{{tenant.name}}</strong> is set up and waiting for you. Here is everything you need to get in."),
        panel("Your login", [
          { label: "Portal", value: "{{tenant.portalUrl}}", strong: true },
          { label: "Email", value: "{{tenant.adminEmail}}" },
          { label: "Password", value: "{{tenant.password}}", showIf: "tenant.password" },
          { label: "Plan", value: "{{tenant.plan}}", showIf: "tenant.plan" },
          { label: "Billing", value: "{{tenant.billingCycle}}", showIf: "tenant.billingCycle" },
        ]),
        // Provisioned admins set their own password from a link; self-serve
        // signups already have one, so they go straight to the login page.
        {
          ...p("Before you log in, choose your password:"),
          showIf: "tenant.setPasswordUrl",
        },
        {
          ...btn("Set your password", "{{tenant.setPasswordUrl}}"),
          showIf: "tenant.setPasswordUrl",
        },
        {
          ...btn("Log in to your portal", "{{tenant.loginUrl}}"),
          showIf: "!tenant.setPasswordUrl",
        },
        {
          ...callout("Please change your password the first time you log in.", "warning"),
          showIf: "tenant.password",
        },
        rule(),
        { ...h3("A good first hour"), eyebrow: "What to do next" },
        steps([
          { title: "Make it yours", text: "Upload your logo and set your brand colours — every email we send on your behalf picks them up automatically." },
          { title: "Turn on payments", text: "Add your Stripe or bank details so you can start taking donations." },
          { title: "Publish something", text: "Your first program or appeal gives supporters somewhere to give." },
          { title: "Bring your team", text: "Invite the people who will run it day to day." },
        ]),
        p("Any questions at all, just reply to this email — we read every one."),
        signOff("The {{platform.name}} team"),
      ],
    },
  },
  {
    key: "tenant.paymentFailed",
    label: "Subscription payment failed",
    group: "tenant",
    scope: "platform",
    audience: "Charity admin",
    required: true,
    description: "Dunning notice when a charity's own subscription payment fails. Cannot be disabled — it precedes suspension.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Hope Trust"),
      v("tenant.plan", "Plan", "Growth"),
      v("billing.amount", "Amount due", 79),
      v("billing.currency", "Currency", "AUD"),
      v("billing.retryDate", "Next retry", "2026-09-02T00:00:00.000Z"),
      v("billing.updateUrl", "Update payment link", "https://donexus.app/billing"),
    ],
    defaults: {
      subject: "{{tenant.name}} — payment failed",
      preheader: "Please update your payment details",
      blocks: [
        { ...h("We couldn't process your payment"), eyebrow: "Action needed" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we tried to charge your card for the <strong>{{tenant.plan}}</strong> plan and it didn't go through."),
        hero(
          "Amount due",
          "{{billing.amount | money:billing.currency}}",
          "{{#if billing.retryDate}}We try again on {{billing.retryDate | date}}{{/if}}",
        ),
        panel("Payment", [
          { label: "Plan", value: "{{tenant.plan}}", strong: true },
          { label: "Next attempt", value: "{{billing.retryDate | date}}", showIf: "billing.retryDate" },
        ]),
        btn("Update payment details", "{{billing.updateUrl}}", {
          note: "Takes a minute, and the next attempt goes through automatically.",
        }),
        callout(
          "Your portal keeps working for now. If the payment still fails after our final attempt, access will be paused.",
          "warning",
        ),
        rule(),
        p("If you think this is a mistake, reply to this email and we'll sort it out."),
      ],
    },
  },
  {
    key: "tenant.subscriptionCancelled",
    label: "Charity subscription cancelled",
    group: "tenant",
    scope: "platform",
    audience: "Charity admin",
    description: "Confirms a charity's platform subscription has ended, and what happens to their data.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Hope Trust"),
      v("tenant.plan", "Plan", "Growth"),
      v("billing.accessUntil", "Access until", "2026-09-30T00:00:00.000Z"),
      v("billing.reactivateUrl", "Reactivate link", "https://donexus.app/billing"),
    ],
    defaults: {
      subject: "{{tenant.name}} — subscription cancelled",
      preheader: "Your access ends {{billing.accessUntil | date}}",
      blocks: [
        { ...h("Your subscription has been cancelled"), eyebrow: "Confirmed" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we've cancelled the {{tenant.plan}} subscription for <strong>{{tenant.name}}</strong>."),
        {
          ...hero("You keep access until", "{{billing.accessUntil | date}}", "Nothing is deleted after that date."),
          showIf: "billing.accessUntil",
        },
        panel("What happens now", [
          { label: "Plan", value: "{{tenant.plan}}", strong: true },
          { label: "Access until", value: "{{billing.accessUntil | date}}", showIf: "billing.accessUntil" },
        ]),
        p("Your data is kept safe and nothing is deleted. Reactivate any time and pick up exactly where you left off."),
        btn("Reactivate", "{{billing.reactivateUrl}}", {
          note: "Everything comes back exactly as you left it.",
        }),
        rule(),
        p("If there's something we could have done better, we'd genuinely like to hear it — just reply."),
      ],
    },
  },

  {
    key: "tenant.brandingDecision",
    label: "Branding request decision",
    group: "tenant",
    scope: "platform",
    audience: "Charity admin",
    description:
      "Tells a charity whether the branding change they submitted for review was approved. Use the approved flag to branch the wording.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Hope Trust"),
      v("branding.approved", "Approved?", true),
      v("branding.note", "Note from the reviewer", "Lovely palette — the contrast on the CTA needed a nudge."),
      v("branding.settingsUrl", "Branding settings link", "https://hopetrust.donexus.app/admin/branding"),
    ],
    defaults: {
      subject: "{{#if branding.approved}}Your branding change for {{tenant.name}} was approved{{else}}Update on your branding change for {{tenant.name}}{{/if}}",
      preheader: "A decision on your branding request",
      blocks: [
        { ...h("Branding change approved"), eyebrow: "Reviewed", showIf: "branding.approved" },
        {
          ...p(
            "Good news — the branding changes you requested for <strong>{{tenant.name}}</strong> have been approved and are now live on your site. You may need to refresh to see them.",
          ),
          showIf: "branding.approved",
        },
        { ...h("Branding change not approved"), eyebrow: "Reviewed", showIf: "!branding.approved" },
        {
          ...p(
            "We reviewed the branding changes you requested for <strong>{{tenant.name}}</strong>, and they weren't applied this time. You can adjust and submit a new request any time from your admin settings.",
          ),
          showIf: "!branding.approved",
        },
        {
          ...callout("<strong>Note from the team:</strong> {{branding.note | nl2br}}", "neutral"),
          showIf: "branding.note",
        },
        {
          ...btn("Open branding settings", "{{branding.settingsUrl}}", {
            note: "Colours and logos apply across your site and every email we send for you.",
          }),
          showIf: "branding.settingsUrl",
        },
      ],
    },
  },

  /* ── Sales & leads (platform) ────────────────────────────────────────── */
  {
    key: "lead.newLeadAlert",
    label: "New lead (team alert)",
    group: "sales",
    scope: "platform",
    audience: "Platform team",
    description: "Internal alert when someone enquires through the platform marketing site.",
    variables: [
      v("lead.orgName", "Organisation", "Riverbank Care"),
      v("lead.contactName", "Contact", "Priya Sharma"),
      v("lead.contactEmail", "Email", "priya@riverbank.org"),
      v("lead.contactPhone", "Phone", "0400 333 444"),
      v("lead.plan", "Plan of interest", "Growth"),
      v("lead.message", "Message", "We're moving off spreadsheets and need something fast."),
      v("lead.url", "Lead link", "https://donexus.app/leads/123"),
    ],
    defaults: {
      subject: "New lead: {{lead.orgName}}",
      preheader: "{{lead.contactName}} — {{lead.plan}}",
      blocks: [
        { ...h("New lead"), eyebrow: "{{lead.plan | default:\"Enquiry\"}}" },
        panel("Contact", [
          { label: "Organisation", value: "{{lead.orgName}}", strong: true },
          { label: "Name", value: "{{lead.contactName}}" },
          { label: "Email", value: "{{lead.contactEmail}}" },
          { label: "Phone", value: "{{lead.contactPhone}}", showIf: "lead.contactPhone" },
          { label: "Plan", value: "{{lead.plan}}", showIf: "lead.plan" },
        ]),
        { ...p("<strong>Message</strong><br/>{{lead.message | nl2br}}"), showIf: "lead.message" },
        btn("Open the lead", "{{lead.url}}", {
          note: "Leads answered within the hour convert best.",
        }),
      ],
    },
  },
  {
    key: "lead.reply",
    label: "Reply to a lead",
    group: "sales",
    scope: "platform",
    audience: "Prospect",
    description: "The wrapper around an operator's typed reply to a sales lead.",
    variables: [
      ...RECIPIENT_VARS,
      v("lead.orgName", "Their organisation", "Riverbank Care"),
      v("message.body", "Operator reply", "Happy to set up a demo — does Tuesday 2pm suit?"),
      v("staff.name", "Replying operator", "Aisha Khan"),
    ],
    defaults: {
      subject: "Re: {{lead.orgName}}",
      preheader: "A reply from {{platform.name}}",
      blocks: [
        p("Hi {{recipient.firstName | default:\"there\"}},"),
        p("{{{message.body}}}"),
        rule(),
        {
          type: "signature",
          note: "",
          name: "{{staff.name}}",
          role: "{{platform.name}}",
          showIf: "staff.name",
        },
        { ...signOff("The {{platform.name}} team"), showIf: "!staff.name" },
      ],
    },
  },
  {
    key: "lead.onboardingInvite",
    label: "Onboarding invite",
    group: "sales",
    scope: "platform",
    audience: "Prospect",
    description: "Sent when a lead is converted — invites them to finish setting up their charity's portal.",
    variables: [
      ...RECIPIENT_VARS,
      v("lead.orgName", "Organisation", "Riverbank Care"),
      v("onboarding.url", "Set-up link", "https://donexus.app/onboarding/abc123"),
      v("onboarding.expiresIn", "Link lifetime", "7 days"),
    ],
    defaults: {
      subject: "Let's get {{lead.orgName}} set up",
      preheader: "Your set-up link is inside",
      blocks: [
        { ...h("Let's get you started"), eyebrow: "{{lead.orgName}}" },
        p("Hi {{recipient.firstName | default:\"there\"}}, great news — we've prepared everything for <strong>{{lead.orgName}}</strong>. Click below to finish setting up your portal."),
        btn("Complete set-up", "{{onboarding.url}}", {
          note: "Valid for {{onboarding.expiresIn}}, and it takes about five minutes.",
        }),
        rule(),
        { ...h3("What you'll do"), eyebrow: "Three steps" },
        steps([
          { title: "Confirm your details", text: "Your name, contact and the web address supporters will use." },
          { title: "Add your branding", text: "Your logo and colours — your site and your emails follow them." },
          { title: "Go live", text: "Publish your first appeal and start taking donations." },
        ]),
        p("Questions before you start? Just reply — a real person reads this inbox."),
        signOff("The {{platform.name}} team"),
      ],
    },
  },
  {
    key: "lead.convertedWelcome",
    label: "Converted lead welcome",
    group: "sales",
    scope: "platform",
    audience: "Charity admin",
    description: "Welcomes a converted lead and points them at their new account.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Riverbank Care"),
      v("tenant.loginUrl", "Login URL", "https://riverbank.donexus.app/admin"),
      v("tenant.adminEmail", "Admin email", "priya@riverbank.org"),
    ],
    defaults: {
      subject: "Welcome to {{tenant.name}} — set up your account",
      preheader: "Your account is waiting",
      blocks: [
        { ...h("Welcome aboard"), eyebrow: "{{tenant.name}}" },
        p("Hi {{recipient.firstName | default:\"there\"}}, <strong>{{tenant.name}}</strong> is ready on {{platform.name}}."),
        panel("Your account", [
          { label: "Login", value: "{{tenant.loginUrl}}", strong: true },
          { label: "Email", value: "{{tenant.adminEmail}}" },
        ]),
        btn("Set up my account", "{{tenant.loginUrl}}", {
          note: "Worth bookmarking — this is your admin portal from now on.",
        }),
        rule(),
        signOff("The {{platform.name}} team"),
      ],
    },
  },
  {
    key: "lead.paymentPending",
    label: "Ready — payment outstanding",
    group: "sales",
    scope: "platform",
    audience: "Charity admin",
    description: "Everything is built and waiting; only the first payment is outstanding.",
    variables: [
      ...RECIPIENT_VARS,
      v("tenant.name", "Charity name", "Riverbank Care"),
      v("billing.amount", "Amount due", 79),
      v("billing.currency", "Currency", "AUD"),
      v("billing.plan", "Plan", "Growth"),
      v("billing.payUrl", "Payment link", "https://donexus.app/checkout/abc123"),
    ],
    defaults: {
      subject: "{{tenant.name}} is ready — just payment left",
      preheader: "One step to go",
      blocks: [
        { ...h("Everything's ready for you"), eyebrow: "One step left" },
        p("Hi {{recipient.firstName | default:\"there\"}}, <strong>{{tenant.name}}</strong> is built and waiting. The only thing left is your first payment."),
        hero("Amount due", "{{billing.amount | money:billing.currency}}", "{{billing.plan}} plan"),
        btn("Complete payment", "{{billing.payUrl}}", {
          note: "Your portal goes live the moment this clears.",
        }),
        rule(),
        signOff("The {{platform.name}} team"),
      ],
    },
  },

  /* ── Helpdesk ────────────────────────────────────────────────────────── */
  {
    key: "support.ticketReply",
    label: "Support ticket reply",
    group: "support",
    scope: "platform",
    audience: "Charity admin",
    description: "The wrapper around a support agent's reply on a ticket.",
    variables: [
      ...RECIPIENT_VARS,
      v("ticket.number", "Ticket number", "1042"),
      v("ticket.summary", "Ticket summary", "Receipts not sending"),
      v("ticket.url", "Ticket link", "https://hopetrust.donexus.app/admin/support/1042"),
      v("message.body", "Agent reply", "We've found the cause — your SMTP password had expired. Updated and tested."),
      v("staff.name", "Agent", "Marcus Hill"),
    ],
    defaults: {
      subject: "Re: [#{{ticket.number}}] {{ticket.summary}}",
      preheader: "An update on your support ticket",
      blocks: [
        p("Hi {{recipient.firstName | default:\"there\"}},"),
        p("{{message.body | nl2br}}"),
        btn("View the ticket", "{{ticket.url}}", {
          note: "Replying to this email lands straight on the ticket.",
        }),
        rule(),
        {
          type: "signature",
          note: "",
          name: "{{staff.name}}",
          role: "{{platform.name}} support · Ticket #{{ticket.number}}",
          showIf: "staff.name",
        },
        {
          ...p("The {{platform.name}} support team · Ticket #{{ticket.number}}", { size: 13, color: "#6b7280" }),
          showIf: "!staff.name",
        },
      ],
    },
  },
  {
    key: "support.satisfactionSurvey",
    label: "Support satisfaction survey",
    group: "support",
    scope: "platform",
    audience: "Charity admin",
    description: "Asks for a CSAT rating after a ticket is resolved.",
    variables: [
      ...RECIPIENT_VARS,
      v("ticket.number", "Ticket number", "1042"),
      v("ticket.summary", "Ticket summary", "Receipts not sending"),
      v("survey.url", "Rating link", "https://hopetrust.donexus.app/support/feedback/abc123"),
    ],
    defaults: {
      subject: "How did we do? [#{{ticket.number}}] {{ticket.summary}}",
      preheader: "One click, that's all",
      blocks: [
        { ...h("How did we do?"), eyebrow: "Ticket #{{ticket.number}}" },
        p("Hi {{recipient.firstName | default:\"there\"}}, we've closed ticket <strong>#{{ticket.number}}</strong> — {{ticket.summary}}."),
        btn("Rate your support experience", "{{survey.url}}", {
          note: "It takes a few seconds, and it genuinely helps us improve.",
        }),
        rule(),
        p(
          "Button not working? Paste this into your browser:<br/>{{survey.url}}",
          { size: 12, color: "#6b7280", align: "center" },
        ),
      ],
    },
  },

  /* ── Platform team ───────────────────────────────────────────────────── */
  {
    key: "operator.invite",
    label: "Platform team invite",
    group: "operators",
    scope: "platform",
    audience: "Platform operator",
    required: true,
    description: "Invites a new operator to the platform console. Cannot be disabled — the link is the only way in.",
    variables: [
      ...RECIPIENT_VARS,
      v("invite.url", "Accept link", "https://donexus.app/accept-invite/abc123"),
      v("invite.role", "Role", "Support Agent"),
      v("invite.expiresIn", "Link lifetime", "48 hours"),
      v("invitedBy", "Invited by", "Aisha Khan"),
    ],
    defaults: {
      subject: "You're invited to the {{platform.name}} team",
      preheader: "Accept your invite to the platform console",
      blocks: [
        { ...h("You've been invited"), eyebrow: "{{platform.name}} console" },
        p(
          "{{invitedBy | default:\"A colleague\"}} has invited you to join the <strong>{{platform.name}}</strong> platform console.",
        ),
        hero("Your role", "{{invite.role}}", "Access begins as soon as you accept."),
        btn("Accept invitation", "{{invite.url}}", {
          note: "This link expires in {{invite.expiresIn}}. If you weren't expecting it, ignore this email — nothing will happen.",
        }),
        rule(),
        steps([
          { title: "Accept the invite", text: "The link above signs you in and sets your password." },
          { title: "Turn on two-factor", text: "Required before you can reach tenant data." },
          { title: "You're in", text: "Your role decides what you can see and change." },
        ]),
      ],
    },
  },
  {
    key: "operator.inviteResend",
    label: "Platform team invite (resent)",
    group: "operators",
    scope: "platform",
    audience: "Platform operator",
    required: true,
    description: "A reminder of an outstanding console invite, with a fresh link.",
    variables: [
      ...RECIPIENT_VARS,
      v("invite.url", "Accept link", "https://donexus.app/accept-invite/abc123"),
      v("invite.role", "Role", "Support Agent"),
      v("invite.expiresIn", "Link lifetime", "48 hours"),
    ],
    defaults: {
      subject: "Your {{platform.name}} team invite",
      preheader: "Here's a fresh link",
      blocks: [
        { ...h("Your invite is waiting"), eyebrow: "{{platform.name}} console" },
        p("Here's a fresh link to join the <strong>{{platform.name}}</strong> platform console. The previous one has been replaced, so use this."),
        hero("Your role", "{{invite.role}}", "Access begins as soon as you accept."),
        btn("Accept invitation", "{{invite.url}}", {
          note: "This link expires in {{invite.expiresIn}}. The earlier link no longer works.",
        }),
        rule(),
        steps([
          { title: "Accept the invite", text: "The link above signs you in and sets your password." },
          { title: "Turn on two-factor", text: "Required before you can reach tenant data." },
          { title: "You're in", text: "Your role decides what you can see and change." },
        ]),
      ],
    },
  },
  {
    key: "operator.passwordResetCode",
    label: "Operator password reset code",
    group: "operators",
    scope: "platform",
    audience: "Platform operator",
    required: true,
    description: "The six-digit code an operator needs to reset their console password. Security-critical.",
    variables: [
      ...RECIPIENT_VARS,
      v("reset.code", "Reset code", "418302"),
      v("reset.expiresIn", "Code lifetime", "10 minutes"),
    ],
    defaults: {
      subject: "Your {{platform.name}} password reset code",
      preheader: "Code expires in {{reset.expiresIn}}",
      blocks: [
        { ...h("Your reset code"), eyebrow: "Security" },
        p("Use this code to reset your {{platform.name}} console password."),
        // A hero rather than a hand-styled chip: it takes the platform's palette
        // instead of hardcoding grey, and the figure is already the right size.
        hero("Reset code", "{{reset.code}}", "Expires in {{reset.expiresIn}}", { mono: true }),
        callout(
          "If you didn't request this, ignore this email and consider changing your password — someone may know your address.",
          "danger",
        ),
      ],
    },
  },
];

/* -- derived indexes + helpers -------------------------------------------- */

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

/** Variables every template can use, regardless of what its call site passes. */
function commonVariables(scope) {
  return scope === "platform" ? [...PLATFORM_VARS, ...RECIPIENT_VARS] : [...ORG_VARS, ...PLATFORM_VARS];
}

/**
 * The full variable palette for a template: its own declared variables plus the
 * common ones, de-duplicated (a template may redeclare `recipient.*` with a
 * better sample value, and its own declaration should win).
 */
function variablesFor(key) {
  const tpl = BY_KEY.get(key);
  if (!tpl) return [];
  const seen = new Map();
  for (const item of [...(tpl.variables || []), ...commonVariables(tpl.scope)]) {
    if (!seen.has(item.key)) seen.set(item.key, item);
  }
  return [...seen.values()];
}

/** Nest the flat `a.b` variable list into the object shape the renderer walks. */
function sampleContext(key) {
  const ctx = {};
  for (const item of variablesFor(key)) {
    const parts = item.key.split(".");
    let cur = ctx;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) cur[part] = item.sample;
      else cur = cur[part] = cur[part] && typeof cur[part] === "object" ? cur[part] : {};
    });
  }
  return ctx;
}

/**
 * Blocks are stored with stable ids so the builder's drag-and-drop and React
 * keys survive a round trip. Authoring them here without ids keeps this file
 * readable, so they are stamped on the way out.
 */
function withIds(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((b, i) => ({ id: b.id || `b${i + 1}`, ...b }));
}

/** The shipped default template for a key, ready to render or to seed an editor. */
function defaultsFor(key) {
  const tpl = BY_KEY.get(key);
  if (!tpl) return null;
  return {
    subject: tpl.defaults.subject,
    preheader: tpl.defaults.preheader || "",
    mode: "blocks",
    blocks: withIds(tpl.defaults.blocks),
    html: "",
  };
}

const get = (key) => BY_KEY.get(key) || null;
const has = (key) => BY_KEY.has(key);
const allKeys = () => TEMPLATES.map((t) => t.key);

module.exports = {
  GROUPS,
  TEMPLATES,
  get,
  has,
  allKeys,
  variablesFor,
  sampleContext,
  defaultsFor,
  withIds,
  commonVariables,
};
