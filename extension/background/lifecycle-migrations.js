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
]);

export async function runMigrations() {
  await migrateCmpListIds();
  await migrateRegionalBlobKeys();
}

// v0.7.2+: Remove old merged blob keys for regional lists.
// Per-language keys (enhancedData_<id>_<region>) replace the single blob.
// storage.js falls back to the blob if per-language keys don't exist yet,
// so this is safe to run before the first re-fetch.
async function migrateRegionalBlobKeys() {
  await new Promise(resolve => {
    chrome.storage.local.remove([
      "enhancedData_regional_cosmetic",
      "enhancedData_regional_blocking",
    ], resolve);
  });
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
