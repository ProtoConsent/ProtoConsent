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

// Enhanced Protection shield icon path (used by popup, log, enhanced tab).
const ENHANCED_ICON = "../icons/purposes/enhanced.svg";

// Non-purpose categories used by enhanced lists (not part of Consent Commons).
const ENHANCED_EXTRA_CATEGORIES = {
  security: { icon: "../icons/purposes/security.svg", short: "Sec", label: "Security" },
};

// --- CNAME cloaking shared state and helpers ---

let cnameMap = null;       // { disguised_domain: trackerIndex }
let cnameTrackers = null;  // trackers[index] = "real-tracker.com"
let cnameLoadDiag = null;  // Diagnostic reason if load fails (shown in debug panel)

// Lookup CNAME tracker for a domain, with www. prefix fallback.
function lookupCname(domain) {
  if (!cnameMap || !cnameTrackers) return null;
  let idx = cnameMap[domain];
  if (idx === undefined) {
    idx = domain.startsWith("www.")
      ? cnameMap[domain.slice(4)]
      : cnameMap["www." + domain];
  }
  return idx !== undefined && idx !== null ? cnameTrackers[idx] : null;
}

// Load CNAME data from storage if the list is enabled.
// Populates cnameMap and cnameTrackers globals.
// Calls optional callback(loaded: boolean) when done.
function loadCnameData(callback) {
  if (cnameMap) { if (callback) callback(true); return; }
  chrome.storage.local.get(["enhancedLists", "enhancedData_cname_trackers"], (r) => {
    const meta = r.enhancedLists && r.enhancedLists.cname_trackers;
    if (meta && meta.enabled) {
      const data = r.enhancedData_cname_trackers;
      if (data && data.map && data.trackers) {
        cnameMap = data.map;
        cnameTrackers = data.trackers;
        cnameLoadDiag = null;
        if (callback) callback(true);
        return;
      }
      cnameLoadDiag = "enabled but data missing - re-download from Enhanced Protection";
    } else if (meta) {
      cnameLoadDiag = "list disabled";
    } else {
      cnameLoadDiag = "list not found in storage";
    }
    if (callback) callback(false);
  });
}

// --- Client Hints stripping shared constants ---

// High-entropy Client Hints headers stripped when advanced_tracking is denied.
// Lowercase for DNR modifyHeaders; UI can derive display names from these.
const HIGH_ENTROPY_CH = [
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64",
  "sec-ch-ua-form-factors",
];

// Display-friendly names for the CH headers (same order as HIGH_ENTROPY_CH).
const HIGH_ENTROPY_CH_LABELS = HIGH_ENTROPY_CH.map(h =>
  "Sec-CH-UA-" + h.replace("sec-ch-ua-", "").split("-").map(
    w => w.charAt(0).toUpperCase() + w.slice(1)
  ).join("-")
);

// Read chStrippingEnabled from storage (defaults to true).
function getChStrippingEnabled(callback) {
  chrome.storage.local.get(["chStrippingEnabled"], (r) => {
    callback(r.chStrippingEnabled !== false);
  });
}

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
