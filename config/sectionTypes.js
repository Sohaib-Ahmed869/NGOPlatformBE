/**
 * Section (block) type registry — the catalog for the dynamic, section-based
 * page builder. Each entry defines a block type's editor `schema` (reusing the
 * SAME field types as config/pageTemplates.js: text | textarea | image | list
 * with itemFields) and its `defaults`.
 *
 * This is the single source of truth for section structure. The frontend pairs
 * each `type` with an icon + a renderer component (src/config/sectionTypes.jsx)
 * and reuses these schemas to render the per-section editor.
 *
 * Stored shape (in Page.content.sections):
 *   { id: string, type: string, archived: boolean, data: { ...schema fields } }
 */

// Shown as help text on user-editable icon fields. These names map to lucide
// components via the frontend ICONS registry in src/components/giving.jsx.
const ICON_HELP =
  "Icon name — one of: Moon, Calculator, Coins, HandHeart, HandCoins, Sparkles, Gem, ShieldCheck, Heart, Star, Wallet, TrendingUp, Briefcase, Scale, ArrowRight, Target, LayoutGrid, GraduationCap, Droplets, Utensils, LifeBuoy";

const SECTION_TYPES = [
  /* ── Hero banner ──────────────────────────────────────────────────── */
  {
    type: "hero",
    label: "Hero banner",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Title", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      { name: "image", label: "Background image", type: "image" },
      { name: "icon", label: "Eyebrow icon", type: "text", help: ICON_HELP },
      { name: "primaryCtaText", label: "Primary button text", type: "text" },
      { name: "primaryCtaLink", label: "Primary button link", type: "text" },
      { name: "secondaryCtaText", label: "Secondary button text", type: "text" },
      { name: "secondaryCtaLink", label: "Secondary button link", type: "text" },
    ],
    defaults: {
      eyebrow: "Who we are",
      title: "About Us",
      subtitle: "Our mission to create lasting, measurable change in the communities we serve.",
      image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1600&q=80",
      icon: "HandHeart",
      primaryCtaText: "Support our work",
      primaryCtaLink: "/donate",
      secondaryCtaText: "Get in touch",
      secondaryCtaLink: "/contact-us",
    },
  },

  /* ── Rich text / heading ──────────────────────────────────────────── */
  {
    type: "richText",
    label: "Text block",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      { name: "body", label: "Body", type: "textarea" },
      { name: "center", label: "Centered? (yes/no)", type: "text", help: "Type 'yes' to centre the text." },
    ],
    defaults: {
      eyebrow: "Our story",
      heading: "Why we exist",
      body: "<p>Share your organisation's story, mission and values here. Use the editor to add headings, lists and links.</p>",
      center: "no",
    },
  },

  /* ── Card / feature grid ──────────────────────────────────────────── */
  {
    type: "cardGrid",
    label: "Card grid",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      { name: "intro", label: "Intro", type: "textarea" },
      {
        name: "items",
        label: "Cards",
        type: "list",
        itemFields: [
          { name: "image", label: "Image", type: "image" },
          { name: "title", label: "Title", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          { name: "link", label: "Link", type: "text" },
        ],
      },
    ],
    defaults: {
      eyebrow: "Get to know us",
      heading: "The people and purpose behind our work",
      intro: "From our mission and leadership to our partners and impact — here's what drives everything we do.",
      items: [
        { image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=600&q=80", title: "Our Vision & Mission", description: "We are committed to serving underprivileged communities with meaningful, lasting impact.", link: "/about-us" },
        { image: "https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=600&q=80", title: "Our Leadership", description: "Meet the dedicated team behind our vision — diverse expertise and a shared passion for change.", link: "/about-us" },
        { image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=600&q=80", title: "Our Partners", description: "We work with organisations and individuals who share our mission.", link: "/our-partners" },
        { image: "https://images.unsplash.com/photo-1526958097901-5e6d742d3371?w=600&q=80", title: "Our Impact", description: "Explore how we are empowering communities and creating sustainable solutions.", link: "/about-us" },
      ],
    },
  },

  /* ── Icon feature grid ────────────────────────────────────────────── */
  {
    type: "featureGrid",
    label: "Feature grid (icons)",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      { name: "intro", label: "Intro", type: "textarea" },
      {
        name: "items",
        label: "Features",
        type: "list",
        itemFields: [
          { name: "icon", label: "Icon", type: "text", help: ICON_HELP },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Description", type: "textarea" },
          { name: "link", label: "Link (optional)", type: "text" },
        ],
      },
    ],
    defaults: {
      eyebrow: "What drives us",
      heading: "Our guiding principles",
      intro: "The values that anchor everything we do.",
      items: [
        { icon: "Target", title: "Our Mission", text: "What we set out to achieve every day.", link: "" },
        { icon: "Eye", title: "Our Vision", text: "The future we're working towards.", link: "" },
        { icon: "Heart", title: "Our Values", text: "The principles that guide our decisions.", link: "" },
      ],
    },
  },

  /* ── Image + text split ───────────────────────────────────────────── */
  {
    type: "imageText",
    label: "Image + text",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      { name: "body", label: "Body", type: "textarea" },
      { name: "image", label: "Image", type: "image" },
      { name: "videoId", label: "Video (YouTube) — optional", type: "text", help: "Paste a YouTube link or ID to show a video instead of the image." },
      { name: "imageSide", label: "Image side (left/right)", type: "text", help: "Type 'left' or 'right'." },
      { name: "ctaText", label: "Button text", type: "text" },
      { name: "ctaLink", label: "Button link", type: "text" },
    ],
    defaults: {
      eyebrow: "Our approach",
      heading: "Real change, delivered with care",
      body: "<p>Describe how your organisation works on the ground — your process, transparency and the outcomes you deliver.</p>",
      image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=1000&q=80",
      imageSide: "right",
      ctaText: "Learn more",
      ctaLink: "/initiatives",
    },
  },

  /* ── Stats band ───────────────────────────────────────────────────── */
  {
    type: "statsBand",
    label: "Stats band",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      {
        name: "items",
        label: "Stats",
        type: "list",
        itemFields: [
          { name: "value", label: "Value", type: "text" },
          { name: "label", label: "Label", type: "text" },
        ],
      },
    ],
    defaults: {
      eyebrow: "Our impact",
      heading: "The difference we've made together",
      items: [
        { value: "$2.4M+", label: "Raised" },
        { value: "48K+", label: "Lives impacted" },
        { value: "120+", label: "Projects" },
        { value: "30+", label: "Countries" },
      ],
    },
  },

  /* ── Team grid ────────────────────────────────────────────────────── */
  {
    type: "teamGrid",
    label: "Team grid",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      { name: "intro", label: "Intro", type: "textarea" },
      {
        name: "items",
        label: "Team members",
        type: "list",
        itemFields: [
          { name: "photo", label: "Photo", type: "image" },
          { name: "name", label: "Name", type: "text" },
          { name: "role", label: "Role", type: "text" },
          { name: "bio", label: "Bio", type: "textarea" },
        ],
      },
    ],
    defaults: {
      eyebrow: "Our people",
      heading: "Meet the team",
      intro: "The people who make our mission possible.",
      items: [
        { photo: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400&fit=crop&q=80", name: "Aisha Khan", role: "Founder & CEO", bio: "Leads our vision and strategy." },
        { photo: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=400&fit=crop&q=80", name: "Sara Ahmed", role: "Programs Director", bio: "Oversees field operations and impact." },
        { photo: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop&q=80", name: "Omar Farooq", role: "Head of Partnerships", bio: "Builds the relationships that extend our reach." },
      ],
    },
  },

  /* ── Logos / partners strip ───────────────────────────────────────── */
  {
    type: "logosStrip",
    label: "Logos strip",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      {
        name: "source",
        label: "Logos source",
        type: "select",
        options: [
          { value: "manual", label: "Manual list only" },
          { value: "approved", label: "Approved partners (from the form)" },
          { value: "both", label: "Both — manual list + approved partners" },
        ],
        help: "“Approved partners” pulls logos from “Become a partner” submissions that an admin has approved and set to show on the website (Admin → Partners).",
      },
      {
        name: "items",
        label: "Logos (manual)",
        type: "list",
        itemFields: [
          { name: "logo", label: "Logo / image", type: "image" },
          { name: "name", label: "Name", type: "text" },
        ],
      },
    ],
    defaults: {
      eyebrow: "Trusted by",
      heading: "Our partners",
      // Default to merging approved "Become a partner" submissions with the
      // curated logos below, so the partner wall is dynamic out of the box.
      source: "both",
      items: [
        { logo: "https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=240&q=80", name: "Partner One" },
        { logo: "https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=240&q=80", name: "Partner Two" },
        { logo: "https://images.unsplash.com/photo-1611162618071-b39a2ec055fb?w=240&q=80", name: "Partner Three" },
        { logo: "https://images.unsplash.com/photo-1611162616305-c69b3fa7fbe0?w=240&q=80", name: "Partner Four" },
      ],
    },
  },

  /* ── Quote / testimonial ──────────────────────────────────────────── */
  {
    type: "quote",
    label: "Quote",
    schema: [
      { name: "quote", label: "Quote", type: "textarea" },
      { name: "author", label: "Author", type: "text" },
      { name: "role", label: "Author role", type: "text" },
      { name: "photo", label: "Author photo", type: "image" },
    ],
    defaults: {
      quote: "Their work changed my family's life. We finally have clean water and hope for the future.",
      author: "Fatima",
      role: "Community member",
      photo: "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=200&h=200&fit=crop&q=80",
    },
  },

  /* ── CTA band ─────────────────────────────────────────────────────── */
  {
    type: "ctaBand",
    label: "Call to action",
    schema: [
      { name: "title", label: "Title", type: "text" },
      { name: "text", label: "Text", type: "textarea" },
      { name: "primaryCtaText", label: "Primary button text", type: "text" },
      { name: "primaryCtaLink", label: "Primary button link", type: "text" },
      { name: "secondaryCtaText", label: "Secondary button text", type: "text" },
      { name: "secondaryCtaLink", label: "Secondary button link", type: "text" },
    ],
    defaults: {
      title: "Be part of the story",
      text: "Your support turns our mission into real, lasting change — join us today.",
      primaryCtaText: "Donate now",
      primaryCtaLink: "/donate",
      secondaryCtaText: "Explore our work",
      secondaryCtaLink: "/initiatives",
    },
  },

  /* ── Gallery ──────────────────────────────────────────────────────── */
  {
    type: "gallery",
    label: "Gallery",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      {
        name: "items",
        label: "Images",
        type: "list",
        itemFields: [
          { name: "image", label: "Image", type: "image" },
          { name: "caption", label: "Caption", type: "text" },
        ],
      },
    ],
    defaults: {
      eyebrow: "In the field",
      heading: "Moments from our work",
      items: [
        { image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=800&q=80", caption: "Community outreach" },
        { image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=800&q=80", caption: "Volunteers in action" },
        { image: "https://images.unsplash.com/photo-1526958097901-5e6d742d3371?w=800&q=80", caption: "Delivering aid" },
      ],
    },
  },

  /* ── FAQ ──────────────────────────────────────────────────────────── */
  {
    type: "faq",
    label: "FAQ",
    schema: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "heading", label: "Heading", type: "text" },
      {
        name: "items",
        label: "Questions",
        type: "list",
        itemFields: [
          { name: "question", label: "Question", type: "text" },
          { name: "answer", label: "Answer", type: "textarea" },
        ],
      },
    ],
    defaults: {
      eyebrow: "Good to know",
      heading: "Frequently asked questions",
      items: [
        { question: "Where does my donation go?", answer: "<p>Every gift goes directly to the cause you choose, with full transparency on impact.</p>" },
        { question: "Is my donation tax-deductible?", answer: "<p>Yes — you'll receive a receipt for every donation you make.</p>" },
      ],
    },
  },
];

const SECTION_MAP = SECTION_TYPES.reduce((acc, s) => ((acc[s.type] = s), acc), {});

function getSectionType(type) {
  return SECTION_MAP[type] || null;
}

// Defaults for a freshly added section of `type` (used by the admin + seeds).
function getSectionDefaults(type) {
  const t = SECTION_MAP[type];
  return t ? JSON.parse(JSON.stringify(t.defaults || {})) : {};
}

/**
 * The default section list for the About page — mirrors the legacy fixed About
 * layout (hero → card grid → CTA) so nothing visually regresses on rollout.
 * `id`s are deterministic here (no randomness in seed/backfill paths).
 */
function defaultAboutSections() {
  return [
    { id: "about-hero", type: "hero", archived: false, data: getSectionDefaults("hero") },
    { id: "about-cards", type: "cardGrid", archived: false, data: getSectionDefaults("cardGrid") },
    { id: "about-cta", type: "ctaBand", archived: false, data: getSectionDefaults("ctaBand") },
  ];
}

/** Default sections for the Our Team page (mirrors the legacy page2.jsx). */
function defaultTeamSections() {
  return [
    {
      id: "team-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: "About Us",
        title: "Our Mission and Values",
        subtitle: "Driven by compassion, dedicated to lasting change in the communities that need it most.",
        image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1600&h=900&fit=crop&q=80",
        icon: "Sparkles",
        primaryCtaText: "Support our work",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Our programs",
        secondaryCtaLink: "/programs",
      },
    },
    {
      id: "team-who",
      type: "imageText",
      archived: false,
      data: {
        eyebrow: "Who We Are",
        heading: "A foundation built on hope and action",
        body: "<p>Founded by a group of passionate philanthropists and community advocates dedicated to social change.</p><p>Our aim is to improve the conditions of underprivileged communities through education, access to clean water and food, healthcare services, and community rehabilitation.</p>",
        image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=800&h=600&fit=crop&q=80",
        imageSide: "right",
        ctaText: "",
        ctaLink: "",
      },
    },
    {
      id: "team-pillars",
      type: "featureGrid",
      archived: false,
      data: {
        eyebrow: "What Drives Us",
        heading: "Mission, Vision & Values",
        intro: "The principles that anchor our work and shape every project we take on.",
        items: [
          { icon: "Target", title: "Our Mission", text: "To provide access to education, healthcare services, and clean water, empowering underprivileged communities for a better future.", link: "" },
          { icon: "Eye", title: "Our Vision", text: "To become the driving force for transforming the lives of underprivileged communities, locally and across the globe.", link: "" },
          { icon: "Heart", title: "Our Values", text: "Compassion, integrity and accountability guide every decision — we treat every community we serve with dignity and respect.", link: "" },
        ],
      },
    },
    {
      id: "team-stats",
      type: "statsBand",
      archived: false,
      data: {
        eyebrow: "",
        heading: "Our impact so far",
        items: [
          { value: "12K+", label: "Lives Impacted" },
          { value: "85+", label: "Projects Delivered" },
          { value: "30+", label: "Communities Served" },
          { value: "10+", label: "Years of Service" },
        ],
      },
    },
    {
      id: "team-leadership",
      type: "teamGrid",
      archived: false,
      data: {
        eyebrow: "Our People",
        heading: "Meet Our Leadership",
        intro: "The dedicated team guiding our vision and turning it into impact on the ground.",
        items: [
          { photo: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600&h=800&fit=crop&q=80", name: "Sarah Mitchell", role: "CEO", bio: "Committed to providing better education, health services and access to water amongst underprivileged communities." },
          { photo: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=600&h=800&fit=crop&q=80", name: "James Chen", role: "COO", bio: "We want to spread hope to underprivileged communities. The sole meaning of life is to serve humanity." },
          { photo: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=600&h=800&fit=crop&q=80", name: "Amira Patel", role: "Director of Programs", bio: "Our blessings should be used to support and uplift those in need — a principle we uphold every day." },
        ],
      },
    },
    {
      id: "team-impact",
      type: "cardGrid",
      archived: false,
      data: {
        eyebrow: "Our Work",
        heading: "Our Impact in Action",
        intro: "A snapshot of the projects and partnerships changing lives across communities.",
        items: [
          { image: "https://images.unsplash.com/photo-1497375638960-ca368c7231e4?w=600&h=400&fit=crop&q=80", title: "Flood Relief Drive", description: "Providing lifelines and first aid care, unlocking lifelong futures and endless possibilities.", link: "" },
          { image: "https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=600&h=400&fit=crop&q=80", title: "Water Supply Scheme", description: "A water supply scheme inaugurated in a valley community, bringing clean water to households.", link: "" },
          { image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&h=400&fit=crop&q=80", title: "Promoting Digital Literacy", description: "Equipping students with the tools to succeed through a digital resource school.", link: "" },
          { image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=600&h=400&fit=crop&q=80", title: "Safe Water through Hand Pumps", description: "Providing water hand pumps to 50 households, serving 80 families with clean water.", link: "" },
          { image: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=600&h=400&fit=crop&q=80", title: "Flood Relief Drive", description: "Standing with families forced to leave their homes and fields during the floods.", link: "" },
          { image: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=600&h=400&fit=crop&q=80", title: "Food Relief Drive", description: "Partnering with community foundations to assist families in need during hard times.", link: "" },
        ],
      },
    },
  ];
}

/** Default sections for the Our Partners page (mirrors the legacy page). */
function defaultPartnersSections() {
  return [
    {
      id: "partners-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: "Stronger together",
        title: "Our Partners",
        subtitle: "We're proud to stand alongside organisations and individuals who share our mission — together, our impact reaches further.",
        image: "https://images.unsplash.com/photo-1552664730-d307ca884978?w=1600&q=80",
        icon: "Handshake",
        primaryCtaText: "Become a partner",
        primaryCtaLink: "/become-a-partner",
        secondaryCtaText: "Support our work",
        secondaryCtaLink: "/donate",
      },
    },
    {
      id: "partners-stats",
      type: "statsBand",
      archived: false,
      data: {
        eyebrow: "",
        heading: "By the numbers",
        items: [
          { value: "40+", label: "Partner organisations" },
          { value: "12", label: "Communities reached" },
          { value: "10+", label: "Years of collaboration" },
          { value: "100%", label: "Reaches the cause" },
        ],
      },
    },
    {
      id: "partners-why",
      type: "featureGrid",
      archived: false,
      data: {
        eyebrow: "Why partner with us",
        heading: "Collaboration that creates real change",
        intro: "When good people and good organisations join forces, the impact compounds. Here's what partnering with us means.",
        items: [
          { icon: "Globe", title: "Greater reach", text: "Together we extend further into communities than any of us could alone — multiplying the good we do.", link: "" },
          { icon: "ShieldCheck", title: "Trusted delivery", text: "Established processes, on-the-ground teams and full transparency mean your support is delivered with care.", link: "" },
          { icon: "TrendingUp", title: "Measurable impact", text: "We report back on outcomes, not just intentions — so every partnership shows real, lasting change.", link: "" },
        ],
      },
    },
    {
      id: "partners-logos",
      type: "logosStrip",
      archived: false,
      data: {
        eyebrow: "Our network",
        heading: "We are proudly partnered with",
        // Merge the curated logos below with partners approved via the form.
        source: "both",
        items: [
          { logo: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=300&q=80", name: "Community Aid Network" },
          { logo: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=300&q=80", name: "Bright Futures Foundation" },
          { logo: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=300&q=80", name: "Unity Education Trust" },
          { logo: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=300&q=80", name: "Global Relief Alliance" },
          { logo: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=300&q=80", name: "Hope Bridge Initiative" },
          { logo: "https://images.unsplash.com/photo-1497375638960-ca368c7231e4?w=300&q=80", name: "Compassion Partners" },
          { logo: "https://images.unsplash.com/photo-1509099836639-18ba1795216d?w=300&q=80", name: "Impact Giving Foundation" },
          { logo: "https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=300&q=80", name: "Community Sports League" },
        ],
      },
    },
    {
      id: "partners-ways",
      type: "featureGrid",
      archived: false,
      data: {
        eyebrow: "Get involved",
        heading: "Ways to partner with us",
        intro: "However you're placed to help, there's a way to work together. Find the partnership that fits you.",
        items: [
          { icon: "Building2", title: "Corporate partnership", text: "Align your brand with meaningful causes through sponsorship, matched giving and workplace fundraising.", link: "/become-a-partner?type=corporate" },
          { icon: "Users", title: "Community groups", text: "Mosques, schools and local organisations joining hands to serve those closest to home.", link: "/become-a-partner?type=community" },
          { icon: "Boxes", title: "In-kind support", text: "Donate goods, services, venues or expertise — practical help that stretches every dollar further.", link: "/become-a-partner?type=in-kind" },
          { icon: "Megaphone", title: "Become an ambassador", text: "Champion our work, share our story and help bring more hands to the mission.", link: "/become-a-partner?type=ambassador" },
        ],
      },
    },
    {
      id: "partners-cta",
      type: "ctaBand",
      archived: false,
      data: {
        title: "Let's create change together",
        text: "Whether you're an organisation, business or community group, we'd love to explore how we can work together.",
        primaryCtaText: "Become a partner",
        primaryCtaLink: "/become-a-partner",
        secondaryCtaText: "Donate now",
        secondaryCtaLink: "/donate",
      },
    },
  ];
}

/** Default sections for the "What We Do" (initiatives hub) page. */
function defaultInitiativesSections() {
  return [
    {
      id: "init-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: "What we do",
        title: "Our Initiatives",
        subtitle: "Programs that drive real, measurable impact in the communities that need it most.",
        image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=1600&q=80",
        icon: "Target",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "About our work",
        secondaryCtaLink: "/about",
      },
    },
    {
      id: "init-cards",
      type: "cardGrid",
      archived: false,
      data: {
        eyebrow: "Our programs",
        heading: "Where your support goes",
        intro: "Each initiative tackles a different need — explore the work and choose the cause closest to your heart.",
        items: [
          { image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&q=80", title: "Education", description: "Quality education for children deprived of it — because progress begins in the classroom.", link: "/initiative-1" },
          { image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&q=80", title: "Food", description: "Healthy meals for those in need, sustaining lives locally and overseas.", link: "/initiative-3" },
          { image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=600&q=80", title: "Water", description: "Clean water for communities with limited or no access to this basic necessity.", link: "/initiative-2" },
          { image: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=600&q=80", title: "Emergencies", description: "Support for struggling families during emergencies, without discrimination.", link: "/initiative-4" },
        ],
      },
    },
    {
      id: "init-cta",
      type: "ctaBand",
      archived: false,
      data: {
        title: "Your support powers every initiative",
        text: "From a child's first classroom to clean water and emergency relief — every gift turns into real, lasting change.",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Get involved",
        secondaryCtaLink: "/get-involved",
      },
    },
  ];
}

/** Default sections for the Get Involved hub page. */
function defaultGetInvolvedSections() {
  return [
    {
      id: "gi-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: "Join the movement",
        title: "Get Involved",
        subtitle: "There are many ways to make a difference — give your time, rally your friends to fundraise, or join us at an upcoming event.",
        image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1600&q=80",
        icon: "HandHeart",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "See events",
        secondaryCtaLink: "/events",
      },
    },
    {
      id: "gi-cards",
      type: "cardGrid",
      archived: false,
      data: {
        eyebrow: "How you can help",
        heading: "Find your way to make a difference",
        intro: "Every contribution counts — pick the one that fits you best and join a community working for lasting change.",
        items: [
          { image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=600&q=80", title: "Attend an Event", description: "From community gatherings to fundraising dinners, join us in person and be part of the change.", link: "/events" },
          { image: "https://images.unsplash.com/photo-1526958097901-5e6d742d3371?w=600&q=80", title: "Start a Fundraiser", description: "Rally your friends and family around a cause you care about and raise funds that go straight to the field.", link: "/p2p-campaigns" },
          { image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=600&q=80", title: "Volunteer", description: "Give your time and skills alongside a community of volunteers driving real impact on the ground.", link: "/team-hope" },
        ],
      },
    },
    {
      id: "gi-cta",
      type: "ctaBand",
      archived: false,
      data: {
        title: "Every hand makes a difference",
        text: "Whether you give an hour or rally a crowd, your involvement helps us reach further. Find the way that's right for you.",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Contact us",
        secondaryCtaLink: "/contact-us",
      },
    },
  ];
}

/** Default sections for the "Ways to Give" (Islamic giving hub) page. */
function defaultGivingSections() {
  return [
    {
      id: "giving-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: "Faith in action",
        title: "Ways to Give",
        subtitle: "Fulfil your Zakat, multiply your reward this Ramadan, and give Sadaqah that reaches those who need it most.",
        image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=1600&q=80",
        icon: "Moon",
        primaryCtaText: "Calculate your Zakat",
        primaryCtaLink: "/zakat/calculator",
        secondaryCtaText: "Ramadan giving",
        secondaryCtaLink: "/Ramadan",
      },
    },
    {
      id: "giving-forms",
      type: "featureGrid",
      archived: false,
      data: {
        eyebrow: "Understanding the obligation",
        heading: "The forms of Islamic giving",
        intro: "Whether obligatory or voluntary, every act of charity draws you closer to Allah. Here's how each form works.",
        items: [
          { icon: "Coins", title: "Zakat", text: "2.5% of qualifying wealth held for a lunar year — one of the five pillars of Islam.", link: "/zakat/calculator" },
          { icon: "HandHeart", title: "Sadaqah", text: "Voluntary charity given any time, in any amount, for any cause close to your heart.", link: "/donate" },
          { icon: "Sparkles", title: "Zakat al-Fitr", text: "A small obligatory gift given before Eid prayer that purifies the fast.", link: "" },
          { icon: "Gem", title: "Fidya & Kaffarah", text: "Compensation for missed fasts — feeding those in need on your behalf.", link: "" },
        ],
      },
    },
    {
      id: "giving-cta",
      type: "ctaBand",
      archived: false,
      data: {
        title: "Give with intention",
        text: "“The likeness of those who spend their wealth in the way of Allah is as the likeness of a grain that grows seven ears.”",
        primaryCtaText: "Calculate your Zakat",
        primaryCtaLink: "/zakat/calculator",
        secondaryCtaText: "Give Sadaqah now",
        secondaryCtaLink: "/donate",
      },
    },
  ];
}

/**
 * Build sections for an "initiative" detail page (Education/Water/Food/
 * Emergencies) from its existing content (hero/mission/focusAreas/stats/
 * feature). Used as a template `buildSections` hook so the rich per-page
 * content isn't duplicated. The donate banner stays a fixed widget on the page
 * (QuickDonate), so it's intentionally not turned into a block here.
 */
function initiativeSections(content) {
  const c = content || {};
  const hero = c.hero || {};
  const mission = c.mission || {};
  const feature = c.feature || {};
  const sections = [
    {
      id: "init-hero",
      type: "hero",
      archived: false,
      data: {
        ...getSectionDefaults("hero"),
        eyebrow: hero.eyebrow || "What we do",
        title: hero.title || "",
        subtitle: hero.subtitle || "",
        image: hero.image || getSectionDefaults("hero").image,
        icon: "Target",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Our work",
        secondaryCtaLink: "/initiatives",
      },
    },
  ];
  if (mission.heading || mission.text) {
    sections.push({
      id: "init-mission",
      type: "imageText",
      archived: false,
      data: {
        eyebrow: mission.eyebrow || "Our mission",
        heading: mission.heading || "",
        body: mission.text || "",
        image: mission.image || "",
        videoId: mission.videoId || "",
        imageSide: "right",
        ctaText: "",
        ctaLink: "",
      },
    });
  }
  if (Array.isArray(c.focusAreas) && c.focusAreas.length) {
    sections.push({
      id: "init-focus",
      type: "cardGrid",
      archived: false,
      data: {
        eyebrow: "What we do",
        heading: c.focusHeading || "Our Focus Areas",
        intro: "",
        items: c.focusAreas.map((a) => ({ image: a.image, title: a.title, description: a.description, link: "" })),
      },
    });
  }
  if (c.stats && Array.isArray(c.stats.items) && c.stats.items.length) {
    sections.push({
      id: "init-stats",
      type: "statsBand",
      archived: false,
      data: {
        eyebrow: "Our impact",
        heading: c.stats.heading || "Our Impact in Numbers",
        items: c.stats.items.map((s) => ({
          value: s.value,
          label: s.tagline || (Array.isArray(s.tags) ? s.tags.join(" · ") : "") || s.label || "",
        })),
      },
    });
  }
  if (feature.heading) {
    sections.push({
      id: "init-feature",
      type: "imageText",
      archived: false,
      data: {
        eyebrow: feature.eyebrow || "Our story",
        heading: feature.heading || "",
        body: feature.text || "",
        image: feature.image || "",
        videoId: feature.videoId || "",
        imageSide: "left",
        ctaText: "",
        ctaLink: "",
      },
    });
  }
  // No closing CTA block — the page renders the QuickDonate banner (which
  // preselects this cause) as its donate prompt, so we avoid a duplicate CTA.
  return sections;
}

/**
 * Default sections for the Home page — the editable marketing blocks. The live
 * Events feed and Testimonials carousel stay fixed widgets on the page (not
 * blocks), so they're not represented here.
 */
function defaultHomeSections() {
  // The hero + its stats are rendered by the bespoke <Hero/> component (its
  // original design), edited via the page's fixed hero fields — so they are NOT
  // blocks here. These are just the editable mid-page marketing sections.
  return [
    {
      id: "home-causes",
      type: "cardGrid",
      archived: false,
      data: {
        eyebrow: "What we do",
        heading: "Where your support goes",
        intro: "Explore our initiatives and choose the cause closest to your heart.",
        items: [
          { image: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600&q=80", title: "Education", description: "Quality education for children deprived of it.", link: "/initiative-1" },
          { image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=600&q=80", title: "Water", description: "Clean water for communities in need.", link: "/initiative-2" },
          { image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&q=80", title: "Food", description: "Healthy meals for those who go without.", link: "/initiative-3" },
          { image: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=600&q=80", title: "Emergencies", description: "Rapid relief when disaster strikes.", link: "/initiative-4" },
        ],
      },
    },
    {
      id: "home-cta",
      type: "ctaBand",
      archived: false,
      data: {
        title: "Ready to make a difference?",
        text: "Join the community of donors changing lives. Every gift, big or small, creates lasting impact.",
        primaryCtaText: "Donate now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Explore our work",
        secondaryCtaLink: "/initiatives",
      },
    },
  ];
}

module.exports = {
  SECTION_TYPES,
  getSectionType,
  getSectionDefaults,
  initiativeSections,
  defaultHomeSections,
  defaultAboutSections,
  defaultTeamSections,
  defaultPartnersSections,
  defaultInitiativesSections,
  defaultGetInvolvedSections,
  defaultGivingSections,
};
