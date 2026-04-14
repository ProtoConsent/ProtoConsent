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
  gpcPurposes, setGpcPurposes,
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
} from "./state.js";

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
      const url = chrome.runtime.getURL("rules/block_" + key + ".json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      entry.domains = rules[0]?.condition?.requestDomains || [];
    } catch (e) {
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + ".json:", e.message);
      entry.domains = [];
    }
    // Extract unique domains from path-based rules
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + "_paths.json");
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
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + "_paths.json:", e.message);
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
    setPresetsConfig({});
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
    setPurposesConfig({});
    return {};
  }
}

// Enhanced lists catalog - merged from local fallback + remote config/enhanced-lists.json
export function loadEnhancedListsCatalog(options) {
  const forceRefresh = options && options.forceRefresh;

  if (enhancedListsCatalog && !forceRefresh &&
      (Date.now() - _catalogLastFetched < CATALOG_TTL)) {
    return Promise.resolve(enhancedListsCatalog);
  }

  if (_catalogPromise && !forceRefresh) return _catalogPromise;

  const localPromise = fetch(chrome.runtime.getURL("config/enhanced-lists.json"))
    .then(r => r.json())
    .catch(() => ({}));

  const consentPromise = new Promise(r =>
    chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))
  );

  const remotePromise = consentPromise.then(consented => {
    if (!consented) return null;

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
        setCatalogError(err.message || "unknown");
        if (DEBUG_RULES) console.warn("ProtoConsent: remote catalog fetch failed:", err.message);
        return null;
      });
  });

  const promise = Promise.all([localPromise, remotePromise]).then(([local, remote]) => {
    setCatalogLastFetched(Date.now());
    setCatalogPromise(null);
    setCatalogLocalCount(Object.keys(local).length);
    setCatalogRemoteCount(remote ? Object.keys(remote).length : 0);

    if (!remote) {
      setCatalogSource("local");
      setEnhancedListsCatalog(local);
      return local;
    }

    setCatalogSource("merged");
    setCatalogError(null);
    setCatalogLastRemoteFetch(Date.now());
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

    setEnhancedListsCatalog(merged);
    return merged;
  });

  setCatalogPromise(promise);
  return promise;
}
