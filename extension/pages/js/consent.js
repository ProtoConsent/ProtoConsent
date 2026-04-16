// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Consent tab: config loading, profile/preset management, purpose list rendering,
// per-domain state, save/notify.
// Loaded after popup.js - reads/writes globals: purposesConfig, presetsConfig,
// enhancedCatalogConfig, PURPOSES_TO_SHOW, gpcPurposeKeys, requiredPurposeKeys,
// currentProfile, currentPurposesState, currentDomain, allRules, defaultProfile,
// defaultPurposes, gpcGlobalEnabled, chStrippingEnabled.
// Calls: displayProtectionScope, updateGpcIndicator, updateChIndicator,
// updateTcfIndicator, navigateToLog, renderSignalsBar.

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

// --- Profile selector ---

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

// --- Purpose state management ---

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

// --- Purpose list rendering ---

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
  chevronEl.textContent = " \u25BE";
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
      chevronEl.textContent = " \u25B8";
      leftEl.setAttribute("aria-expanded", "false");
    } else {
      descEl.classList.remove("is-collapsed");
      chevronEl.textContent = " \u25BE";
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

// --- Save and notify ---

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
