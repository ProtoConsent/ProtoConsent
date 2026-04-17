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

  // Reset "Show/Hide details" button when switching tabs
  const toggleDescBtn = document.getElementById("pc-toggle-descriptions");
  if (toggleDescBtn) {
    toggleDescBtn.textContent = "Show details";
    toggleDescBtn.setAttribute("aria-expanded", "false");
  }
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
        // Enhanced tab: toggle collapsible bars (counter + signals) + overview grid + list cards
        _toggleBars();
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

      if (activeMode === "proto") {
        // Proto tab: toggle its own collapsible bars + purpose accordions
        document.querySelectorAll("#pc-view-proto .pc-bar").forEach(bar => {
          var toggle = bar.querySelector(".pc-bar-toggle");
          if (toggle) toggle.click();
        });
        var cards = document.querySelectorAll("#proto-purposes .proto-card");
        var collapsed = 0;
        cards.forEach(c => { if (!c.classList.contains("is-expanded")) collapsed++; });
        var expand = collapsed > cards.length / 2;
        cards.forEach(c => {
          c.classList.toggle("is-expanded", expand);
          var h = c.querySelector(".proto-card-header");
          if (h) h.setAttribute("aria-expanded", expand ? "true" : "false");
          var ch = c.querySelector(".proto-card-chevron");
          if (ch) ch.textContent = expand ? " \u25BE" : " \u25B8";
        });
        toggleDescBtn.textContent = expand ? "Hide details" : "Show details";
        toggleDescBtn.setAttribute("aria-expanded", expand ? "true" : "false");
        return;
      }

      // Consent tab: toggle shared bars + purpose descriptions
      _toggleBars();
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