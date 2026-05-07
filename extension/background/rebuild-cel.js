// ProtoConsent Consent-Enhanced Link (CEL) resolution
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { loadEnhancedListsCatalog } from "./config-loader.js";

const CEL_PURPOSES = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);


// Resolve consent-enhanced-link list IDs and pending downloads.
// Used by both full and selective rebuilds.
//
// @param {Object} enhancedListsMeta - from getEnhancedListsFromStorage()
// @param {Object} globalPurposes - resolved global purposes
// @param {Object} [consentEnhancedLink] - pre-loaded CEL state; if omitted, reads from storage
// @returns {{ consentLinkedListIds: Set<string>, celPendingDownload: string[] }}

export async function resolveConsentEnhancedLink(enhancedListsMeta, globalPurposes, consentEnhancedLink) {
  const consentLinkedListIds = new Set();
  const celPendingDownload = [];

  // Load CEL state from storage if not provided
  if (!consentEnhancedLink) {
    consentEnhancedLink = await new Promise(resolve => {
      chrome.storage.local.get(["consentEnhancedLink", "dynamicListsConsent", "celMode", "celCustomPurposes"], r => resolve({
        cel: r.consentEnhancedLink === true,
        sync: r.dynamicListsConsent === true,
        mode: r.celMode || "profile",
        customPurposes: r.celCustomPurposes || null,
      }));
    });
  }

  if (!consentEnhancedLink.cel) return { consentLinkedListIds, celPendingDownload };

  const celCatalog = await loadEnhancedListsCatalog();
  if (!celCatalog) return { consentLinkedListIds, celPendingDownload };

  // Custom mode: use user-selected purposes; profile mode: derive from global profile
  const deniedCategories = new Set();
  if (consentEnhancedLink.mode === "custom") {
    if (consentEnhancedLink.customPurposes && typeof consentEnhancedLink.customPurposes === "object") {
      for (const [purpose, denied] of Object.entries(consentEnhancedLink.customPurposes)) {
        if (denied && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
      }
    }
    // No stored custom purposes = no CEL activation until user configures
  } else {
    for (const [purpose, allowed] of Object.entries(globalPurposes)) {
      if (!allowed && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
    }
  }

  for (const [listId, listDef] of Object.entries(celCatalog)) {
    if (listDef.category && CEL_PURPOSES.has(listDef.category) && deniedCategories.has(listDef.category)) {
      if (enhancedListsMeta[listId]) {
        consentLinkedListIds.add(listId);
      } else if (listDef.fetch_url && consentEnhancedLink.sync) {
        celPendingDownload.push(listId);
      }
    }
  }

  return { consentLinkedListIds, celPendingDownload };
}
