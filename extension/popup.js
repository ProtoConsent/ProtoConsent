// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
// For more details see <https://www.gnu.org/licenses/>.

// popup.js with safe chrome.storage.local

// For debugging: set to true to log rule saves and messages
const DEBUG_RULES = false;

const PURPOSES_TO_SHOW = [
  "functional",
  "analytics",
  "ads",
  "personalization",
  "third_parties",
  "advanced_tracking"
];

let purposesConfig = {};
let presetsConfig = {};
let currentDomain = null;
let currentProfile = "balanced";
let currentPurposesState = {};
let allRules = {};

async function initPopup() {
  try {
    await loadConfigs();
    await initDomain();
    await loadRulesFromStorageSafe();
    initProfileSelect();
    initStateForDomain();
    renderPurposesList();
  } catch (err) {
    console.error("ProtoConsent popup error:", err);
    showPopupError("Could not load ProtoConsent settings for this site.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initPopup();

  const purposesLink = document.getElementById("pc-purposes-link");
  if (purposesLink) {
    purposesLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("purposes-editor.html") });
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

  purposesConfig = await purposesRes.json();
  presetsConfig = await presetsRes.json();
}

// Get current tab domain
async function initDomain() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0] || !tabs[0].url) {
    document.getElementById("pc-site-domain").textContent = "unknown";
    return;
  }

  try {
    const url = new URL(tabs[0].url);
    const hostname = url.hostname.replace(/^www\./, "");
    currentDomain = hostname;
    document.getElementById("pc-site-domain").textContent = hostname;
  } catch (e) {
    document.getElementById("pc-site-domain").textContent = "unknown";
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

// Init profile selector
function initProfileSelect() {
  const selectEl = document.getElementById("pc-profile-select");

  if (currentDomain && allRules[currentDomain] && allRules[currentDomain].profile) {
    currentProfile = allRules[currentDomain].profile;
  }

  selectEl.value = currentProfile;

  selectEl.addEventListener("change", () => {
    currentProfile = selectEl.value;
    applyPresetToCurrentDomain();
    renderPurposesList();
    saveCurrentDomainRulesSafe();
  });
}

// Init currentPurposesState for this domain
function initStateForDomain() {
  if (!currentDomain) return;

  const existing = allRules[currentDomain];

  if (existing && existing.purposes) {
    currentPurposesState = { ...existing.purposes };
    if (existing.profile) {
      currentProfile = existing.profile;
      const selectEl = document.getElementById("pc-profile-select");
      selectEl.value = currentProfile;
    }
  } else {
    applyPresetToCurrentDomain();
  }
}

// Apply preset values for currentProfile into currentPurposesState
function applyPresetToCurrentDomain() {
  const profile = presetsConfig[currentProfile];
  const profilePurposes = (profile && profile.purposes) || {};

  PURPOSES_TO_SHOW.forEach((purposeKey) => {
    const presetValue = profilePurposes[purposeKey];
    currentPurposesState[purposeKey] = presetValue !== false;
  });
}

// Create a single purpose item element (data + DOM)
function createPurposeItemElement(purposeKey, cfg) {
  const isAllowed = currentPurposesState[purposeKey] !== false;

  const itemEl = document.createElement("div");
  itemEl.className = "pc-purpose-item";
  itemEl.dataset.purpose = purposeKey;

  const checkboxId = `pc-toggle-${purposeKey}`;

  // Checkbox that owns the state for this purpose
  const checkboxEl = document.createElement("input");
  checkboxEl.type = "checkbox";
  checkboxEl.id = checkboxId;
  checkboxEl.className = "pc-toggle-checkbox";
  checkboxEl.checked = isAllowed;

  // Header container (visual row)
  const headerEl = document.createElement("div");
  headerEl.className = "pc-purpose-header";

  // Left side: (icon + name),
  // Clicking it will collapse/expand the description.
  const leftEl = document.createElement("div");
  leftEl.className = "pc-purpose-left";

  const iconEl = document.createElement("div");
  iconEl.className = "pc-purpose-icon";
  iconEl.textContent = cfg.short || (cfg.label?.charAt(0) || "?");

  const nameEl = document.createElement("div");
  nameEl.className = "pc-purpose-name";
  nameEl.textContent = cfg.label || purposeKey;

  leftEl.appendChild(iconEl);
  leftEl.appendChild(nameEl);

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
    if (checkboxEl.checked) {
      switchEl.classList.add("is-on");
      stateLabelEl.textContent = "Allowed";
    } else {
      switchEl.classList.remove("is-on");
      stateLabelEl.textContent = "Blocked";
    }
  }

  // Sync internal state + visuals when checkbox changes
  checkboxEl.addEventListener("change", () => {
    const newValue = checkboxEl.checked;
    currentPurposesState[purposeKey] = newValue;
    updateSwitchVisual();
    saveCurrentDomainRulesSafe();
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
  let isCollapsed = false;
  function updateDescriptionVisibility() {
    if (isCollapsed) {
      descEl.classList.add("is-collapsed");
    } else {
      descEl.classList.remove("is-collapsed");
    }
  }

  leftEl.addEventListener("click", () => {
    isCollapsed = !isCollapsed;
    updateDescriptionVisibility();
  });

  // Start expanded
  updateDescriptionVisibility();

  // Final assembly
  itemEl.appendChild(checkboxEl);
  itemEl.appendChild(headerEl);
  itemEl.appendChild(descEl);

  return itemEl;
}

// Render purposes list
function renderPurposesList() {
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
function saveCurrentDomainRulesSafe() {
  if (!currentDomain) return;
  if (!chrome.storage || !chrome.storage.local) return;

  allRules[currentDomain] = {
    profile: currentProfile,
    purposes: { ...currentPurposesState }
  };

  chrome.storage.local.set({ rules: allRules }, () => {
    if (chrome.runtime.lastError) {
      console.error("ProtoConsent: error saving rules:", chrome.runtime.lastError);
    } else {
      if (DEBUG_RULES) {
        console.debug("ProtoConsent: saved rules for", currentDomain, {
          profile: currentProfile,
          purposes: currentPurposesState
        });
      }
      notifyBackgroundRulesUpdated();
    }
  });
}

function notifyBackgroundRulesUpdated() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" }, () => {
    // ignore runtime errors (e.g. background sleeping), but log them for debugging
    const err = chrome.runtime.lastError;
    if (err && DEBUG_RULES) {
      console.debug("ProtoConsent: background may be sleeping:", err.message);
    }
  });
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
  buttonEl.className = "pc-popup-error-button";
  buttonEl.textContent = "Try again";

  buttonEl.addEventListener("click", () => {
    initPopup();
  });

  listEl.appendChild(errorEl);
  listEl.appendChild(buttonEl);
}

