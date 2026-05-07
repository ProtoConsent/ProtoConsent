// ProtoConsent revoke/safelist rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Builds priority-3 ALLOW rules from all enhanced lists with type "revoke":
//   - domain revocations (full domain safelisting)
//   - path exceptions (scoped allow for specific URL patterns)
// All rules are ALLOW — revoke lists never block.
//
// protoconsent_hotfix is "internal" (always active, user cannot disable).
// Other revoke lists (e.g. functional) respect their .enabled flag.

import { DEBUG_RULES } from "./config-bridge.js";
import {
  RULE_RANGES, BLOCK_RESOURCE_TYPES,
  can,
  setHotfixDomainSet,
} from "./state.js";
import { getEnhancedDataFromStorage } from "./storage.js";
import { updateHotfixListener } from "./tracking.js";

// Internal lists are always processed regardless of .enabled flag.
const INTERNAL_REVOKE_LISTS = new Set(["protoconsent_hotfix"]);

function nextIdInRange(currentId, rangeName) {
  if (currentId > RULE_RANGES[rangeName].end)
    throw new Error(`Rule ID overflow in range "${rangeName}": nextId=${currentId} exceeds end=${RULE_RANGES[rangeName].end}`);
  return currentId;
}

/**
 * Build safelist rules from all revoke-type enhanced lists.
 * Reads each list individually from storage.
 *
 * @param {Object} enhancedListsMeta - from getEnhancedListsFromStorage()
 * @returns {{ rules: Array, domainCount: number, exceptionCount: number, listCounts: Object }}
 */
export async function buildRevokeRules(enhancedListsMeta) {
  const rules = [];
  let nextId = RULE_RANGES.hotfix.start;
  const allDomains = new Set();
  let totalExceptionCount = 0;
  const listCounts = {};

  if (!can("ownBlocking")) {
    setHotfixDomainSet(new Set());
    updateHotfixListener();
    return { rules, domainCount: 0, exceptionCount: 0, listCounts };
  }

  for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
    if (listMeta.type !== "revoke") continue;
    // Internal lists are always active; others respect .enabled
    if (!INTERNAL_REVOKE_LISTS.has(listId) && !listMeta.enabled) continue;

    const listData = await getEnhancedDataFromStorage(listId);
    if (!listData) continue;

    let domainCount = 0;
    let exceptionCount = 0;

    // Domain revocations: priority 3 ALLOW
    if (listData.domains?.length) {
      nextIdInRange(nextId, "hotfix");
      rules.push({
        id: nextId++, priority: 3,
        action: { type: "allow" },
        condition: { requestDomains: listData.domains, resourceTypes: BLOCK_RESOURCE_TYPES },
      });
      domainCount = listData.domains.length;
      for (const d of listData.domains) allDomains.add(d);
    }

    // Path exceptions: priority 3 ALLOW with initiatorDomains scope
    if (listData.pathExceptions?.length && can("enhancedDnr")) {
      for (const pe of listData.pathExceptions) {
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
    }

    if (domainCount > 0 || exceptionCount > 0) {
      listCounts[listId] = { domains: domainCount, exceptions: exceptionCount };
    }
    totalExceptionCount += exceptionCount;
  }

  setHotfixDomainSet(allDomains);
  if (DEBUG_RULES && allDomains.size > 0) {
    console.log("ProtoConsent rebuild: revoke safelist —", allDomains.size, "domains,", totalExceptionCount, "path exceptions from", Object.keys(listCounts).length, "lists");
  }
  updateHotfixListener();
  return { rules, domainCount: allDomains.size, exceptionCount: totalExceptionCount, listCounts };
}
