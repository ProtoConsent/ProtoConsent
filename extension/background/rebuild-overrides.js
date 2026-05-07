// ProtoConsent per-site overrides, whitelist, and CEL resolution rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  RULE_RANGES, BLOCK_RESOURCE_TYPES, PURPOSES_FOR_ENFORCEMENT,
  can, nextIdInRange,
} from "./state.js";
import { resolvePurposes, isValidHostname } from "./storage.js";

export function buildOverrideRules(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes) {
  const rules = [];
  const blockMap = {};
  const permissiveSites = [];
  let nextId = RULE_RANGES.overrides.start;

  if (!can("ownBlocking")) return { rules, blockMap, permissiveSites };

  const allowOverrides = {};
  const blockOverrides = {};
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
  return { rules, blockMap, permissiveSites };
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
  return { rules, whitelistMap, globalDomains, perSite };
}
