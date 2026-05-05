// ProtoConsent background storage utilities
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.storage.local wrappers for rules, whitelist, enhanced lists
// and presets. Includes purpose resolution, hostname validation and
// serialized write locks to prevent concurrent read-modify-write races.

import {
  PURPOSES_FOR_ENFORCEMENT, purposesConfig,
  _wlQueue, setWlQueue,
  enhancedStorageChain, setEnhancedStorageChain,
  _cosmeticExcQueue, setCosmeticExcQueue,
  _cosmeticSiteQueue, setCosmeticSiteQueue,
} from "./state.js";

// Validate domain: must look like a hostname
const VALID_HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
export function isValidHostname(s) {
  return typeof s === "string" && s.length <= 253 && VALID_HOSTNAME_RE.test(s);
}

// Get the user's default profile config from storage.
export function getDefaultProfileConfig() {
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
export function resolvePurposes(siteConfig, presets, defaultConfig) {
  const resolved = {};
  const profileName = siteConfig.profile || (defaultConfig && defaultConfig.profile) || "balanced";

  let profilePurposes;
  if (!siteConfig.profile && profileName === "custom" && defaultConfig && defaultConfig.purposes) {
    profilePurposes = defaultConfig.purposes;
  } else {
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

  // Force required purposes to true
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    if (purposesConfig && purposesConfig[key]?.required) {
      resolved[key] = true;
    }
  }

  return resolved;
}

// Get all rules from storage.
export function getAllRulesFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["rules"], (result) => {
      resolve(result.rules || {});
    });
  });
}

// Get the domain whitelist from storage.
export function getWhitelistFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["whitelist"], (result) => {
      resolve(result.whitelist || {});
    });
  });
}

// Get Enhanced Protection list state from storage.
export function getEnhancedListsFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["enhancedLists"], (result) => {
      resolve(result.enhancedLists || {});
    });
  });
}

// Read the heavy domain/path arrays for one enhanced list from storage.
export function getEnhancedDataFromStorage(listId) {
  const key = "enhancedData_" + listId;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || null);
    });
  });
}

// Get heavy domain/path data for all enabled enhanced lists.
// Regional lists are stored per-language; this function merges them
// transparently so callers see a single object per regional list.
export function getAllEnhancedDataFromStorage(lists) {
  const enabledIds = Object.entries(lists).filter(([, v]) => v.enabled).map(([k]) => k);
  if (enabledIds.length === 0) return Promise.resolve({});

  const keys = [];
  const regionalExpansions = {};

  for (const id of enabledIds) {
    if (lists[id].regions?.length) {
      regionalExpansions[id] = lists[id].regions;
      for (const region of lists[id].regions) {
        keys.push("enhancedData_" + id + "_" + region);
      }
      keys.push("enhancedData_" + id); // fallback: old blob key
    } else {
      keys.push("enhancedData_" + id);
    }
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      const out = {};
      for (const id of enabledIds) {
        if (regionalExpansions[id]) {
          const isCosmetic = lists[id].type === "cosmetic";
          const merged = isCosmetic
            ? { generic: [], domains: {}, exceptions: {} }
            : { domains: [], pathRules: [] };
          let hasPerLang = false;
          for (const region of regionalExpansions[id]) {
            const data = result["enhancedData_" + id + "_" + region];
            if (!data) continue;
            hasPerLang = true;
            if (isCosmetic) {
              if (data.generic) merged.generic.push(...data.generic);
              if (data.domains && typeof data.domains === "object") {
                for (const [dom, sels] of Object.entries(data.domains)) {
                  if (merged.domains[dom]) merged.domains[dom] = merged.domains[dom].concat(sels);
                  else merged.domains[dom] = sels;
                }
              }
              if (data.exceptions && typeof data.exceptions === "object") {
                for (const [dom, sels] of Object.entries(data.exceptions)) {
                  if (merged.exceptions[dom]) merged.exceptions[dom] = merged.exceptions[dom].concat(sels);
                  else merged.exceptions[dom] = [...sels];
                }
              }
            } else {
              if (data.domains) merged.domains.push(...data.domains);
              if (data.pathRules) merged.pathRules.push(...data.pathRules);
            }
          }
          if (hasPerLang) {
            out[id] = merged;
          } else {
            const blob = result["enhancedData_" + id];
            if (blob) out[id] = blob;
          }
        } else {
          const data = result["enhancedData_" + id];
          if (data) out[id] = data;
        }
      }
      resolve(out);
    });
  });
}

// Get Enhanced Protection preset from storage
export function getEnhancedPresetFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["enhancedPreset"], (result) => {
      resolve(result.enhancedPreset || "off");
    });
  });
}

// Serialize read-modify-write on enhancedLists to avoid race conditions
export function withEnhancedStorageLock(fn) {
  const next = enhancedStorageChain.then(fn, fn);
  setEnhancedStorageChain(next);
  return next;
}

// Serialized whitelist write queue
export function withWhitelist(fn) {
  const next = _wlQueue.then(() => getWhitelistFromStorage().then(fn), () => getWhitelistFromStorage().then(fn));
  setWlQueue(next);
  return next;
}

// Serialized cosmetic user exceptions write queue
function getCosmeticUserExceptions() {
  return new Promise(resolve => {
    chrome.storage.local.get(["cosmeticUserExceptions"], r => resolve(r.cosmeticUserExceptions || {}));
  });
}

export function withCosmeticExceptions(fn) {
  const next = _cosmeticExcQueue.then(() => getCosmeticUserExceptions().then(fn), () => getCosmeticUserExceptions().then(fn));
  setCosmeticExcQueue(next);
  return next;
}

// Serialized cosmetic excluded sites write queue
function getCosmeticExcludedSites() {
  return new Promise(resolve => {
    chrome.storage.local.get(["cosmeticExcludedSites"], r => resolve(r.cosmeticExcludedSites || []));
  });
}

export function withCosmeticExcludedSites(fn) {
  const next = _cosmeticSiteQueue.then(() => getCosmeticExcludedSites().then(fn), () => getCosmeticExcludedSites().then(fn));
  setCosmeticSiteQueue(next);
  return next;
}
