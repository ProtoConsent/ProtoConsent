// ProtoConsent background blocker detection
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Detects external blocker presence via behavioral signals:
// - Standalone: unattributed blocked hostnames (domains our lists don't cover
//   but something is blocking) accumulate across navigations.
// - Monitoring: zero ERR_BLOCKED_BY_CLIENT after several navigations.
//
// Dismissals are persisted in chrome.storage.local with a 24-hour TTL.

import {
  blockerDetection, updateBlockerDetection,
  unattributedBuffer,
  tabCoverageMetrics,
  operatingMode,
} from "./state.js";

// Standalone: unique unattributed hostnames needed to trigger suggestion
const SUGGEST_UNATTRIBUTED_THRESHOLD = 5;
// Monitoring: navigations before evaluating absence of blocks
const WARN_NAV_THRESHOLD = 2;
// Dismissal TTL in ms (24 hours)
const DISMISS_TTL = 24 * 60 * 60 * 1000;

// Storage keys for persistent dismissals
const STORAGE_KEY_SUGGEST = "_blockerSuggestDismissedAt";
const STORAGE_KEY_WARN = "_blockerWarnDismissedAt";


// Called on each real page navigation (from lifecycle.js).
// Accumulates coverage + unattributed data from the previous page load.
// url may be undefined on same-URL refresh; we still count those (likely web pages).

export function onNavigation(tabId, coverageMap, url) {
  // Skip non-web pages (chrome://, about:, extension pages)
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) return;
  // Accumulate observed block count from previous page
  const prev = coverageMap.get(tabId);
  if (prev) {
    blockerDetection.totalObserved += prev.observed;
  }

  // Collect unique unattributed hostnames (from the global buffer, not per-tab)
  // Cap at 500 to prevent unbounded growth across long sessions.
  for (let i = 0; i < unattributedBuffer.length; i++) {
    const entry = unattributedBuffer[i];
    if (entry.tabId === tabId && entry.hostname) {
      if (blockerDetection.unattributedHostnames.size < 500) {
        blockerDetection.unattributedHostnames.add(entry.hostname);
      }
    }
  }

  blockerDetection.navCount++;
  evaluate();
}


// In-memory dismiss flags (survive until SW restart; storage check covers restarts)
let _suggestDismissed = false;
let _warnDismissed = false;


// Evaluate behavioral signals after enough navigations.

function evaluate() {
  if (operatingMode === "standalone") {
    if (!_suggestDismissed && blockerDetection.unattributedHostnames.size >= SUGGEST_UNATTRIBUTED_THRESHOLD) {
      updateBlockerDetection({ behavioralSignal: true });
    }
  } else {
    // Monitoring: warn if no blocks at all after threshold
    if (blockerDetection.navCount >= WARN_NAV_THRESHOLD) {
      const warn = !_warnDismissed && blockerDetection.totalObserved === 0;
      updateBlockerDetection({ noBlockerWarning: warn });
      _updateWarningBadge(warn);
    }
  }
}

// Red "!" badge for no-blocker warning in Monitoring mode.
// Per-tab only on HTTP/HTTPS pages; no global badge to avoid chrome:// etc.
let _warningBadge = false;

function _isWebUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

function _updateWarningBadge(show) {
  const changed = show !== _warningBadge;
  _warningBadge = show;
  if (!changed) return;
  // Apply/clear on ALL existing tabs
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (show && _isWebUrl(tab.url)) {
        chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#D32F2F" }).catch(() => {});
      } else {
        chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
      }
    }
  });
}

// Called from lifecycle.js on each navigation to set/clear badge per-tab.
export function applyWarningBadgeForTab(tabId, url) {
  if (!_warningBadge) return;
  if (url) {
    if (_isWebUrl(url)) {
      chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#D32F2F" }).catch(() => {});
    }
    return;
  }
  // No URL available (same-URL refresh): check actual tab URL
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (_isWebUrl(tab.url)) {
      chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#D32F2F" }).catch(() => {});
    }
  });
}


// Called from session.js on SW restart to restore badge state.
export function restoreWarningBadge(warn) {
  if (!warn) return;
  // Check if user already dismissed the warning (within TTL)
  chrome.storage.local.get(STORAGE_KEY_WARN, (data) => {
    const dismissed = data[STORAGE_KEY_WARN] && (Date.now() - data[STORAGE_KEY_WARN] < DISMISS_TTL);
    if (dismissed) return;
    _warningBadge = false; // Force change detection
    _updateWarningBadge(true);
  });
}

export function resetBehavioralCounters() {
  _suggestDismissed = false;
  _warnDismissed = false;
  updateBlockerDetection({
    navCount: 0,
    totalObserved: 0,
    behavioralSignal: false,
    noBlockerWarning: false,
  });
  blockerDetection.unattributedHostnames = new Set();
  unattributedBuffer.length = 0;
  tabCoverageMetrics.clear();
  _updateWarningBadge(false);
}


// Get detection state for popup consumption.
// Does a live check of the current unattributed buffer (covers the
// current page, not yet processed by onNavigation) plus accumulated state.

export function getBlockerDetectionState(callback) {
  // Live check: count unique unattributed hostnames across entire buffer
  const liveUnattributed = new Set(blockerDetection.unattributedHostnames);
  for (let i = 0; i < unattributedBuffer.length; i++) {
    if (unattributedBuffer[i].hostname) {
      liveUnattributed.add(unattributedBuffer[i].hostname);
    }
  }
  const liveSignal = blockerDetection.behavioralSignal ||
    (operatingMode === "standalone" && liveUnattributed.size >= SUGGEST_UNATTRIBUTED_THRESHOLD);

  // Live check for warn: also scan current tabCoverageMetrics for any observed blocks
  let liveObserved = blockerDetection.totalObserved;
  for (const [, metrics] of tabCoverageMetrics) {
    liveObserved += metrics.observed;
  }
  const liveNoBlocker = blockerDetection.navCount >= WARN_NAV_THRESHOLD && liveObserved === 0;

  chrome.storage.local.get([STORAGE_KEY_SUGGEST, STORAGE_KEY_WARN], (data) => {
    const now = Date.now();
    const suggestDismissed = data[STORAGE_KEY_SUGGEST] && (now - data[STORAGE_KEY_SUGGEST] < DISMISS_TTL);
    const warnDismissed = data[STORAGE_KEY_WARN] && (now - data[STORAGE_KEY_WARN] < DISMISS_TTL);

    const shouldSuggest = !suggestDismissed && liveSignal;
    const shouldWarn = !warnDismissed && liveNoBlocker && operatingMode === "protoconsent";

    callback({
      behavioralSignal: liveSignal,
      suggestMonitoring: shouldSuggest,
      warnNoBlocker: shouldWarn,
    });
  });
}


// Dismiss a suggestion or warning (TTL in DISMISS_TTL).

export function dismissBlockerDetection(target) {
  if (target === "suggestion") {
    _suggestDismissed = true;
    chrome.storage.local.set({ [STORAGE_KEY_SUGGEST]: Date.now() });
  } else if (target === "warning") {
    _warnDismissed = true;
    chrome.storage.local.set({ [STORAGE_KEY_WARN]: Date.now() });
    _updateWarningBadge(false);
  }
}
