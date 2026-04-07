// ProtoConsent shared configuration and constants
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Debug panel in popup + verbose logging in background.
// Activate at runtime: chrome.storage.local.set({ debug: true })
// Deactivate:          chrome.storage.local.remove("debug")
let DEBUG_RULES = false;

// Prefer onRuleMatchedDebug (declarativeNetRequest debug API) when available.
// Default false: use webRequest (same code path in developer and store builds).
// Set to true for precise rule-level debugging during blocklist development.
// In store builds onRuleMatchedDebug does not exist, so this flag has no effect.
const USE_DNR_DEBUG = false;

async function loadDebugFlag() {
  try {
    const { debug } = await chrome.storage.local.get("debug");
    DEBUG_RULES = debug === true;
  } catch (_) { /* keep default */ }
}

// --- Shared helpers (used by popup.js, log.js, etc.) ---

function pluralize(n, singular) {
  return n + " " + singular + (n !== 1 ? "s" : "");
}

function compactNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function getPurposeLabel(key, style, config) {
  const cfg = (config || (typeof purposesConfig !== "undefined" ? purposesConfig : {}))[key];
  if (!cfg) return key;
  if (style === "short") return cfg.short_label || cfg.short || key;
  return cfg.label || key;
}

function formatHHMM(ts) {
  if (ts == null || isNaN(ts)) return "--:--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function formatHHMMSS(ts) {
  if (ts == null || isNaN(ts)) return "--:--:--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--:--";
  return formatHHMM(ts) + ":" + String(d.getSeconds()).padStart(2, "0");
}

// Non-purpose categories used by enhanced lists (not part of Consent Commons).
const ENHANCED_EXTRA_CATEGORIES = {
  security: { icon: "../icons/purposes/security.svg", short: "Sec", label: "Security" },
};

// Resolve enhanced list category → icon/label info.
// Returns { icon, short, label } from purposesConfig or ENHANCED_EXTRA_CATEGORIES,
// or null if no category. Depends on globals: enhancedCatalogConfig (popup.js),
// epCatalog (enhanced.js), purposesConfig (popup.js).
function getEnhancedCategoryInfo(listId) {
  // Prefer the always-loaded catalog; fall back to epCatalog (enhanced tab)
  const catalog = (typeof enhancedCatalogConfig !== "undefined" && Object.keys(enhancedCatalogConfig).length > 0)
    ? enhancedCatalogConfig
    : (typeof epCatalog !== "undefined" ? epCatalog : null);
  if (!catalog) return null;
  const def = catalog[listId];
  if (!def || !def.category) return null;
  // Try purposes first, then extra categories
  const cfg = (typeof purposesConfig !== "undefined" ? purposesConfig[def.category] : null)
    || ENHANCED_EXTRA_CATEGORIES[def.category];
  if (!cfg) return null;
  return { icon: cfg.icon, short: cfg.short || "", label: cfg.label || def.category };
}
