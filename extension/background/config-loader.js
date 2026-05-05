// ProtoConsent background config loader
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Loads blocklists, presets, purposes and the enhanced catalog from
// extension-bundled JSON and (optionally) remote sources. Builds the
// reverse hostname index used by tracking.js for purpose attribution.

import { DEBUG_RULES } from "./config-bridge.js";
import {
  PURPOSES_FOR_ENFORCEMENT, setPurposesForEnforcement,
  setGpcPurposes,
  blocklistsConfig, setBlocklistsConfig,
  reverseHostIndex, setReverseHostIndex,
  enhancedReverseIndex,
  enabledBlockRulesets,
  dynamicBlockRuleMap,
  presetsConfig, setPresetsConfig,
  purposesConfig, setPurposesConfig,
  enhancedListsCatalog, setEnhancedListsCatalog,
  _catalogPromise, setCatalogPromise,
  _catalogLastFetched, setCatalogLastFetched,
  _catalogSource, setCatalogSource,
  _catalogError, setCatalogError,
  _catalogLocalCount, setCatalogLocalCount,
  _catalogRemoteCount, setCatalogRemoteCount,
  _catalogLastRemoteFetch, setCatalogLastRemoteFetch,
  CATALOG_TTL, CATALOG_REMOTE_URL, CATALOG_REMOTE_FALLBACK,
  SUPPORTED_MANIFEST_VERSION,
  setPathOnlyUrlFilters,
  pathAttributionIndex,
  bundledPathAttribution, setBundledPathAttribution,
  regionalLanguagesConfig, setRegionalLanguagesConfig,
} from "./state.js";
import { DEPRECATED_LIST_IDS } from "./lifecycle-migrations.js";

// Load domain and path-domain lists from static rulesets.
// Subsequent calls return the cached in-memory version.
export async function loadBlocklistsConfig() {
  if (blocklistsConfig) return blocklistsConfig;

  // Ensure purposes are loaded first
  await loadPurposesConfig();

  const config = {};
  const pathOnlyMap = new Map();
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    const entry = {};
    try {
      const url = chrome.runtime.getURL("rules/protoconsent_" + key + ".json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      entry.domains = rules[0]?.condition?.requestDomains || [];
    } catch (e) {
      if (key !== "functional" && DEBUG_RULES) console.warn("loadBlocklistsConfig: protoconsent_" + key + ".json:", e.message);
      entry.domains = [];
    }
    // Extract unique domains from path-based rules
    try {
      const url = chrome.runtime.getURL("rules/protoconsent_" + key + "_paths.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      const domainSet = new Set(entry.domains);
      const pathDomains = [];
      for (const rule of rules) {
        const m = rule.condition?.urlFilter?.match(/^\|\|([^/]+)/);
        if (!m) continue;
        const extracted = m[1];
        if (rule.condition.urlFilter === "||" + extracted) {
          // Path-only pattern (no path component): e.g. ||matomo.js
          const existing = pathOnlyMap.get(extracted);
          if (existing) {
            if (!existing.includes(key)) existing.push(key);
          } else {
            pathOnlyMap.set(extracted, [key]);
          }
        } else if (!domainSet.has(extracted)) {
          pathDomains.push(extracted);
          domainSet.add(extracted);
        }
      }
      entry.pathDomains = pathDomains;
    } catch (e) {
      if (key !== "functional" && DEBUG_RULES) console.warn("loadBlocklistsConfig: protoconsent_" + key + "_paths.json:", e.message);
      entry.pathDomains = [];
    }
    config[key] = entry;
  }
  setBlocklistsConfig(config);
  setReverseHostIndex(buildReverseHostIndex(config));
  setPathOnlyUrlFilters(pathOnlyMap);
  return config;
}

// Build a hostname-to-purpose lookup from the blocklists.
export function buildReverseHostIndex(config) {
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

// Resolve ALL matching purposes for a blocked hostname.
export function resolvePurposesFromHostname(hostname) {
  if (!reverseHostIndex) return [];
  let h = hostname;
  while (h) {
    const purposes = reverseHostIndex.get(h);
    if (purposes) {
      const activeDynamic = new Set(Object.values(dynamicBlockRuleMap));
      const active = purposes.filter(p =>
        enabledBlockRulesets.has("protoconsent_" + p) ||
        enabledBlockRulesets.has("protoconsent_" + p + "_paths") ||
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

// Extract hostname + path prefix from a urlFilter pattern for attribution.
// Returns {hostname, prefix} or null if not attributable.
export function parseUrlFilterForAttribution(urlFilter) {
  if (!urlFilter || !urlFilter.startsWith("||")) return null;
  const body = urlFilter.slice(2);
  const slashIdx = body.indexOf("/");
  if (slashIdx < 1) return null;
  const hostname = body.slice(0, slashIdx);
  if (hostname.includes("*")) return null;
  let pathPart = "/" + body.slice(slashIdx + 1);
  const starIdx = pathPart.indexOf("*");
  if (starIdx >= 0) pathPart = pathPart.slice(0, starIdx);
  const qIdx = pathPart.indexOf("?");
  if (qIdx >= 0) pathPart = pathPart.slice(0, qIdx);
  const caretIdx = pathPart.indexOf("^");
  if (caretIdx >= 0) pathPart = pathPart.slice(0, caretIdx);
  if (pathPart.length <= 1) return null;
  return { hostname, prefix: pathPart };
}

// Load path attribution entries from bundled external path rulesets.
// Populates bundledPathAttribution (Map<listId, Map<hostname, Array<{prefix, source}>>>).
const BUNDLED_EXTERNAL_PATHS = [
  { file: "easyprivacy_paths.json", listId: "easyprivacy", source: "enhanced:easyprivacy" },
  { file: "easylist_paths.json", listId: "easylist", source: "enhanced:easylist" },
];

let _bundledPathLoaded = false;

export async function loadBundledPathAttribution() {
  if (_bundledPathLoaded) return;
  _bundledPathLoaded = true;
  const result = new Map();
  for (const { file, listId, source } of BUNDLED_EXTERNAL_PATHS) {
    try {
      const url = chrome.runtime.getURL("rules/" + file);
      const res = await fetch(url);
      if (!res.ok) continue;
      const rules = await res.json();
      const hostMap = new Map();
      for (const rule of rules) {
        const parsed = parseUrlFilterForAttribution(rule.condition?.urlFilter);
        if (!parsed) continue;
        let arr = hostMap.get(parsed.hostname);
        if (!arr) { arr = []; hostMap.set(parsed.hostname, arr); }
        arr.push({ prefix: parsed.prefix, source });
      }
      if (hostMap.size > 0) result.set(listId, hostMap);
    } catch (e) {
      if (DEBUG_RULES) console.warn("loadBundledPathAttribution:", file, e.message);
    }
  }
  setBundledPathAttribution(result);
}

// Resolve purposes from a full URL by checking path prefixes.
// Used when hostname-only attribution fails for path-level blocks.
export function resolvePurposesFromUrl(url) {
  if (!pathAttributionIndex || pathAttributionIndex.size === 0) return [];
  try {
    const parsed = new URL(url);
    let h = parsed.hostname;
    const pathAndQuery = parsed.pathname + parsed.search;
    while (h) {
      const entries = pathAttributionIndex.get(h);
      if (entries) {
        for (const { prefix, source } of entries) {
          if (pathAndQuery.startsWith(prefix)) return [source];
        }
      }
      const dot = h.indexOf(".");
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
  } catch (_) {}
  return [];
}

// Load presets.json once when the service worker starts.
export async function loadPresetsConfig() {
  if (presetsConfig) return presetsConfig;

  try {
    const url = chrome.runtime.getURL("config/presets.json");
    const res = await fetch(url);
    const data = await res.json();
    setPresetsConfig(data);
    return data;
  } catch (e) {
    console.error("Failed to load presets.json:", e);
    return {};
  }
}

// Load purposes.json once when the service worker starts.
export async function loadPurposesConfig() {
  if (purposesConfig) return purposesConfig;

  try {
    const url = chrome.runtime.getURL("config/purposes.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    setPurposesConfig(data);

    setPurposesForEnforcement(Object.keys(data));
    setGpcPurposes(
      Object.keys(data).filter(key => data[key].triggers_gpc)
    );

    return data;
  } catch (e) {
    console.error("Failed to load purposes.json:", e);
    return {};
  }
}

// Load regional-languages.json once when the service worker starts.
// Returns { cn: { label, languages }, de: { ... }, ... }
export async function loadRegionalLanguagesConfig() {
  if (regionalLanguagesConfig) return regionalLanguagesConfig;

  try {
    const url = chrome.runtime.getURL("config/regional-languages.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    setRegionalLanguagesConfig(data);
    return data;
  } catch (e) {
    if (DEBUG_RULES) console.warn("Failed to load regional-languages.json:", e);
    return {};
  }
}

// Enhanced lists catalog - merged from local fallback + remote config/enhanced-lists.json
// Per-source regional entries are synthesized from regional-languages.json (CDN or bundled).
const RL_REMOTE_URL = "https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/config/regional-languages.json";
const RL_REMOTE_FALLBACK = "https://raw.githubusercontent.com/ProtoConsent/data/main/config/regional-languages.json";
const CDN_REGIONAL_BASE = "https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/enhanced/regional/";

export function loadEnhancedListsCatalog(options) {
  const forceRefresh = options && options.forceRefresh;

  if (enhancedListsCatalog && !forceRefresh &&
      (Date.now() - _catalogLastFetched < CATALOG_TTL)) {
    return Promise.resolve(enhancedListsCatalog);
  }

  if (_catalogPromise && !forceRefresh) return _catalogPromise;

  const localPromise = fetch(chrome.runtime.getURL("config/enhanced-lists.json"))
    .then(r => r.json())
    .then(data => data.lists || data)
    .catch(() => ({}));

  const consentPromise = new Promise(r =>
    chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))
  );

  const remotePromise = consentPromise.then(consented => {
    if (!consented) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const fetchOpts = { credentials: "omit", signal: controller.signal, cache: "no-store" };

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
          if (DEBUG_RULES) console.warn("ProtoConsent: remote manifest_version " +
            manifest.manifest_version + " > supported " +
            SUPPORTED_MANIFEST_VERSION + ", using local catalog");
          return null;
        }
        return manifest.lists || null;
      })
      .catch(err => {
        clearTimeout(timeoutId);
        setCatalogError(err.message || "unknown");
        if (DEBUG_RULES) console.warn("ProtoConsent: remote catalog fetch failed:", err.message);
        return null;
      });
  });

  // Fetch fresh regional-languages.json from CDN for version metadata
  const rlRemotePromise = consentPromise.then(consented => {
    if (!consented) return null;
    return fetch(RL_REMOTE_URL, { credentials: "omit", cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .catch(() => fetch(RL_REMOTE_FALLBACK, { credentials: "omit" }).then(r => r.ok ? r.json() : null).catch(() => null));
  });

  const promise = Promise.all([localPromise, remotePromise, rlRemotePromise]).then(async ([local, remote, rlRemote]) => {
    setCatalogLastFetched(Date.now());
    setCatalogPromise(null);
    setCatalogLocalCount(Object.keys(local).length);
    setCatalogRemoteCount(remote ? Object.keys(remote).length : 0);

    let merged;
    if (!remote) {
      setCatalogSource("local");
      merged = local;
    } else {
      setCatalogSource("merged");
      setCatalogError(null);
      setCatalogLastRemoteFetch(Date.now());
      merged = Object.create(null);
      for (const id of Object.keys(local)) {
        merged[id] = local[id];
      }
      for (const id of Object.keys(remote)) {
        if (DEPRECATED_LIST_IDS.has(id)) continue;
        if (merged[id]) {
          const entry = Object.create(null);
          Object.assign(entry, merged[id], remote[id]);
          merged[id] = entry;
        } else {
          merged[id] = remote[id];
        }
      }
    }

    // Synthesize per-source regional entries from regional-languages.json
    let rlConfig = rlRemote || regionalLanguagesConfig;
    if (!rlConfig) {
      try {
        const r = await fetch(chrome.runtime.getURL("config/regional-languages.json"));
        if (r.ok) rlConfig = await r.json();
      } catch (_) {}
    }
    if (rlConfig) {
      setRegionalLanguagesConfig(rlConfig);
      for (const [region, def] of Object.entries(rlConfig)) {
        if (!def.sources) continue;
        for (const src of def.sources) {
          if (!src.slug) continue;
          for (const type of ["blocking", "cosmetic"]) {
            const id = "regional_" + region + "_" + src.slug + "_" + type;
            merged[id] = {
              name: src.name,
              description: "Regional " + type + " filters from " + src.name,
              source: src.url,
              license: "GPL-3.0-or-later",
              category: null,
              preset: "basic",
              type: type === "cosmetic" ? "cosmetic" : null,
              region: region,
              flag: def.flag || null,
              source_slug: src.slug,
              source_name: src.name,
              fetch_url: CDN_REGIONAL_BASE + "regional_" + region + "_" + src.slug + "_" + type + ".json",
              version: src[type + "_version"] || null,
              domain_count: type === "blocking" ? (src.blocking_domains || 0) : 0,
              path_rule_count: type === "blocking" ? (src.blocking_paths || 0) : 0,
              generic_count: type === "cosmetic" ? (src.cosmetic_generic || 0) : 0,
              domain_rule_count: type === "cosmetic" ? (src.cosmetic_domain_rules || 0) : 0,
            };
          }
        }
      }
    }

    setEnhancedListsCatalog(merged);
    return merged;
  });

  setCatalogPromise(promise);
  return promise;
}
