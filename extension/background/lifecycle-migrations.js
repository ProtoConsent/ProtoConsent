// ProtoConsent storage migrations
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs on install/update to clean up stale storage keys from previous versions.
// Add new migrations at the bottom of runMigrations().

// IDs renamed in v0.6. Used by config-loader.js to filter stale CDN catalog entries.
export const DEPRECATED_LIST_IDS = new Set([
  "protoconsent_cmp_detectors",
  "protoconsent_cmp_signatures_site",
  "regional_cosmetic",
  "regional_blocking",
]);

export async function runMigrations() {
  await migrateCmpListIds();
  await migrateRegionalToPerSource();
}

// v0.8+: Remove old aggregate regional list entries and their storage keys.
// Per-source entries (regional_{region}_{slug}_{type}) replace the 2 aggregate
// entries (regional_cosmetic, regional_blocking) and their per-language data keys.
async function migrateRegionalToPerSource() {
  const result = await new Promise(r => chrome.storage.local.get(["enhancedLists"], r));
  const lists = result.enhancedLists;
  if (!lists) return;
  const oldIds = ["regional_cosmetic", "regional_blocking"];
  const hasOld = oldIds.some(id => lists[id]);
  if (!hasOld) return;

  const keysToRemove = [];
  for (const id of oldIds) {
    keysToRemove.push("enhancedData_" + id);
    if (lists[id]?.regions) {
      for (const region of lists[id].regions) {
        keysToRemove.push("enhancedData_" + id + "_" + region);
      }
    }
    delete lists[id];
  }

  await new Promise(r => chrome.storage.local.set({ enhancedLists: lists }, r));
  await new Promise(r => chrome.storage.local.remove(keysToRemove, r));
}

// v0.6+: Rename protoconsent_cmp_detectors -> autoconsent_cmp_detectors
//        Rename protoconsent_cmp_signatures_site -> autoconsent_cmp_signatures_site
async function migrateCmpListIds() {
  await new Promise(resolve => {
    chrome.storage.local.remove([
      "enhancedData_protoconsent_cmp_signatures",
      "enhancedData_protoconsent_cmp_detectors",
      "enhancedData_protoconsent_cmp_signatures_site",
      "enhancedData_autoconsent_cmp_detectors",
      "enhancedData_autoconsent_cmp_signatures_site",
      "_cmpSignatures",
      "_cmpDetectors",
      "_cmpSiteSignatures",
    ], resolve);
  });
  await new Promise(resolve => {
    chrome.storage.local.get(["enhancedLists"], (result) => {
      const lists = result.enhancedLists;
      if (lists && (lists.protoconsent_cmp_detectors || lists.protoconsent_cmp_signatures_site)) {
        delete lists.protoconsent_cmp_detectors;
        delete lists.protoconsent_cmp_signatures_site;
        chrome.storage.local.set({ enhancedLists: lists }, resolve);
      } else {
        resolve();
      }
    });
  });
}
