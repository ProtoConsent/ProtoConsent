// ProtoConsent regional list management
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Handles storage-change logic when user selects/deselects regional
// languages. Each regional source is a standard enhanced list entry
// identified by catalog entries with a `region` field.

import { isRegionalEntry, DEBUG_RULES } from "./config-bridge.js";
import { loadEnhancedListsCatalog } from "./config-loader.js";
import {
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage, withEnhancedStorageLock,
} from "./storage.js";
import { rebuildCategories } from "./rebuild.js";
import { fetchEnhancedList } from "./handlers-enhanced.js";

let _regionalDebounceTimer = null;

export function initRegionalStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.regionalLanguages) return;
    const newLangs = changes.regionalLanguages.newValue || [];
    const oldLangs = changes.regionalLanguages.oldValue || [];

    if (_regionalDebounceTimer) clearTimeout(_regionalDebounceTimer);
    _regionalDebounceTimer = setTimeout(async () => {
      _regionalDebounceTimer = null;
      const [catalog, preset] = await Promise.all([
        loadEnhancedListsCatalog(),
        getEnhancedPresetFromStorage(),
      ]);
      if (preset === "off") return;

      const added = newLangs.filter(l => !oldLangs.includes(l));
      const removed = oldLangs.filter(l => !newLangs.includes(l));

      const entriesByRegion = {};
      for (const [id, def] of Object.entries(catalog)) {
        if (!isRegionalEntry(def)) continue;
        if (!entriesByRegion[def.region]) entriesByRegion[def.region] = [];
        entriesByRegion[def.region].push(id);
      }

      // Fetch new lists outside the lock (fire-and-forget)
      // Read-modify-write inside the lock
      const toFetch = [];
      await withEnhancedStorageLock(async () => {
        const lists = await getEnhancedListsFromStorage();
        let changed = false;
        const dataKeysToRemove = [];

        for (const lang of removed) {
          for (const id of (entriesByRegion[lang] || [])) {
            if (lists[id]) {
              delete lists[id];
              dataKeysToRemove.push("enhancedData_" + id);
              changed = true;
            }
          }
        }

        for (const lang of added) {
          for (const id of (entriesByRegion[lang] || [])) {
            if (lists[id]) {
              if (!lists[id].enabled) { lists[id].enabled = true; changed = true; }
            } else {
              toFetch.push(id);
            }
          }
        }

        if (changed) {
          await new Promise(r => chrome.storage.local.set({ enhancedLists: lists }, r));
          if (dataKeysToRemove.length > 0) {
            await new Promise(r => chrome.storage.local.remove(dataKeysToRemove, r));
          }
          rebuildCategories(new Set(["enhanced"]));
        }
      });

      // Fetch entries that don't exist yet (after lock released)
      if (toFetch.length > 0 && (preset === "basic" || preset === "full")) {
        for (const id of toFetch) {
          fetchEnhancedList(id).catch(() => {});
        }
      }

      if (DEBUG_RULES && (added.length || removed.length)) {
        console.log("ProtoConsent regional: languages changed", { added, removed });
      }
    }, 100);
  });
}
