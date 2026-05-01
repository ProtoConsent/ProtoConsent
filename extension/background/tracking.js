// ProtoConsent background request tracking
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// webRequest listeners (onErrorOccurred, onSendHeaders) and
// onRuleMatchedDebug for blocked-request counting, GPC signal
// detection and real-time streaming to the popup Log tab.

import {
  useDnrDebug,
  tabBlockedDomains, tabGpcDomains, tabParamStrips, tabWhitelistHits,
  tabPathDetails, PATH_DETAIL_CAP,
  dynamicBlockRuleMap, dynamicGpcSetIds, dynamicParamStripIds, dynamicEnhancedMap,
  dynamicWhitelistMap,
  gpcGlobalActive, gpcAddDomains, gpcRemoveDomains,
  logPorts, _extEventLog,
  tabCoverageMetrics, unattributedBuffer, UNATTRIBUTED_BUFFER_CAP,
  pathOnlyUrlFilters,
  hotfixDomainSet, tabHotfixHits,
} from "./state.js";
import { resolvePurposesFromHostname, resolvePurposesFromUrl } from "./config-loader.js";
import { guessHeuristicPurpose } from "./heuristic.js";
import { scheduleSessionPersist, updateBadgeForTab } from "./session.js";

// --- Lifetime blocked counter ---
// In-memory running total is the source of truth. Flushed to
// chrome.storage.local by session.js for persistence across restarts.
let _lifetimeTotal = 0;

function incrementLifetimeBlocked(n) {
  _lifetimeTotal += n;
}

// Called by session.js on startup to restore from storage.
export function setLifetimeTotal(n) {
  _lifetimeTotal = n;
}

// Called by session.js (flush) and handlers.js (read).
export function getLifetimeTotal() {
  return _lifetimeTotal;
}

// Log port management
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "log") return;
  logPorts.add(port);
  // Replay buffered inter-extension events to new port
  for (const evt of _extEventLog) {
    try { port.postMessage(Object.assign({ type: "ext" }, evt)); } catch (_) {}
  }
  port.onDisconnect.addListener(() => logPorts.delete(port));
});

if (useDnrDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const { rule, request } = info;
    if (request.tabId < 0) return;

    let purpose = null;

    if (rule.rulesetId && rule.rulesetId.startsWith("protoconsent_")) {
      purpose = rule.rulesetId.slice(13).replace(/_paths$/, "");
    }
    else if (rule.rulesetId && !rule.rulesetId.startsWith("_") && rule.rulesetId.endsWith("_paths")) {
      purpose = "enhanced:" + rule.rulesetId.replace(/_paths$/, "");
    }
    else if (rule.rulesetId === "_dynamic" && dynamicBlockRuleMap[rule.ruleId]) {
      purpose = dynamicBlockRuleMap[rule.ruleId];
    }
    else if (rule.rulesetId === "_dynamic" && dynamicEnhancedMap[rule.ruleId]) {
      purpose = "enhanced:" + dynamicEnhancedMap[rule.ruleId];
    }

    // Param strip detection (static rulesets or dynamic CDN rules)
    if (rule.rulesetId === "strip_tracking_params" || rule.rulesetId === "strip_tracking_params_sites" ||
        (rule.rulesetId === "_dynamic" && dynamicParamStripIds.has(rule.ruleId))) {
      let domain;
      try { domain = new URL(request.url).hostname; } catch (_) { return; }
      if (!tabParamStrips.has(request.tabId)) tabParamStrips.set(request.tabId, {});
      const stripData = tabParamStrips.get(request.tabId);
      if (typeof stripData[domain] !== "object") stripData[domain] = { count: 0, params: [] };
      stripData[domain].count++;
      scheduleSessionPersist();
      for (const port of logPorts) {
        try { port.postMessage({ type: "param_strip", domain, tabId: request.tabId }); } catch (_) {}
      }
      return;
    }

    if (!purpose) {
      if (rule.rulesetId === "_dynamic" && dynamicGpcSetIds.has(rule.ruleId)) {
        let domain;
        try { domain = new URL(request.url).hostname; } catch (_) { return; }
        if (!tabGpcDomains.has(request.tabId)) tabGpcDomains.set(request.tabId, {});
        const gpcData = tabGpcDomains.get(request.tabId);
        const now = Date.now();
        if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
        gpcData[domain].count++;
        gpcData[domain].lastSeen = now;
        scheduleSessionPersist();
        for (const port of logPorts) {
          try { port.postMessage({ type: "gpc", domain, tabId: request.tabId }); } catch (_) {}
        }
      }
      return;
    }

    let domain;
    try { domain = new URL(request.url).hostname; } catch (_) { return; }

    if (!tabBlockedDomains.has(request.tabId)) {
      tabBlockedDomains.set(request.tabId, {});
    }
    const tabData = tabBlockedDomains.get(request.tabId);
    if (!tabData[purpose]) tabData[purpose] = {};
    tabData[purpose][domain] = (tabData[purpose][domain] || 0) + 1;
    incrementLifetimeBlocked(1);
    if (rule.rulesetId && rule.rulesetId.endsWith("_paths")) {
      try {
        const pathname = new URL(request.url).pathname;
        if (!tabPathDetails.has(request.tabId)) tabPathDetails.set(request.tabId, new Map());
        const hostPaths = tabPathDetails.get(request.tabId);
        if (!hostPaths.has(domain)) hostPaths.set(domain, new Set());
        const paths = hostPaths.get(domain);
        if (paths.size < PATH_DETAIL_CAP) paths.add(pathname);
      } catch (_) {}
    }
    scheduleSessionPersist();
    updateBadgeForTab(request.tabId);

    for (const port of logPorts) {
      try { port.postMessage({ type: "block", purpose, url: request.url, tabId: request.tabId }); } catch (_) {}
    }
  });
}

function attributeBlock(tabId, hostname, url, purposes, metrics, isPathBlock) {
  metrics.attributed++;
  incrementLifetimeBlocked(1);
  if (!tabBlockedDomains.has(tabId)) tabBlockedDomains.set(tabId, {});
  const tabData = tabBlockedDomains.get(tabId);
  for (const p of purposes) {
    if (!tabData[p]) tabData[p] = {};
    tabData[p][hostname] = (tabData[p][hostname] || 0) + 1;
  }
  if (isPathBlock) {
    try {
      const pathname = new URL(url).pathname;
      if (!tabPathDetails.has(tabId)) tabPathDetails.set(tabId, new Map());
      const hostPaths = tabPathDetails.get(tabId);
      if (!hostPaths.has(hostname)) hostPaths.set(hostname, new Set());
      const paths = hostPaths.get(hostname);
      if (paths.size < PATH_DETAIL_CAP) paths.add(pathname);
    } catch (_) {}
  }
  scheduleSessionPersist();
  updateBadgeForTab(tabId);
  for (const p of purposes) {
    for (const port of logPorts) {
      try { port.postMessage({ type: "block", purpose: p, url, tabId }); } catch (_) {}
    }
  }
}

// Standard data source: webRequest.onErrorOccurred for extension-blocked requests.
if (!useDnrDebug) {
  const BLOCKED_ERRORS = new Set([
    "net::ERR_BLOCKED_BY_CLIENT",
    "NS_ERROR_ABORT",
    "NS_ERROR_BLOCKED_URI",
  ]);
  try {
    chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (!BLOCKED_ERRORS.has(details.error)) return;
      if (details.tabId < 0) return;

      let hostname;
      try { hostname = new URL(details.url).hostname; } catch (_) { return; }

      // Coverage tracking: count ALL observed blocks
      if (!tabCoverageMetrics.has(details.tabId)) {
        tabCoverageMetrics.set(details.tabId, { observed: 0, attributed: 0 });
      }
      const metrics = tabCoverageMetrics.get(details.tabId);
      metrics.observed++;

      const purposes = resolvePurposesFromHostname(hostname);
      if (!purposes.length) {
        // Try URL path-level attribution for enhanced path blocks
        const urlPurposes = resolvePurposesFromUrl(details.url);
        if (urlPurposes.length) {
          attributeBlock(details.tabId, hostname, details.url, urlPurposes, metrics, true);
          return;
        }
        // Secondary check: does the URL match a path-only pattern? (e.g. ||matomo.js)
        let pathPurposes = null;
        if (pathOnlyUrlFilters.size > 0) {
          for (const [pattern, purps] of pathOnlyUrlFilters) {
            if (details.url.includes(pattern)) {
              pathPurposes = purps;
              break;
            }
          }
        }
        if (!pathPurposes) {
          // Truly unattributed block: buffer for debug/Proto tab
          if (unattributedBuffer.length >= UNATTRIBUTED_BUFFER_CAP) unattributedBuffer.shift();
          const heuristic = guessHeuristicPurpose(hostname);
          unattributedBuffer.push({ hostname, tabId: details.tabId, ts: Date.now(), heuristic });
          return;
        }
        // Path-only match: attribute to the matched purpose(s)
        attributeBlock(details.tabId, hostname, details.url, pathPurposes, metrics, true);
        return;
      }

      attributeBlock(details.tabId, hostname, details.url, purposes, metrics);
    },
    { urls: ["<all_urls>"] }
  );
  } catch (e) {
    console.warn("ProtoConsent: onErrorOccurred listener not available:", e.message);
  }

  // Standard GPC tracking: webRequest.onSendHeaders
  try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.requestHeaders) return;

      const hasGpc = details.requestHeaders.some(
        h => h.name.toLowerCase() === "sec-gpc" && h.value === "1"
      );
      if (!hasGpc) return;

      let domain;
      try { domain = new URL(details.url).hostname; } catch (_) { return; }

      if (gpcGlobalActive) {
        if (gpcRemoveDomains.size > 0) {
          let h = domain;
          while (h) {
            if (gpcRemoveDomains.has(h)) return;
            const dot = h.indexOf(".");
            if (dot < 0) break;
            h = h.slice(dot + 1);
          }
        }
      } else {
        if (gpcAddDomains.size === 0) return;
        let matched = false;
        let h = domain;
        while (h) {
          if (gpcAddDomains.has(h)) { matched = true; break; }
          const dot = h.indexOf(".");
          if (dot < 0) break;
          h = h.slice(dot + 1);
        }
        if (!matched) return;
      }

      if (!tabGpcDomains.has(details.tabId)) tabGpcDomains.set(details.tabId, {});
      const gpcData = tabGpcDomains.get(details.tabId);
      const now = Date.now();
      if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
      gpcData[domain].count++;
      gpcData[domain].lastSeen = now;
      scheduleSessionPersist();

      for (const port of logPorts) {
        try { port.postMessage({ type: "gpc", domain, tabId: details.tabId }); } catch (_) {}
      }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );
  } catch (e) {
    console.warn("ProtoConsent: onSendHeaders listener not available:", e.message);
  }

  // Whitelist hit tracking: count successful requests to whitelisted domains
  try {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details.tabId < 0) return;
        let hostname;
        try { hostname = new URL(details.url).hostname; } catch (_) { return; }
        let matched = false;
        for (const domains of Object.values(dynamicWhitelistMap)) {
          if (domains.includes(hostname)) { matched = true; break; }
        }
        if (!matched) return;
        if (!tabWhitelistHits.has(details.tabId)) tabWhitelistHits.set(details.tabId, {});
        const hits = tabWhitelistHits.get(details.tabId);
        hits[hostname] = (hits[hostname] || 0) + 1;
      },
      { urls: ["<all_urls>"] }
    );
  } catch (e) {
    console.warn("ProtoConsent: onCompleted listener not available:", e.message);
  }
}

// Param strip detection via webNavigation.
// DNR redirect rules (queryTransform.removeParams) are invisible to webRequest
// (Chrome processes DNR before webRequest). webNavigation operates at navigation
// level: onBeforeNavigate has the original URL, onCommitted has the final URL
// after DNR redirect. Comparing the two detects stripped params.
const _pendingNavUrls = new Map(); // tabId -> original URL string
export function clearPendingNavUrl(tabId) { _pendingNavUrls.delete(tabId); }

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  if (details.tabId < 0) return;
  _pendingNavUrls.set(details.tabId, details.url);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.tabId < 0) return;
  const originalUrl = _pendingNavUrls.get(details.tabId);
  _pendingNavUrls.delete(details.tabId);
  if (!originalUrl) return;

  // Server-side redirects also change the committed URL; skip those.
  const qualifiers = details.transitionQualifiers || [];
  if (qualifiers.includes("server_redirect")) return;

  let orig, final;
  try {
    orig = new URL(originalUrl);
    final = new URL(details.url);
  } catch (_) { return; }

  // Only param strips: same origin + path, different query
  if (orig.origin !== final.origin) return;
  if (orig.pathname !== final.pathname) return;
  if (orig.search === final.search) return;

  // Find which params were removed
  const finalKeys = new Set(final.searchParams.keys());
  const removed = [];
  for (const key of orig.searchParams.keys()) {
    if (!finalKeys.has(key)) removed.push(key);
  }
  if (removed.length === 0) return;

  const domain = orig.hostname;

  if (!tabParamStrips.has(details.tabId)) tabParamStrips.set(details.tabId, {});
  const stripData = tabParamStrips.get(details.tabId);
  // Backward compat: old session data may have domain -> number
  if (typeof stripData[domain] !== "object") stripData[domain] = { count: 0, params: [] };
  // In debug mode onRuleMatchedDebug already incremented count; only add param names here
  if (!useDnrDebug) stripData[domain].count++;
  for (const p of removed) {
    if (!stripData[domain].params.includes(p)) stripData[domain].params.push(p);
  }
  scheduleSessionPersist();

  for (const port of logPorts) {
    try {
      port.postMessage({ type: "param_strip", domain, params: removed, tabId: details.tabId });
    } catch (_) {}
  }
});

// --- Hotfix domain tracking via onCompleted ---
// Registered dynamically by rebuild.js when hotfix domains exist.
// Tracks which hotfix domains were actually loaded per tab.
let _hotfixListener = null;

export function updateHotfixListener() {
  if (_hotfixListener) {
    try { chrome.webRequest.onCompleted.removeListener(_hotfixListener); } catch (_) {}
    _hotfixListener = null;
  }
  if (hotfixDomainSet.size === 0) return;

  const urls = [];
  for (const d of hotfixDomainSet) {
    urls.push("*://*." + d + "/*");
    urls.push("*://" + d + "/*");
  }

  _hotfixListener = (details) => {
    if (details.tabId < 0) return;
    let hostname;
    try { hostname = new URL(details.url).hostname; } catch (_) { return; }
    if (!hotfixDomainSet.has(hostname)) {
      const parts = hostname.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        if (hotfixDomainSet.has(parent)) { hostname = parent; break; }
      }
    }
    if (!hotfixDomainSet.has(hostname)) return;
    if (!tabHotfixHits.has(details.tabId)) tabHotfixHits.set(details.tabId, new Set());
    tabHotfixHits.get(details.tabId).add(hostname);
  };

  try {
    chrome.webRequest.onCompleted.addListener(_hotfixListener, { urls });
  } catch (e) {
    console.warn("ProtoConsent: hotfix onCompleted listener failed:", e.message);
    _hotfixListener = null;
  }
}
