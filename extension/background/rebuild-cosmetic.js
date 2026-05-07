// ProtoConsent cosmetic injection rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { DEBUG_RULES } from "./config-bridge.js";
import { COSMETIC_SCRIPT_ID, lastRebuildDebug } from "./state.js";
import { getEnhancedDataFromStorage } from "./storage.js";

// Register or unregister the cosmetic filtering content script.
// Compiles generic+domain CSS from active cosmetic lists and stores it
// in chrome.storage.local for the content script to read at document_start.
export async function updateCosmeticInjection(enhancedListsMeta, permissiveSites, consentLinkedListIds) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_SCRIPT_ID] }).catch(() => {});

    const { enhancedCosmeticEnabled } = await new Promise(resolve =>
      chrome.storage.local.get("enhancedCosmeticEnabled", resolve));
    if (enhancedCosmeticEnabled === false) {
      chrome.storage.local.remove(["_cosmeticCSS", "_cosmeticDomains", "_cosmeticExceptions"]);
      return;
    }

    // Collect all active cosmetic lists (read individually from storage)
    const activeCosmeticData = [];
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (listMeta.type !== "cosmetic") continue;
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      const data = await getEnhancedDataFromStorage(listId);
      if (data) activeCosmeticData.push(data);
    }

    if (activeCosmeticData.length === 0) {
      await new Promise(resolve => {
        chrome.storage.local.remove(["_cosmeticCSS", "_cosmeticDomains", "_cosmeticExceptions"], resolve);
      });
      return;
    }

    // Merge generic selectors and domain selectors from all active lists
    const genericSet = new Set();
    const domainMap = {};
    const exceptionMap = {};
    for (const data of activeCosmeticData) {
      if (data.generic) for (const sel of data.generic) genericSet.add(sel);
      if (data.domains) {
        for (const [domain, sels] of Object.entries(data.domains)) {
          if (!domainMap[domain]) domainMap[domain] = new Set();
          for (const sel of sels) domainMap[domain].add(sel);
        }
      }
      if (data.exceptions) {
        for (const [domain, sels] of Object.entries(data.exceptions)) {
          if (!exceptionMap[domain]) exceptionMap[domain] = new Set();
          for (const sel of sels) exceptionMap[domain].add(sel);
        }
      }
    }

    // Merge user-defined cosmetic exceptions
    const userExc = await new Promise(resolve =>
      chrome.storage.local.get(["cosmeticUserExceptions"], r => resolve(r.cosmeticUserExceptions || {}))
    );
    for (const [domain, sels] of Object.entries(userExc)) {
      if (!exceptionMap[domain]) exceptionMap[domain] = new Set();
      for (const sel of sels) exceptionMap[domain].add(sel);
    }

    // Build CSS string: chunk generic selectors into groups of 500
    // Filter out selectors containing { or } to prevent CSS injection
    const allGeneric = [...genericSet].filter(s => !s.includes("{") && !s.includes("}") && !s.includes("<") && !s.includes("url("));
    const CHUNK = 500;
    const chunks = [];
    for (let i = 0; i < allGeneric.length; i += CHUNK) {
      const slice = allGeneric.slice(i, i + CHUNK);
      chunks.push(slice.join(",") + "{display:none!important}");
    }
    const cosmeticCSS = chunks.join("\n");

    // Serialize domain map (convert Sets to Arrays, filter unsafe selectors)
    const cosmeticDomains = {};
    for (const [d, sels] of Object.entries(domainMap)) {
      const safe = [...sels].filter(s => !s.includes("{") && !s.includes("}") && !s.includes("<") && !s.includes("url("));
      if (safe.length) cosmeticDomains[d] = safe;
    }

    // Serialize exception map (convert Sets to Arrays)
    const cosmeticExceptions = {};
    for (const [d, sels] of Object.entries(exceptionMap)) {
      const arr = [...sels];
      if (arr.length) cosmeticExceptions[d] = arr;
    }

    // Store compiled CSS + domain map + exceptions for the content script
    const storageData = { _cosmeticCSS: cosmeticCSS, _cosmeticDomains: cosmeticDomains, _cosmeticExceptions: Object.keys(cosmeticExceptions).length > 0 ? cosmeticExceptions : {} };
    await new Promise(resolve => {
      chrome.storage.local.set(storageData, resolve);
    });

    // Build exclude patterns for permissive sites + user-excluded cosmetic sites
    const excludeMatches = [];
    if (permissiveSites && permissiveSites.length > 0) {
      for (const site of permissiveSites) {
        excludeMatches.push(`*://*.${site}/*`, `*://${site}/*`);
      }
    }
    const cosmeticExcSites = await new Promise(resolve =>
      chrome.storage.local.get(["cosmeticExcludedSites"], r => resolve(r.cosmeticExcludedSites || []))
    );
    for (const site of cosmeticExcSites) {
      excludeMatches.push(`*://*.${site}/*`, `*://${site}/*`);
    }

    await chrome.scripting.registerContentScripts([{
      id: COSMETIC_SCRIPT_ID,
      matches: ["<all_urls>"],
      excludeMatches: excludeMatches.length > 0 ? excludeMatches : undefined,
      js: ["cosmetic-inject.js"],
      runAt: "document_start",
      allFrames: true,
    }]);

    lastRebuildDebug.cosmeticGenericCount = allGeneric.length;
    lastRebuildDebug.cosmeticDomainCount = Object.keys(cosmeticDomains).length;

  } catch (e) {
    if (DEBUG_RULES) console.error("ProtoConsent: failed to update cosmetic injection:", e);
  }
}
