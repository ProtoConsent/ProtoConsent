// ProtoConsent background request tracking
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// webRequest listeners (onErrorOccurred, onSendHeaders) and
// onRuleMatchedDebug for blocked-request counting, GPC signal
// detection and real-time streaming to the popup Log tab.

import {
  useDnrDebug,
  tabBlockedDomains, tabGpcDomains,
  dynamicBlockRuleMap, dynamicGpcSetIds, dynamicEnhancedMap,
  gpcGlobalActive, gpcAddDomains, gpcRemoveDomains,
  logPorts, _extEventLog,
  tabCoverageMetrics, unattributedBuffer, UNATTRIBUTED_BUFFER_CAP,
  pathOnlyUrlFilters,
} from "./state.js";
import { resolvePurposesFromHostname } from "./config-loader.js";
import { scheduleSessionPersist, updateBadgeForTab } from "./session.js";

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

    if (rule.rulesetId && rule.rulesetId.startsWith("block_")) {
      purpose = rule.rulesetId.slice(6).replace(/_paths$/, "");
    }
    else if (rule.rulesetId === "_dynamic" && dynamicBlockRuleMap[rule.ruleId]) {
      purpose = dynamicBlockRuleMap[rule.ruleId];
    }
    else if (rule.rulesetId === "_dynamic" && dynamicEnhancedMap[rule.ruleId]) {
      purpose = "enhanced:" + dynamicEnhancedMap[rule.ruleId];
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
    scheduleSessionPersist();
    updateBadgeForTab(request.tabId);

    for (const port of logPorts) {
      try { port.postMessage({ type: "block", purpose, url: request.url, tabId: request.tabId }); } catch (_) {}
    }
  });
}

// Standard data source: webRequest.onErrorOccurred for ERR_BLOCKED_BY_CLIENT.
if (!useDnrDebug) {
  try {
    chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
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
          unattributedBuffer.push({ hostname, tabId: details.tabId, ts: Date.now() });
          return;
        }
        // Path-only match: attribute to the matched purpose(s)
        metrics.attributed++;
        if (!tabBlockedDomains.has(details.tabId)) {
          tabBlockedDomains.set(details.tabId, {});
        }
        const tabData = tabBlockedDomains.get(details.tabId);
        for (const p of pathPurposes) {
          if (!tabData[p]) tabData[p] = {};
          tabData[p][hostname] = (tabData[p][hostname] || 0) + 1;
        }
        scheduleSessionPersist();
        updateBadgeForTab(details.tabId);
        for (const p of pathPurposes) {
          for (const port of logPorts) {
            try {
              port.postMessage({ type: "block", purpose: p, url: details.url, tabId: details.tabId });
            } catch (_) {}
          }
        }
        return;
      }

      metrics.attributed++;

      if (!tabBlockedDomains.has(details.tabId)) {
        tabBlockedDomains.set(details.tabId, {});
      }
      const tabData = tabBlockedDomains.get(details.tabId);
      for (const purpose of purposes) {
        if (!tabData[purpose]) tabData[purpose] = {};
        tabData[purpose][hostname] = (tabData[purpose][hostname] || 0) + 1;
      }
      scheduleSessionPersist();
      updateBadgeForTab(details.tabId);

      for (const purpose of purposes) {
        for (const port of logPorts) {
          try {
            port.postMessage({ type: "block", purpose, url: details.url, tabId: details.tabId });
          } catch (_) {}
        }
      }
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
}
