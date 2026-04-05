// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// popup.js with safe chrome.storage.local
// DEBUG_RULES loaded from config.js via <script> in popup.html
// .well-known logic in well-known.js, debug panel in debug.js

// Estimated time saved per blocked request (ms) — conservative approximation
// Accounts for DNS + connection + download of typical third-party tracking scripts
const ESTIMATED_MS_PER_BLOCKED_REQUEST = 50;

let PURPOSES_TO_SHOW = [];
let gpcPurposeKeys = [];

let purposesConfig = {};
let presetsConfig = {};
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
let lastGpcDomains = [];
let lastGpcDomainCounts = {};
let requiredPurposeKeys = new Set();
let activeMode = "consent";

function getActivePurposes() {
  return PURPOSES_TO_SHOW.filter(p => lastPurposeStats[p] || lastBlockedDomains[p]);
}

async function initPopup() {
  try {
    await loadDebugFlag();
    initModeRail();
    await loadConfigs();
    await loadDefaultProfile();
    initProfileSelect();
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
  renderPurposesList();
  await displayBlockedCount();
  await loadSiteDeclaration();
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

  // Hide Enhanced tab until is implemented
  const enhancedTab = modeRail?.querySelector('[data-mode="enhanced"]');
  if (enhancedTab) enhancedTab.hidden = true;

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode || "consent";
      setActiveMode(mode);
      if (mode === "log" && typeof initLogTab === "function") initLogTab();
    });
  });
  setActiveMode(activeMode);
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
  const EMPTY_BLOCKED_RESULT = { blocked: 0, gpc: 0, gpcDomains: [], domainHitCount: {}, rulesetHitCount: {}, blockedDomains: {} };
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

    if (!matched || !matched.rulesMatchedInfo) return EMPTY_BLOCKED_RESULT;

    const blockedDomains = domainsResp?.data || {};
    const gpcDomains = domainsResp?.gpcDomains || [];
    const gpcDomainCounts = domainsResp?.gpcDomainCounts || {};

    // Cache per-purpose domain and path counts for displayProtectionScope
    if (domainsResp?.purposeDomainCounts) {
      purposeDomainCounts = domainsResp.purposeDomainCounts;
    }
    if (domainsResp?.purposePathCounts) {
      purposePathCounts = domainsResp.purposePathCounts;
    }

    // Classify dynamic rules from Chrome's persistent store (reliable after SW restart)
    const dynamicBlockIds = new Set();
    const dynamicGpcIds = new Set();
    for (const rule of dynamicRules) {
      if (rule.action.type === "block") {
        dynamicBlockIds.add(rule.id);
      } else if (rule.action.type === "modifyHeaders") {
        const isGpcSet = rule.action.requestHeaders?.some(
          h => h.header === "Sec-GPC" && h.operation === "set"
        );
        if (isGpcSet) dynamicGpcIds.add(rule.id);
      }
    }

    let blocked = 0;
    let gpc = 0;
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
    }

    return { blocked, gpc, gpcDomains, gpcDomainCounts, domainHitCount, rulesetHitCount, blockedDomains };
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

async function displayBlockedCount() {
  const countEl = document.getElementById("pc-blocked-count");
  const statRowEl = document.querySelector(".pc-header-stat");

  try {
    const { blocked, gpc, gpcDomains, gpcDomainCounts, domainHitCount, rulesetHitCount, blockedDomains } = await getBlockedRulesCount();
    lastBlockedDomains = blockedDomains;
    lastBlocked = blocked;
    lastGpcSignalsSent = gpc;
    lastGpcDomains = gpcDomains;
    lastGpcDomainCounts = gpcDomainCounts;

    // domainHitCount maps purpose -> count from static rulesets only.
    // Supplement with blockedDomains (from onRuleMatchedDebug) to cover dynamic rule matches.
    lastPurposeStats = Object.assign({}, domainHitCount);

    // Supplement with purpose counts from blockedDomains (covers dynamic rule matches)
    if (blockedDomains) {
      for (const [purpose, domains] of Object.entries(blockedDomains)) {
        if (!lastPurposeStats[purpose]) {
          const total = Object.values(domains).reduce((sum, c) => sum + c, 0);
          if (total > 0) lastPurposeStats[purpose] = total;
        }
      }
    }

    // Unified counter line: "X blocked · ~Ys faster · Z GPC to domains"
    if (countEl) {
      const parts = [];
      if (blocked > 0) {
        parts.push(blocked + " blocked");
        const estimatedMs = blocked * ESTIMATED_MS_PER_BLOCKED_REQUEST;
        if (estimatedMs >= 100) {
          parts.push("~" + formatEstimatedTime(estimatedMs) + " faster");
        }
      }
      if (gpc > 0) {
        const domainCount = gpcDomains.length;
        if (domainCount > 0) {
          parts.push("GPC to " + pluralize(domainCount, "domain"));
        } else {
          parts.push("GPC to " + pluralize(gpc, "request"));
        }
      }

      countEl.textContent = parts.length > 0
        ? parts.join(" · ")
        : "Nothing blocked";

      if (blocked > 0) {
        countEl.classList.add("has-blocked", "clickable");
        countEl.title = "Click to see blocked domains in Log tab";
        if (statRowEl) statRowEl.classList.add("clickable");
      } else {
        countEl.classList.remove("has-blocked", "clickable");
        countEl.title = "";
        if (statRowEl) statRowEl.classList.remove("clickable");
      }
    }

    // Inject per-purpose stats into purpose items
    displayPerPurposeStats();
    displayProtectionScope();
    updateGpcIndicator(gpc);

    // Debug panel (visible only when debug flag is set in storage)
    if (DEBUG_RULES) {
      renderDebugPanel({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains });
    }

    // Refresh Log tab panels if currently active
    if (activeMode === "log" && typeof refreshLogView === "function") {
      refreshLogView();
    }

    // Auto-retry: if Chrome has counted blocked/GPC matches but our listener
    // hasn't captured domain names yet (the service worker may have been idle
    // when the first requests arrived), re-fetch after a short delay so the
    // user sees domains without needing to reopen the popup.
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
    if (countEl) countEl.textContent = "? requests blocked";
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

    // Remove existing stat if re-rendering
    const existing = itemEl.querySelector(".pc-purpose-stat");
    if (existing) existing.remove();

    const count = lastPurposeStats[purposeKey];
    if (!count) continue;

    const ms = count * ESTIMATED_MS_PER_BLOCKED_REQUEST;
    const statEl = document.createElement("div");
    statEl.className = "pc-purpose-stat clickable";
    statEl.textContent = count + " blocked \u002D ~" + formatEstimatedTime(ms);
    statEl.title = "View blocked domains in Log tab";
    statEl.setAttribute("role", "button");
    statEl.setAttribute("tabindex", "0");
    statEl.setAttribute("aria-label", "Show blocked trackers for " + getPurposeLabel(purposeKey));
    statEl.addEventListener("click", navigateToLog);
    statEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigateToLog();
      }
    });

    // Insert after header, before description
    const descEl = itemEl.querySelector(".pc-purpose-description");
    if (descEl) {
      itemEl.insertBefore(statEl, descEl);
    } else {
      itemEl.appendChild(statEl);
    }
  }
}

// Display "Protected from X trackers" below the counter bar
function displayProtectionScope() {
  const scopeEl = document.getElementById("pc-protection-scope");
  const scopeTextEl = document.getElementById("pc-protection-scope-text");
  if (!scopeEl || !scopeTextEl) return;

  const hasBlockedPurposes = PURPOSES_TO_SHOW.some((purposeKey) => currentPurposesState[purposeKey] === false);

  let domainCount = 0;
  let pathCount = 0;
  for (const purposeKey of PURPOSES_TO_SHOW) {
    if (currentPurposesState[purposeKey]) continue; // allowed, not blocking
    if (purposeDomainCounts[purposeKey]) domainCount += purposeDomainCounts[purposeKey];
    if (purposePathCounts[purposeKey]) pathCount += purposePathCounts[purposeKey];
  }

  const total = domainCount + pathCount;
  if (total > 0) {
    scopeTextEl.textContent = "Protected: " + total + " tracking rules";
    scopeTextEl.title = "";
    scopeEl.style.display = "flex";
  } else {
    if (hasBlockedPurposes) {
      scopeTextEl.textContent = "Protection enabled";
      scopeTextEl.title = "";
    } else {
      scopeTextEl.textContent = "No site-level protections";
      scopeTextEl.title = lastBlocked > 0
        ? "This site allows all purposes; blocked requests may still come from embedded third-party contexts."
        : "This site currently allows all purposes.";
    }
    scopeEl.style.display = "flex";
  }
}

// Navigate to the Log tab (replaces the old expandable detail)
function navigateToLog(innerTab) {
  const tab = (typeof innerTab === "string") ? innerTab : "domains";
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
  if (toggleDescBtn) {
    toggleDescBtn.addEventListener("click", () => {
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

  const [purposesRes, presetsRes] = await Promise.all([
    fetch(purposesUrl),
    fetch(presetsUrl)
  ]);

  if (!purposesRes.ok) throw new Error("Failed to load purposes.json: HTTP " + purposesRes.status);
  if (!presetsRes.ok) throw new Error("Failed to load presets.json: HTTP " + presetsRes.status);

  purposesConfig = await purposesRes.json();
  presetsConfig = await presetsRes.json();

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
    chrome.storage.local.get(["defaultProfile", "defaultPurposes"], (result) => {
      defaultProfile = result.defaultProfile || "balanced";
      defaultPurposes = result.defaultPurposes || null;
      currentProfile = defaultProfile;
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
  const customOption = document.querySelector('#pc-profile-select option[value="custom"]');
  if (customOption) {
    customOption.disabled = !visible;
    customOption.hidden = !visible;
  }
}

// Init profile selector (event handler only; values set by initStateForDomain)
function initProfileSelect() {
  const selectEl = document.getElementById("pc-profile-select");

  selectEl.addEventListener("change", () => {
    currentProfile = selectEl.value;
    // When switching to a named preset, hide the custom option
    if (currentProfile !== "custom") {
      setCustomOptionVisible(false);
    }
    applyPresetToCurrentDomain();
    renderPurposesList();
    saveCurrentDomainRulesSafe();
    displayProtectionScope();
    updateGpcIndicator();
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

  // Sync select element with current profile
  const selectEl = document.getElementById("pc-profile-select");
  selectEl.value = currentProfile;

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
        const selectEl = document.getElementById("pc-profile-select");
        setCustomOptionVisible(false);
        selectEl.value = presetKey;
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
    const selectEl = document.getElementById("pc-profile-select");
    setCustomOptionVisible(true);
    selectEl.value = "custom";
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
  nameEl.appendChild(chevronEl);

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

  leftEl.addEventListener("click", () => {
    const nowCollapsed = !descEl.classList.contains("is-collapsed");
    updateDescriptionVisibility(nowCollapsed);
  });
  leftEl.addEventListener("keydown", (e) => {
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
    // After rule rebuild, matched rule IDs are stale — prompt reload
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
  if (!currentDomain || !Array.isArray(gpcPurposeKeys) || gpcPurposeKeys.length === 0) return false;
  return gpcPurposeKeys.some((key) => currentPurposesState[key] === false);
}

// Color/label reflect the expected state; the observed count is exposed only in the tooltip.
function updateGpcIndicator(observedGpc = lastGpcSignalsSent) {
  const indicatorEl = document.getElementById("pc-gpc-indicator");
  const labelEl = document.getElementById("pc-gpc-label");
  if (!indicatorEl || !labelEl) return;

  if (!currentDomain) {
    indicatorEl.classList.remove("is-active", "is-inactive");
    indicatorEl.classList.add("is-disabled");
    labelEl.textContent = "GPC n/a";
    indicatorEl.title = "GPC unavailable on this page";
    return;
  }

  const expectedOn = expectedGpcEnabled();
  indicatorEl.classList.remove("is-disabled");
  indicatorEl.classList.toggle("is-active", expectedOn);
  indicatorEl.classList.toggle("is-inactive", !expectedOn);
  labelEl.textContent = expectedOn ? "GPC on" : "GPC off";
  const expectedText = expectedOn ? "Expected: GPC on" : "Expected: GPC off";
  const domains = lastGpcDomains;
  let observedText;
  if (observedGpc > 0 && domains.length > 0) {
    observedText = "Observed: GPC sent to " + pluralize(domains.length, "domain")
      + " (" + pluralize(observedGpc, "request") + ")";
  } else if (observedGpc > 0) {
    observedText = "Observed: " + pluralize(observedGpc, "GPC signal") + " sent";
  } else {
    observedText = "Observed: no GPC signals sent yet on this tab";
  }
  indicatorEl.title = expectedText + "\n" + observedText;
  indicatorEl.style.cursor = "pointer";
  if (!indicatorEl._logClickBound) {
    indicatorEl.setAttribute("role", "button");
    indicatorEl.setAttribute("tabindex", "0");
    indicatorEl.addEventListener("click", () => navigateToLog("gpc"));
    indicatorEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigateToLog("gpc");
      }
    });
    indicatorEl._logClickBound = true;
  }
}

function updateHeaderControls() {
  const reloadBtn = document.getElementById("pc-reload-btn");
  if (reloadBtn) {
    const enabled = !!currentDomain;
    reloadBtn.disabled = !enabled;
    if (!enabled) reloadBtn.classList.remove("is-recommended");
  }
  updateGpcIndicator();
}

function waitForTabReload(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!chrome.tabs || !chrome.tabs.onUpdated) {
      resolve(false);
      return;
    }

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

async function reloadActiveTab() {
  const reloadBtn = document.getElementById("pc-reload-btn");
  const countEl = document.getElementById("pc-blocked-count");
  if (!reloadBtn || !chrome.tabs) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || !isSupportedWebUrl(tab.url)) return;

    reloadBtn.disabled = true;
    reloadBtn.classList.remove("is-recommended");
    if (countEl) countEl.textContent = "Reloading page...";

    chrome.tabs.reload(tab.id, {}, async () => {
      // Popup may have closed; guard all DOM access
      if (chrome.runtime.lastError) {
        console.error("ProtoConsent: reload request failed:", chrome.runtime.lastError);
        if (reloadBtn) reloadBtn.disabled = false;
        await displayBlockedCount();
        return;
      }

      const reloaded = await waitForTabReload(tab.id);
      // Re-query elements in case popup closed
      const reloadBtnEl = document.getElementById("pc-reload-btn");
      const countElEl = document.getElementById("pc-blocked-count");

      if (reloadBtnEl) reloadBtnEl.disabled = false;

      if (reloaded) {
        await refreshPopupState();
      } else {
        if (countElEl) countElEl.textContent = "Reload page to update stats";
      }
    });
  } catch (err) {
    console.error("ProtoConsent: reload failed:", err);
    reloadBtn.disabled = false;
    await displayBlockedCount();
  }
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
  const selectEl = document.getElementById("pc-profile-select");
  if (selectEl) selectEl.disabled = true;

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
