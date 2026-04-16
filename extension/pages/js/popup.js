// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// popup.js with safe chrome.storage.local
// DEBUG_RULES loaded from config.js via <script> in popup.html
// .well-known logic in well-known.js, debug panel in debug.js

// Estimated time saved per blocked request (ms) - conservative approximation
// Accounts for DNS + connection + download of typical third-party tracking scripts
const ESTIMATED_MS_PER_BLOCKED_REQUEST = 50;

let PURPOSES_TO_SHOW = [];
let gpcPurposeKeys = [];

let purposesConfig = {};
let presetsConfig = {};
let enhancedCatalogConfig = {};
let purposeDomainCounts = {};
let purposePathCounts = {};
let currentDomain = null;
let currentProtocol = "https:";
let currentHost = null;
let defaultProfile = "balanced";
let defaultPurposes = null;
let currentProfile = "balanced";
let currentPurposesState = {};
let allRules = {};
let lastGpcSignalsSent = 0;
let lastChStripped = 0;

let lastGpcDomains = [];
let lastGpcDomainCounts = {};
let lastWhitelist = {};
let lastWhitelistHitDomains = {};
let requiredPurposeKeys = new Set();
let activeMode = "consent";
let gpcGlobalEnabled = true;
let chStrippingEnabled = true;

function getActivePurposes() {
  const core = PURPOSES_TO_SHOW.filter(p => lastPurposeStats[p] || lastBlockedDomains[p]);
  // Include Enhanced Protection list keys (enhanced:listId)
  const enhanced = Object.keys(lastBlockedDomains || {}).filter(k => k.startsWith("enhanced:"));
  const enhancedStats = Object.keys(lastPurposeStats || {}).filter(k => k.startsWith("enhanced:") && !enhanced.includes(k));
  return [...core, ...enhanced, ...enhancedStats];
}

async function initPopup() {
  try {
    await loadDebugFlag();
    await loadOperatingMode();
    initModeRail();
    await loadConfigs();
    await loadDefaultProfile();
    initProfileSelect();
    // Pre-fetch enhanced/proto state so tabs open instantly (fire-and-forget)
    try { if (typeof initEnhancedTab === "function") initEnhancedTab(); } catch (_) {}
    try { if (typeof initProtoTab === "function") initProtoTab(); } catch (_) {}
    await refreshPopupState();
  } catch (err) {
    console.error("ProtoConsent popup error:", err);
    showPopupError("Could not load ProtoConsent settings for this site.");
    waitForTabReady();
  }
}

// Refresh all domain-dependent state. Called on init and after page reload.
async function refreshPopupState() {
  await initDomain();
  updateHeaderControls();
  await loadRulesFromStorageSafe();
  initStateForDomain();
  updateGpcIndicator();
  updateChIndicator();

  updateTcfIndicator();
  renderPurposesList();
  await displayBlockedCount();
  await loadSiteDeclaration();
  checkBlockerDetectionForConsent();
}

// Auto-retry initPopup when the active tab finishes loading.
// Fires once, then removes itself.
function waitForTabReady() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        initPopup();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function initModeRail() {
  const modeRail = document.getElementById("pc-mode-rail");
  const modeTabs = document.querySelectorAll(".pc-mode-tab");

  if (modeRail) modeRail.hidden = false;

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode || "consent";
      setActiveMode(mode);
      if (mode === "log" && typeof initLogTab === "function") initLogTab();
      if (mode === "enhanced" && typeof initEnhancedTab === "function") initEnhancedTab();
      if (mode === "proto" && typeof initProtoTab === "function") initProtoTab();
    });
  });
  setActiveMode(activeMode);
  if (activeMode === "proto" && typeof initProtoTab === "function") initProtoTab();
}

function setActiveMode(mode) {
  activeMode = mode;

  const views = document.querySelectorAll("[data-mode-view]");
  views.forEach((view) => {
    const isActive = view.dataset.modeView === mode;
    view.hidden = !isActive;
    view.setAttribute("aria-hidden", isActive ? "false" : "true");
  });

  const tabs = document.querySelectorAll(".pc-mode-tab");
  tabs.forEach((tab) => {
    const isActive = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

 // Get the count of matched DNR rules for the current tab.
 // Calls chrome.declarativeNetRequest.getMatchedRules({ tabId })
 // and fetches per-domain detail from the background's onRuleMatchedDebug tracker.
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
    const dynamicWhitelistDomains = {}; // ruleId → requestDomains[]
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
    const whitelistHitDomains = {}; // domain → count
    const domainHitCount = {};
    const rulesetHitCount = {}; // rulesetId → count (for debug)
    for (const info of matched.rulesMatchedInfo) {
      const rulesetId = info.rule.rulesetId;

      // Static ruleset match (e.g. "block_ads" or "block_ads_paths" → purpose "ads")
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

// Fetch and display the blocked rules count on the popup.
let lastPurposeStats = {};
let lastBlockedDomains = {};
let lastBlocked = 0;
let displayRetries = 0;
const MAX_DISPLAY_RETRIES = 2;

// Compute block provenance from getMatchedRules (own) vs webRequest (observed).
// Single source of truth - used by proto.js and debug.js.
function computeBlockProvenance(coverage) {
  let own = lastBlocked || 0;
  let observed = (coverage && coverage.observed) || 0;
  let attributed = (coverage && coverage.attributed) || 0;
  let external = Math.max(0, observed - own);
  return { own: own, observed: observed, attributed: attributed, external: external };
}

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

// Shared: build collapsed content for stats bar (used by consent + proto)
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

// Compute scope text for bar expanded view
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

// Build enhanced scope line into element (async, may update after load)
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

// Navigate to the Log tab
function navigateToLog(innerTab) {
  let tab;
  if (typeof innerTab === "string") {
    tab = innerTab;
  } else if (lastBlocked > 0) {
    tab = "domains";
  } else if (lastGpcSignalsSent > 0) {
    tab = "gpc";
  } else {
    tab = "domains";
  }
  if (typeof setActiveMode === "function") setActiveMode("log");
  if (typeof initLogTab === "function") initLogTab();
  if (typeof setActiveLogTab === "function") setActiveLogTab(tab);
}

document.addEventListener("DOMContentLoaded", () => {
  initPopup();

  const reloadBtn = document.getElementById("pc-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", reloadActiveTab);
  }

  const purposesLink = document.getElementById("pc-purposes-link");
  if (purposesLink) {
    purposesLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/purposes-settings.html") });
    });
  }

  const countEl = document.getElementById("pc-blocked-count");
  if (countEl) {
    countEl.addEventListener("click", navigateToLog);
  }

  const headerStatEl = document.querySelector(".pc-header-stat");
  if (headerStatEl) {
    headerStatEl.addEventListener("click", (e) => {
      if (e.target && e.target.closest("#pc-blocked-count")) return;
      if (!headerStatEl.classList.contains("clickable")) return;
      navigateToLog();
    });
  }

  const toggleDescBtn = document.getElementById("pc-toggle-descriptions");

  // Toggle stats + signals collapsible bars programmatically
  function _toggleBars() {
    [_statsBar, _signalsBar].forEach(bar => {
      if (!bar) return;
      var toggle = bar.querySelector(".pc-bar-toggle");
      if (toggle) toggle.click();
    });
  }

  if (toggleDescBtn) {
    toggleDescBtn.addEventListener("click", () => {
      if (activeMode === "enhanced") {
        // Enhanced tab: toggle overview grid card + .ep-list-card is-expanded
        const ovCard = document.getElementById("ep-card-overview");
        if (ovCard) {
          const ovToggle = ovCard.querySelector(".pc-grid-card-toggle");
          if (ovToggle) ovToggle.click();
        }
        const cards = document.querySelectorAll(".ep-list-card");
        let collapsedCount = 0;
        cards.forEach((card) => {
          if (!card.classList.contains("is-expanded")) collapsedCount++;
        });
        const shouldExpand = collapsedCount > cards.length / 2;
        cards.forEach((card) => {
          card.classList.toggle("is-expanded", shouldExpand);
          const header = card.querySelector(".ep-list-header");
          if (header) header.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
        });
        toggleDescBtn.textContent = shouldExpand ? "Hide details" : "Show details";
        toggleDescBtn.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
        return;
      }

      // Toggle collapsible bars (stats + signals) for Consent and Proto
      _toggleBars();

      if (activeMode === "proto") {
        // Proto tab: toggle .proto-card is-expanded (bars already toggled above)
        const cards = document.querySelectorAll("#pc-view-proto .proto-card");
        let collapsedCount = 0;
        cards.forEach((card) => {
          if (!card.classList.contains("is-expanded")) collapsedCount++;
        });
        const shouldExpand = collapsedCount > cards.length / 2;
        if (typeof toggleProtoDetails === "function") toggleProtoDetails(shouldExpand);
        toggleDescBtn.textContent = shouldExpand ? "Hide details" : "Show details";
        toggleDescBtn.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
        return;
      }
      // Consent tab: toggle .pc-purpose-description is-collapsed (bars already toggled above)
      const descriptions = document.querySelectorAll(".pc-purpose-description");
      const chevrons = document.querySelectorAll(".pc-purpose-chevron");
      const leftEls = document.querySelectorAll(".pc-purpose-left");
      // Expand all if majority are collapsed, collapse all otherwise
      let collapsedCount = 0;
      descriptions.forEach((desc) => {
        if (desc.classList.contains("is-collapsed")) collapsedCount++;
      });
      const shouldExpand = collapsedCount > descriptions.length / 2;

      descriptions.forEach((desc) => {
        if (shouldExpand) {
          desc.classList.remove("is-collapsed");
        } else {
          desc.classList.add("is-collapsed");
        }
      });
      chevrons.forEach((ch) => {
        ch.textContent = shouldExpand ? " ▾" : " ▸";
      });
      leftEls.forEach((el) => {
        el.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
      });
      toggleDescBtn.textContent = shouldExpand ? "Hide details" : "Show details";
      toggleDescBtn.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
    });
  }
});

// Load purposes and presets from config/
async function loadConfigs() {
  const purposesUrl = chrome.runtime.getURL("config/purposes.json");
  const presetsUrl = chrome.runtime.getURL("config/presets.json");
  const enhancedUrl = chrome.runtime.getURL("config/enhanced-lists.json");

  const [purposesRes, presetsRes, enhancedRes] = await Promise.all([
    fetch(purposesUrl),
    fetch(presetsUrl),
    fetch(enhancedUrl)
  ]);

  if (!purposesRes.ok) throw new Error("Failed to load purposes.json: HTTP " + purposesRes.status);
  if (!presetsRes.ok) throw new Error("Failed to load presets.json: HTTP " + presetsRes.status);

  purposesConfig = await purposesRes.json();
  presetsConfig = await presetsRes.json();
  enhancedCatalogConfig = enhancedRes.ok ? await enhancedRes.json() : {};

  // Derive display order from config, sorted by the order field
  PURPOSES_TO_SHOW = Object.keys(purposesConfig)
    .sort((a, b) => (purposesConfig[a].order || 0) - (purposesConfig[b].order || 0));

  // Purposes that can trigger Sec-GPC when blocked
  gpcPurposeKeys = PURPOSES_TO_SHOW.filter((key) => purposesConfig[key] && purposesConfig[key].triggers_gpc);

  // Purposes that are always enabled (e.g. functional)
  requiredPurposeKeys = new Set(
    PURPOSES_TO_SHOW.filter((key) => purposesConfig[key]?.required)
  );
}

// Load the user's default profile from storage
async function loadDefaultProfile() {
  if (!chrome.storage || !chrome.storage.local) return;

  return new Promise((resolve) => {
    chrome.storage.local.get(["defaultProfile", "defaultPurposes", "gpcEnabled", "chStrippingEnabled"], (result) => {
      defaultProfile = result.defaultProfile || "balanced";
      defaultPurposes = result.defaultPurposes || null;
      if (!defaultPurposes && presetsConfig[defaultProfile]) {
        defaultPurposes = {};
        var pp = presetsConfig[defaultProfile].purposes || {};
        for (var i = 0; i < PURPOSES_TO_SHOW.length; i++) {
          defaultPurposes[PURPOSES_TO_SHOW[i]] = pp[PURPOSES_TO_SHOW[i]] !== false;
        }
      }
      currentProfile = defaultProfile;
      gpcGlobalEnabled = result.gpcEnabled !== false;
      chStrippingEnabled = result.chStrippingEnabled !== false;
      resolve();
    });
  });
}

// Get current tab domain
async function initDomain() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0] || !tabs[0].url) {
    currentDomain = null;
    showUnsupportedPage();
    return;
  }

  try {
    const url = new URL(tabs[0].url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      currentDomain = null;
      showUnsupportedPage();
      return;
    }
    const hostname = url.hostname.replace(/^www\./, "");
    currentDomain = hostname;
    currentProtocol = url.protocol;
    currentHost = url.host;
    document.getElementById("pc-site-domain").textContent = hostname;
  } catch (e) {
    currentDomain = null;
    showUnsupportedPage();
  }
}

// Safe wrapper around chrome.storage.local.get
async function loadRulesFromStorageSafe() {
  if (!chrome.storage || !chrome.storage.local) {
    // Storage not available (very old / special environment) → start empty
    allRules = {};
    return;
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(["rules"], (result) => {
      allRules = result && result.rules ? result.rules : {};
      resolve();
    });
  });
}

// Show or hide the "Custom" option in the profile selector
function setCustomOptionVisible(visible) {
  const customOption = document.querySelector('.pc-profile-option-custom');
  if (customOption) customOption.hidden = !visible;
}

// Update the profile button text and active state in the dropdown
function syncProfileDropdown(value) {
  const btnText = document.getElementById("pc-profile-btn-text");
  if (btnText) {
    const opt = document.querySelector('.pc-profile-option[data-value="' + value + '"]');
    btnText.textContent = opt ? opt.textContent : value;
  }
  document.querySelectorAll('.pc-profile-option').forEach(o => {
    o.classList.toggle('is-active', o.dataset.value === value);
  });
}

// Init profile selector (event handler only; values set by initStateForDomain)
function initProfileSelect() {
  const btn = document.getElementById("pc-profile-btn");
  const menu = document.getElementById("pc-profile-menu");

  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
  });

  menu.addEventListener("click", (e) => {
    const opt = e.target.closest('.pc-profile-option');
    if (!opt || opt.hidden || opt.disabled) return;
    menu.hidden = true;
    currentProfile = opt.dataset.value;
    if (currentProfile !== "custom") setCustomOptionVisible(false);
    syncProfileDropdown(currentProfile);
    applyPresetToCurrentDomain();
    renderPurposesList();
    saveCurrentDomainRulesSafe();
    displayProtectionScope();
    updateGpcIndicator();
    updateChIndicator();
    updateTcfIndicator();
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.hidden = true;
    }
  });
}

// Force required purposes (e.g. functional) to true regardless of stored state
function forceRequiredPurposes() {
  for (const key of requiredPurposeKeys) {
    currentPurposesState[key] = true;
  }
}

// Init currentPurposesState for this domain, resolving profile inheritance
function initStateForDomain() {
  if (!currentDomain) return;

  const existing = allRules[currentDomain];

  if (existing && existing.profile) {
    currentProfile = existing.profile;

    // Show the custom option if this domain uses it
    if (currentProfile === "custom") {
      setCustomOptionVisible(true);
    }
    // Start from profile defaults (if named preset) or empty (if custom)
    const profilePurposes = (presetsConfig[currentProfile] && presetsConfig[currentProfile].purposes) || {};
    PURPOSES_TO_SHOW.forEach((key) => {
      currentPurposesState[key] = profilePurposes[key] !== false;
    });

    // Apply explicit overrides on top
    if (existing.purposes) {
      Object.keys(existing.purposes).forEach((key) => {
        currentPurposesState[key] = existing.purposes[key];
      });
    }
  } else {
    applyPresetToCurrentDomain();
  }

  // Sync dropdown with current profile
  syncProfileDropdown(currentProfile);

  forceRequiredPurposes();
}

// Apply preset values for currentProfile into currentPurposesState
function applyPresetToCurrentDomain() {
  let profilePurposes;
  if (currentProfile === "custom" && defaultPurposes) {
    // Custom global default: use stored default purposes
    profilePurposes = defaultPurposes;
  } else {
    const profile = presetsConfig[currentProfile];
    profilePurposes = (profile && profile.purposes) || {};
  }

  PURPOSES_TO_SHOW.forEach((purposeKey) => {
    const presetValue = profilePurposes[purposeKey];
    currentPurposesState[purposeKey] = presetValue !== false;
  });

  forceRequiredPurposes();
}

// Check if current toggles match the active preset; if not, switch to "custom".
// If already "custom", check if toggles match any named preset and revert.
function detectCustomProfile() {
  if (currentProfile === "custom") {
    // Try to match a named preset
    for (const [presetKey, presetDef] of Object.entries(presetsConfig)) {
      const purposes = presetDef.purposes || {};
      const matches = PURPOSES_TO_SHOW.every((key) => {
        if (requiredPurposeKeys.has(key)) return true;
        return currentPurposesState[key] === (purposes[key] !== false);
      });
      if (matches) {
        currentProfile = presetKey;
        setCustomOptionVisible(false);
        syncProfileDropdown(presetKey);
        return;
      }
    }
    return;
  }

  const profilePurposes = (presetsConfig[currentProfile] && presetsConfig[currentProfile].purposes) || {};
  const matchesPreset = PURPOSES_TO_SHOW.every((key) => {
    if (requiredPurposeKeys.has(key)) return true;
    return currentPurposesState[key] === (profilePurposes[key] !== false);
  });

  if (!matchesPreset) {
    currentProfile = "custom";
    setCustomOptionVisible(true);
    syncProfileDropdown("custom");
  }
}

// Create a single purpose item element (data + DOM)
function createPurposeItemElement(purposeKey, cfg) {
  const isAllowed = currentPurposesState[purposeKey] !== false;

  const itemEl = document.createElement("li");
  itemEl.className = "pc-purpose-item";
  itemEl.dataset.purpose = purposeKey;

  const isRequired = requiredPurposeKeys.has(purposeKey);
  if (isRequired) {
    itemEl.classList.add("is-required");
  }

  const checkboxId = `pc-toggle-${purposeKey}`;

  // Checkbox that owns the state for this purpose
  const checkboxEl = document.createElement("input");
  checkboxEl.type = "checkbox";
  checkboxEl.id = checkboxId;
  checkboxEl.className = "pc-toggle-checkbox";
  checkboxEl.checked = isAllowed;
  checkboxEl.setAttribute("aria-label", cfg.label + " \u002D " + (isAllowed ? "Allowed" : "Blocked"));

  if (isRequired) {
    checkboxEl.checked = true;
    checkboxEl.disabled = true;
  }

  // Header container (visual row)
  const headerEl = document.createElement("div");
  headerEl.className = "pc-purpose-header";

  // Left side: (icon + name),
  // Clicking it will collapse/expand the description.
  const leftEl = document.createElement("div");
  leftEl.className = "pc-purpose-left";

  const iconEl = document.createElement("div");
  iconEl.className = "pc-purpose-icon";
  if (cfg.icon) {
    const imgEl = document.createElement("img");
    imgEl.src = cfg.icon;
    imgEl.alt = "";
    imgEl.className = "pc-purpose-icon-img";
    imgEl.width = 18;
    imgEl.height = 18;
    imgEl.onerror = () => {
      iconEl.removeChild(imgEl);
      iconEl.textContent = cfg.short || (cfg.label?.charAt(0) || "?");
    };
    iconEl.appendChild(imgEl);
  } else {
    iconEl.textContent = cfg.short || (cfg.label?.charAt(0) || "?");
  }

  const nameEl = document.createElement("div");
  nameEl.className = "pc-purpose-name";

  const nameTxt = document.createTextNode(cfg.label || purposeKey);
  const chevronEl = document.createElement("span");
  chevronEl.className = "pc-purpose-chevron";
  chevronEl.setAttribute("aria-hidden", "true");
  chevronEl.textContent = " ▾";
  nameEl.appendChild(nameTxt);

  leftEl.appendChild(chevronEl);
  leftEl.appendChild(iconEl);
  leftEl.appendChild(nameEl);
  leftEl.setAttribute("role", "button");
  leftEl.setAttribute("aria-expanded", "false");
  leftEl.setAttribute("tabindex", "0");

  // Right side: toggle area (label + visual switch + Allowed/Blocked)
  const toggleLabelEl = document.createElement("label");
  toggleLabelEl.className = "pc-purpose-toggle";
  toggleLabelEl.setAttribute("for", checkboxId);

  const switchEl = document.createElement("span");
  switchEl.className = "pc-toggle-switch";

  const knobEl = document.createElement("span");
  knobEl.className = "pc-toggle-switch-knob";
  switchEl.appendChild(knobEl);

  const stateLabelEl = document.createElement("span");
  stateLabelEl.className = "pc-toggle-label";

  // Update the visual switch based on the checkbox state
  function updateSwitchVisual() {
    itemEl.classList.remove("is-allowed", "is-blocked");
    stateLabelEl.classList.remove("is-allowed", "is-blocked", "is-required");

    if (isRequired) {
      switchEl.classList.add("is-on", "is-disabled");
      stateLabelEl.textContent = "Required";
      stateLabelEl.classList.add("is-required");
      checkboxEl.setAttribute("aria-label", cfg.label + " \u002D Required (always enabled)");
      return;
    }
    if (checkboxEl.checked) {
      switchEl.classList.add("is-on");
      stateLabelEl.textContent = "Allowed";
      stateLabelEl.classList.add("is-allowed");
      itemEl.classList.add("is-allowed");
      checkboxEl.setAttribute("aria-label", cfg.label + " \u002D Allowed");
    } else {
      switchEl.classList.remove("is-on");
      stateLabelEl.textContent = "Blocked";
      stateLabelEl.classList.add("is-blocked");
      itemEl.classList.add("is-blocked");
      checkboxEl.setAttribute("aria-label", cfg.label + " \u002D Blocked");
    }
  }

  // Sync internal state + visuals when checkbox changes
  checkboxEl.addEventListener("change", () => {
    if (isRequired) return;
    const newValue = checkboxEl.checked;
    currentPurposesState[purposeKey] = newValue;
    updateSwitchVisual();
    detectCustomProfile();
    saveCurrentDomainRulesSafe();
    displayProtectionScope();
    updateGpcIndicator();
    updateChIndicator();
  updateTcfIndicator();
  });

  // Initial visual state
  updateSwitchVisual();

  toggleLabelEl.appendChild(switchEl);
  toggleLabelEl.appendChild(stateLabelEl);

  headerEl.appendChild(leftEl);
  headerEl.appendChild(toggleLabelEl);

  // Description: collapsible block
  const descEl = document.createElement("div");
  descEl.className = "pc-purpose-description";
  descEl.textContent = cfg.description || "";

  // Wire title (left side) to collapse/expand description
  function updateDescriptionVisibility(collapsed) {
    if (collapsed) {
      descEl.classList.add("is-collapsed");
      chevronEl.textContent = " ▸";
      leftEl.setAttribute("aria-expanded", "false");
    } else {
      descEl.classList.remove("is-collapsed");
      chevronEl.textContent = " ▾";
      leftEl.setAttribute("aria-expanded", "true");
    }
  }

  headerEl.addEventListener("click", (e) => {
    if (e.target.closest(".pc-purpose-toggle, .pc-toggle-switch, .pc-toggle-checkbox")) return;
    const nowCollapsed = !descEl.classList.contains("is-collapsed");
    updateDescriptionVisibility(nowCollapsed);
  });
  headerEl.addEventListener("keydown", (e) => {
    if (e.target.closest(".pc-purpose-toggle, .pc-toggle-switch, .pc-toggle-checkbox")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const nowCollapsed = !descEl.classList.contains("is-collapsed");
      updateDescriptionVisibility(nowCollapsed);
    }
  });

  // Start collapsed
  updateDescriptionVisibility(true);

  // Final assembly (checkbox before header for CSS focus-visible sibling selector)
  itemEl.appendChild(checkboxEl);
  itemEl.appendChild(headerEl);
  itemEl.appendChild(descEl);

  return itemEl;
}

// Render purposes list
function renderPurposesList() {
  if (!currentDomain) return;

  const listEl = document.getElementById("pc-purposes-list");
  listEl.innerHTML = "";

  PURPOSES_TO_SHOW.forEach((purposeKey) => {
    const cfg = purposesConfig[purposeKey];
    if (!cfg) return;

    const itemEl = createPurposeItemElement(purposeKey, cfg);
    listEl.appendChild(itemEl);
  });
}

// Safe wrapper around chrome.storage.local.set
// When profile is custom, stores all purposes explicitly (no inheritance).
// For named presets, stores only overrides that differ from the profile defaults.
function saveCurrentDomainRulesSafe() {
  if (!currentDomain) return;
  if (!chrome.storage || !chrome.storage.local) return;

  let purposes;
  if (currentProfile === "custom") {
    // Custom: store all purposes explicitly
    purposes = {};
    PURPOSES_TO_SHOW.forEach((key) => {
      if (requiredPurposeKeys.has(key)) return;
      purposes[key] = currentPurposesState[key] !== false;
    });
  } else {
    // Named preset: only store overrides that differ from profile
    const profilePurposes = (presetsConfig[currentProfile] && presetsConfig[currentProfile].purposes) || {};
    purposes = {};
    PURPOSES_TO_SHOW.forEach((key) => {
      if (requiredPurposeKeys.has(key)) return;
      const profileDefault = profilePurposes[key] !== false;
      if (currentPurposesState[key] !== profileDefault) {
        purposes[key] = currentPurposesState[key];
      }
    });
  }

  // Re-read rules from storage to avoid overwriting concurrent changes (e.g. Reset all sites)
  chrome.storage.local.get(["rules"], (result) => {
    allRules = result && result.rules ? result.rules : {};
    allRules[currentDomain] = {
      profile: currentProfile,
      purposes: purposes
    };

    chrome.storage.local.set({ rules: allRules }, () => {
      if (chrome.runtime.lastError) {
        console.error("ProtoConsent: error saving rules:", chrome.runtime.lastError);
        const countEl = document.getElementById("pc-blocked-count");
        if (countEl) countEl.textContent = "Error saving, try again";
      } else {
        notifyBackgroundRulesUpdated();
      }
    });
  });
}

function notifyBackgroundRulesUpdated() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" }, () => {
    void chrome.runtime.lastError; // Suppress "no listener" warning
    // After rule rebuild, matched rule IDs are stale - prompt reload
    const countEl = document.getElementById("pc-blocked-count");
    if (countEl) {
      countEl.textContent = "Reload page to update stats";
      countEl.classList.remove("has-blocked", "clickable");
    }
    const scopeEl = document.getElementById("pc-protection-scope");
    const scopeTextEl = document.getElementById("pc-protection-scope-text");
    if (scopeEl) scopeEl.style.display = "flex";
    if (scopeTextEl) scopeTextEl.textContent = "";
    const reloadBtn = document.getElementById("pc-reload-btn");
    if (reloadBtn && currentDomain) reloadBtn.classList.add("is-recommended");
  });
}

function isSupportedWebUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

// Returns true when any purpose with triggers_gpc is blocked in the current configuration.
function expectedGpcEnabled() {
  if (!gpcGlobalEnabled) return false;
  if (!currentDomain || !Array.isArray(gpcPurposeKeys) || gpcPurposeKeys.length === 0) return false;
  return gpcPurposeKeys.some((key) => currentPurposesState[key] === false);
}

// Color/dot reflect the expected state; the tooltip provides full details.
// Now renders into the signals bar instead of a fixed HTML element.
function updateGpcIndicator(observedGpc) {
  renderSignalsBar(observedGpc);
}

function updateHeaderControls() {
  const reloadBtn = document.getElementById("pc-reload-btn");
  if (reloadBtn) {
    const enabled = !!currentDomain;
    reloadBtn.disabled = !enabled;
    if (!enabled) reloadBtn.classList.remove("is-recommended");
  }
  renderSignalsBar();
}

// Client Hints stripping indicator - now rendered in signals bar
function updateChIndicator() {
  renderSignalsBar();
}


function updateTcfIndicator() {
  renderSignalsBar();
}

// Show a message when the active tab is not an http(s) page
function showUnsupportedPage() {
  document.getElementById("pc-site-domain").textContent = "—";
  const listEl = document.getElementById("pc-purposes-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const msgEl = document.createElement("div");
  msgEl.className = "pc-unsupported-msg";
  msgEl.textContent = "ProtoConsent only works on regular web pages (http/https)";
  listEl.appendChild(msgEl);

  // Disable profile selector
  const profileBtn = document.getElementById("pc-profile-btn");
  if (profileBtn) profileBtn.disabled = true;

  // Hide stat bar and detail on unsupported pages
  const countEl = document.getElementById("pc-blocked-count");
  if (countEl) countEl.parentElement.style.display = "none";
  const scopeEl = document.getElementById("pc-protection-scope");
  if (scopeEl) scopeEl.style.display = "none";

  updateHeaderControls();
}

// Simple UI error helper
function showPopupError(message) {
  const listEl = document.getElementById("pc-purposes-list");
  if (!listEl) return;

  listEl.innerHTML = "";

  const errorEl = document.createElement("div");
  errorEl.className = "pc-popup-error";
  errorEl.textContent = message;

  const buttonEl = document.createElement("button");
  buttonEl.className = "pc-footer-link";
  buttonEl.textContent = "Try again";

  buttonEl.addEventListener("click", () => {
    initPopup();
  });

  listEl.appendChild(errorEl);
  listEl.appendChild(buttonEl);
}

// Load operating mode from storage and set default tab + indicator
async function loadOperatingMode() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["operatingMode"], (result) => {
      const mode = result.operatingMode || "standalone";
      // Update global from config.js
      if (typeof operatingMode !== "undefined") operatingMode = mode;
      // In Monitoring mode, default to Proto tab
      if (mode === "protoconsent") activeMode = "proto";
      updateModeIndicator(mode);
      resolve();
    });
  });
}

function updateModeIndicator(mode) {
  const indicator = document.getElementById("pc-mode-indicator");
  const label = document.getElementById("pc-mode-label");
  if (!indicator || !label) return;

  const isProto = mode === "protoconsent";
  indicator.hidden = false;
  indicator.classList.toggle("is-protoconsent", isProto);
  label.textContent = isProto ? "Monitoring" : "Blocking";
  indicator.title = isProto
    ? "Monitoring: adds privacy signals, banner management and consent control on top of your blocker. Click to switch to Blocking"
    : "Blocking: enforces your privacy preferences by blocking tracking requests, sending GPC signals and managing consent banners. Click to switch to Monitoring";
  indicator.style.cursor = "pointer";
  indicator.setAttribute("role", "button");
  indicator.setAttribute("tabindex", "0");

  if (!indicator._clickBound) {
    const toggleMode = () => {
      const current = (typeof operatingMode !== "undefined") ? operatingMode : "standalone";
      const newMode = current === "protoconsent" ? "standalone" : "protoconsent";
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_SET_OPERATING_MODE", mode: newMode }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && !resp.ok) return;
        if (typeof operatingMode !== "undefined") operatingMode = newMode;
        updateModeIndicator(newMode);
        // Switch to appropriate tab
        if (newMode === "protoconsent") {
          setActiveMode("proto");
          if (typeof initProtoTab === "function") initProtoTab();
        } else {
          setActiveMode("consent");
        }
      });
    };
    indicator.addEventListener("click", toggleMode);
    indicator.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMode(); }
    });
    indicator._clickBound = true;
  }
}

// Check blocker detection state and show suggest-monitoring banner in Consent tab
function checkBlockerDetectionForConsent() {
  let mode = (typeof operatingMode !== "undefined") ? operatingMode : "standalone";
  if (mode === "protoconsent") return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_BLOCKER_DETECTION" }, function (state) {
    if (chrome.runtime.lastError || !state) return;
    if (typeof renderBlockerDetectionBanner === "function") {
      renderBlockerDetectionBanner(state, mode, "consent-blocker-banner");
    }
  });
}