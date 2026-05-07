// ProtoConsent GPC + Client Hints signal rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { DEBUG_RULES, HIGH_ENTROPY_CH } from "./config-bridge.js";
import { RULE_RANGES, GPC_RESOURCE_TYPES, gpcPurposes, GPC_SCRIPT_ID, nextIdInRange } from "./state.js";
import { resolvePurposes } from "./storage.js";

export function buildGpcRules(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled) {
  const rules = [];
  const gpcSetIds = new Set();
  let nextId = RULE_RANGES.gpc.start;
  const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);

  if (globalNeedsGPC) {
    nextIdInRange(nextId, "gpc");
    const gpcGlobalId = nextId++;
    gpcSetIds.add(gpcGlobalId);
    rules.push({
      id: gpcGlobalId, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "set", value: "1" }] },
      condition: { resourceTypes: GPC_RESOURCE_TYPES },
    });
  }

  const gpcAddSites = [];
  const gpcRemoveSites = [];
  for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
    const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
    const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);
    if (siteNeedsGPC === globalNeedsGPC) continue;
    if (siteNeedsGPC) gpcAddSites.push(domain);
    else gpcRemoveSites.push(domain);
  }

  if (gpcAddSites.length > 0) {
    nextIdInRange(nextId, "gpc");
    const gpcAddId = nextId++;
    gpcSetIds.add(gpcAddId);
    rules.push({
      id: gpcAddId, priority: 2,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "set", value: "1" }] },
      condition: { requestDomains: gpcAddSites, resourceTypes: GPC_RESOURCE_TYPES },
    });
  }
  if (gpcRemoveSites.length > 0) {
    nextIdInRange(nextId, "gpc");
    rules.push({
      id: nextId++, priority: 2,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "remove" }] },
      condition: { requestDomains: gpcRemoveSites, resourceTypes: GPC_RESOURCE_TYPES },
    });
  }

  return { rules, gpcSetIds, globalNeedsGPC, gpcAddSites, gpcRemoveSites };
}

export function buildChRules(rulesByDomain, presets, defaultConfig, globalPurposes, chStrippingEnabled) {
  const rules = [];
  const chRuleIds = new Set();
  let nextId = RULE_RANGES.ch.start;
  const chHeaders = HIGH_ENTROPY_CH.map(h => ({ header: h, operation: "remove" }));
  const globalDeniesAT = chStrippingEnabled && !globalPurposes.advanced_tracking;

  const chAddSites = [];
  const chRemoveSites = [];
  for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
    const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
    const siteDeniesAT = chStrippingEnabled && !sitePurposes.advanced_tracking;
    if (siteDeniesAT === globalDeniesAT) continue;
    if (siteDeniesAT) chAddSites.push(domain);
    else chRemoveSites.push(domain);
  }

  if (globalDeniesAT) {
    nextIdInRange(nextId, "ch");
    const chGlobalId = nextId++;
    chRuleIds.add(chGlobalId);
    const chGlobalRule = { id: chGlobalId, priority: 1, action: { type: "modifyHeaders", requestHeaders: chHeaders }, condition: { resourceTypes: GPC_RESOURCE_TYPES } };
    if (chRemoveSites.length > 0) chGlobalRule.condition.excludedRequestDomains = chRemoveSites;
    rules.push(chGlobalRule);
  }
  if (chAddSites.length > 0) {
    nextIdInRange(nextId, "ch");
    const chPerSiteId = nextId++;
    chRuleIds.add(chPerSiteId);
    rules.push({ id: chPerSiteId, priority: 2, action: { type: "modifyHeaders", requestHeaders: chHeaders }, condition: { requestDomains: chAddSites, resourceTypes: GPC_RESOURCE_TYPES } });
  }
  return { rules, chRuleIds };
}

// Register or unregister the GPC DOM signal (navigator.globalPrivacyControl)
export async function updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] }).catch(() => {});

    if (!gpcEnabled) return;

    const globalNeedsGPC = gpcPurposes.length > 0 && gpcPurposes.some(p => !globalPurposes[p]);

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

    if (globalNeedsGPC) {
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: ["<all_urls>"],
        excludeMatches: excludeDomains.length > 0 ? excludeDomains : undefined,
        js: ["content-scripts/gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (includeDomains.length > 0) {
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: includeDomains,
        js: ["content-scripts/gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    }

  } catch (e) {
    if (DEBUG_RULES) console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}
