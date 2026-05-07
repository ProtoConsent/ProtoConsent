// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auto-refresh engine for Enhanced lists. Uses chrome.alarms for periodic
// refresh and provides install/startup hooks for immediate downloads.

import { fetchEnhancedList } from "./handlers.js";
import { loadEnhancedListsCatalog } from "./config-loader.js";
import { lastCelPendingDownload, setLastCelPendingDownload } from "./state.js";
import { isRegionalEntry, DEBUG_RULES } from "./config-bridge.js";
import { getEnhancedListsFromStorage, getEnhancedPresetFromStorage } from "./storage.js";

const ALARM_OWN = "protoconsent_list_refresh";
const ALARM_EXTERNAL = "external_list_refresh";
export const STORAGE_KEY_OWN_INTERVAL = "autoRefreshIntervalOwn";
export const STORAGE_KEY_EXT_INTERVAL = "autoRefreshIntervalExternal";
const DEFAULT_INTERVAL_HOURS = 24;
const MIN_INTERVAL_HOURS = 6;
const PROTOCONSENT_SOURCE = "https://github.com/ProtoConsent/data";
const MAX_CONCURRENT = 4;

function isOwnList(listDef) {
  return listDef && listDef.source === PROTOCONSENT_SOURCE;
}

// Run up to `limit` async tasks at a time from an array of functions.
function pooled(tasks, limit) {
  const results = [];
  let idx = 0;
  function next() {
    if (idx >= tasks.length) return Promise.resolve();
    const i = idx++;
    return tasks[i]().then(r => { results[i] = r; }).catch(e => {
      results[i] = { ok: false, error: e.message };
      if (DEBUG_RULES) console.warn("ProtoConsent: list download failed:", e.message);
    }).then(next);
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) workers.push(next());
  return Promise.all(workers).then(() => results);
}

// Refresh downloaded+enabled lists matching the filter.
// options.initialDownload: download all preset-matching lists, not just already-downloaded ones.
let _refreshRunning = false;

export function refreshLists(filter, options) {
  if (_refreshRunning) {
    if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: skipped (already running)");
    return Promise.resolve();
  }
  _refreshRunning = true;
  const initialDownload = options && options.initialDownload;
  if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: starting", filter, initialDownload ? "(initial)" : "");
  return new Promise(resolve => {
    chrome.storage.local.get(["dynamicListsConsent", "regionalLanguages"], r => {
      resolve(r);
    });
  }).then(storage => {
    if (storage.dynamicListsConsent === false) {
      if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: skipped (consent false)");
      return;
    }
    return loadEnhancedListsCatalog().then(catalog => {
      if (!catalog) {
        if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: no catalog");
        return;
      }
      if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: catalog loaded,", Object.keys(catalog).length, "entries");
      return getEnhancedListsFromStorage().then(lists => {
        const hasLangs = Array.isArray(storage.regionalLanguages) && storage.regionalLanguages.length > 0;

        // On initial download, only download lists matching the active preset
        const presetPromise = initialDownload ? getEnhancedPresetFromStorage() : Promise.resolve(null);
        return presetPromise.then(preset => {
        if (DEBUG_RULES && initialDownload) console.log("ProtoConsent auto-refresh: initial download, preset =", preset);
        const tasks = [];

        for (const [listId, listDef] of Object.entries(catalog)) {
          if (!listDef.fetch_url) continue;
          // Skip regional lists if their language isn't selected
          if (isRegionalEntry(listDef) && (!hasLangs || !storage.regionalLanguages.includes(listDef.region))) continue;

          const matchesFilter = filter === "all"
            || (filter === "own" && isOwnList(listDef))
            || (filter === "external" && !isOwnList(listDef));
          if (!matchesFilter) continue;

          if (initialDownload) {
            // Only download lists that match the active preset (basic by default)
            if (preset === "off") continue;
            if (listDef.preset === "optional") continue;
            if (preset === "basic" && listDef.preset !== "basic") continue;
            // "full" or unset: download all non-optional
            tasks.push(() => fetchEnhancedList(listId, lists));
          } else if (lists[listId]) {
            // Only refresh already-downloaded lists
            tasks.push(() => fetchEnhancedList(listId, lists));
          }
        }

        if (tasks.length === 0) {
          if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: no tasks to run");
          return;
        }
        if (DEBUG_RULES) console.log("ProtoConsent auto-refresh:", tasks.length, "lists to download");
        return pooled(tasks, MAX_CONCURRENT).then(results => {
          const ok = results.filter(r => r && r.ok).length;
          const skipped = results.filter(r => r && r.skipped).length;
          const failed = results.filter(r => r && !r.ok);
          if (DEBUG_RULES) console.log("ProtoConsent auto-refresh: done -", ok, "ok,", skipped, "skipped,", failed.length, "failed");
          if (DEBUG_RULES && failed.length > 0) {
            console.warn("ProtoConsent auto-refresh failures:", failed.map(f => f.error).join(", "));
          }
          // Consume any CEL-pending downloads that were queued during rebuild
          consumeCelPendingDownloads();
        });
        }); // presetPromise
      });
    });
  }).catch(e => {
    if (DEBUG_RULES) console.warn("ProtoConsent auto-refresh error:", e);
  }).finally(() => {
    _refreshRunning = false;
  });
}

// Download a regional list that hasn't been fetched yet (triggered by language selection).
// Checks that the active preset includes it before downloading.
export function fetchAndEnableRegionalList(listId) {
  return getEnhancedPresetFromStorage().then(preset => {
    if (preset === "off") return;
    return loadEnhancedListsCatalog().then(catalog => {
      const listDef = catalog && catalog[listId];
      if (!listDef) return;
      if (preset === "basic" && listDef.preset !== "basic") return;
      if (DEBUG_RULES) console.log("ProtoConsent: auto-downloading regional list", listId, "after language selection");
      return fetchEnhancedList(listId);
    });
  });
}

// Download any lists queued by the CEL mechanism during rebuild.
export function consumeCelPendingDownloads() {
  const pending = [...lastCelPendingDownload];
  if (pending.length === 0) return Promise.resolve();
  setLastCelPendingDownload([]);
  if (DEBUG_RULES) console.log("ProtoConsent: auto-downloading " + pending.length + " CEL-pending lists");
  const tasks = pending.map(listId => () => fetchEnhancedList(listId));
  return pooled(tasks, MAX_CONCURRENT);
}

// Create or recreate periodic alarms based on stored interval settings.
// If dynamicListsConsent is false, clears alarms instead.
export function setupAlarms() {
  chrome.storage.local.get(["dynamicListsConsent", STORAGE_KEY_OWN_INTERVAL, STORAGE_KEY_EXT_INTERVAL], data => {
    if (data.dynamicListsConsent === false) {
      chrome.alarms.clear(ALARM_OWN);
      chrome.alarms.clear(ALARM_EXTERNAL);
      return;
    }
    const ownHours = Math.max(MIN_INTERVAL_HOURS, data[STORAGE_KEY_OWN_INTERVAL] || DEFAULT_INTERVAL_HOURS);
    const extHours = Math.max(MIN_INTERVAL_HOURS, data[STORAGE_KEY_EXT_INTERVAL] || DEFAULT_INTERVAL_HOURS);
    chrome.alarms.create(ALARM_OWN, { periodInMinutes: ownHours * 60 });
    chrome.alarms.create(ALARM_EXTERNAL, { periodInMinutes: extHours * 60 });
    if (DEBUG_RULES) console.log("ProtoConsent: alarms set - own every " + ownHours + "h, external every " + extHours + "h");
  });
}

// Check if any downloaded lists are overdue for refresh (e.g., laptop was closed).
export function checkOverdueRefresh() {
  chrome.storage.local.get(["dynamicListsConsent", STORAGE_KEY_OWN_INTERVAL, STORAGE_KEY_EXT_INTERVAL], data => {
    if (data.dynamicListsConsent === false) return;
    const ownMs = Math.max(MIN_INTERVAL_HOURS, data[STORAGE_KEY_OWN_INTERVAL] || DEFAULT_INTERVAL_HOURS) * 3600000;
    const extMs = Math.max(MIN_INTERVAL_HOURS, data[STORAGE_KEY_EXT_INTERVAL] || DEFAULT_INTERVAL_HOURS) * 3600000;
    const now = Date.now();

    loadEnhancedListsCatalog().then(catalog => {
      if (!catalog) return;
      return getEnhancedListsFromStorage().then(lists => {
        let ownOverdue = false;
        let extOverdue = false;
        for (const [listId, meta] of Object.entries(lists)) {
          if (!meta.lastFetched) continue;
          const listDef = catalog[listId];
          if (!listDef) continue;
          const interval = isOwnList(listDef) ? ownMs : extMs;
          if (now - meta.lastFetched > interval) {
            if (isOwnList(listDef)) ownOverdue = true;
            else extOverdue = true;
          }
        }
        if (ownOverdue && extOverdue) return refreshLists("all");
        else if (ownOverdue) return refreshLists("own");
        else if (extOverdue) return refreshLists("external");
      });
    }).catch(e => {
      if (DEBUG_RULES) console.warn("ProtoConsent: overdue refresh check failed:", e);
    });
  });
}

// Alarm listener - dispatches to the correct refresh filter.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_OWN) refreshLists("own").catch(() => {});
  if (alarm.name === ALARM_EXTERNAL) refreshLists("external").catch(() => {});
});

// Message listener - re-setup alarms when settings change, refresh on re-enable.
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "PROTOCONSENT_REFRESH_ALARMS_UPDATED") {
    setupAlarms();
    // If sync was just re-enabled, trigger immediate refresh of downloaded lists
    chrome.storage.local.get(["dynamicListsConsent"], data => {
      if (data.dynamicListsConsent !== false) {
        refreshLists("all").catch(() => {});
      }
    });
  }
});
