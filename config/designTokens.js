/**
 * Backend guard for the per-tenant DESIGN system. Validates/sanitises incoming
 * design values so only known ids are ever stored. The full registry (font
 * stacks, shape vars, templates) lives on the frontend (src/config/designTokens.js);
 * the backend only needs the valid id sets + the baseline default.
 */

const FONT_IDS = ["serif", "playfair", "lora", "merriweather", "sourceSerif", "inter", "poppins", "outfit", "nunito", "workSans", "dmSans", "sourceSans"];
const ROUNDNESS_IDS = ["sharp", "soft", "rounded", "pill"];
const BORDER_IDS = ["thin", "none", "bold"];
const SHADOW_IDS = ["soft", "none", "lifted"];
const TEMPLATE_IDS = ["classic", "modern", "editorial", "minimal", "bold", "coastal", "heritage", "midnight", "grove"];
const NAVBAR_VARIANT_IDS = ["classic", "centered", "split", "minimal", "allExpanded", "mega", "command"];
const FOOTER_VARIANT_IDS = ["classic", "compact", "centered"];

const DEFAULT_DESIGN = {
  templateId: "classic",
  fonts: { heading: "serif", body: "serif", nav: "serif" },
  shape: { roundness: "sharp", borderWidth: "thin", shadow: "soft" },
  variants: { navbar: "classic", footer: "classic" },
};

const oneOf = (val, list, def) => (list.includes(val) ? val : def);
const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

function sanitizeDesign(input) {
  const d = input || {};
  const f = d.fonts || {};
  const s = d.shape || {};
  const v = d.variants || {};
  // A template's colour palette — only kept when all three are valid hex.
  const c = d.colors && typeof d.colors === "object" ? d.colors : {};
  const colors = hex(c.primary) && hex(c.accent) && hex(c.bg) ? { primary: hex(c.primary), accent: hex(c.accent), bg: hex(c.bg) } : null;
  return {
    templateId: oneOf(d.templateId, TEMPLATE_IDS, "classic"),
    colorThemeId: typeof d.colorThemeId === "string" ? d.colorThemeId.slice(0, 40) : null,
    colors,
    fonts: {
      heading: oneOf(f.heading, FONT_IDS, "serif"),
      body: oneOf(f.body, FONT_IDS, "serif"),
      nav: oneOf(f.nav, FONT_IDS, "serif"),
    },
    shape: {
      roundness: oneOf(s.roundness, ROUNDNESS_IDS, "sharp"),
      borderWidth: oneOf(s.borderWidth, BORDER_IDS, "thin"),
      shadow: oneOf(s.shadow, SHADOW_IDS, "soft"),
    },
    variants: {
      navbar: oneOf(v.navbar, NAVBAR_VARIANT_IDS, "classic"),
      footer: oneOf(v.footer, FOOTER_VARIANT_IDS, "classic"),
    },
  };
}

module.exports = { DEFAULT_DESIGN, sanitizeDesign, FONT_IDS, ROUNDNESS_IDS, BORDER_IDS, SHADOW_IDS, TEMPLATE_IDS, NAVBAR_VARIANT_IDS, FOOTER_VARIANT_IDS };
