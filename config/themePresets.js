/**
 * All theme presets with their color values.
 * Used by registration controller and branding controller.
 */
const themes = {
  // Warm & Classic
  "default": { primaryColor: "#2C2418", accentColor: "#C9A84C", backgroundColor: "#FAF7F2" },
  "warm-amber": { primaryColor: "#3E2723", accentColor: "#FF8F00", backgroundColor: "#FFF8E1" },
  "warm-terracotta": { primaryColor: "#4A2C2A", accentColor: "#C75B39", backgroundColor: "#FBF0EB" },
  "warm-burgundy": { primaryColor: "#3C1421", accentColor: "#9C254D", backgroundColor: "#FDF2F4" },
  "warm-copper": { primaryColor: "#3B2F2F", accentColor: "#B87333", backgroundColor: "#FAF6F0" },
  "warm-mahogany": { primaryColor: "#2E1503", accentColor: "#8B4513", backgroundColor: "#FDF5EE" },
  "warm-cinnamon": { primaryColor: "#3B1F0B", accentColor: "#D2691E", backgroundColor: "#FFF5EB" },
  "warm-rust": { primaryColor: "#2D1B0E", accentColor: "#A0522D", backgroundColor: "#FAF0E6" },
  "warm-honey": { primaryColor: "#2C2418", accentColor: "#DAA520", backgroundColor: "#FFFEF5" },
  "warm-clay": { primaryColor: "#3A2A1F", accentColor: "#CC7722", backgroundColor: "#F8F0E3" },
  // Modern & Bold
  "modern-crimson": { primaryColor: "#1A1A2E", accentColor: "#E94560", backgroundColor: "#F8F9FA" },
  "modern-electric": { primaryColor: "#0D1B2A", accentColor: "#0077B6", backgroundColor: "#F0F4F8" },
  "modern-violet": { primaryColor: "#1A1A2E", accentColor: "#7C3AED", backgroundColor: "#F5F3FF" },
  "modern-magenta": { primaryColor: "#1C1C2E", accentColor: "#DB2777", backgroundColor: "#FDF2F8" },
  "modern-coral": { primaryColor: "#1A1A2A", accentColor: "#F97316", backgroundColor: "#FFF7ED" },
  "modern-cyan": { primaryColor: "#0F172A", accentColor: "#06B6D4", backgroundColor: "#ECFEFF" },
  "modern-rose": { primaryColor: "#1C1917", accentColor: "#E11D48", backgroundColor: "#FFF1F2" },
  "modern-indigo": { primaryColor: "#1E1B4B", accentColor: "#4F46E5", backgroundColor: "#EEF2FF" },
  "modern-emerald": { primaryColor: "#0F172A", accentColor: "#10B981", backgroundColor: "#F0FDF4" },
  "modern-slate": { primaryColor: "#0F172A", accentColor: "#6366F1", backgroundColor: "#F8FAFC" },
  // Nature & Earth
  "nature-forest": { primaryColor: "#1B4332", accentColor: "#40916C", backgroundColor: "#F0FFF4" },
  "nature-ocean": { primaryColor: "#0C4A6E", accentColor: "#0284C7", backgroundColor: "#F0F9FF" },
  "nature-sage": { primaryColor: "#3D405B", accentColor: "#81B29A", backgroundColor: "#F4F1DE" },
  "nature-lavender": { primaryColor: "#3B3355", accentColor: "#9B72CF", backgroundColor: "#F5F0FF" },
  "nature-moss": { primaryColor: "#2D3B2D", accentColor: "#5C8A4D", backgroundColor: "#F2F7F0" },
  "nature-sand": { primaryColor: "#4A4035", accentColor: "#C4A35A", backgroundColor: "#FAF6ED" },
  "nature-sky": { primaryColor: "#1E3A5F", accentColor: "#4DA8DA", backgroundColor: "#F0F8FF" },
  "nature-stone": { primaryColor: "#374151", accentColor: "#6B7280", backgroundColor: "#F3F4F6" },
  "nature-sunset": { primaryColor: "#2B2D42", accentColor: "#EF8354", backgroundColor: "#FFF8F0" },
  "nature-meadow": { primaryColor: "#2D4A22", accentColor: "#7CB342", backgroundColor: "#F1F8E9" },
  // Professional & Clean
  "pro-classic": { primaryColor: "#2D3436", accentColor: "#0984E3", backgroundColor: "#FFFFFF" },
  "pro-charcoal": { primaryColor: "#2D3436", accentColor: "#636E72", backgroundColor: "#FFFFFF" },
  "pro-navy": { primaryColor: "#1B2A4A", accentColor: "#2E86C1", backgroundColor: "#FAFBFC" },
  "pro-steel": { primaryColor: "#263238", accentColor: "#546E7A", backgroundColor: "#FAFAFA" },
  "pro-graphite": { primaryColor: "#212121", accentColor: "#424242", backgroundColor: "#FAFAFA" },
  "pro-royal": { primaryColor: "#1A237E", accentColor: "#3949AB", backgroundColor: "#F5F5FF" },
  "pro-teal": { primaryColor: "#1A3C34", accentColor: "#009688", backgroundColor: "#F0FDFA" },
  "pro-burgundy": { primaryColor: "#2C1320", accentColor: "#880E4F", backgroundColor: "#FFF5F8" },
  "pro-midnight": { primaryColor: "#0A0E27", accentColor: "#5C6BC0", backgroundColor: "#F8F9FF" },
  "pro-titanium": { primaryColor: "#37474F", accentColor: "#78909C", backgroundColor: "#ECEFF1" },
};

/**
 * Get theme colors by ID with fallback to default.
 */
function getThemeColors(themeId) {
  return themes[themeId] || themes["default"];
}

module.exports = { themes, getThemeColors };
