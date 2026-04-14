// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// debug.js — Debug panel rendering for the Log > Debug tab.
// Renders directly into #pc-log-debug (only called when DEBUG_RULES = true).
// Loaded after popup.js; uses globals: currentDomain, currentProfile, currentPurposesState.

function renderDebugPanel({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains }) {
  const content = document.getElementById("pc-log-debug");
  if (!content) return;

  // Ensure CNAME map is loaded before rendering
  if (!cnameMap) {
    loadCnameData(() => {
      renderDebugPanelInner({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains }, content);
    });
    return;
  }
  renderDebugPanelInner({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains }, content);
}

function renderDebugPanelInner({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains }, content) {

  // Fetch background rebuild snapshot
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_DEBUG" }, (bg) => {
    const lines = [];

    // Extension version and data source
    const manifest = chrome.runtime.getManifest();
    lines.push("— ProtoConsent v" + manifest.version + " —");
    const source = USE_DNR_DEBUG ? "onRuleMatchedDebug" : "webRequest";
    lines.push("  data source: " + source);
    var modeLabel = (typeof operatingMode !== "undefined" && operatingMode === "protoconsent") ? "Monitoring" : "Blocking";
    lines.push("  mode: " + modeLabel);
    lines.push("");

    // Site info
    lines.push("— site: " + (currentDomain || "?") + " (profile: " + currentProfile + ") —");
    if (currentPurposesState) {
      const siteStr = Object.entries(currentPurposesState)
        .map(([k, v]) => k + ":" + (v ? "\u2713" : "\u2717")).join("  ");
      lines.push("  " + siteStr);
    }
    lines.push("");

    // Global profile & purposes
    if (bg && bg.globalProfile) {
      lines.push("— global profile: " + bg.globalProfile + " —");
      if (bg.globalPurposes) {
        const purposeStr = Object.entries(bg.globalPurposes)
          .map(([k, v]) => k + ":" + (v ? "\u2713" : "\u2717")).join("  ");
        lines.push("  " + purposeStr);
      }
      lines.push("");
    }

    // Log port status
    const portStatus = (typeof logPort !== "undefined" && logPort) ? "connected" : "disconnected";
    lines.push("— log port: " + portStatus + " (bg ports: " + (bg?.logPorts || 0) + ") —");
    lines.push("");

    // Session persistence check
    if (bg && typeof bg.sessionKeys !== "undefined") {
      lines.push("— session storage: " + bg.sessionKeys + " keys —");
      lines.push("");
    }

    // Navigation guard status
    if (bg && typeof bg.navigatingTabs !== "undefined") {
      lines.push("— navigation guard: " + bg.navigatingTabs + " tabs navigating —");
      lines.push("");
    }

    // Category domain counts
    if (bg && bg.categoryDomains) {
      lines.push("— blocklist sizes —");
      for (const [cat, info] of Object.entries(bg.categoryDomains).sort()) {
        lines.push("  " + cat + ": " + info);
      }
      lines.push("");
    }

    // Static rulesets & dynamic rules
    if (bg && bg.enableIds) {
      lines.push("— rulesets —");
      lines.push("  enabled:  " + (bg.enableIds.join(", ") || "(none)"));
      lines.push("  disabled: " + (bg.disableIds.join(", ") || "(none)"));
      lines.push("  dynamic: " + bg.dynamicCount +
        " (" + bg.overrideCount + " overrides, " +
        bg.gpcGlobal + " GPC global, " + bg.gpcPerSite + " GPC per-site)");
      if (bg.error) lines.push("  \u26A0 ERROR: " + bg.error);
      if (bg.rulesetError) lines.push("  \u26A0 RULESET ERROR: " + bg.rulesetError);
      lines.push("");
    }

    // Override detail
    if (bg && bg.overrideDetails && Object.keys(bg.overrideDetails).length) {
      lines.push("— overrides —");
      for (const [id, detail] of Object.entries(bg.overrideDetails)) {
        lines.push("  rule " + id + ": " + detail);
      }
      lines.push("");
    }

    // Custom sites
    if (bg && bg.customSites && bg.customSites.length) {
      lines.push("— custom sites (" + bg.customSites.length + ") —");
      lines.push("  " + bg.customSites.join(", "));
      lines.push("");
    }

    // Whitelist
    if (bg && bg.whitelistDomainCount > 0) {
      lines.push("— whitelist —");
      lines.push("  domains: " + bg.whitelistDomainCount +
        " (" + bg.whitelistGlobalCount + " global, " + bg.whitelistPerSiteCount + " per-site)");
      lines.push("  DNR rules: " + bg.whitelistRuleCount);
      if (bg.whitelistSites && bg.whitelistSites.length) {
        lines.push("  sites: " + bg.whitelistSites.join(", "));
      }
      lines.push("");
    }

    // Enhanced Protection
    if (bg && (bg.enhancedCount > 0 || bg.enhancedRules > 0)) {
      lines.push("— enhanced protection —");
      lines.push("  lists active: " + (bg.enhancedCount || 0) +
        "  DNR rules: " + (bg.enhancedRules || 0));
      if (bg.enhancedListIds && bg.enhancedListIds.length) {
        lines.push("  lists: " + bg.enhancedListIds.join(", "));
      }
      lines.push("");
    } else {
      lines.push("— enhanced protection: off —");
      lines.push("");
    }

    // CMP auto-response lists
    if (bg && bg.cmpLists) {
      lines.push("— CMP auto-response —");
      lines.push("  CMP lists: " + (bg.cmpLists.length > 0 ? bg.cmpLists.join(", ") : "(none)"));
      lines.push("");
    }

    // Blocker detection diagnostics
    if (bg && bg.blockerDetect) {
      var bd = bg.blockerDetect;
      lines.push("— blocker detection —");
      lines.push("  navCount: " + bd.navCount + "  totalObserved: " + bd.totalObserved);
      lines.push("  behavioralSignal: " + bd.behavioralSignal + "  noBlockerWarning: " + bd.noBlockerWarning);
      lines.push("  unattributedHostnames (accumulated): " + bd.unattributedHostnames);
      lines.push("  buffer: " + bd.bufferLength + " entries, " + bd.bufferUniqueHostnames + " unique hostnames");
      lines.push("  live coverage: " + bd.liveCoverageEntries + " tabs, " + bd.liveCoverageObserved + " observed");
      lines.push("");
    }

    // Dynamic lists catalog
    if (bg) {
      const consent = bg.dynamicListsConsent ? "on" : "off";
      lines.push("-- dynamic lists: consent " + consent + " --");
      lines.push("  source: " + (bg.catalogSource || "none"));
      if (bg.catalogLastFetched) {
        lines.push("  last load: " + new Date(bg.catalogLastFetched).toISOString());
      } else {
        lines.push("  last load: never");
      }
      if (bg.catalogLastRemoteFetch) {
        lines.push("  last remote fetch: " + new Date(bg.catalogLastRemoteFetch).toISOString());
      }
      if (bg.catalogError) lines.push("  error: " + bg.catalogError);
      lines.push("  catalog entries: local " + (bg.catalogLocalCount || 0) +
        ", remote " + (bg.catalogRemoteCount || 0));
      lines.push("");
    }

    // Consent-Enhanced link
    if (bg) {
      const cel = bg.consentEnhancedLink ? "on" : "off";
      lines.push("-- consent-enhanced link: " + cel + " --");
      if (bg.consentLinkedListIds && bg.consentLinkedListIds.length) {
        lines.push("  linked lists: " + bg.consentLinkedListIds.join(", "));
      } else {
        lines.push("  linked lists: none");
      }
      if (bg.celPendingDownload && bg.celPendingDownload.length) {
        lines.push("  pending download: " + bg.celPendingDownload.join(", "));
      }
      lines.push("");
    }

    // Client Hints stripping
    if (bg && bg.chStripping) {
      const toggle = bg.chEnabled ? "on" : "off";
      lines.push("— client hints stripping: " + bg.chStripping + " (toggle: " + toggle + ") —");
      lines.push("  DNR rules: " + (bg.chRules || 0));
      if (bg.chExcluded > 0) lines.push("  excluded sites: " + bg.chExcluded);
      if (bg.chAddSites > 0) lines.push("  per-site add: " + bg.chAddSites);
      lines.push("");
    }

    // Inter-extension API
    if (bg && typeof bg.interExtEnabled !== "undefined") {
      const status = bg.interExtEnabled ? "on" : "off";
      lines.push("— inter-extension API: " + status + " —");
      if (bg.interExtEnabled) {
        lines.push("  allowlist: " + (bg.interExtAllowlist.length || 0) +
          (bg.interExtAllowlist.length ? " [" + bg.interExtAllowlist.join(", ") + "]" : ""));
        lines.push("  pending:   " + (bg.interExtPending.length || 0) +
          (bg.interExtPending.length ? " [" + bg.interExtPending.map(e => e.id).join(", ") + "]" : ""));
        lines.push("  denylist:  " + (bg.interExtDenylist.length || 0) +
          (bg.interExtDenylist.length ? " [" + bg.interExtDenylist.join(", ") + "]" : ""));
      }
      lines.push("");
    }

    // TCF CMP detection
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_TCF", tabId: tabs[0].id }, (resp) => {
          if (chrome.runtime.lastError) { void chrome.runtime.lastError; }
          if (resp && resp.tcf) {
            const tcf = resp.tcf;
            // Insert TCF section before tab matches
            const tcfLines = [];
            tcfLines.push("— TCF CMP detection —");
            tcfLines.push("  cmpId: " + (tcf.cmpId || "unknown"));
            tcfLines.push("  cmpVersion: " + (tcf.cmpVersion || "unknown"));
            tcfLines.push("  tcfPolicyVersion: " + (tcf.tcfPolicyVersion || "unknown"));
            if (tcf.purposeConsents) {
              const entries = Object.entries(tcf.purposeConsents);
              if (entries.length > 0) {
                tcfLines.push("  purposeConsents: " + entries.map(([id, v]) => id + ":" + (v ? "Y" : "N")).join(" "));
              } else {
                tcfLines.push("  purposeConsents: (empty, banner not responded)");
              }
            } else {
              tcfLines.push("  purposeConsents: null");
            }
            tcfLines.push("");
            // Append to existing content
            content.textContent += "\n\n" + tcfLines.join("\n");
          }
        });
        // CMP auto-response injection (current tab)
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_CMP", tabId: tabs[0].id }, (resp) => {
          if (chrome.runtime.lastError) { void chrome.runtime.lastError; }
          if (resp && resp.cmp) {
            const c = resp.cmp;
            const cmpLines = [];
            cmpLines.push("— CMP injection (this tab) —");
            cmpLines.push("  domain: " + c.domain);
            cmpLines.push("  matched CMPs: " + c.cmpIds.join(", "));
            cmpLines.push("  cookies: " + c.cookieCount);
            cmpLines.push("  selectors: " + c.selectorCount);
            cmpLines.push("  scroll unlock: " + (c.scrollUnlock ? "yes" : "no"));
            cmpLines.push("  timestamp: " + new Date(c.ts).toLocaleTimeString());
            cmpLines.push("");
            const pre = document.querySelector("#pc-log-debug");
            if (pre) pre.textContent += "\n" + cmpLines.join("\n");
          }
        });
        // CMP detection (2.B.1 — CSS detectors + cookie observation)
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_CMP_DETECT", tabId: tabs[0].id }, (resp) => {
          if (chrome.runtime.lastError) { void chrome.runtime.lastError; }
          if (resp && resp.cmpDetect) {
            const cd = resp.cmpDetect;
            const lines2 = [];
            lines2.push("— CMP detection (this tab) —");
            lines2.push("  domain: " + cd.domain);
            lines2.push("  timestamp: " + new Date(cd.ts).toLocaleTimeString());
            // CSS detections
            if (Array.isArray(cd.detected) && cd.detected.length > 0) {
              lines2.push("  CSS detections: " + cd.detected.length);
              for (const d of cd.detected) {
                const state = d.showing ? "showing" : (d.present ? "present" : "detected");
                lines2.push("    " + d.cmpId + " (" + state + ")");
              }
            } else {
              lines2.push("  CSS detections: 0");
            }
            // Cookie detections
            if (Array.isArray(cd.cookies) && cd.cookies.length > 0) {
              lines2.push("  cookie detections: " + cd.cookies.length);
              for (const c2 of cd.cookies) {
                lines2.push("    " + c2.cmpId + ": " + c2.cookieName + " = " + (c2.rawValue || "").slice(0, 80));
              }
            } else {
              lines2.push("  cookie detections: 0");
            }
            // Site-specific hiding
            if (Array.isArray(cd.siteHidden) && cd.siteHidden.length > 0) {
              lines2.push("  site-specific hiding: " + cd.siteHidden.length);
              for (const s of cd.siteHidden) {
                lines2.push("    " + s.cmpId + " (" + s.selectorCount + " selectors)");
              }
            }
            // Observation (cookie decoding)
            if (Array.isArray(cd.observation) && cd.observation.length > 0) {
              lines2.push("  observation: " + cd.observation.length + " CMPs decoded");
              for (const obs of cd.observation) {
                if (obs.conflicts && obs.conflicts.length > 0) {
                  for (const cf of obs.conflicts) {
                    lines2.push("    " + obs.cmpId + ": " + cf.purpose + " CMP=" + (cf.cmpValue ? "allow" : "deny") + " us=" + (cf.userValue ? "allow" : "deny"));
                  }
                } else {
                  lines2.push("    " + obs.cmpId + ": consent matches");
                }
              }
            }
            lines2.push("");
            const pre = document.querySelector("#pc-log-debug");
            if (pre) pre.textContent += "\n" + lines2.join("\n");
          }
        });
      }
    });

    // Tab match info (from Chrome's getMatchedRules — persisted counts, always accurate)
    lines.push("— tab matches (getMatchedRules) —");
    lines.push("  blocked: " + blocked + "  gpc: " + gpc + " (" + (gpcDomains?.length || 0) + " domains)");
    lines.push("");

    // Ruleset breakdown (from Chrome's getMatchedRules — per rulesetId)
    if (Object.keys(rulesetHitCount).length) {
      lines.push("— ruleset hits (getMatchedRules) —");
      for (const [id, count] of Object.entries(rulesetHitCount).sort()) {
        const tag = id.endsWith("_paths") ? " (path)" : id === "_dynamic_block" ? " (dynamic)" : " (domain)";
        lines.push("  " + id + ": " + count + tag);
      }
      lines.push("");
    }

    // Purpose breakdown (from Chrome's getMatchedRules — derived from rulesetId)
    if (Object.keys(domainHitCount).length) {
      lines.push("— purpose hits (getMatchedRules) —");
      for (const [purpose, count] of Object.entries(domainHitCount).sort()) {
        lines.push("  " + purpose + ": " + count);
      }
      lines.push("");
    }

    // Blocked domains detail (from our event listener — may have gaps if service worker was idle)
    if (Object.keys(blockedDomains).length) {
      lines.push("— blocked domains (event listener) —");
      for (const [purpose, domains] of Object.entries(blockedDomains).sort()) {
        for (const [domain, count] of Object.entries(domains).sort()) {
          lines.push("  [" + purpose + "] " + domain + " \u00d7" + count);
        }
      }
      lines.push("");
    }

    // CNAME cloaking cross-reference
    if (cnameMap && cnameTrackers) {
      const allDomains = new Set();
      // Collect all domains seen (blocked + GPC)
      for (const domains of Object.values(blockedDomains)) {
        for (const d of Object.keys(domains)) allDomains.add(d);
      }
      if (gpcDomains) {
        for (const d of gpcDomains) allDomains.add(d);
      }
      const cnameMatches = [];
      for (const d of allDomains) {
        const tracker = lookupCname(d);
        if (tracker) {
          cnameMatches.push("  " + d + " \u2192 " + tracker);
        }
      }
      lines.push("— CNAME cloaking (" + Object.keys(cnameMap).length.toLocaleString() + " entries) —");
      if (cnameMatches.length) {
        lines.push("  matches: " + cnameMatches.length);
        for (const m of cnameMatches) lines.push(m);
      } else {
        lines.push("  no matches in current tab domains");
      }
    } else {
      lines.push("— CNAME cloaking: not loaded" + (cnameLoadDiag ? " (" + cnameLoadDiag + ")" : "") + " —");
    }

    content.textContent = lines.join("\n");
  });
}
