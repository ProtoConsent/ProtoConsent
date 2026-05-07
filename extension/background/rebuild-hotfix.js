// ProtoConsent hotfix (safelist) rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Builds priority-3 ALLOW rules from protoconsent_hotfix data:
//   - domain revocations (full domain safelisting)
//   - path exceptions (scoped allow for specific URL patterns)
// All rules are ALLOW — hotfix never blocks.

import { DEBUG_RULES } from "./config-bridge.js";
import {
  RULE_RANGES, BLOCK_RESOURCE_TYPES,
  can,
  setHotfixDomainSet,
} from "./state.js";
import { getEnhancedDataFromStorage } from "./storage.js";
import { updateHotfixListener } from "./tracking.js";

function nextIdInRange(currentId, rangeName) {
  if (currentId > RULE_RANGES[rangeName].end)
    throw new Error(`Rule ID overflow in range "${rangeName}": nextId=${currentId} exceeds end=${RULE_RANGES[rangeName].end}`);
  return currentId;
}

/**
 * Build hotfix safelist rules from protoconsent_hotfix data.
 * Reads only the hotfix list from storage.
 *
 * @returns {{ rules: Array, domainCount: number, exceptionCount: number }}
 */
export async function buildHotfixRules() {
  const rules = [];
  let nextId = RULE_RANGES.hotfix.start;

  if (!can("ownBlocking")) {
    setHotfixDomainSet(new Set());
    updateHotfixListener();
    return { rules, domainCount: 0, exceptionCount: 0 };
  }

  const hotfixData = await getEnhancedDataFromStorage("protoconsent_hotfix");

  // Domain revocations: priority 3 ALLOW
  let domainCount = 0;
  if (hotfixData?.domains?.length) {
    nextIdInRange(nextId, "hotfix");
    rules.push({
      id: nextId++, priority: 3,
      action: { type: "allow" },
      condition: { requestDomains: hotfixData.domains, resourceTypes: BLOCK_RESOURCE_TYPES },
    });
    domainCount = hotfixData.domains.length;
    setHotfixDomainSet(new Set(hotfixData.domains));
    if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix allow rule for", domainCount, "domains");
  } else {
    setHotfixDomainSet(new Set());
  }

  // Path exceptions: priority 3 ALLOW with initiatorDomains scope
  let exceptionCount = 0;
  if (hotfixData?.pathExceptions?.length && can("enhancedDnr")) {
    for (const pe of hotfixData.pathExceptions) {
      if (!pe.urlFilter) continue;
      nextIdInRange(nextId, "hotfix");
      const condition = { urlFilter: pe.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
      if (Array.isArray(pe.initiatorDomains) && pe.initiatorDomains.length > 0) {
        condition.initiatorDomains = pe.initiatorDomains;
      } else if (pe.firstParty) {
        const hostMatch = pe.urlFilter.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\//i);
        if (hostMatch) condition.initiatorDomains = [hostMatch[1]];
      }
      rules.push({ id: nextId++, priority: 3, action: { type: "allow" }, condition });
      exceptionCount++;
    }
    if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix path exception rules:", exceptionCount);
  }

  updateHotfixListener();
  return { rules, domainCount, exceptionCount };
}
