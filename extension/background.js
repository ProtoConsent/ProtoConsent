// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// background.js - ProtoConsent enforcement using declarativeNetRequest
importScripts("config.js");

// Resolved once at startup: use onRuleMatchedDebug only when both opted-in
// (USE_DNR_DEBUG in config.js) and available (unpacked extension).
const useDnrDebug = USE_DNR_DEBUG && !!chrome.declarativeNetRequest.onRuleMatchedDebug;

// We assign IDs for dynamic rules starting from 1 upwards
const BASE_RULE_ID = 1;

// Reserve dynamic rule slots for core enforcement (overrides + GPC + enhanced).
// Whitelist rules are trimmed if they would exceed the remaining budget.
const DYNAMIC_RULE_RESERVE = 100;

// Resource types for blocking rules (not main_frame - that would block the page itself)
const BLOCK_RESOURCE_TYPES = [
  "script", "xmlhttprequest", "image", "sub_frame", "ping", "other"
];

// Resource types for GPC header injection (includes main_frame for the server signal)
const GPC_RESOURCE_TYPES = ["main_frame", ...BLOCK_RESOURCE_TYPES];

// Purposes we currently enforce - derived at runtime from purposes.json keys.
let PURPOSES_FOR_ENFORCEMENT = [];

// Purposes that trigger the Sec-GPC header when denied.
// Derived at runtime from purposes.json (triggers_gpc: true).
let gpcPurposes = [];

// Cached domain and path-domain lists extracted from static rulesets (rules/block_*.json).
// Curated subset of public blocklists - not a full ad/tracking blocker.
// Sources: OISD big/small, HaGeZi Pro/TIF, EasyPrivacy/EasyList, Peter Lowe's
// Loaded once per SW lifetime. Maps purposeKey -> { domains: string[], pathDomains: string[] }.
let blocklistsConfig = null;

// Per-tab tracking of blocked domains for the popup detail view.
// Maps tabId -> { purposeKey -> { domain -> count } }
// Persisted to chrome.storage.session to survive SW idle/restart.
const tabBlockedDomains = new Map();

// Per-tab TCF CMP detection data (populated by tcf-detect.js via content-script relay)
const tabTcfData = new Map();

// Maps dynamic block rule IDs to their purpose (rebuilt on each rule update).
let dynamicBlockRuleMap = {};

// Set of dynamic rule IDs that inject Sec-GPC: 1 (rebuilt on each rule update).
let dynamicGpcSetIds = new Set();

// Set of dynamic rule IDs that strip high-entropy Client Hints (rebuilt on each rule update).
let dynamicChRuleIds = new Set();

// Maps dynamic whitelist allow rule IDs to their requestDomains array,
// so getMatchedRules in the popup can count whitelist hits per domain.
let dynamicWhitelistMap = {};

// Maps dynamic enhanced block rule IDs to their list ID (e.g. "easyprivacy").
// Used by onErrorOccurred / onRuleMatchedDebug for attribution.
let dynamicEnhancedMap = {};

// Reverse index: maps each hostname to its purpose key(s), so we can
// determine which purpose blocked a request given only the hostname.
// Built after loadBlocklistsConfig(). Used by onErrorOccurred.
let reverseHostIndex = null;

// Enhanced reverse index: maps hostname → listId for Enhanced Protection lists.
// Built during rebuild from cached enhanced list domains. Used by onErrorOccurred
// to attribute blocks to enhanced lists when core reverse index has no match.
let enhancedReverseIndex = null;

// Set of currently-enabled static blocking rulesets (e.g. "block_analytics").
// Updated on each rebuildAllDynamicRules cycle. Used to disambiguate purpose
// when a domain appears in multiple blocklists.
let enabledBlockRulesets = new Set();

// GPC (Global Privacy Control) configuration snapshot - updated on each rebuild.
// gpcGlobalActive: true if the global GPC rule is on (applies to all requests by default).
// gpcAddDomains: sites that override global to ADD GPC (requestDomains targets).
// gpcRemoveDomains: sites that override global to REMOVE GPC (requestDomains targets).
// Used by onSendHeaders to filter out browser-native GPC signals (e.g. Brave/Firefox
// send Sec-GPC natively; we only count signals injected by our own rules).
let gpcGlobalActive = false;
let gpcAddDomains = new Set();
let gpcRemoveDomains = new Set();

// Per-tab tracking of unique domains that received GPC (Sec-GPC: 1) signals.
// Maps tabId -> Set<domain>
const tabGpcDomains = new Map();

// Session persistence helpers:
// Throttled write to chrome.storage.session (max once per 2s) to avoid
// excessive writes on pages with many blocked requests.
let sessionPersistTimer = null;
function scheduleSessionPersist() {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persistTabDataToSession();
  }, 2000);
}

function persistTabDataToSession() {
  if (!chrome.storage.session) return;
  // Convert Maps to plain objects for storage
  const blocked = {};
  for (const [tabId, data] of tabBlockedDomains) {
    blocked[tabId] = data;
  }
  const gpc = {};
  for (const [tabId, domains] of tabGpcDomains) {
    gpc[tabId] = domains;
  }
  chrome.storage.session.set({ _tabBlocked: blocked, _tabGpc: gpc, _extEventLog: _extEventLog });
}

async function restoreTabDataFromSession() {
  if (!chrome.storage.session) return;
  try {
    const result = await chrome.storage.session.get(null);
    if (result._tabBlocked) {
      for (const [tabId, data] of Object.entries(result._tabBlocked)) {
        tabBlockedDomains.set(Number(tabId), data);
      }
    }
    if (result._tabGpc) {
      for (const [tabId, domains] of Object.entries(result._tabGpc)) {
        tabGpcDomains.set(Number(tabId), domains);
      }
    }
    // Restore inter-extension event log
    if (Array.isArray(result._extEventLog)) {
      _extEventLog.length = 0;
      for (const evt of result._extEventLog) _extEventLog.push(evt);
    }
    // Restore per-tab TCF detection data (keys: "tcf_<tabId>")
    // and prune orphan keys for tabs that no longer exist.
    const tcfKeys = Object.keys(result).filter(k => k.startsWith("tcf_"));
    if (tcfKeys.length > 0) {
      const existingTabs = new Set();
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) existingTabs.add(t.id);
      } catch (_) {}
      const orphanKeys = [];
      for (const key of tcfKeys) {
        const tabId = Number(key.slice(4));
        if (tabId > 0 && existingTabs.has(tabId) && result[key]?.detected) {
          tabTcfData.set(tabId, result[key]);
        } else {
          orphanKeys.push(key);
        }
      }
      if (orphanKeys.length > 0) {
        chrome.storage.session.remove(orphanKeys).catch(() => {});
      }
    }
  } catch (_) { /* session storage may be empty on first run */ }
}

// Last rebuild debug snapshot (served to popup on request)
let lastRebuildDebug = {};
let lastConsentLinkedListIds = [];
let lastCelPendingDownload = [];

// Restore persisted tab data from session storage on every SW load.
// This runs at the top level so it executes each time Chrome spins up the worker.
restoreTabDataFromSession();

// Badge: show blocked request count per tab on the extension icon.
// Uses our tabBlockedDomains as source (not Chrome's getMatchedRules total)
// so the number matches what the popup and log display.
chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });

function updateBadgeForTab(tabId) {
  const tabData = tabBlockedDomains.get(tabId);
  if (!tabData) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  let total = 0;
  for (const domains of Object.values(tabData)) {
    for (const count of Object.values(domains)) {
      total += count;
    }
  }
  chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : "" });
}

// Cached in-memory copy of presets.json; loaded once per SW lifetime.
let presetsConfig = null;

// Cached in-memory copy of purposes.json; loaded once per SW lifetime.
let purposesConfig = null;

// Start loading blocklists early so the reverse hostname index is ready
// when the first onErrorOccurred event arrives. We don't await the result
// here - rebuildAllDynamicRules awaits it later. This call must stay below
// the presetsConfig/purposesConfig declarations or they will be undefined.
loadBlocklistsConfig();


// Load domain and path-domain lists from static rulesets (rules/block_*.json, rules/block_*_paths.json).
// Subsequent calls return the cached in-memory version.
async function loadBlocklistsConfig() {
  if (blocklistsConfig) return blocklistsConfig;

  // Ensure purposes are loaded first (provides PURPOSES_FOR_ENFORCEMENT)
  await loadPurposesConfig();

  const config = {};
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    const entry = {};
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + ".json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      entry.domains = rules[0]?.condition?.requestDomains || [];
    } catch (e) {
      // Expected for categories without a static ruleset (e.g. "functional")
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + ".json:", e.message);
      entry.domains = [];
    }
    // Extract unique domains from path-based rules (urlFilter "||domain.com/path")
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + "_paths.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      const domainSet = new Set(entry.domains);
      const pathDomains = [];
      for (const rule of rules) {
        const m = rule.condition?.urlFilter?.match(/^\|\|([^/]+)/);
        if (m && !domainSet.has(m[1])) {
          pathDomains.push(m[1]);
          domainSet.add(m[1]);
        }
      }
      entry.pathDomains = pathDomains;
    } catch (e) {
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + "_paths.json:", e.message);
      entry.pathDomains = [];
    }
    config[key] = entry;
  }
  blocklistsConfig = config;
  reverseHostIndex = buildReverseHostIndex(config);
  return blocklistsConfig;
}

// Build a hostname-to-purpose lookup from the blocklists.
// Returns Map<hostname, string[]> where each value is an array of purpose keys.
// A domain may appear in multiple purposes (e.g. both "analytics" and "ads").
// ~40K entries; built once when blocklists are loaded.
function buildReverseHostIndex(config) {
  const index = new Map();
  for (const purpose of PURPOSES_FOR_ENFORCEMENT) {
    const entry = config[purpose];
    if (!entry) continue;
    const allDomains = (entry.domains || []).concat(entry.pathDomains || []);
    for (const domain of allDomains) {
      const existing = index.get(domain);
      if (existing) {
        if (!existing.includes(purpose)) existing.push(purpose);
      } else {
        index.set(domain, [purpose]);
      }
    }
  }
  return index;
}

// Resolve ALL matching purposes for a blocked hostname using the lookup index.
// Walks up the domain hierarchy to handle subdomain matching (declarativeNetRequest's
// requestDomains matches all subdomains, so "tracker.google-analytics.com" matches
// "google-analytics.com"). Returns an array of purpose keys (may be empty).
// In developer mode, onRuleMatchedDebug fires once per matching ruleset;
// this replicates that behavior for onErrorOccurred (which fires once per request).
function resolvePurposesFromHostname(hostname) {
  if (!reverseHostIndex) return [];
  let h = hostname;
  while (h) {
    const purposes = reverseHostIndex.get(h);
    if (purposes) {
      // Filter to purposes with active blocking (static rulesets or dynamic overrides)
      const activeDynamic = new Set(Object.values(dynamicBlockRuleMap));
      const active = purposes.filter(p =>
        enabledBlockRulesets.has("block_" + p) ||
        enabledBlockRulesets.has("block_" + p + "_paths") ||
        activeDynamic.has(p)
      );
      return active.length > 0 ? active : purposes;
    }
    const dot = h.indexOf(".");
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  // Check Enhanced Protection lists
  if (enhancedReverseIndex) {
    h = hostname;
    while (h) {
      const listId = enhancedReverseIndex.get(h);
      if (listId) return ["enhanced:" + listId];
      const dot = h.indexOf(".");
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
  }
  return [];
}

// Load presets.json once when the service worker starts.
// Subsequent calls return the cached in-memory version.
async function loadPresetsConfig() {
  if (presetsConfig) return presetsConfig;

  try {
    const url = chrome.runtime.getURL("config/presets.json");
    const res = await fetch(url);
    presetsConfig = await res.json();
    return presetsConfig;
  } catch (e) {
    console.error("Failed to load presets.json:", e);
    presetsConfig = {};
    return presetsConfig;
  }
}

// Load purposes.json once when the service worker starts.
// Extracts the list of purposes that trigger GPC (triggers_gpc: true).
async function loadPurposesConfig() {
  if (purposesConfig) return purposesConfig;

  try {
    const url = chrome.runtime.getURL("config/purposes.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    purposesConfig = await res.json();
  } catch (e) {
    console.error("Failed to load purposes.json:", e);
    purposesConfig = {};
  }

  // Derive purpose lists from config
  PURPOSES_FOR_ENFORCEMENT = Object.keys(purposesConfig);
  gpcPurposes = PURPOSES_FOR_ENFORCEMENT
    .filter(key => purposesConfig[key].triggers_gpc);

  return purposesConfig;
}

// Utility: get the user's default profile config from storage.
// Returns { profile, purposes } where purposes is only set for custom defaults.
function getDefaultProfileConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["defaultProfile", "defaultPurposes"], (result) => {
      resolve({
        profile: result.defaultProfile || "balanced",
        purposes: result.defaultPurposes || null
      });
    });
  });
}


// Resolve purpose states for a site rule by applying profile defaults
// and then any explicit overrides.
// Returns an object with all purpose keys mapped to booleans.
function resolvePurposes(siteConfig, presets, defaultConfig) {
  const resolved = {};
  const profileName = siteConfig.profile || (defaultConfig && defaultConfig.profile) || "balanced";

  // Determine base purposes: custom global default or named preset
  let profilePurposes;
  if (!siteConfig.profile && profileName === "custom" && defaultConfig && defaultConfig.purposes) {
    profilePurposes = defaultConfig.purposes;
  } else {
    // Fall back to "balanced" if the named profile doesn't exist (e.g. "custom" without saved purposes)
    const profileDef = presets[profileName] || presets["balanced"];
    profilePurposes = (profileDef && profileDef.purposes) || {};
  }
  const overrides = siteConfig.purposes || {};

  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    if (key in overrides) {
      resolved[key] = overrides[key];
    } else {
      resolved[key] = profilePurposes[key] !== false;
    }
  }

  // Force required purposes to true (defensive: even if storage is corrupted)
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    if (purposesConfig && purposesConfig[key]?.required) {
      resolved[key] = true;
    }
  }

  return resolved;
}

// Utility: get all rules from storage.
// Returns an object mapping domain -> siteConfig.
function getAllRulesFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["rules"], (result) => {
      resolve(result.rules || {});
    });
  });
}

// Utility: get the domain whitelist from storage.
// Returns an object mapping domain -> { site: purpose, ... }.
// site is a hostname (per-site) or "*" (global).
function getWhitelistFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["whitelist"], (result) => {
      resolve(result.whitelist || {});
    });
  });
}

// Validate domain: must look like a hostname (letters, digits, hyphens, dots, at least one dot).
const VALID_HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
function isValidHostname(s) {
  return typeof s === "string" && s.length <= 253 && VALID_HOSTNAME_RE.test(s);
}

// Get Enhanced Protection list state from storage.
// Returns an object mapping listId -> { enabled, version, domainCount, pathRuleCount, lastFetched }
// Domain/path data is stored separately in enhancedData_{listId} keys for performance.
function getEnhancedListsFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["enhancedLists"], (result) => {
      resolve(result.enhancedLists || {});
    });
  });
}

// Read the heavy domain/path arrays for one enhanced list from storage.
// Currently unused - kept for future use (e.g. single-list update or detail view).
// See getAllEnhancedDataFromStorage below for the batch version used by rebuild.
function getEnhancedDataFromStorage(listId) {
  const key = "enhancedData_" + listId;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || null);
    });
  });
}

// Get heavy domain/path data for all enabled enhanced lists.
function getAllEnhancedDataFromStorage(lists) {
  const enabledIds = Object.entries(lists).filter(([, v]) => v.enabled).map(([k]) => k);
  if (enabledIds.length === 0) return Promise.resolve({});
  const keys = enabledIds.map(id => "enhancedData_" + id);
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      const out = {};
      for (const id of enabledIds) {
        const data = result["enhancedData_" + id];
        if (data) out[id] = data;
      }
      resolve(out);
    });
  });
}

// Get Enhanced Protection preset from storage ("off" | "basic" | "full" | "custom")
function getEnhancedPresetFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["enhancedPreset"], (result) => {
      resolve(result.enhancedPreset || "off");
    });
  });
}

// Serialize read-modify-write on enhancedLists to avoid race conditions
// when multiple FETCH/REMOVE/TOGGLE handlers run concurrently.
let enhancedStorageChain = Promise.resolve();

function withEnhancedStorageLock(fn) {
  enhancedStorageChain = enhancedStorageChain.then(fn, fn);
  return enhancedStorageChain;
}

// Enhanced lists catalog - merged from local fallback + remote lists.json
let enhancedListsCatalog = null;
let _catalogPromise = null;
let _catalogLastFetched = 0;
let _catalogSource = "none"; // "local" | "merged" | "none"
let _catalogError = null;
let _catalogLocalCount = 0;
let _catalogRemoteCount = 0;
let _catalogLastRemoteFetch = 0;
const CATALOG_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CATALOG_REMOTE_URL = "https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/lists.json";
const CATALOG_REMOTE_FALLBACK = "https://raw.githubusercontent.com/ProtoConsent/data/main/lists.json";
const SUPPORTED_MANIFEST_VERSION = 1;

function loadEnhancedListsCatalog(options) {
  const forceRefresh = options && options.forceRefresh;

  if (enhancedListsCatalog && !forceRefresh &&
      (Date.now() - _catalogLastFetched < CATALOG_TTL)) {
    return Promise.resolve(enhancedListsCatalog);
  }

  // Deduplicate concurrent calls: return in-flight promise if one exists
  if (_catalogPromise && !forceRefresh) return _catalogPromise;

  // Load local fallback (always available, even offline)
  const localPromise = fetch(chrome.runtime.getURL("config/enhanced-lists.json"))
    .then(r => r.json())
    .catch(() => ({}));

  // Remote fetch gated by user consent (dynamicListsConsent)
  const consentPromise = new Promise(r =>
    chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))
  );

  const remotePromise = consentPromise.then(consented => {
    if (!consented) return null;

    // Fetch remote lists.json (10s timeout, CDN with fallback)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const fetchOpts = { credentials: "omit", signal: controller.signal };

    return fetch(CATALOG_REMOTE_URL, fetchOpts)
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch(err => {
        if (err.name === "AbortError") throw err;
        return fetch(CATALOG_REMOTE_FALLBACK, fetchOpts)
          .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
      })
      .then(manifest => {
        clearTimeout(timeoutId);
        if (!manifest || typeof manifest.manifest_version !== "number") return null;
        if (manifest.manifest_version > SUPPORTED_MANIFEST_VERSION) {
          console.warn("ProtoConsent: remote manifest_version " +
            manifest.manifest_version + " > supported " +
            SUPPORTED_MANIFEST_VERSION + ", using local catalog");
          return null;
        }
        return manifest.lists || null;
      })
      .catch(err => {
        clearTimeout(timeoutId);
        _catalogError = err.message || "unknown";
        if (DEBUG_RULES) console.warn("ProtoConsent: remote catalog fetch failed:", err.message);
        return null;
      });
  });

  _catalogPromise = Promise.all([localPromise, remotePromise]).then(([local, remote]) => {
    _catalogLastFetched = Date.now();
    _catalogPromise = null;
    _catalogLocalCount = Object.keys(local).length;
    _catalogRemoteCount = remote ? Object.keys(remote).length : 0;

    if (!remote) {
      _catalogSource = "local";
      _catalogError = _catalogError || null;
      enhancedListsCatalog = local;
      return enhancedListsCatalog;
    }

    // Merge: local-first, remote-overlay (null-prototype to avoid __proto__ pollution)
    _catalogSource = "merged";
    _catalogError = null;
    _catalogLastRemoteFetch = Date.now();
    const merged = Object.create(null);
    for (const id of Object.keys(local)) {
      merged[id] = local[id];
    }
    for (const id of Object.keys(remote)) {
      if (merged[id]) {
        const entry = Object.create(null);
        Object.assign(entry, merged[id], remote[id]);
        merged[id] = entry;
      } else {
        merged[id] = remote[id];
      }
    }

    enhancedListsCatalog = merged;
    return enhancedListsCatalog;
  });

  return _catalogPromise;
}

// Serialized whitelist write queue to prevent concurrent read-modify-write conflicts.
let _wlQueue = Promise.resolve();
function withWhitelist(fn) {
  _wlQueue = _wlQueue.then(() => getWhitelistFromStorage().then(fn));
  return _wlQueue;
}

// Sequential guard: if a rebuild is already running, queue one re-run at the end.
let _rebuildRunning = false;
let _rebuildQueued = false;


// Main function: rebuild all DNR enforcement from current storage + blocklists.
// 1) Enable/disable static rulesets (domain + path) for global blocking per category.
// 2) Build per-site dynamic overrides (block/allow) grouped by category.
// 3) Build whitelist allow rules (priority 3 - global domain exceptions).
// 4) Build GPC header rules (global + per-site overrides).
// 5) Replace all dynamic rules in a single updateDynamicRules call.
// 6) Update static rulesets AFTER dynamic (may temporarily block too much, but never too little).
async function rebuildAllDynamicRules() {
  if (_rebuildRunning) {
    _rebuildQueued = true;
    return;
  }
  _rebuildRunning = true;

  await loadDebugFlag();

  try {
    await _rebuildAllDynamicRulesImpl();
  } finally {
    _rebuildRunning = false;
    if (_rebuildQueued) {
      _rebuildQueued = false;
      rebuildAllDynamicRules();
    }
  }
}

async function _rebuildAllDynamicRulesImpl() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    console.warn("ProtoConsent: declarativeNetRequest not available in this browser.");
    return;
  }

  try {
    // loadPurposesConfig must run first - it populates PURPOSES_FOR_ENFORCEMENT
    // which loadBlocklistsConfig needs to know which rule files to read.
    await loadPurposesConfig();

    const [rulesByDomain, blocklists, presets, defaultConfig, whitelist, enhancedListsMeta] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
      getWhitelistFromStorage(),
      getEnhancedListsFromStorage(),
    ]);
    const enhancedData = await getAllEnhancedDataFromStorage(enhancedListsMeta);

    // GPC toggle: default to true if not set
    const gpcEnabled = await new Promise(resolve => {
      chrome.storage.local.get(["gpcEnabled"], r => resolve(r.gpcEnabled !== false));
    });

    // Client Hints stripping toggle: default to true if not set
    const chStrippingEnabled = await new Promise(resolve => {
      getChStrippingEnabled(resolve);
    });

    // Consent-Enhanced link: denied purposes auto-activate Enhanced lists
    const consentEnhancedLink = await new Promise(resolve => {
      chrome.storage.local.get(["consentEnhancedLink", "dynamicListsConsent"], r => resolve({
        cel: r.consentEnhancedLink === true,
        sync: r.dynamicListsConsent === true,
      }));
    });

    // Collect existing dynamic rule IDs for the atomic swap at the end
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    const newRules = [];
    let nextRuleId = BASE_RULE_ID;
    const newDynamicBlockMap = {};
    const newGpcSetIds = new Set();
    const newWhitelistMap = {};
    const newEnhancedMap = {};

    // 1. Resolve global default purposes (what applies to unconfigured sites)
    const globalPurposes = resolvePurposes({}, presets, defaultConfig);

    // 2. Compute which static rulesets to enable/disable.
    //    Each category may have a domain ruleset (block_X) and/or a path ruleset (block_X_paths).
    //    We enable/disable them independently based on the global profile,
    //    freeing the dynamic rule budget for per-site overrides.
    const enableIds = [];
    const disableIds = [];
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const hasDomains = blocklists[purposeKey]?.domains?.length > 0;
      const hasPaths = blocklists[purposeKey]?.pathDomains?.length > 0;
      if (!hasDomains && !hasPaths) continue; // no rulesets for this category
      const rulesetId = "block_" + purposeKey;
      if (!globalPurposes[purposeKey]) {
        if (hasDomains) enableIds.push(rulesetId);
        if (hasPaths) enableIds.push(rulesetId + "_paths");
      } else {
        if (hasDomains) disableIds.push(rulesetId);
        if (hasPaths) disableIds.push(rulesetId + "_paths");
      }
    }

    // Track which static rulesets are actively blocking (for onErrorOccurred disambiguation)
    enabledBlockRulesets = new Set(enableIds);

    // 3. Per-site overrides (priority 2 - override static rules where site differs)
    //    First pass: group sites by (category, action) so we can batch all sites
    //    into one initiatorDomains array per rule. This keeps the rule count
    //    proportional to categories (max 10 dynamic rules), not to the number of custom sites.
    //    Override requestDomains merges domain + pathDomain lists so both domain-based
    //    and path-based static rules are overridden for the site.
    const allowOverrides = {}; // purposeKey -> [site1, site2, ...]
    const blockOverrides = {}; // purposeKey -> [site1, site2, ...]
    const permissiveSites = []; // sites where all purposes are allowed (excludes enhanced)

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);

      let allAllowed = true;
      for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
        const siteAllows = sitePurposes[purposeKey];
        const globalAllows = globalPurposes[purposeKey];
        if (!siteAllows) allAllowed = false;

        if (siteAllows === globalAllows) continue;

        if (siteAllows) {
          if (!allowOverrides[purposeKey]) allowOverrides[purposeKey] = [];
          allowOverrides[purposeKey].push(domain);
        } else {
          if (!blockOverrides[purposeKey]) blockOverrides[purposeKey] = [];
          blockOverrides[purposeKey].push(domain);
        }
      }
      if (allAllowed) permissiveSites.push(domain);
    }

    // Second pass: emit one rule per (category, action) with all sites grouped
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const domainList = blocklists[purposeKey]?.domains || [];
      const pathDomainList = blocklists[purposeKey]?.pathDomains || [];
      const domains = pathDomainList.length ? [...domainList, ...pathDomainList] : domainList;
      if (!domains.length) continue;

      if (allowOverrides[purposeKey]?.length) {
        newRules.push({
          id: nextRuleId++,
          priority: 2,
          action: { type: "allow" },
          condition: {
            requestDomains: domains,
            initiatorDomains: allowOverrides[purposeKey],
            resourceTypes: BLOCK_RESOURCE_TYPES,
          },
        });
      }

      if (blockOverrides[purposeKey]?.length) {
        // Path-extracted domains (e.g. "elpais.com" from ||elpais.com/t.gif)
        // are too broad as requestDomains - DNR matches all subdomains, so
        // "elpais.com" would block static.elpais.com, imagenes.elpais.com, etc.
        // When one overlaps with an initiatorDomain the rule blocks the site's
        // own first-party resources.  Filter those out; the static path ruleset
        // handles them with precise urlFilter patterns when enabled globally.
        const initiators = blockOverrides[purposeKey];
        let effectiveDomains = domains;
        if (pathDomainList.length) {
          const safePathDomains = pathDomainList.filter(pd =>
            !initiators.some(id => pd === id || pd.endsWith("." + id) || id.endsWith("." + pd))
          );
          effectiveDomains = safePathDomains.length
            ? [...domainList, ...safePathDomains]
            : domainList;
        }
        if (effectiveDomains.length) {
          newDynamicBlockMap[nextRuleId] = purposeKey;
          newRules.push({
            id: nextRuleId++,
            priority: 2,
            action: { type: "block" },
            condition: {
              requestDomains: effectiveDomains,
              initiatorDomains: initiators,
              resourceTypes: BLOCK_RESOURCE_TYPES,
            },
          });
        }
      }
    }

    // 4. Whitelist allow rules (priority 3 - always win over blocks and per-site overrides).
    //    Global entries ("*") → one rule without initiatorDomains.
    //    Per-site entries → grouped by site, one rule per site with initiatorDomains.
    //    Budget: whitelist rules are capped so core rules always have room.
    const globalWhitelistDomains = [];
    const perSiteWhitelist = {}; // site -> [domain, ...]

    for (const [domain, siteMap] of Object.entries(whitelist)) {
      if (!isValidHostname(domain)) continue; // skip corrupted entries
      for (const site of Object.keys(siteMap)) {
        if (site === "*") {
          globalWhitelistDomains.push(domain);
        } else if (isValidHostname(site)) {
          if (!perSiteWhitelist[site]) perSiteWhitelist[site] = [];
          perSiteWhitelist[site].push(domain);
        }
      }
    }

    // Cap whitelist rules to the remaining budget after core rules + reserve.
    const maxDynamic = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
    const coreRuleCount = newRules.length; // overrides + blocks so far (before whitelist)
    const whitelistBudget = maxDynamic - coreRuleCount - DYNAMIC_RULE_RESERVE;
    // 1 rule for global (if any) + 1 rule per site
    const whitelistRulesNeeded = (globalWhitelistDomains.length > 0 ? 1 : 0) +
      Object.keys(perSiteWhitelist).length;

    if (whitelistRulesNeeded > whitelistBudget) {
      console.warn("ProtoConsent: whitelist needs " + whitelistRulesNeeded +
        " rules but budget is " + whitelistBudget +
        " (core: " + coreRuleCount + ", reserve: " + DYNAMIC_RULE_RESERVE + "). " +
        "Some per-site whitelist entries will be dropped.");
    }

    let whitelistRulesAdded = 0;

    if (globalWhitelistDomains.length > 0 && whitelistRulesAdded < whitelistBudget) {
      const wlId = nextRuleId++;
      newWhitelistMap[wlId] = globalWhitelistDomains;
      newRules.push({
        id: wlId,
        priority: 3,
        action: { type: "allow" },
        condition: {
          requestDomains: globalWhitelistDomains,
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      });
      whitelistRulesAdded++;
    }

    for (const [site, domains] of Object.entries(perSiteWhitelist)) {
      if (whitelistRulesAdded >= whitelistBudget) break;
      const wlId = nextRuleId++;
      newWhitelistMap[wlId] = domains;
      newRules.push({
        id: wlId,
        priority: 3,
        action: { type: "allow" },
        condition: {
          requestDomains: domains,
          initiatorDomains: [site],
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      });
      whitelistRulesAdded++;
    }

    // 5. Enhanced Protection lists (dynamic block rules, priority 2).
    //    Each enabled list produces one domain rule and optional path rules.
    //    Domain/path data is stored in separate enhancedData_* keys for performance.
    //    Sites with all purposes allowed (permissive) are excluded.
    //    Consent-Enhanced link: denied purposes auto-activate matching lists.
    const consentLinkedListIds = new Set();
    const celPendingDownload = [];
    if (consentEnhancedLink.cel) {
      const celCatalog = await loadEnhancedListsCatalog();
      if (celCatalog) {
        const deniedCategories = new Set();
        for (const [purpose, allowed] of Object.entries(globalPurposes)) {
          if (!allowed) deniedCategories.add(purpose);
        }
        for (const [listId, listDef] of Object.entries(celCatalog)) {
          if (listDef.category && deniedCategories.has(listDef.category)) {
            if (enhancedListsMeta[listId]) {
              consentLinkedListIds.add(listId);
            } else if (listDef.fetch_url && consentEnhancedLink.sync) {
              celPendingDownload.push(listId);
            }
          }
        }
      }
    }

    // Fetch data for consent-linked lists that are disabled (not loaded by default)
    if (consentLinkedListIds.size > 0) {
      const missingIds = [...consentLinkedListIds].filter(id => !enhancedData[id]);
      if (missingIds.length > 0) {
        const keys = missingIds.map(id => "enhancedData_" + id);
        const extraData = await new Promise(resolve => {
          chrome.storage.local.get(keys, result => {
            const out = {};
            for (const id of missingIds) {
              if (result["enhancedData_" + id]) out[id] = result["enhancedData_" + id];
            }
            resolve(out);
          });
        });
        Object.assign(enhancedData, extraData);
      }
    }

    lastConsentLinkedListIds = [...consentLinkedListIds];
    lastCelPendingDownload = celPendingDownload;

    const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;

    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      if (listMeta.type === "informational") continue; // CNAME etc. - no DNR rules
      const listData = enhancedData[listId];
      if (!listData) continue;

      if (listData.domains?.length) {
        const rId = nextRuleId++;
        newEnhancedMap[rId] = listId;
        const condition = {
          requestDomains: listData.domains,
          resourceTypes: BLOCK_RESOURCE_TYPES,
        };
        if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
        newRules.push({
          id: rId,
          priority: 2,
          action: { type: "block" },
          condition,
        });
      }

      if (listData.pathRules?.length) {
        for (const pr of listData.pathRules) {
          const rId = nextRuleId++;
          newEnhancedMap[rId] = listId;
          const condition = {
            urlFilter: pr.urlFilter,
            resourceTypes: BLOCK_RESOURCE_TYPES,
          };
          if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
          newRules.push({
            id: rId,
            priority: 2,
            action: { type: "block" },
            condition,
          });
        }
      }
    }

    // Build enhanced reverse index for onErrorOccurred attribution
    const newEnhancedReverseIndex = new Map();
    for (const [listId, listData] of Object.entries(enhancedData)) {
      if (listData.domains?.length) {
        for (const d of listData.domains) {
          newEnhancedReverseIndex.set(d, listId);
        }
      }
      // Also index hostnames from path rules (urlFilter: "||domain/path")
      if (listData.pathRules?.length) {
        for (const pr of listData.pathRules) {
          const m = pr.urlFilter?.match(/^\|\|([^/]+)/);
          if (m && !newEnhancedReverseIndex.has(m[1])) {
            newEnhancedReverseIndex.set(m[1], listId);
          }
        }
      }
    }
    enhancedReverseIndex = newEnhancedReverseIndex;

    // 6. GPC header rules - inject Sec-GPC: 1 when privacy purposes are denied.
    //
    // Per-site overrides use requestDomains (the destination), not initiatorDomains
    // (the page making the request). This means: trusting elpais.com (custom, all
    // allowed) removes GPC from requests TO elpais.com, but third-party requests
    // FROM elpais.com to e.g. google-analytics.com still carry the global GPC
    // signal - trusting a site does not imply trusting the third parties it loads.
    // The same applies to cross-origin iframes: an iframe from youtube.com on a
    // trusted elpais.com page still receives GPC from the global rule.
    const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);

    if (globalNeedsGPC) {
      // Global: send GPC on all requests by default
      const gpcGlobalId = nextRuleId++;
      newGpcSetIds.add(gpcGlobalId);
      newRules.push({
        id: gpcGlobalId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "set", value: "1" }
          ]
        },
        condition: {
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    // Per-site GPC overrides - grouped into max 2 rules (add/remove)
    const gpcAddSites = [];
    const gpcRemoveSites = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (siteNeedsGPC) {
        gpcAddSites.push(domain);
      } else {
        gpcRemoveSites.push(domain);
      }
    }

    if (gpcAddSites.length > 0) {
      const gpcAddId = nextRuleId++;
      newGpcSetIds.add(gpcAddId);
      newRules.push({
        id: gpcAddId,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "set", value: "1" }
          ]
        },
        condition: {
          requestDomains: gpcAddSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    // GPC remove rule for permissive sites - popup filters these out
    // by only counting "set" operations, not "remove"
    if (gpcRemoveSites.length > 0) {
      newRules.push({
        id: nextRuleId++,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "remove" }
          ]
        },
        condition: {
          requestDomains: gpcRemoveSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    // Snapshot GPC config for the onSendHeaders production filter.
    // This tells the production listener which domains should receive GPC,
    // filtering out native browser GPC signals that we didn't inject.
    gpcGlobalActive = globalNeedsGPC;
    gpcAddDomains = new Set(gpcAddSites);
    gpcRemoveDomains = new Set(gpcRemoveSites);

    // 6b. Client Hints stripping - remove high-entropy Sec-CH-UA-* headers
    //     when advanced_tracking purpose is denied.
    //     These headers expose OS version, CPU architecture, device model and
    //     full browser version - enough (~33 bits) to uniquely fingerprint a
    //     user. Firefox and Safari do not send Client Hints at all, so removing
    //     them causes no site breakage.
    //     Low-entropy hints (Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform)
    //     are kept - they have minimal fingerprinting value and are needed for
    //     basic content negotiation.
    //     HIGH_ENTROPY_CH is defined in config.js.
    const chHeaders = HIGH_ENTROPY_CH.map(h => ({ header: h, operation: "remove" }));

    const globalDeniesAT = chStrippingEnabled && !globalPurposes.advanced_tracking;

    // Collect per-site exceptions before emitting the global rule
    const chAddSites = [];    // deny AT per-site when global allows
    const chRemoveSites = []; // allow AT per-site when global denies

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteDeniesAT = chStrippingEnabled && !sitePurposes.advanced_tracking;
      if (siteDeniesAT === globalDeniesAT) continue;
      if (siteDeniesAT) chAddSites.push(domain);
      else chRemoveSites.push(domain);
    }

    // Global CH stripping rule (priority 1).  Cannot "un-remove" a native
    // header, so sites that allow AT are excluded via excludedRequestDomains
    // instead of a separate override rule.
    const newChRuleIds = new Set();
    if (globalDeniesAT) {
      const chGlobalId = nextRuleId++;
      newChRuleIds.add(chGlobalId);
      const chGlobalRule = {
        id: chGlobalId,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: chHeaders },
        condition: { resourceTypes: GPC_RESOURCE_TYPES },
      };
      if (chRemoveSites.length > 0) {
        chGlobalRule.condition.excludedRequestDomains = chRemoveSites;
      }
      newRules.push(chGlobalRule);
    }

    // Per-site CH stripping: sites that deny AT when the global profile allows it
    if (chAddSites.length > 0) {
      const chPerSiteId = nextRuleId++;
      newChRuleIds.add(chPerSiteId);
      newRules.push({
        id: chPerSiteId,
        priority: 2,
        action: { type: "modifyHeaders", requestHeaders: chHeaders },
        condition: {
          requestDomains: chAddSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    if (DEBUG_RULES) {
      const overrideCount = newRules.filter(r => r.condition.initiatorDomains).length;
      const gpcGlobal = newRules.filter(r =>
        r.action.type === "modifyHeaders" && !r.condition.requestDomains).length;
      const gpcPerSite = newRules.filter(r =>
        r.action.type === "modifyHeaders" && r.condition.requestDomains).length;
      // Per-category domain counts
      const categoryDomains = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const d = blocklists[key]?.domains?.length || 0;
        const p = blocklists[key]?.pathDomains?.length || 0;
        if (d || p) categoryDomains[key] = d + "d+" + p + "p=" + (d + p);
      }
      // Per-site override detail
      const overrideDetails = {};
      for (const r of newRules) {
        if (r.condition.initiatorDomains && r.condition.requestDomains) {
          overrideDetails[r.id] = r.action.type + " " + r.condition.requestDomains.length +
            " → " + r.condition.initiatorDomains.join(",");
        }
      }
      // Custom sites summary
      const customSites = Object.keys(rulesByDomain);
      lastRebuildDebug = {
        globalProfile: defaultConfig.profile || "balanced",
        globalPurposes,
        categoryDomains,
        customSites,
        enableIds,
        disableIds,
        dynamicCount: newRules.length,
        overrideCount,
        gpcGlobal,
        gpcPerSite,
        overrideDetails,
        whitelistDomainCount: Object.keys(whitelist).length,
        whitelistGlobalCount: globalWhitelistDomains.length,
        whitelistPerSiteCount: Object.values(perSiteWhitelist).reduce((s, d) => s + d.length, 0),
        whitelistRuleCount: (globalWhitelistDomains.length > 0 ? 1 : 0) + Object.keys(perSiteWhitelist).length,
        whitelistSites: Object.keys(perSiteWhitelist),
        enhancedCount: Object.values(enhancedListsMeta).filter(l => l.enabled).length,
        enhancedListIds: Object.entries(enhancedListsMeta)
          .filter(([, l]) => l.enabled).map(([id]) => id),
        enhancedRules: Object.keys(newEnhancedMap).length,
        chStripping: globalDeniesAT ? "global" : (chAddSites.length > 0 ? "per-site" : "off"),
        chEnabled: chStrippingEnabled,
        chRules: newChRuleIds.size,
        chExcluded: chRemoveSites.length,
        chAddSites: chAddSites.length,
        consentEnhancedLink: consentEnhancedLink.cel,
        consentLinkedListIds: [...consentLinkedListIds],
        celPendingDownload: celPendingDownload,
        ts: Date.now(),
      };
    }

    // 7. Apply changes: dynamic rules FIRST, then static rulesets.
    //    Order matters for security: during the brief gap between calls,
    //    "new dynamic + old static" may block too much (safe), whereas the
    //    reverse order "new static + old dynamic" could let requests through.
    //    Each wrapped in its own try/catch to surface errors independently.
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: newRules,
      });
      dynamicBlockRuleMap = newDynamicBlockMap;
      dynamicGpcSetIds = newGpcSetIds;
      dynamicChRuleIds = newChRuleIds;
      dynamicWhitelistMap = newWhitelistMap;
      dynamicEnhancedMap = newEnhancedMap;
    } catch (e) {
      console.error("updateDynamicRules failed:", e.message, "rules:", newRules.length);
      if (DEBUG_RULES) lastRebuildDebug.error = e.message;
    }
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enableIds,
        disableRulesetIds: disableIds,
      });
    } catch (e) {
      console.error("updateEnabledRulesets failed:", e.message,
        "enable:", enableIds, "disable:", disableIds);
      if (DEBUG_RULES) lastRebuildDebug.rulesetError = e.message;
    }

    // Update the GPC content script registration to match the new rule state
    await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);

  } catch (e) {
    console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
  }
}

// Register or unregister the GPC DOM signal (navigator.globalPrivacyControl)
// as a MAIN-world content script, scoped to domains where GPC is needed.
// Receives pre-computed data from the rebuild to avoid re-reading storage.
const GPC_SCRIPT_ID = "protoconsent-gpc";

async function updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    // Always unregister first to start fresh
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] }).catch(() => {});

    // If GPC is globally disabled, unregister and return
    if (!gpcEnabled) return;

    const globalNeedsGPC = gpcPurposes.length > 0 && gpcPurposes.some(p => !globalPurposes[p]);

    // Collect per-site exceptions (domains that differ from global GPC state)
    const excludeDomains = [];
    const includeDomains = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (globalNeedsGPC && !siteNeedsGPC) {
        excludeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      } else if (!globalNeedsGPC && siteNeedsGPC) {
        includeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      }
    }

    // Determine if we need to register at all
    if (globalNeedsGPC) {
      // Register for all URLs, excluding domains that override to no-GPC
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: ["<all_urls>"],
        excludeMatches: excludeDomains.length > 0 ? excludeDomains : undefined,
        js: ["gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (includeDomains.length > 0) {
      // Global doesn't need GPC but some sites do
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: includeDomains,
        js: ["gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    }
    // else: no GPC needed anywhere, nothing to register

  } catch (e) {
    console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}

// Handle a bridge query from the content script.
// Reads storage, resolves purposes for the requested domain,
// and returns the appropriate data based on the action.
async function handleBridgeQuery(message) {
  const { domain, action, purpose } = message;

  const [rules, presets, defaultConfig] = await Promise.all([
    getAllRulesFromStorage(),
    loadPresetsConfig(),
    getDefaultProfileConfig(),
    loadPurposesConfig()
  ]);

  const siteConfig = rules[domain] || {};
  const resolved = resolvePurposes(siteConfig, presets, defaultConfig);

  switch (action) {
    case 'get':
      return (purpose in resolved) ? resolved[purpose] : null;
    case 'getAll':
      return resolved;
    case 'getProfile':
      return siteConfig.profile || (defaultConfig && defaultConfig.profile) || 'balanced';
    default:
      return null;
  }
}

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // Popup notifies that rules were changed by the user
  if (message.type === "PROTOCONSENT_RULES_UPDATED") {
    rebuildAllDynamicRules();
    sendResponse({ ok: true });
    return;
  }

  // Popup requests per-tab blocked domain detail + per-purpose counts (domains + paths)
  if (message.type === "PROTOCONSENT_GET_BLOCKED_DOMAINS") {
    // Lazy rebuild if SW restarted and in-memory state is stale
    if (PURPOSES_FOR_ENFORCEMENT.length === 0) {
      rebuildAllDynamicRules();
    }
    Promise.all([loadBlocklistsConfig(), getWhitelistFromStorage()]).then(([bl, whitelist]) => {
      const purposeDomainCounts = {};
      const purposePathCounts = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const dLen = bl[key]?.domains?.length;
        const pLen = bl[key]?.pathDomains?.length;
        if (dLen) purposeDomainCounts[key] = dLen;
        if (pLen) purposePathCounts[key] = pLen;
      }
      const gpcDomains = tabGpcDomains.get(message.tabId);
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        purposeDomainCounts,
        purposePathCounts,
        gpcDomains: gpcDomains ? Object.keys(gpcDomains) : [],
        gpcDomainCounts: gpcDomains || {},
        whitelist,
      });
    });
    return true; // async response
  }

  // Content script forwards an SDK query
  if (message.type === "PROTOCONSENT_BRIDGE_QUERY") {
    handleBridgeQuery(message)
      .then((data) => sendResponse({ data }))
      .catch(() => sendResponse({ data: null }));
    return true; // keep message channel open for async response
  }

  // TCF detection from tcf-detect.js (via content-script.js relay)
  if (message.type === "PROTOCONSENT_TCF_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId) {
      // Validate and sanitize TCF data before storing
      const rawCmpId = message.cmpId;
      const rawCmpVer = message.cmpVersion;
      const rawPolicyVer = message.tcfPolicyVersion;
      const rawConsents = message.purposeConsents;

      const cmpId = (typeof rawCmpId === "number" && rawCmpId > 0 && rawCmpId < 10000) ? rawCmpId : null;
      const cmpVersion = (typeof rawCmpVer === "number" && rawCmpVer > 0 && rawCmpVer < 100) ? rawCmpVer : null;
      const tcfPolicyVersion = (typeof rawPolicyVer === "number" && rawPolicyVer > 0 && rawPolicyVer < 100) ? rawPolicyVer : null;

      let purposeConsents = null;
      if (rawConsents && typeof rawConsents === "object" && !Array.isArray(rawConsents)) {
        purposeConsents = {};
        const entries = Object.entries(rawConsents);
        // TCF v2 has max 11 purposes; cap at 20 to be safe
        const maxEntries = Math.min(entries.length, 20);
        for (let i = 0; i < maxEntries; i++) {
          const [key, val] = entries[i];
          if (/^\d{1,2}$/.test(key) && typeof val === "boolean") {
            purposeConsents[key] = val;
          }
        }
      }

      const tcfInfo = { detected: true, cmpId, cmpVersion, tcfPolicyVersion, purposeConsents };
      tabTcfData.set(tabId, tcfInfo);
      if (chrome.storage.session) {
        chrome.storage.session.set({ ["tcf_" + tabId]: tcfInfo }).catch(() => {});
      }
    }
    return;
  }

  // Popup requests TCF data for a tab
  if (message.type === "PROTOCONSENT_GET_TCF") {
    const info = tabTcfData.get(message.tabId) || null;
    sendResponse({ tcf: info });
    return;
  }

  // Popup requests last rebuild debug snapshot
  if (message.type === "PROTOCONSENT_GET_DEBUG") {
    // If the SW restarted and lastRebuildDebug is stale (no enableIds),
    // trigger a rebuild first so the snapshot reflects actual state.
    const respond = () => {
      const debugData = Object.assign({}, lastRebuildDebug, {
        navigatingTabs: tabNavigating.size,
        logPorts: logPorts.size,
        catalogSource: _catalogSource,
        catalogLastFetched: _catalogLastFetched,
        catalogError: _catalogError,
        catalogLocalCount: _catalogLocalCount,
        catalogRemoteCount: _catalogRemoteCount,
        catalogLastRemoteFetch: _catalogLastRemoteFetch,
      });
      // Gather async debug data: session storage + inter-extension API state + dynamic lists consent
      const p1 = (chrome.storage.session && chrome.storage.session.get)
        ? chrome.storage.session.get(null).then(s => Object.keys(s).length).catch(() => -1)
        : Promise.resolve(-1);
      const p2 = new Promise(r => chrome.storage.local.get(
        ["interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending"],
        r
      ));
      const p3 = new Promise(r => chrome.storage.local.get(
        ["dynamicListsConsent", "consentEnhancedLink"], d => r({
          dynamicConsent: d.dynamicListsConsent === true,
          consentEnhancedLink: d.consentEnhancedLink === true,
        })
      ));
      Promise.all([p1, p2, p3]).then(([sessionKeys, ext, p3Result]) => {
        debugData.sessionKeys = sessionKeys;
        debugData.interExtEnabled = ext.interExtEnabled === true;
        debugData.interExtAllowlist = ext.interExtAllowlist || [];
        debugData.interExtDenylist = ext.interExtDenylist || [];
        debugData.interExtPending = ext.interExtPending || [];
        debugData.dynamicListsConsent = p3Result.dynamicConsent;
        debugData.consentEnhancedLink = p3Result.consentEnhancedLink;
        debugData.consentLinkedListIds = lastConsentLinkedListIds;
        debugData.celPendingDownload = lastCelPendingDownload;
        sendResponse(debugData);
      });
    };
    if (!lastRebuildDebug.enableIds) {
      rebuildAllDynamicRules().then(respond).catch(respond);
    } else {
      respond();
    }
    return true; // async response
  }

  // Popup requests .well-known fetch (via background to bypass page Service Workers)
  if (message.type === "PROTOCONSENT_FETCH_WELL_KNOWN") {
    const domain = message.domain;
    if (!domain || typeof domain !== "string") {
      sendResponse({ data: null });
      return;
    }
    const host = (message.host && typeof message.host === "string") ? message.host : domain;
    const protocol = message.protocol === "http:" ? "http://" : "https://";
    const url = protocol + host + "/.well-known/protoconsent.json";
    fetch(url, { credentials: "omit", redirect: "follow" })
      .then(res => {
        if (!res.ok) return null;
        return res.text().then(text => {
          if (text.length > 5000) return null;
          try { return JSON.parse(text); } catch (_) { return null; }
        });
      })
      .then(data => sendResponse({ data: data || null }))
      .catch(() => sendResponse({ data: null }));
    return true; // async response
  }

  // Popup requests adding a domain to the whitelist
  if (message.type === "PROTOCONSENT_WHITELIST_ADD") {
    const { domain, purpose, site } = message;
    if (!domain || !purpose || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return;
    }
    const siteKey = (site && isValidHostname(site)) ? site : "*";
    withWhitelist(whitelist => {
      if (!whitelist[domain]) whitelist[domain] = {};
      // Remove conflicting scope (if adding per-site, remove global and vice versa)
      if (siteKey === "*") {
        // Going global: remove all per-site entries for this domain
        whitelist[domain] = {};
      } else {
        // Going per-site: remove global entry if present
        delete whitelist[domain]["*"];
      }
      whitelist[domain][siteKey] = purpose;
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true; // async response
  }

  // Popup requests removing a domain from the whitelist
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE") {
    const { domain, site } = message;
    if (!domain) { sendResponse({ ok: false }); return; }
    withWhitelist(whitelist => {
      if (whitelist[domain]) {
        if (site) {
          delete whitelist[domain][site];
          if (Object.keys(whitelist[domain]).length === 0) {
            delete whitelist[domain];
          }
        } else {
          delete whitelist[domain];
        }
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true; // async response
  }

  // Popup requests toggling whitelist scope between per-site and global
  if (message.type === "PROTOCONSENT_WHITELIST_TOGGLE_SCOPE") {
    const { domain, site } = message;
    if (!domain || !site) { sendResponse({ ok: false }); return; }
    withWhitelist(whitelist => {
      if (!whitelist[domain]) { sendResponse({ ok: false }); return Promise.resolve(); }
      if (site === "*") {
        // Currently global → make per-site: need the caller to provide the target site
        // This case is handled by WHITELIST_ADD with a specific site
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      // Currently per-site → make global: move entry from site key to "*"
      const purpose = whitelist[domain][site];
      if (!purpose) {
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      // Clean all entries, set global
      whitelist[domain] = { "*": purpose };
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true, whitelist });
          }
          resolve();
        });
      });
    });
    return true; // async response
  }

  // Enhanced Protection: get current state (catalog + enabled lists + preset)
  if (message.type === "PROTOCONSENT_ENHANCED_GET_STATE") {
    const forceRefresh = message.forceRefresh === true;
    Promise.all([
      loadEnhancedListsCatalog(forceRefresh ? { forceRefresh: true } : undefined),
      getEnhancedListsFromStorage(),
      getEnhancedPresetFromStorage(),
      new Promise(r => chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))),
      new Promise(r => chrome.storage.local.get("consentEnhancedLink", d => r(d.consentEnhancedLink === true))),
    ]).then(([catalog, lists, preset, dynamicConsent, consentEnhancedLink]) => {
      const consentLinkedListIds = lastConsentLinkedListIds;
      const celPendingDownload = lastCelPendingDownload;
      sendResponse({ catalog, lists, preset, dynamicConsent, consentEnhancedLink, consentLinkedListIds, celPendingDownload });
    });
    return true; // async response
  }

  // Enhanced Protection: set preset (off / basic / full)
  if (message.type === "PROTOCONSENT_ENHANCED_SET_PRESET") {
    const preset = message.preset;
    if (!["off", "basic", "full", "custom"].includes(preset)) {
      sendResponse({ ok: false }); return;
    }
    loadEnhancedListsCatalog().then(catalog => {
      withEnhancedStorageLock(() => {
        return getEnhancedListsFromStorage().then(lists => {
          for (const [listId, listDef] of Object.entries(catalog)) {
            if (!lists[listId]) continue; // not downloaded - skip
            if (preset === "off") {
              lists[listId].enabled = false;
            } else if (preset === "basic") {
              lists[listId].enabled = listDef.preset === "basic";
            } else if (preset === "full") {
              lists[listId].enabled = true;
            }
            // "custom" does not change individual toggles
          }
          return new Promise(resolve => {
            chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: preset }, () => {
              if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                resolve();
                return;
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true; // async response
  }

  // Enhanced Protection: toggle a single list
  if (message.type === "PROTOCONSENT_ENHANCED_TOGGLE") {
    const { listId, enabled } = message;
    if (!listId || typeof enabled !== "boolean") {
      sendResponse({ ok: false }); return;
    }
    withEnhancedStorageLock(() => {
      return getEnhancedListsFromStorage().then(lists => {
        if (!lists[listId]) {
          sendResponse({ ok: false, error: "List not downloaded" }); return;
        }
        lists[listId].enabled = enabled;
        return new Promise(resolve => {
          chrome.storage.local.set({
            enhancedLists: lists,
            enhancedPreset: "custom",
          }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              resolve();
              return;
            }
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
            resolve();
          });
        });
      });
    });
    return true; // async response
  }

  // Enhanced Protection: fetch (download) a list from its source
  if (message.type === "PROTOCONSENT_ENHANCED_FETCH") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    Promise.all([
      loadEnhancedListsCatalog(),
    ]).then(([catalog]) => {
      const listDef = catalog[listId];
      if (!listDef || !listDef.fetch_url) {
        sendResponse({ ok: false, error: "Unknown list or no fetch URL" }); return;
      }
      // Resolve relative paths as extension-local URLs
      const fetchUrl = listDef.fetch_url.startsWith("http")
        ? listDef.fetch_url
        : chrome.runtime.getURL(listDef.fetch_url);
      // Fallback: if primary CDN fails, try raw GitHub
      const fallbackUrl = fetchUrl.includes("cdn.jsdelivr.net/gh/")
        ? fetchUrl.replace("https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/", "https://raw.githubusercontent.com/ProtoConsent/data/main/")
        : null;
      // 30-second timeout to avoid hanging on network issues
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const fetchOpts = { credentials: "omit", signal: controller.signal };
      const tryFetch = (url) => fetch(url, fetchOpts).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
      (tryFetch(fetchUrl).catch(err => {
        if (fallbackUrl && err.name !== "AbortError") return tryFetch(fallbackUrl);
        throw err;
      }))
        .then(data => {
          clearTimeout(timeoutId);
          // Informational lists (e.g. CNAME trackers) store a lookup map, not DNR rules
          if (listDef.type === "informational") {
            if (!data.map || typeof data.map !== "object" || !Array.isArray(data.trackers)) {
              throw new Error("Invalid informational list format: missing map or trackers");
            }
            const domainCount = data.domain_count || Object.keys(data.map).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeInformational(lists, shouldEnable);
                  });
                }
                return storeInformational(lists, shouldEnable);
                function storeInformational(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    domainCount,
                    pathRuleCount: 0,
                    type: "informational",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { map: data.map, trackers: data.trackers },
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      sendResponse({ ok: true, domainCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          // Validate format
          if (!data.rules || !Array.isArray(data.rules)) {
            throw new Error("Invalid list format: missing rules array");
          }
          // Extract domains and path rules
          const domains = [];
          const pathRules = [];
          for (const rule of data.rules) {
            if (rule.condition?.requestDomains) {
              for (const d of rule.condition.requestDomains) domains.push(d);
            }
            if (rule.condition?.urlFilter) {
              pathRules.push({ urlFilter: rule.condition.urlFilter });
            }
          }
          // Serialize the read-modify-write to prevent concurrent FETCH
          // handlers from overwriting each other's list data.
          return withEnhancedStorageLock(() => {
            return Promise.all([
              getEnhancedListsFromStorage(),
              getEnhancedPresetFromStorage(),
            ]).then(([lists, preset]) => {
              // Skip storage write and rebuild if version is unchanged (update, not first download)
              const existing = lists[listId];
              if (existing && data.version && existing.version === data.version) {
                sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount, pathRuleCount: existing.pathRuleCount });
                return;
              }
              // Preserve user's enabled state on update; use preset logic only for new downloads
              const existingEnabled = existing?.enabled;
              let shouldEnable;
              if (existingEnabled !== undefined) {
                shouldEnable = existingEnabled;
              } else {
                shouldEnable = true;
                if (preset === "off") shouldEnable = false;
                else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                // "full" and "custom" → enable by default
              }
              lists[listId] = {
                enabled: shouldEnable,
                version: data.version || null,
                lastFetched: Date.now(),
                domainCount: domains.length,
                pathRuleCount: pathRules.length,
              };
              const storageUpdate = {
                enhancedLists: lists,
                ["enhancedData_" + listId]: {
                  domains,
                  pathRules: pathRules.length > 0 ? pathRules : undefined,
                },
              };
              return new Promise(resolve => {
                chrome.storage.local.set(storageUpdate, () => {
                  if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    resolve();
                    return;
                  }
                  rebuildAllDynamicRules();
                  sendResponse({ ok: true, domainCount: domains.length, pathRuleCount: pathRules.length });
                  resolve();
                });
              });
            });
          });
        })
        .catch(err => {
          clearTimeout(timeoutId);
          sendResponse({ ok: false, error: err.name === "AbortError" ? "Download timed out" : err.message });
        });
    });
    return true; // async response
  }

  // Enhanced Protection: remove downloaded list data from storage
  if (message.type === "PROTOCONSENT_ENHANCED_REMOVE") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    withEnhancedStorageLock(() => {
      return Promise.all([
        getEnhancedListsFromStorage(),
        loadEnhancedListsCatalog(),
        getEnhancedPresetFromStorage(),
      ]).then(([lists, catalog, preset]) => {
        if (!lists[listId]) {
          sendResponse({ ok: true }); return;
        }
        delete lists[listId];
        // Recalculate preset: if current preset is "full" or "basic" and the
        // actual enabled state no longer matches, switch to "custom".
        let newPreset = preset;
        if (preset === "full" || preset === "basic") {
          for (const [id, def] of Object.entries(catalog)) {
            const data = lists[id];
            if (!data) continue; // not downloaded - skip
            const shouldBeEnabled = preset === "full" ? true : def.preset === "basic";
            const isEnabled = data ? !!data.enabled : false;
            if (shouldBeEnabled !== isEnabled) {
              newPreset = "custom";
              break;
            }
          }
        }
        return new Promise(resolve => {
          chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: newPreset }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              resolve();
              return;
            }
            chrome.storage.local.remove("enhancedData_" + listId, () => {
              if (chrome.runtime.lastError) {
                // Data key removal failed - log but still report success
                // since the list metadata was already updated.
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true; // async response
  }
});

// --- Inter-extension provider API ---
// Allows other privacy extensions to query ProtoConsent's consent state.
// Read-only: consumers can query purposes for a domain, never modify preferences.
// See design/spec/inter-extension-protocol.md for the full specification.

const _extRateLimit = new Map(); // senderId -> { count, windowStart }
const EXT_RATE_LIMIT = 10;      // max requests per minute per extension
const EXT_RATE_WINDOW = 60000;  // 1 minute window
const EXT_PENDING_CAP = 10;     // max pending authorization requests stored
const EXT_UNKNOWN_LIMIT = 3;    // max new unknown-ID requests per minute (global)

// Global cooldown for unknown extension IDs (anti-flood).
let _unknownIds = new Set();   // unique unknown IDs seen in current window
let _unknownWindowStart = 0;

// Recent inter-extension events for log replay (capped buffer).
const _extEventLog = [];
const EXT_EVENT_LOG_CAP = 50;

function pushExtEvent(evt) {
  evt.ts = Date.now();
  _extEventLog.push(evt);
  if (_extEventLog.length > EXT_EVENT_LOG_CAP) _extEventLog.shift();
  for (const port of logPorts) {
    try { port.postMessage(Object.assign({ type: "ext" }, evt)); } catch (_) {}
  }
  scheduleSessionPersist();
}

// Clean stale rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - EXT_RATE_WINDOW;
  for (const [id, entry] of _extRateLimit) {
    if (entry.windowStart < cutoff) _extRateLimit.delete(id);
  }
}, 300000);

function checkExtRateLimit(senderId) {
  const now = Date.now();
  let entry = _extRateLimit.get(senderId);
  if (!entry || now - entry.windowStart > EXT_RATE_WINDOW) {
    entry = { count: 0, windowStart: now };
    _extRateLimit.set(senderId, entry);
  }
  entry.count++;
  return entry.count <= EXT_RATE_LIMIT;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Validate envelope
  if (!message || typeof message !== "object" || typeof message.type !== "string"
      || message.type.length > 64 || !message.type.startsWith("protoconsent:")) {
    return; // silently ignore non-protocol messages
  }

  // Check opt-in toggle (default: disabled), allowlist, and denylist (TOFU)
  chrome.storage.local.get(["interExtEnabled", "interExtAllowlist", "interExtDenylist"], (r) => {
    if (r.interExtEnabled !== true) {
      sendResponse({ type: "protoconsent:error", error: "disabled", message: "Inter-extension API is disabled by user" });
      const sid = sender.id || "?";
      pushExtEvent({ sender: sid, action: message.type, result: "disabled" });
      return;
    }

    const senderId = sender.id;
    if (!senderId) return; // anomalous - onMessageExternal should always provide sender.id

    // Denylist: silently drop messages from denied extensions (no response).
    const denylist = r.interExtDenylist || [];
    if (denylist.includes(senderId)) return; // no log - silent by design

    const allowlist = r.interExtAllowlist || []; // array of allowed extension IDs

    // TOFU allowlist: unknown extensions get need_authorization error
    // and are recorded as pending for the user to approve via settings.
    if (!allowlist.includes(senderId)) {
      // Global cooldown for unknown IDs: max EXT_UNKNOWN_LIMIT new unique IDs per minute.
      // Prevents flooding the pending queue with thousands of fake extension IDs.
      // Only counts each unique senderId once per window (not repeat requests from same ID).
      const now = Date.now();
      if (now - _unknownWindowStart > EXT_RATE_WINDOW) {
        _unknownIds = new Set();
        _unknownWindowStart = now;
      }
      const isNewId = !_unknownIds.has(senderId);
      if (isNewId) _unknownIds.add(senderId);
      if (isNewId && _unknownIds.size > EXT_UNKNOWN_LIMIT) return; // silent drop - flood protection

      // Record pending request so the UI can show an authorization prompt.
      // Store: { id, firstSeen }. Cap at EXT_PENDING_CAP (discard oldest).
      chrome.storage.local.get(["interExtPending"], (p) => {
        const pending = p.interExtPending || [];
        if (!pending.some(e => e.id === senderId) && pending.length < EXT_PENDING_CAP) {
          pending.push({ id: senderId, firstSeen: Date.now() });
          chrome.storage.local.set({ interExtPending: pending });
        }
      });
      sendResponse({ type: "protoconsent:error", error: "need_authorization",
        message: "Extension not authorized. The user must approve this extension in ProtoConsent settings." });
      pushExtEvent({ sender: senderId, action: message.type, result: "need_authorization" });
      return;
    }

    // Rate limiting
    if (!checkExtRateLimit(senderId)) {
      sendResponse({ type: "protoconsent:error", error: "rate_limited", message: "Too many requests" });
      pushExtEvent({ sender: senderId, action: message.type, result: "rate_limited" });
      return;
    }

    // Capabilities discovery
    if (message.type === "protoconsent:capabilities") {
      const manifest = chrome.runtime.getManifest();
      sendResponse({
        type: "protoconsent:capabilities_response",
        name: "ProtoConsent",
        version: manifest.version,
        protocol_version: INTEREXT_PROTOCOL_VERSION,
        supported_types: ["protoconsent:query", "protoconsent:capabilities"],
        purposes: ["functional", "analytics", "ads", "personalization", "third_parties", "advanced_tracking"]
      });
      pushExtEvent({ sender: senderId, action: "capabilities", result: "ok" });
      return;
    }

    // Consent query
    if (message.type === "protoconsent:query") {
      const domain = message.domain;
      if (!domain || typeof domain !== "string" || domain.length > 253 || !isValidHostname(domain)) {
        sendResponse({ type: "protoconsent:error", error: "invalid_domain", message: "A valid hostname is required" });
        pushExtEvent({ sender: senderId, action: "query", domain: String(message.domain || ""), result: "invalid_domain" });
        return;
      }

      Promise.all([
        handleBridgeQuery({ domain, action: "getAll" }),
        handleBridgeQuery({ domain, action: "getProfile" })
      ]).then(([purposes, profile]) => {
        sendResponse({
          type: "protoconsent:response",
          domain,
          purposes: purposes || {},
          profile: profile || "balanced",
          version: chrome.runtime.getManifest().version
        });
        pushExtEvent({ sender: senderId, action: "query", domain, result: "ok", profile: profile || "balanced" });
      }).catch(() => {
        sendResponse({ type: "protoconsent:error", error: "internal", message: "Failed to resolve purposes" });
        pushExtEvent({ sender: senderId, action: "query", domain, result: "internal" });
      });
      return;
    }

    // Unknown protocol message
    sendResponse({ type: "protoconsent:error", error: "unknown_type", message: "Unsupported message type" });
    pushExtEvent({ sender: senderId, action: message.type, result: "unknown_type" });
  });
  return true; // async - storage read before any response
});

// Track blocked domains per tab for the popup detail view.
// onRuleMatchedDebug fires for every matched rule (static + dynamic).
// Also forwards events to connected log ports for real-time display.
const logPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "log") return;
  logPorts.add(port);
  // Replay buffered inter-extension events to new port
  for (const evt of _extEventLog) {
    try { port.postMessage(Object.assign({ type: "ext" }, evt)); } catch (_) {}
  }
  port.onDisconnect.addListener(() => logPorts.delete(port));
});

if (useDnrDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const { rule, request } = info;
    if (request.tabId < 0) return;

    let purpose = null;

    // Static block ruleset (e.g. "block_ads" or "block_ads_paths" → "ads")
    if (rule.rulesetId && rule.rulesetId.startsWith("block_")) {
      purpose = rule.rulesetId.slice(6).replace(/_paths$/, "");
    }
    // Dynamic block override
    else if (rule.rulesetId === "_dynamic" && dynamicBlockRuleMap[rule.ruleId]) {
      purpose = dynamicBlockRuleMap[rule.ruleId];
    }
    // Enhanced Protection list block
    else if (rule.rulesetId === "_dynamic" && dynamicEnhancedMap[rule.ruleId]) {
      purpose = "enhanced:" + dynamicEnhancedMap[rule.ruleId];
    }

    if (!purpose) {
      // Track unique domains that received a GPC "set" signal
      if (rule.rulesetId === "_dynamic" && dynamicGpcSetIds.has(rule.ruleId)) {
        let domain;
        try { domain = new URL(request.url).hostname; } catch (_) { return; }
        if (!tabGpcDomains.has(request.tabId)) tabGpcDomains.set(request.tabId, {});
        const gpcData = tabGpcDomains.get(request.tabId);
        const now = Date.now();
        if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
        gpcData[domain].count++;
        gpcData[domain].lastSeen = now;
        scheduleSessionPersist();
        // Forward GPC event to log ports
        for (const port of logPorts) {
          try { port.postMessage({ type: "gpc", domain, tabId: request.tabId }); } catch (_) {}
        }
      }
      return;
    }

    let domain;
    try { domain = new URL(request.url).hostname; } catch (_) { return; }

    if (!tabBlockedDomains.has(request.tabId)) {
      tabBlockedDomains.set(request.tabId, {});
    }
    const tabData = tabBlockedDomains.get(request.tabId);
    if (!tabData[purpose]) tabData[purpose] = {};
    tabData[purpose][domain] = (tabData[purpose][domain] || 0) + 1;
    scheduleSessionPersist();
    updateBadgeForTab(request.tabId);

    // Forward block event to log ports
    for (const port of logPorts) {
      try { port.postMessage({ type: "block", purpose, url: request.url, tabId: request.tabId }); } catch (_) {}
    }
  });
}

// Standard data source: webRequest.onErrorOccurred for ERR_BLOCKED_BY_CLIENT.
// Used by default in both developer and store builds (USE_DNR_DEBUG = false).
// Provides URL and tabId but no ruleId - purpose resolved via reverse hostname index.
// Known limitation: other extensions blocking the same request produce false positives
// (mitigated by filtering against our blocklists via reverseHostIndex).
if (!useDnrDebug) {
  try {
    chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
      if (details.tabId < 0) return;

      let hostname;
      try { hostname = new URL(details.url).hostname; } catch (_) { return; }

      // Resolve ALL matching purposes; empty means not in our blocklists
      // (likely blocked by another extension - skip to avoid counting someone else's blocks)
      const purposes = resolvePurposesFromHostname(hostname);
      if (!purposes.length) return;

      // Update tabBlockedDomains for each matching purpose (mirrors dev behavior
      // where onRuleMatchedDebug fires once per matching ruleset)
      if (!tabBlockedDomains.has(details.tabId)) {
        tabBlockedDomains.set(details.tabId, {});
      }
      const tabData = tabBlockedDomains.get(details.tabId);
      for (const purpose of purposes) {
        if (!tabData[purpose]) tabData[purpose] = {};
        tabData[purpose][hostname] = (tabData[purpose][hostname] || 0) + 1;
      }
      scheduleSessionPersist();
      updateBadgeForTab(details.tabId);

      // Forward block event to connected log ports (one per purpose, same as dev)
      for (const purpose of purposes) {
        for (const port of logPorts) {
          try {
            port.postMessage({ type: "block", purpose, url: details.url, tabId: details.tabId });
          } catch (_) {}
        }
      }
    },
    { urls: ["<all_urls>"] }
  );
  } catch (e) {
    console.warn("ProtoConsent: onErrorOccurred listener not available:", e.message);
  }

  // Standard GPC tracking: webRequest.onSendHeaders observes final request headers.
  // If Chrome applies DNR modifyHeaders (Sec-GPC: 1) before this event, we can detect
  // which domains received the GPC signal. Same data structure as onRuleMatchedDebug path.
  // If DNR headers are NOT visible here, this listener harmlessly captures nothing.
  // Filter: only count GPC for domains where OUR rules inject the header, not native browser GPC.
  try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.requestHeaders) return;

      const hasGpc = details.requestHeaders.some(
        h => h.name.toLowerCase() === "sec-gpc" && h.value === "1"
      );
      if (!hasGpc) return;

      let domain;
      try { domain = new URL(details.url).hostname; } catch (_) { return; }

      // Check if OUR DNR rules would inject GPC for this domain.
      // DNR requestDomains matches subdomains, so "tracker.example.com" matches
      // a rule targeting "example.com". Walk up labels to replicate DNR behavior.
      if (gpcGlobalActive) {
        // Global rule sends GPC to all domains, except per-site remove overrides.
        // Check if this domain matches any gpcRemoveDomains entry (subdomain-aware).
        if (gpcRemoveDomains.size > 0) {
          let h = domain;
          while (h) {
            if (gpcRemoveDomains.has(h)) return; // Excluded by per-site override
            const dot = h.indexOf(".");
            if (dot < 0) break;
            h = h.slice(dot + 1);
          }
        }
      } else {
        // No global rule - GPC only for per-site add overrides.
        if (gpcAddDomains.size === 0) return;
        let matched = false;
        let h = domain;
        while (h) {
          if (gpcAddDomains.has(h)) { matched = true; break; }
          const dot = h.indexOf(".");
          if (dot < 0) break;
          h = h.slice(dot + 1);
        }
        if (!matched) return;
      }

      if (!tabGpcDomains.has(details.tabId)) tabGpcDomains.set(details.tabId, {});
      const gpcData = tabGpcDomains.get(details.tabId);
      const now = Date.now();
      if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
      gpcData[domain].count++;
      gpcData[domain].lastSeen = now;
      scheduleSessionPersist();

      // Forward GPC event to log ports
      for (const port of logPorts) {
        try { port.postMessage({ type: "gpc", domain, tabId: details.tabId }); } catch (_) {}
      }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );
  } catch (e) {
    console.warn("ProtoConsent: onSendHeaders listener not available:", e.message);
  }
}

// Clear per-tab tracking on navigation and tab close.
// Guard against multiple "loading" events per navigation cycle (e.g. redirects,
// paywall logic on sites like wsj.com) which would wipe already-captured domains.
const tabNavigating = new Set();
// Track last URL per tab to detect SPA navigation (pushState/replaceState)
const tabLastUrl = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    if (!tabNavigating.has(tabId)) {
      tabNavigating.add(tabId);
      tabBlockedDomains.delete(tabId);
      tabGpcDomains.delete(tabId);
      tabTcfData.delete(tabId);
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
      scheduleSessionPersist();
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  } else if (changeInfo.status === "complete") {
    tabNavigating.delete(tabId);
  }
  // SPA navigation: URL changed without "loading" status (pushState/replaceState).
  // Clear stale TCF data since the content script won't re-execute.
  if (changeInfo.url && !tabNavigating.has(tabId)) {
    const prev = tabLastUrl.get(tabId);
    if (prev && prev !== changeInfo.url) {
      tabTcfData.delete(tabId);
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
    }
    tabLastUrl.set(tabId, changeInfo.url);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockedDomains.delete(tabId);
  tabGpcDomains.delete(tabId);
  tabTcfData.delete(tabId);
  tabLastUrl.delete(tabId);
  if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
  scheduleSessionPersist();
});

// Rebuild once on service worker startup (where supported)
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// For browsers that don't support onStartup in this context,
// also rebuild when the extension is installed or updated.
chrome.runtime.onInstalled.addListener((details) => {
  rebuildAllDynamicRules();

  if (details.reason === 'install') {
    chrome.storage.local.get(['onboardingComplete'], (result) => {
      if (!result.onboardingComplete) {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
      }
    });
  }
});
