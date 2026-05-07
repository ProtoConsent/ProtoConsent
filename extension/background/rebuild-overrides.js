// ProtoConsent per-site overrides, whitelist, and CEL resolution rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  RULE_RANGES, BLOCK_RESOURCE_TYPES, PURPOSES_FOR_ENFORCEMENT,
  can,
} from "./state.js";
import { resolvePurposes, isValidHostname } from "./storage.js";
import { loadEnhancedListsCatalog } from "./config-loader.js";

function nextIdInRange(currentId, rangeName) {
  if (currentId > RULE_RANGES[rangeName].end)
    throw new Error(`Rule ID overflow in range "${rangeName}": nextId=${currentId} exceeds end=${RULE_RANGES[rangeName].end}`);
  return currentId;
}

export function buildOverrideRules(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes) {
  const rules = [];
  const blockMap = {};
  let nextId = RULE_RANGES.overrides.start;

  if (!can("ownBlocking")) return { rules, blockMap };

  const allowOverrides = {};
  const blockOverrides = {};
  for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
    const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const siteAllows = sitePurposes[purposeKey];
      const globalAllows = globalPurposes[purposeKey];
      if (siteAllows === globalAllows) continue;
      if (siteAllows) {
        if (!allowOverrides[purposeKey]) allowOverrides[purposeKey] = [];
        allowOverrides[purposeKey].push(domain);
      } else {
        if (!blockOverrides[purposeKey]) blockOverrides[purposeKey] = [];
        blockOverrides[purposeKey].push(domain);
      }
    }
  }

  for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
    const domainList = blocklists[purposeKey]?.domains || [];
    const pathDomainList = blocklists[purposeKey]?.pathDomains || [];
    const domains = pathDomainList.length ? [...domainList, ...pathDomainList] : domainList;
    if (!domains.length) continue;

    if (allowOverrides[purposeKey]?.length) {
      nextIdInRange(nextId, "overrides");
      rules.push({
        id: nextId++,
        priority: 2,
        action: { type: "allow" },
        condition: { requestDomains: domains, initiatorDomains: allowOverrides[purposeKey], resourceTypes: BLOCK_RESOURCE_TYPES },
      });
    }
    if (blockOverrides[purposeKey]?.length) {
      const initiators = blockOverrides[purposeKey];
      let effectiveDomains = domains;
      if (pathDomainList.length) {
        const safePathDomains = pathDomainList.filter(pd =>
          !initiators.some(id => pd === id || pd.endsWith("." + id) || id.endsWith("." + pd))
        );
        effectiveDomains = safePathDomains.length ? [...domainList, ...safePathDomains] : domainList;
      }
      if (effectiveDomains.length) {
        nextIdInRange(nextId, "overrides");
        blockMap[nextId] = purposeKey;
        rules.push({
          id: nextId++,
          priority: 2,
          action: { type: "block" },
          condition: { requestDomains: effectiveDomains, initiatorDomains: initiators, resourceTypes: BLOCK_RESOURCE_TYPES },
        });
      }
    }
  }
  return { rules, blockMap };
}

export function buildWhitelistRules(whitelist) {
  const rules = [];
  const whitelistMap = {};
  let nextId = RULE_RANGES.whitelist.start;

  if (!can("whitelistOverrides")) return { rules, whitelistMap };

  const globalDomains = [];
  const perSite = {};
  for (const [domain, siteMap] of Object.entries(whitelist)) {
    if (!isValidHostname(domain)) continue;
    for (const site of Object.keys(siteMap)) {
      if (site === "*") globalDomains.push(domain);
      else if (isValidHostname(site)) {
        if (!perSite[site]) perSite[site] = [];
        perSite[site].push(domain);
      }
    }
  }

  const budget = RULE_RANGES.whitelist.end - RULE_RANGES.whitelist.start + 1;
  let added = 0;

  if (globalDomains.length > 0 && added < budget) {
    const wlId = nextId++;
    whitelistMap[wlId] = globalDomains;
    rules.push({ id: wlId, priority: 3, action: { type: "allow" }, condition: { requestDomains: globalDomains, resourceTypes: BLOCK_RESOURCE_TYPES } });
    added++;
  }
  for (const [site, domains] of Object.entries(perSite)) {
    if (added >= budget) break;
    const wlId = nextId++;
    whitelistMap[wlId] = domains;
    rules.push({ id: wlId, priority: 3, action: { type: "allow" }, condition: { requestDomains: domains, initiatorDomains: [site], resourceTypes: BLOCK_RESOURCE_TYPES } });
    added++;
  }
  return { rules, whitelistMap };
}

// Resolve consent-enhanced-link list IDs from current storage state (shared by builders and post-update).
export async function getConsentLinkedListIds(enhancedListsMeta, globalPurposes) {
  const CEL_PURPOSES = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);
  const consentLinkedListIds = new Set();
  const celState = await new Promise(resolve => {
    chrome.storage.local.get(["consentEnhancedLink", "celMode", "celCustomPurposes"], r => resolve({
      cel: r.consentEnhancedLink === true,
      mode: r.celMode || "profile",
      customPurposes: r.celCustomPurposes || null,
    }));
  });
  if (!celState.cel) return consentLinkedListIds;
  const celCatalog = await loadEnhancedListsCatalog();
  if (!celCatalog) return consentLinkedListIds;
  const deniedCategories = new Set();
  if (celState.mode === "custom") {
    if (celState.customPurposes && typeof celState.customPurposes === "object") {
      for (const [purpose, denied] of Object.entries(celState.customPurposes)) {
        if (denied && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
      }
    }
  } else {
    for (const [purpose, allowed] of Object.entries(globalPurposes)) {
      if (!allowed && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
    }
  }
  for (const [listId, listDef] of Object.entries(celCatalog)) {
    if (listDef.category && CEL_PURPOSES.has(listDef.category) && deniedCategories.has(listDef.category)) {
      if (enhancedListsMeta[listId]) consentLinkedListIds.add(listId);
    }
  }
  return consentLinkedListIds;
}
