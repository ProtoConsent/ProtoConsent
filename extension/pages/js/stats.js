// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Blocking stats: data fetching, stats bar rendering, scope helpers.
// Loaded after popup.js - reads/writes globals: lastBlocked, lastBlockedDomains,
// lastGpcSignalsSent, lastChStripped, lastGpcDomains, lastGpcDomainCounts,
// lastWhitelistHitDomains, lastPurposeStats, lastWhitelist, PURPOSES_TO_SHOW,
// currentPurposesState, purposeDomainCounts, purposePathCounts, activeMode,
// ESTIMATED_MS_PER_BLOCKED_REQUEST, displayRetries, MAX_DISPLAY_RETRIES.
// Also defines: _statsBar, _signalsBar, ensureBars (used by signals.js).

// --- Globals owned by stats (written here, read by other modules) ---

let lastPurposeStats = {};
let lastBlockedDomains = {};
let lastBlocked = 0;
let displayRetries = 0;
const MAX_DISPLAY_RETRIES = 2;

// --- Stats bar + signals bar (collapsible) ---

var _statsBar = null;
var _signalsBar = null;

function ensureBars() {
  if (!_statsBar) {
    var container = document.getElementById("pc-bar-stats");
    if (container) {
      _statsBar = createCollapsibleBar("pc-stats-bar", { ariaLabel: "Blocking stats", tint: null });
      _statsBar.setCollapsed("loading...");
      container.appendChild(_statsBar);
    }
  }
  if (!_signalsBar) {
    var container = document.getElementById("pc-bar-signals");
    if (container) {
      _signalsBar = createCollapsibleBar("pc-signals-bar", { ariaLabel: "Privacy signals", tint: "signals" });
      _signalsBar.setCollapsed("Privacy signals");
      container.appendChild(_signalsBar);
    }
  }
}

// --- Blocked rules count ---

 // @returns {Promise<{blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains}>}
 // domainHitCount: purpose -> count (from static rulesets only)
 // blockedDomains: purpose -> { domain -> count } (from onRuleMatchedDebug, covers both static + dynamic)
async function getBlockedRulesCount() {
  const EMPTY_BLOCKED_RESULT = { blocked: 0, gpc: 0, ch: 0, paramStrips: 0, gpcDomains: [], gpcDomainCounts: {}, domainHitCount: {}, rulesetHitCount: {}, blockedDomains: {}, whitelistHits: 0, whitelistHitDomains: {} };
  try {
    if (!chrome.declarativeNetRequest || !chrome.tabs) {
      return EMPTY_BLOCKED_RESULT;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return EMPTY_BLOCKED_RESULT;

    const tabId = tabs[0].id;

    const [matchedResult, domainsResult, dynamicResult] = await Promise.allSettled([
      chrome.declarativeNetRequest.getMatchedRules({ tabId }),
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_BLOCKED_DOMAINS", tabId }),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);

    const matched = matchedResult.status === "fulfilled" ? matchedResult.value : null;
    const domainsResp = domainsResult.status === "fulfilled" ? domainsResult.value : null;
    const dynamicRules = dynamicResult.status === "fulfilled" ? dynamicResult.value : [];

    const blockedDomains = domainsResp?.data || {};
    const gpcDomains = domainsResp?.gpcDomains || [];
    const gpcDomainCounts = domainsResp?.gpcDomainCounts || {};
    lastWhitelist = domainsResp?.whitelist || {};

    // Cache per-purpose domain and path counts for displayProtectionScope
    if (domainsResp?.purposeDomainCounts) {
      purposeDomainCounts = domainsResp.purposeDomainCounts;
    }
    if (domainsResp?.purposePathCounts) {
      purposePathCounts = domainsResp.purposePathCounts;
    }

    // If getMatchedRules failed but we have webRequest data, build result from that
    if (!matched || !matched.rulesMatchedInfo) {
      let blocked = 0;
      const domainHitCount = {};
      if (blockedDomains) {
        for (const [purpose, domains] of Object.entries(blockedDomains)) {
          const total = Object.values(domains).reduce((sum, c) => sum + c, 0);
          if (total > 0) {
            blocked += total;
            domainHitCount[purpose] = total;
          }
        }
      }
      var gpcTotal = Object.values(gpcDomainCounts).reduce((s, c) => s + c, 0);
      return { blocked, gpc: gpcTotal || gpcDomains.length, ch: 0, paramStrips: 0, gpcDomains, gpcDomainCounts, domainHitCount, rulesetHitCount: {}, blockedDomains, whitelistHits: 0, whitelistHitDomains: {} };
    }

    // Classify dynamic rules from Chrome's persistent store (reliable after SW restart)
    const dynamicBlockIds = new Set();
    const dynamicGpcIds = new Set();
    const dynamicChIds = new Set();
    const dynamicParamStripIds = new Set();
    const dynamicWhitelistDomains = {}; // ruleId -> requestDomains[]
    for (const rule of dynamicRules) {
      if (rule.action.type === "block") {
        dynamicBlockIds.add(rule.id);
      } else if (rule.action.type === "modifyHeaders") {
        const isGpcSet = rule.action.requestHeaders?.some(
          h => h.header === "Sec-GPC" && h.operation === "set"
        );
        const isChStrip = rule.action.requestHeaders?.some(
          h => h.header.startsWith("sec-ch-ua-") && h.operation === "remove"
        );
        if (isGpcSet) dynamicGpcIds.add(rule.id);
        if (isChStrip) dynamicChIds.add(rule.id);
      } else if (rule.action.type === "allow") {
        dynamicWhitelistDomains[rule.id] = rule.condition?.requestDomains || [];
      } else if (rule.action.type === "redirect" && rule.action.redirect?.transform?.queryTransform?.removeParams) {
        dynamicParamStripIds.add(rule.id);
      }
    }

    let blocked = 0;
    let gpc = 0;
    let ch = 0;
    let paramStrips = 0;
    let whitelistHits = 0;
    const whitelistHitDomains = {}; // domain -> count
    const domainHitCount = {};
    const rulesetHitCount = {}; // rulesetId -> count (for debug)
    for (const info of matched.rulesMatchedInfo) {
      const rulesetId = info.rule.rulesetId;

      // Static ruleset match (e.g. "block_ads" or "block_ads_paths" -> purpose "ads")
      if (rulesetId && rulesetId.startsWith("block_")) {
        blocked++;
        const purpose = rulesetId.slice(6).replace(/_paths$/, "");
        domainHitCount[purpose] = (domainHitCount[purpose] || 0) + 1;
        rulesetHitCount[rulesetId] = (rulesetHitCount[rulesetId] || 0) + 1;
      }
      // Dynamic block override (per-site)
      else if (rulesetId === "_dynamic" && dynamicBlockIds.has(info.rule.ruleId)) {
        blocked++;
        rulesetHitCount["_dynamic_block"] = (rulesetHitCount["_dynamic_block"] || 0) + 1;
      }
      // GPC header (dynamic)
      else if (rulesetId === "_dynamic" && dynamicGpcIds.has(info.rule.ruleId)) {
        gpc++;
      }
      // Client Hints stripping (dynamic)
      else if (rulesetId === "_dynamic" && dynamicChIds.has(info.rule.ruleId)) {
        ch++;
      }
      // Whitelist allow rule (dynamic)
      else if (rulesetId === "_dynamic" && dynamicWhitelistDomains[info.rule.ruleId]) {
        whitelistHits++;
        for (const d of dynamicWhitelistDomains[info.rule.ruleId]) {
          whitelistHitDomains[d] = (whitelistHitDomains[d] || 0) + 1;
        }
      }
      // Static param strip rulesets
      else if (rulesetId === "strip_tracking_params" || rulesetId === "strip_tracking_params_sites") {
        paramStrips++;
      }
      // Dynamic param strip (CDN redirect rules)
      else if (rulesetId === "_dynamic" && dynamicParamStripIds.has(info.rule.ruleId)) {
        paramStrips++;
      }
    }

    // If getMatchedRules returned fewer blocks than the webRequest-based
    // tabBlockedDomains, use the higher count and reconcile domainHitCount.
    // getMatchedRules can reset (e.g. after SW restart) while webRequest data survives.
    if (blockedDomains) {
      let webRequestTotal = 0;
      for (const [purpose, domains] of Object.entries(blockedDomains)) {
        const total = Object.values(domains).reduce((sum, c) => sum + c, 0);
        webRequestTotal += total;
        if (total > (domainHitCount[purpose] || 0)) {
          domainHitCount[purpose] = total;
        }
      }
      if (webRequestTotal > blocked) blocked = webRequestTotal;
    }

    return { blocked, gpc, ch, paramStrips, gpcDomains, gpcDomainCounts, domainHitCount, rulesetHitCount, blockedDomains, whitelistHits, whitelistHitDomains };
  } catch (err) {
    console.error("ProtoConsent: error fetching matched rules count:", err);
    return EMPTY_BLOCKED_RESULT;
  }
}

// --- Block provenance ---

// Compute block provenance from getMatchedRules (own) vs webRequest (observed).
// Single source of truth - used by proto.js and debug.js.
// In monitoring mode, own is always 0 (ProtoConsent does not block).
function computeBlockProvenance(coverage, mode) {
  let own = (mode === "protoconsent") ? 0 : (lastBlocked || 0);
  let observed = (coverage && coverage.observed) || 0;
  let attributed = (coverage && coverage.attributed) || 0;
  let external = (mode === "protoconsent") ? observed : Math.max(0, observed - own);
  return { own: own, observed: observed, attributed: attributed, external: external };
}

// --- Stats bar rendering ---

function buildStatsCollapsed(blocked) {
  var frag = document.createDocumentFragment();
  var fragments = [];

  if (blocked > 0) {
    var enhancedCount = 0;
    for (var key in lastPurposeStats) {
      if (key.startsWith("enhanced:")) enhancedCount += lastPurposeStats[key];
    }
    var blockedSpan = document.createElement("span");
    blockedSpan.appendChild(document.createTextNode(blocked + " blocked"));
    if (enhancedCount > 0) {
      var epSpan = document.createElement("span");
      epSpan.className = "pc-counter-enhanced";
      epSpan.title = enhancedCount + " blocked by Enhanced Protection";
      blockedSpan.appendChild(document.createTextNode(" "));
      epSpan.appendChild(document.createTextNode("("));
      var epIcon = document.createElement("img");
      epIcon.src = ENHANCED_ICON;
      epIcon.width = 12;
      epIcon.height = 12;
      epIcon.alt = enhancedCount + " enhanced";
      epIcon.className = "pc-counter-enhanced-icon";
      epSpan.appendChild(epIcon);
      epSpan.appendChild(document.createTextNode(enhancedCount + ")"));
      blockedSpan.appendChild(epSpan);
    }
    fragments.push(blockedSpan);

    var estimatedMs = blocked * ESTIMATED_MS_PER_BLOCKED_REQUEST;
    if (estimatedMs >= 100) {
      fragments.push(document.createTextNode("~" + formatEstimatedTime(estimatedMs) + " faster"));
    }
  }
  if (fragments.length > 0) {
    for (var i = 0; i < fragments.length; i++) {
      if (i > 0) frag.appendChild(document.createTextNode(" \u00b7 "));
      frag.appendChild(fragments[i]);
    }
    return frag;
  }
  return "Nothing blocked";
}

async function displayBlockedCount() {
  ensureBars();

  try {
    const { blocked, gpc, ch, paramStrips, gpcDomains, gpcDomainCounts, domainHitCount, rulesetHitCount, blockedDomains, whitelistHitDomains } = await getBlockedRulesCount();
    lastBlockedDomains = blockedDomains;
    lastBlocked = blocked;
    lastGpcSignalsSent = gpc;
    lastChStripped = ch;
    lastGpcDomains = gpcDomains;
    lastGpcDomainCounts = gpcDomainCounts;
    lastWhitelistHitDomains = whitelistHitDomains || {};

    // domainHitCount maps purpose -> count from static rulesets only.
    // Supplement with blockedDomains (from onRuleMatchedDebug) to cover dynamic rule matches.
    lastPurposeStats = Object.assign({}, domainHitCount);

    // Merge with blockedDomains counts (event listener covers dynamic + static matches).
    if (blockedDomains) {
      for (const [purpose, domains] of Object.entries(blockedDomains)) {
        const total = Object.values(domains).reduce((sum, c) => sum + c, 0);
        if (total > 0) {
          lastPurposeStats[purpose] = Math.max(lastPurposeStats[purpose] || 0, total);
        }
      }
    }

    // --- Stats bar collapsed content ---
    if (_statsBar) {
      _statsBar.setCollapsed(buildStatsCollapsed(blocked));

      // --- Stats bar expanded content ---
      var expDiv = document.createElement("div");

      // Scope line (core rules)
      var scopeText = computeScopeText();
      if (scopeText) {
        var scopeLine = document.createElement("span");
        scopeLine.textContent = scopeText;
        scopeLine.style.color = "var(--pc-accent)";
        scopeLine.style.fontWeight = "600";
        expDiv.appendChild(scopeLine);
      }

      // Enhanced scope
      var enhancedEl = document.createElement("span");
      enhancedEl.style.color = "#b45309";
      enhancedEl.style.fontWeight = "600";
      enhancedEl._sep = scopeText ? " \u00b7 " : "";
      expDiv.appendChild(enhancedEl);
      buildEnhancedScopeLine(enhancedEl);

      // Link to Log Domains
      if (blocked > 0 || gpc > 0) {
        var logLink = document.createElement("button");
        logLink.type = "button";
        logLink.className = "pc-bar-link";
        logLink.textContent = "\u2192 View blocked domains";
        logLink.addEventListener("click", function () { navigateToLog("domains"); });
        expDiv.appendChild(logLink);
      }

      _statsBar.setExpanded(expDiv);
    }

    // Inject per-purpose stats into purpose items
    displayPerPurposeStats();

    // Signals bar
    renderSignalsBar(gpc);

    // Debug panel (visible only when debug flag is set in storage)
    if (DEBUG_RULES) {
      renderDebugPanel({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains });
    }

    // Refresh Log tab panels if currently active
    if (activeMode === "log" && typeof refreshLogView === "function") {
      refreshLogView();
    }

    // Auto-retry: re-fetch after a short delay if domain data is missing
    const hasDomainData = blockedDomains && Object.keys(blockedDomains).length > 0;
    const hasGpcData = gpcDomains && gpcDomains.length > 0;
    if (((blocked > 0 && !hasDomainData) || (gpc > 0 && !hasGpcData)) && displayRetries < MAX_DISPLAY_RETRIES) {
      displayRetries++;
      setTimeout(displayBlockedCount, 1500);
    } else {
      displayRetries = 0;
    }
  } catch (err) {
    console.error("ProtoConsent: error displaying blocked count:", err);
    if (_statsBar) _statsBar.setCollapsed("? requests blocked");
  }
}

// --- Scope helpers ---

function computeScopeText() {
  var domainCount = 0;
  var pathCount = 0;
  for (var i = 0; i < PURPOSES_TO_SHOW.length; i++) {
    var pk = PURPOSES_TO_SHOW[i];
    if (currentPurposesState[pk] !== false) continue;
    if (purposeDomainCounts[pk]) domainCount += purposeDomainCounts[pk];
    if (purposePathCounts[pk]) pathCount += purposePathCounts[pk];
  }
  var total = domainCount + pathCount;
  if (total > 0) return "Core \u00b7 " + compactNumber(total) + " rules";
  var hasBlocked = PURPOSES_TO_SHOW.some(function (pk) { return currentPurposesState[pk] === false; });
  return hasBlocked ? "Protection enabled" : "";
}

function buildEnhancedScopeLine(el) {
  if (typeof epLists !== "undefined" && Object.keys(epLists).length > 0) {
    var stats = getEnhancedStats();
    var celIds = typeof epConsentLinkedIds !== "undefined" ? epConsentLinkedIds : new Set();
    var infoDomains = Object.entries(epLists)
      .filter(function (e) { return (e[1].enabled || celIds.has(e[0])) && e[1].type === "informational"; })
      .reduce(function (sum, e) { return sum + (e[1].domainCount || 0); }, 0);
    renderEnhancedScopeLine(el, stats.blockingCount + stats.cosmeticCount + stats.cmpCount, stats.totalRules, stats.infoCount, infoDomains);
  } else {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      var lists = resp.lists || {};
      var celIds = new Set(resp.consentLinkedListIds || []);
      var active = Object.entries(lists).filter(function (e) { return e[1].enabled || celIds.has(e[0]); }).map(function (e) { return e[1]; });
      var blocking = active.filter(function (l) { return l.type !== "informational" && l.type !== "cosmetic" && l.type !== "cmp"; });
      var cosmetic = active.filter(function (l) { return l.type === "cosmetic"; });
      var cmp = active.filter(function (l) { return l.type === "cmp"; });
      var info = active.filter(function (l) { return l.type === "informational"; });
      var bRules = blocking.reduce(function (s, l) { return s + (l.domainCount || 0); }, 0);
      var cRules = cosmetic.reduce(function (s, l) { return s + (l.genericCount || 0) + (l.domainRuleCount || 0); }, 0);
      var cmpT = cmp.reduce(function (s, l) { return s + (l.cmpCount || 0); }, 0);
      renderEnhancedScopeLine(el, blocking.length + cosmetic.length + cmp.length, bRules + cRules + cmpT,
        info.length, info.reduce(function (s, l) { return s + (l.domainCount || 0); }, 0));
    });
  }
}

function formatEstimatedTime(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms / 10) * 10 + "ms";
}

function displayPerPurposeStats() {
  for (const purposeKey of PURPOSES_TO_SHOW) {
    const itemEl = document.querySelector('.pc-purpose-item[data-purpose="' + purposeKey + '"]');
    if (!itemEl) continue;

    // Remove existing inline stat if re-rendering
    const existing = itemEl.querySelector(".pc-purpose-stat-inline");
    if (existing) existing.remove();

    const count = lastPurposeStats[purposeKey];
    if (!count) continue;

    // Inline stat between name and toggle in the header row
    const headerEl = itemEl.querySelector(".pc-purpose-header");
    const toggleEl = itemEl.querySelector(".pc-purpose-toggle");
    if (!headerEl || !toggleEl) continue;

    const statEl = document.createElement("span");
    statEl.className = "pc-purpose-stat-inline";
    statEl.textContent = count + " blocked";
    statEl.title = "View blocked domains in Log tab";
    statEl.style.cursor = "pointer";
    statEl.addEventListener("click", function (e) { e.stopPropagation(); navigateToLog(); });
    headerEl.insertBefore(statEl, toggleEl);
  }
}

// Display "Protected from X trackers" below the counter bar
// Now integrated into stats bar expanded view via computeScopeText()
function displayProtectionScope() {
  // Refresh the stats bar if it exists (scope is inside expanded bar now)
  if (_statsBar) {
    var scopeText = computeScopeText();
    var scopeLine = _statsBar._body.querySelector(".pc-scope-line");
    if (scopeLine) {
      scopeLine.textContent = scopeText || "";
      scopeLine.style.display = scopeText ? "" : "none";
    }
  }
}

function renderEnhancedScopeLine(el, blockingCount, totalDomains, infoCount, infoDomains) {
  const totalLists = blockingCount + (infoCount || 0);
  if (totalLists === 0) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "";
  el.textContent = el._sep || "";
  const icon = document.createElement("img");
  icon.src = ENHANCED_ICON;
  icon.width = 12;
  icon.height = 12;
  icon.alt = "Enhanced";
  icon.style.verticalAlign = "text-bottom";
  icon.style.position = "relative";
  icon.style.top = "-1px";
  icon.style.marginRight = "4px";
  el.appendChild(icon);
  let text = totalLists + (totalLists === 1 ? " list" : " lists") +
    " \u00b7 " + compactNumber(totalDomains) + " rules";
  if (infoCount > 0 && infoDomains > 0) {
    text += " + " + compactNumber(infoDomains);
  }
  el.appendChild(document.createTextNode(text));
  if (infoCount > 0 && infoDomains > 0) {
    const infoSpan = document.createElement("span");
    infoSpan.textContent = " \u2139";
    infoSpan.setAttribute("aria-label", "informational entries");
    infoSpan.title = "Informational entries (not blocking)";
    el.appendChild(infoSpan);
  }
  el.style.display = "";
}
