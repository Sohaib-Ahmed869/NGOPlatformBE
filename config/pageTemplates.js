/**
 * Page Template Registry
 * ----------------------
 * Single source of truth for the tenant website's pages.
 *
 * Each entry describes one page: its route, how it appears in the
 * auto-generated navigation, whether its content is editable in the admin
 * (Phase 1 wires content for home/about/contact/donate), the editor field
 * schema, and the default content (which mirrors the current hardcoded copy
 * so seeding causes ZERO visual change).
 *
 * `navParentKey` models the existing dropdown groups (About Us, Our
 * Initiatives, Islamic Giving) so the auto-generated nav reproduces today's
 * menu exactly.
 *
 * Field types used by the generic admin editor:
 *   text | textarea | image | list (repeatable, with `itemFields`)
 */

// Shared editor schema for the four "initiative" pages (Education, Water,
// Food, Emergencies) — they share the hero + mission + donate-banner + focus
// areas structure.
const INITIATIVE_SCHEMA = [
  { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
  { name: "hero.title", label: "Hero Title", type: "text" },
  { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
  { name: "hero.image", label: "Hero Background Image", type: "image" },
  { name: "mission.heading", label: "Mission Heading", type: "text" },
  { name: "mission.text", label: "Mission Text", type: "textarea" },
  { name: "mission.image", label: "Mission Image", type: "image" },
  {
    name: "mission.videoId",
    label: "Mission Video (YouTube)",
    type: "text",
    help: "Optional. Paste a YouTube link or video ID to show a video instead of the image.",
  },
  { name: "donateBanner.title", label: "Donate Banner Title", type: "text" },
  { name: "donateBanner.image", label: "Donate Banner Image", type: "image" },
  { name: "focusHeading", label: "Focus Section Heading", type: "text" },
  {
    name: "focusAreas",
    label: "Focus Areas",
    type: "list",
    itemFields: [
      { name: "image", label: "Image", type: "image" },
      { name: "title", label: "Title", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
    ],
  },
  { name: "stats.heading", label: "Impact Section Heading", type: "text" },
  {
    name: "stats.items",
    label: "Impact Stats",
    type: "list",
    itemFields: [
      { name: "value", label: "Value", type: "text" },
      { name: "tagline", label: "Tagline (optional)", type: "text" },
    ],
  },
  { name: "feature.eyebrow", label: "Feature Eyebrow", type: "text" },
  { name: "feature.heading", label: "Feature Heading", type: "text" },
  { name: "feature.text", label: "Feature Text", type: "textarea" },
  { name: "feature.image", label: "Feature Image", type: "image" },
  {
    name: "feature.videoId",
    label: "Feature Video (YouTube)",
    type: "text",
    help: "Optional. Paste a YouTube link or video ID to show a video instead of the image.",
  },
];

const PAGE_TEMPLATES = [
  // ── Home ────────────────────────────────────────────────────────────
  {
    key: "home",
    path: "/",
    navLabel: "Home",
    navOrder: 0,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.badge", label: "Hero Badge", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      {
        name: "hero.highlight",
        label: "Highlighted Words",
        type: "text",
        help: "A phrase inside the title that gets the accent colour. Leave blank for none.",
      },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.primaryCtaText", label: "Primary Button Text", type: "text" },
      { name: "hero.primaryCtaLink", label: "Primary Button Link", type: "text" },
      { name: "hero.secondaryCtaText", label: "Secondary Button Text", type: "text" },
      { name: "hero.secondaryCtaLink", label: "Secondary Button Link", type: "text" },
      {
        name: "hero.stats",
        label: "Hero Stats",
        type: "list",
        itemFields: [
          { name: "value", label: "Value", type: "text" },
          { name: "label", label: "Label", type: "text" },
        ],
      },
    ],
    defaults: {
      hero: {
        badge: "Empowering communities worldwide",
        title: "Changing Lives, One Act of Kindness",
        highlight: "One Act",
        subtitle:
          "Join thousands of donors making a real difference in communities around the world. Transparent. Accountable. Impactful.",
        primaryCtaText: "Donate Now",
        primaryCtaLink: "/donate",
        secondaryCtaText: "Learn More",
        secondaryCtaLink: "/about",
        stats: [
          { value: "$2.4M+", label: "Raised" },
          { value: "48K+", label: "Lives Impacted" },
          { value: "120+", label: "Projects" },
          { value: "30+", label: "Countries" },
        ],
      },
    },
  },

  // ── About Us (dropdown group) ───────────────────────────────────────
  {
    key: "about",
    path: "/about",
    navLabel: "About Us",
    navOrder: 1,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      {
        name: "cards",
        label: "About Cards",
        type: "list",
        itemFields: [
          { name: "title", label: "Title", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          { name: "image", label: "Image", type: "image" },
          { name: "link", label: "Button Link", type: "text" },
        ],
      },
    ],
    defaults: {
      hero: {
        eyebrow: "Who we are",
        title: "About Us",
        subtitle: "Our mission to create lasting change",
        image:
          "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1600&q=80",
      },
      cards: [
        {
          title: "Our Vision & Mission",
          description:
            "We are committed to serving underprivileged communities. Our vision and mission guide everything we do, ensuring meaningful and lasting impact.",
          image:
            "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=400&h=400&fit=crop&q=80",
          link: "/about-us",
        },
        {
          title: "Our Leadership",
          description:
            "Meet the dedicated team behind our vision. Our leadership brings together diverse expertise and a shared passion for driving positive change.",
          image:
            "https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=400&h=400&fit=crop&q=80",
          link: "/about-us",
        },
        {
          title: "Our Partners",
          description:
            "Collaboration is at the heart of our success. We proudly work with organizations and individuals who share our mission to amplify our impact.",
          image:
            "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=400&h=400&fit=crop&q=80",
          link: "/our-partners",
        },
        {
          title: "Our Impact",
          description:
            "Explore how we are empowering communities and creating sustainable solutions for a better tomorrow.",
          image:
            "https://images.unsplash.com/photo-1526958097901-5e6d742d3371?w=400&h=400&fit=crop&q=80",
          link: "/about-us",
        },
      ],
    },
  },
  {
    key: "team",
    path: "/about-us",
    navLabel: "Our Team",
    navParentKey: "about",
    navOrder: 0,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.label", label: "Hero Label", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
    ],
    defaults: {
      hero: {
        label: "About Us",
        title: "Our Mission and Values",
        image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=1600&h=900&fit=crop&q=80",
      },
    },
  },
  {
    key: "partners",
    path: "/our-partners",
    navLabel: "Our Partners",
    navParentKey: "about",
    navOrder: 1,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      {
        name: "stats",
        label: "Stats Band",
        type: "list",
        itemFields: [
          { name: "value", label: "Value", type: "text" },
          { name: "label", label: "Label", type: "text" },
        ],
      },
      { name: "whyEyebrow", label: "Why — Eyebrow", type: "text" },
      { name: "whyHeading", label: "Why — Heading", type: "text" },
      { name: "whyIntro", label: "Why — Intro", type: "textarea" },
      {
        name: "why",
        label: "Why Partner Cards",
        type: "list",
        itemFields: [
          { name: "icon", label: "Icon", type: "text", help: "One of: Globe, ShieldCheck, TrendingUp, Sparkles, Heart, Award, HeartHandshake" },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Description", type: "textarea" },
        ],
      },
      { name: "introLabel", label: "Partners — Eyebrow", type: "text" },
      { name: "introHeading", label: "Partners — Heading", type: "text" },
      {
        name: "partners",
        label: "Partners",
        type: "list",
        itemFields: [
          { name: "logo", label: "Logo / Photo", type: "image" },
          { name: "name", label: "Name", type: "text" },
        ],
      },
      { name: "waysEyebrow", label: "Ways — Eyebrow", type: "text" },
      { name: "waysHeading", label: "Ways — Heading", type: "text" },
      { name: "waysIntro", label: "Ways — Intro", type: "textarea" },
      {
        name: "ways",
        label: "Ways to Partner Cards",
        type: "list",
        itemFields: [
          { name: "icon", label: "Icon", type: "text", help: "One of: Building2, Users, Boxes, Megaphone, Handshake, HeartHandshake, Globe" },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Description", type: "textarea" },
        ],
      },
      { name: "cta.title", label: "Closing CTA — Title", type: "text" },
      { name: "cta.text", label: "Closing CTA — Text", type: "textarea" },
    ],
    defaults: {
      hero: {
        eyebrow: "Stronger together",
        title: "Our Partners",
        subtitle:
          "We're proud to stand alongside organisations and individuals who share our mission — together, our impact reaches further.",
        image: "https://images.unsplash.com/photo-1552664730-d307ca884978?w=1600&q=80",
      },
      stats: [
        { value: "40+", label: "Partner organisations" },
        { value: "12", label: "Communities reached" },
        { value: "10+", label: "Years of collaboration" },
        { value: "100%", label: "Reaches the cause" },
      ],
      whyEyebrow: "Why partner with us",
      whyHeading: "Collaboration that creates real change",
      whyIntro:
        "When good people and good organisations join forces, the impact compounds. Here's what partnering with us means.",
      why: [
        { icon: "Globe", title: "Greater reach", text: "Together we extend further into communities than any of us could alone — multiplying the good we do." },
        { icon: "ShieldCheck", title: "Trusted delivery", text: "Established processes, on-the-ground teams and full transparency mean your support is delivered with care." },
        { icon: "TrendingUp", title: "Measurable impact", text: "We report back on outcomes, not just intentions — so every partnership shows real, lasting change." },
      ],
      introLabel: "Our network",
      introHeading: "We are proudly partnered with",
      partners: [
        { logo: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=300&q=80", name: "Community Aid Network" },
        { logo: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=300&q=80", name: "Bright Futures Foundation" },
        { logo: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=300&q=80", name: "Unity Education Trust" },
        { logo: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=300&q=80", name: "Global Relief Alliance" },
        { logo: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=300&q=80", name: "Hope Bridge Initiative" },
        { logo: "https://images.unsplash.com/photo-1497375638960-ca368c7231e4?w=300&q=80", name: "Compassion Partners" },
        { logo: "https://images.unsplash.com/photo-1509099836639-18ba1795216d?w=300&q=80", name: "Impact Giving Foundation" },
        { logo: "https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=300&q=80", name: "Community Sports League" },
        { logo: "https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?w=300&q=80", name: "Cultural Heritage Group" },
        { logo: "https://images.unsplash.com/photo-1609599006353-e629aaabfeae?w=300&q=80", name: "Humanity First Foundation" },
        { logo: "https://images.unsplash.com/photo-1578357078586-491adf1aa5ba?w=300&q=80", name: "Brothers in Need" },
        { logo: "https://images.unsplash.com/photo-1526958097901-5e6d742d3371?w=300&q=80", name: "Multicultural Community Group" },
      ],
      waysEyebrow: "Get involved",
      waysHeading: "Ways to partner with us",
      waysIntro:
        "However you're placed to help, there's a way to work together. Find the partnership that fits you.",
      ways: [
        { icon: "Building2", title: "Corporate partnership", text: "Align your brand with meaningful causes through sponsorship, matched giving and workplace fundraising." },
        { icon: "Users", title: "Community groups", text: "Mosques, schools and local organisations joining hands to serve those closest to home." },
        { icon: "Boxes", title: "In-kind support", text: "Donate goods, services, venues or expertise — practical help that stretches every dollar further." },
        { icon: "Megaphone", title: "Become an ambassador", text: "Champion our work, share our story and help bring more hands to the mission." },
      ],
      cta: {
        title: "Let's create change together",
        text: "Whether you're an organisation, business or community group, we'd love to explore how we can work together.",
      },
    },
  },

  // ── Our Initiatives (dropdown group) ────────────────────────────────
  {
    key: "initiatives",
    path: "/initiatives",
    navLabel: "Our Initiatives",
    navOrder: 2,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      {
        name: "cards",
        label: "Initiative Cards",
        type: "list",
        itemFields: [
          { name: "icon", label: "Image", type: "image" },
          { name: "title", label: "Title", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          { name: "link", label: "Link", type: "text" },
        ],
      },
    ],
    defaults: {
      hero: {
        eyebrow: "What we do",
        title: "Our Initiatives",
        subtitle: "Programs that drive real impact",
        image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=1600&q=80",
      },
      cards: [
        { icon: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&h=400&fit=crop&q=80", title: "Education", link: "/initiative-1", description: "It is our firm belief that the progress of the nation is in the hands of its mothers, daughters and sisters." },
        { icon: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=400&h=400&fit=crop&q=80", title: "Food", link: "/initiative-3", description: "Provide healthy meals to those in need and help sustain lives locally and overseas." },
        { icon: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=400&h=400&fit=crop&q=80", title: "Water", link: "/initiative-2", description: "Water is a basic necessity. Millions of people have limited or no access to clean water, making life difficult for them." },
        { icon: "https://images.unsplash.com/photo-1603321544554-f416a9a11fcb?w=400&h=400&fit=crop&q=80", title: "Emergencies", link: "/initiative-4", description: "Support all struggling families and households during emergencies, ensuring assistance without discrimination." },
        { icon: "https://images.unsplash.com/photo-1538300342682-cf57afb97285?w=400&h=400&fit=crop&q=80", title: "Clean Water", link: "#", description: "Delivering sustainable clean water solutions to communities in need through wells, filtration systems, and infrastructure projects." },
        { icon: "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=400&h=400&fit=crop&q=80", title: "Women Empowerment", link: "#", description: "Empowering women through skills training, microfinance support, and educational programs to build self-reliant communities." },
      ],
    },
  },
  {
    key: "education",
    path: "/initiative-1",
    navLabel: "Education",
    navParentKey: "initiatives",
    navOrder: 0,
    showInNav: true,
    editable: true,
    schema: INITIATIVE_SCHEMA,
    defaults: {
      hero: {
        title: "Education",
        subtitle: "Building futures through learning",
        image: "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1600&q=80",
      },
      mission: {
        heading:
          "We aim to educate every child in every corner of the country, who are deprived of quality education in order to steer Pakistan forward.",
        text: "We believe that in order to progress further it's imperative that education for girls becomes our goal and with this in mind, we have set out to achieve our mission.",
      },
      donateBanner: {
        title: "Support Education Today",
        image: "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=800&q=80",
      },
      focusHeading: "Our Focus Areas",
      focusAreas: [
        {
          image: "https://images.unsplash.com/photo-1577896851231-70ef18881754?w=600&q=80",
          title: "Community schooling system",
          description:
            "We aim to foster knowledge and non-cognitive development to bring change in lives, equipping them with the values and skills to thrive in all aspects of life.",
        },
        {
          image: "https://images.unsplash.com/photo-1529390079861-591de354faf5?w=600&q=80",
          title: "Awareness Initiatives",
          description:
            "We provide family counseling services, psychological care, and care for students, medical camps, and providing professional capacity building training to staff.",
        },
        {
          image: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=600&q=80",
          title: "Professional Development Programs",
          description:
            "Our program empowers teachers to support students by sharing innovative teaching methods, building skills, and fostering mentorship.",
        },
      ],
    },
  },
  {
    key: "food",
    path: "/initiative-3",
    navLabel: "Food",
    navParentKey: "initiatives",
    navOrder: 1,
    showInNav: true,
    editable: true,
    schema: INITIATIVE_SCHEMA,
    defaults: {
      hero: {
        title: "Food Security",
        subtitle: "No family should go hungry",
        image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?auto=format&fit=crop&w=1600&q=80",
      },
      mission: {
        heading: "We aim to provide immediate healthy food to the underprivileged.",
        text: "With our vision of providing basic necessities to the underprivileged, HopeGive teams work to provide immediate assistance to maintain life, improve health and support the morale of the affected population.",
      },
      donateBanner: {
        title: "Help Feed a Family",
        image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=800&q=80",
      },
      focusHeading: "Our Focus Areas",
      focusAreas: [
        {
          image: "https://images.unsplash.com/photo-1578357078586-491adf1aa5ba?w=600&q=80",
          title: "Ration Drives in Pakistan",
          description:
            "The HopeGive Foundation has actively worked on various initiatives to help underprivileged communities in Pakistan, including organizing ration drives for families in need. These drives often aim to provide essential food items and supplies to low-income families, particularly during emergencies, natural disasters, or significant religious events like Ramadan.",
        },
        {
          image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=600&q=80",
          title: "Ramadan Food Drive in Australia",
          description:
            "The HopeGive Foundation Ramadan Food Drive provides food and essentials to underprivileged families during Ramadan. It aligns with HopeGive's mission of Hope Not Out, focusing on humanitarian aid. The initiative promotes the spirit of giving and engages local donors and volunteers.",
        },
      ],
    },
  },
  {
    key: "water",
    path: "/initiative-2",
    navLabel: "Water",
    navParentKey: "initiatives",
    navOrder: 2,
    showInNav: true,
    editable: true,
    schema: INITIATIVE_SCHEMA,
    defaults: {
      hero: {
        title: "Clean Water",
        subtitle: "Access to safe water for all",
        image: "https://images.unsplash.com/photo-1519455953755-af066f52f1a6?auto=format&fit=crop&w=1600&q=80",
      },
      mission: {
        heading: "We aim to help procure and provide water facilities to people in need.",
        text: "Millions of people in Pakistan have limited or no access to water, making life difficult for them. Furthermore, a lack of access to clean water leads to many health-related issues. For HopeGive, it is one of our goals to help procure and provide clean water facilities to people in need.",
      },
      donateBanner: {
        title: "Provide Clean Water",
        image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=800&q=80",
      },
      focusHeading: "Our Focus Areas",
      focusAreas: [
        {
          image: "https://images.unsplash.com/photo-1594398901394-4e34939a4fd0?w=600&q=80",
          title: "Water Pipelines",
          description:
            "We faced significant challenges installing water pipelines within villages and camps without electricity. Despite this, we successfully laid multiple pipelines providing thousands of gallons of water daily to local communities.",
        },
        {
          image: "https://images.unsplash.com/photo-1581888227599-779811939961?w=600&q=80",
          title: "Solar Panels",
          description:
            "We have started installing solar panels to ensure communities have access to water while reducing harmful emissions from generator use. Our water tank at Khajuri Bazar KPK provides 10,000 gallons of water to 5,000 households.",
        },
        {
          image: "https://images.unsplash.com/photo-1541544741938-0af808871cc0?w=600&q=80",
          title: "Clean Water, New Beginnings",
          description:
            "Our clean water initiatives, from R.O plants in Balochistan to handpumps in Sindh, are transforming lives by providing access to something as fundamental as clean water.",
        },
      ],
    },
  },
  {
    key: "emergencies",
    path: "/initiative-4",
    navLabel: "Emergencies",
    navParentKey: "initiatives",
    navOrder: 3,
    showInNav: true,
    editable: true,
    schema: INITIATIVE_SCHEMA,
    defaults: {
      hero: {
        title: "Emergency Relief",
        subtitle: "Rapid response when it matters most",
        image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?auto=format&fit=crop&w=1600&q=80",
      },
      mission: {
        heading: "We aim to provide immediate healthy food to the underprivileged.",
        text: "In Chakwal, Punjab, essential rations were distributed to underserved families for a month, providing food security. We are also in the process of construction of fifteen homes for underprivileged widows in Hoshab, Balochistan, also advanced with support from Australian donors. These efforts highlight HopeGive's commitment to rebuilding lives and fostering resilience in communities facing hardship.",
      },
      donateBanner: {
        title: "Support Emergency Relief",
        image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=800&q=80",
      },
      focusHeading: "Our Previous Projects",
      focusAreas: [
        {
          image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=600&q=80",
          title: "Beirut Crisis Appeal",
          description:
            "The fallout from the explosions in Beirut was exponential as people were left struggling to access food and safe spaces. HopeGive Foundation rushed its support to the affected and partnered with AusRelief. Together we were able to present a cheque of AUD 5,000 on behalf of donors from the community to help relief activities as part of Beirut Crisis Appeal. Photo credit: Hussen Malla, Al-Jazeera",
        },
        {
          image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=600&q=80",
          title: "Australian Bushfires Support",
          description:
            "We paid a visit to the NSW Rural Fire Services Headquarters (Penrith) where the RFS officials apprised the HopeGive Foundation team regarding the state of bushfire in NSW. We continued to coordinate with RFS. and donated drinking water and other essential items that were needed at that point in time by the victims of the calamitous fire to ensure together it's Hope Not Out for everyone in Australia.",
        },
        {
          image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=600&q=80",
          title: "COVID 19 Support in Australia",
          description:
            "During COVID-19, HopeGive Foundation provided food packs that sustained 36,000 families in Pakistan for over two weeks, including Hindu and Christian minorities. We also extended aid to underprivileged communities in Bangladesh, while in Australia, we supported families and students in Sydney, Melbourne, Perth, and Hobart bringing relief and hope where it was needed most.",
        },
        {
          image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=600&q=80",
          title: "Turkey Emergency Appeal",
          description:
            "Our brothers and sisters in Turkey and Syria were struck by an earthquake which caused many buildings to collapse, resulting in millions of dollars worth of damage. Thousands were injured, and hundreds lost their lives. We worked alongside our implementation partners to deliver emergency relief in Turkey and Syria during this time of crisis.",
        },
      ],
    },
  },

  // ── Islamic Giving (dropdown group) ─────────────────────────────────
  {
    key: "giving",
    path: "/giving",
    navLabel: "Islamic Giving",
    navOrder: 3,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      {
        name: "forms",
        label: "Forms of Giving Cards",
        type: "list",
        itemFields: [
          { name: "icon", label: "Icon", type: "text", help: "One of: Coins, HandHeart, Sparkles, Gem, Heart, Star, Moon" },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Description", type: "textarea" },
        ],
      },
    ],
    defaults: {
      hero: {
        eyebrow: "Faith in action",
        title: "Islamic Giving",
        subtitle:
          "Fulfil your Zakat, multiply your reward this Ramadan, and give Sadaqah that reaches those who need it most.",
        image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=1600&q=80",
      },
      forms: [
        { icon: "Coins", title: "Zakat", text: "2.5% of qualifying wealth held for a lunar year — one of the five pillars of Islam." },
        { icon: "HandHeart", title: "Sadaqah", text: "Voluntary charity given any time, in any amount, for any cause close to your heart." },
        { icon: "Sparkles", title: "Zakat al-Fitr", text: "A small obligatory gift given before Eid prayer that purifies the fast." },
        { icon: "Gem", title: "Fidya & Kaffarah", text: "Compensation for missed fasts — feeding those in need on your behalf." },
      ],
    },
  },
  {
    key: "ramadan",
    path: "/Ramadan",
    navLabel: "Ramadan Donations",
    navParentKey: "giving",
    navOrder: 0,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      { name: "intro.line1", label: "Intro Paragraph 1", type: "textarea" },
      { name: "intro.line2", label: "Intro Paragraph 2", type: "textarea" },
      {
        name: "tenNights",
        label: "Last 10 Nights Cards",
        type: "list",
        itemFields: [
          { name: "amount", label: "Title", type: "text" },
          { name: "price", label: "Amount per night ($)", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          { name: "image", label: "Image", type: "image" },
        ],
      },
      {
        name: "daily",
        label: "Daily Giving Cards",
        type: "list",
        itemFields: [
          { name: "amount", label: "Title", type: "text" },
          { name: "price", label: "Amount per night ($)", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          { name: "image", label: "Image", type: "image" },
        ],
      },
      { name: "mission.title", label: "Mission Title", type: "text" },
      { name: "mission.text", label: "Mission Text", type: "textarea" },
      { name: "mission.image", label: "Mission Image (shown when no video is set)", type: "image" },
      {
        name: "mission.videoId",
        label: "Mission Video (YouTube)",
        type: "text",
        help: "Optional. Paste a YouTube link or video ID to show a video instead of the image. Leave blank to show the image.",
      },
    ],
    defaults: {
      hero: {
        eyebrow: "The last 10 nights",
        title: "Ramadan Giving",
        image: "https://images.unsplash.com/photo-1609599006353-e629aaabfeae?w=1200&q=80",
      },
      intro: {
        line1:
          "Automate your daily sadaqah for the last 10 nights of Ramadan and never miss the immense rewards of Laylatul Qadr.",
        line2:
          "During the last ten nights, many of us dedicate more time to Dhikr, Salah and Sadaqah. Set your giving on autopilot so every blessed night counts — including the night that is better than a thousand months.",
      },
      tenNights: [
        { amount: "Feed a family of 5", price: "7", description: "Donate $7 each night for a food / ration bag for a family of 5 in the last 10 nights.", image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=600&q=80" },
        { amount: "Educate a child", price: "30", description: "Donate $30 each night to support a child's education during the last 10 nights.", image: "https://images.unsplash.com/photo-1497375638960-ca368c7231e4?w=600&q=80" },
        { amount: "Build a hand pump", price: "60", description: "Donate $60 each night to fund a large hand pump providing clean water.", image: "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?w=600&q=80" },
      ],
      daily: [
        { amount: "Give $5 a night", price: "5", description: "Consistent daily support for those in need — small acts, multiplied across the blessed nights.", image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=600&q=80" },
        { amount: "Give $10 a night", price: "10", description: "Provide essential aid every night and make a lasting impact through the last 10 nights.", image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=600&q=80" },
        { amount: "Give $20 a night", price: "20", description: "Sustain vital programs and bring meaningful change throughout Ramadan.", image: "https://images.unsplash.com/photo-1593113598332-cd288d649433?w=600&q=80" },
      ],
      mission: {
        title: "Supporting local communities in Ramadan",
        text: "Our Ramadan initiative provides food and essential supplies to underprivileged families during the holy month. Rooted in compassion, we focus on humanitarian aid within the local community — encouraging donations and volunteer involvement to support those most in need.",
        image: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?w=1000&q=80",
        videoId: "",
      },
    },
  },
  {
    key: "zakat",
    path: "/zakat/calculator",
    navLabel: "Zakat Calculator",
    navParentKey: "giving",
    navOrder: 1,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.eyebrow", label: "Hero Eyebrow", type: "text" },
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
    ],
    defaults: {
      hero: {
        eyebrow: "2.5% of your wealth",
        title: "Zakat Calculator",
        subtitle:
          "Add up your assets, subtract what you owe, and we'll work out your Zakat instantly — then you can pay it in seconds.",
        image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1600&q=80",
      },
    },
  },

  // ── Top-level pages ─────────────────────────────────────────────────
  {
    key: "programs",
    path: "/programs",
    navLabel: "Programs",
    navOrder: 4,
    showInNav: true,
    editable: false,
  },
  {
    key: "teamHope",
    path: "/team-hope",
    navLabel: "Team Hope",
    navOrder: 5,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      { name: "formHeading", label: "Form Heading", type: "text" },
    ],
    defaults: {
      hero: {
        title: "Team Hope",
        subtitle: "Join our volunteer community",
        image: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?w=1600&q=80",
      },
      formHeading: "Join our team",
    },
  },
  {
    key: "events",
    path: "/events",
    navLabel: "Events",
    navOrder: 6,
    showInNav: true,
    editable: false,
  },
  {
    // Supporter-created, admin-moderated GoFundMe-style fundraisers. The page is
    // self-contained (own hero + "Start a fundraiser" CTA), so it's not CMS-
    // editable — this entry just puts it in the auto-generated nav + route gate.
    key: "p2p-campaigns",
    path: "/p2p-campaigns",
    navLabel: "Fundraisers",
    navOrder: 6.5,
    showInNav: true,
    editable: false,
  },

  // ── Contact ─────────────────────────────────────────────────────────
  {
    key: "contact",
    path: "/contact-us",
    navLabel: "Contact Us",
    navOrder: 7,
    showInNav: true,
    editable: true,
    schema: [
      { name: "hero.title", label: "Hero Title", type: "text" },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
      { name: "hero.image", label: "Hero Background Image", type: "image" },
      { name: "formHeading", label: "Form Heading", type: "text" },
    ],
    defaults: {
      hero: {
        title: "Get In Touch",
        subtitle: "We would love to hear from you",
        image:
          "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=1600&q=80",
      },
      formHeading: "Get in touch",
    },
  },

  // ── Donate (reached via CTAs, not the top nav) ──────────────────────
  {
    key: "donate",
    path: "/donate",
    navLabel: "Donate",
    navOrder: 8,
    showInNav: false,
    editable: true,
    schema: [
      { name: "hero.title", label: "Hero Title", type: "text" },
      {
        name: "hero.highlight",
        label: "Highlighted Words",
        type: "text",
        help: "A phrase inside the title that gets the accent colour.",
      },
      { name: "hero.subtitle", label: "Hero Subtitle", type: "textarea" },
    ],
    defaults: {
      hero: {
        title: "Make a Donation",
        highlight: "Donation",
        subtitle: "Choose an amount and start making a difference today.",
      },
    },
  },
];

const TEMPLATE_MAP = PAGE_TEMPLATES.reduce((acc, t) => {
  acc[t.key] = t;
  return acc;
}, {});

function getTemplate(key) {
  return TEMPLATE_MAP[key] || null;
}

module.exports = { PAGE_TEMPLATES, TEMPLATE_MAP, getTemplate };
