// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// popup.js with safe chrome.storage.local
// DEBUG_RULES loaded from config.js via <script> in popup.html

// Consent Commons icons for legal_basis values in site declaration
const LEGAL_BASIS_ICONS = {
  consent: "icons/declaration/consent.png",
  contractual: "icons/declaration/contractual.png",
  legitimate_interest: "icons/declaration/legitimate_interest.png",
  legal_obligation: "icons/declaration/legal_obligation.png",
  public_interest: "icons/declaration/public_interest.png",
  vital_interest: "icons/declaration/vital_interest.png",
};

// Display labels for legal_basis values
const LEGAL_BASIS_LABELS = {
  legitimate_interest: "legit. interest",
};


let PURPOSES_TO_SHOW = [];

let purposesConfig = {};
let presetsConfig = {};
let purposeDomainCounts = {};
let currentDomain = null;
let defaultProfile = "balanced";
let defaultPurposes = null;
let currentProfile = "balanced";
let currentPurposesState = {};
let allRules = {};

async function initPopup() {
  try {
    await loadConfigs();
    await loadDefaultProfile();
    await initDomain();
    await loadRulesFromStorageSafe();
    initProfileSelect();
    initStateForDomain();
    renderPurposesList();
    await displayBlockedCount();
    await loadSiteDeclaration();
  } catch (err) {
    console.error("ProtoConsent popup error:", err);
    showPopupError("Could not load ProtoConsent settings for this site.");
  }
}

 // Get the count of matched DNR rules for the current tab.
 // Calls chrome.declarativeNetRequest.getMatchedRules({ tabId })
 // and fetches per-domain detail from the background's onRuleMatchedDebug tracker.
 // @returns {Promise<{blocked, gpc, domainHitCount, blockedDomains}>}
async function getBlockedRulesCount() {
  try {
    if (!chrome.declarativeNetRequest || !chrome.tabs) {
      return { blocked: 0, gpc: 0, domainHitCount: {}, blockedDomains: {} };
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return { blocked: 0, gpc: 0, domainHitCount: {}, blockedDomains: {} };

    const tabId = tabs[0].id;

    const [matched, domainsResp, dynamicRules] = await Promise.all([
      chrome.declarativeNetRequest.getMatchedRules({ tabId }),
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_BLOCKED_DOMAINS", tabId }),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);

    if (!matched || !matched.rulesMatchedInfo) return { blocked: 0, gpc: 0, domainHitCount: {}, blockedDomains: {} };

    const blockedDomains = domainsResp?.data || {};

    // Cache per-purpose domain counts for displayProtectionScope
    if (domainsResp?.purposeDomainCounts) {
      purposeDomainCounts = domainsResp.purposeDomainCounts;
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

    return { blocked, gpc, domainHitCount, rulesetHitCount, blockedDomains };
  } catch (err) {
    console.error("ProtoConsent: error fetching matched rules count:", err);
    return { blocked: 0, gpc: 0, domainHitCount: {}, rulesetHitCount: {}, blockedDomains: {} };
  }
}

// Fetch and display the blocked rules count on the popup.
let lastDomainHitCount = {};
let lastPurposeStats = {};
let lastBlockedDomains = {};
let lastBlocked = 0;

async function displayBlockedCount() {
  const scopeEl = document.getElementById("pc-protection-scope");
  const gpcEl = document.getElementById("pc-gpc-count");

  try {
    const { blocked, gpc, domainHitCount, rulesetHitCount, blockedDomains } = await getBlockedRulesCount();
    lastDomainHitCount = domainHitCount;
    lastBlockedDomains = blockedDomains;
    lastBlocked = blocked;

    // domainHitCount already maps purpose -> count from static rulesets
    lastPurposeStats = Object.assign({}, domainHitCount);

    // GPC count (separate static line)
    if (gpcEl) {
      gpcEl.textContent = gpc > 0 ? gpc + " GPC signals sent" : "";
    }

    // Inject per-purpose stats into purpose items
    displayPerPurposeStats();
    displayProtectionScope();

    // Debug panel (visible only when DEBUG_RULES = true)
    if (DEBUG_RULES) {
      renderDebugPanel({ blocked, gpc, domainHitCount, rulesetHitCount, blockedDomains });
    }
  } catch (err) {
    console.error("ProtoConsent: error displaying blocked count:", err);
  }
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

    const statEl = document.createElement("div");
    statEl.className = "pc-purpose-stat";
    statEl.textContent = count + " blocked";
    statEl.addEventListener("click", toggleBlockedDetail);

    // Insert after header, before description
    const descEl = itemEl.querySelector(".pc-purpose-description");
    if (descEl) {
      itemEl.insertBefore(statEl, descEl);
    } else {
      itemEl.appendChild(statEl);
    }
  }
}

// Display "Protected from X tracker domains" based on which
// purposes are currently blocked for this site.
function displayProtectionScope() {
  const scopeEl = document.getElementById("pc-protection-scope");
  if (!scopeEl) return;

  let domainCount = 0;
  for (const purposeKey of PURPOSES_TO_SHOW) {
    if (currentPurposesState[purposeKey]) continue; // allowed, not blocking
    if (purposeDomainCounts[purposeKey]) domainCount += purposeDomainCounts[purposeKey];
  }

  if (domainCount > 0) {
    scopeEl.textContent = "Protected from " + domainCount + " tracker domains";
    scopeEl.style.display = "";
    if (scopeEl.parentElement) scopeEl.parentElement.style.display = "";
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "▸";
  } else {
    scopeEl.textContent = "";
    scopeEl.style.display = "none";
    if (scopeEl.parentElement) scopeEl.parentElement.style.display = "none";
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "";
  }
}

// Toggle detail breakdown on counter click
async function toggleBlockedDetail() {
  const detailEl = document.getElementById("pc-blocked-detail");
  const scopeEl = document.getElementById("pc-protection-scope");
  if (!detailEl) return;

  if (!detailEl.classList.contains("is-collapsed")) {
    detailEl.classList.add("is-collapsed");
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "▸";
    if (scopeEl) scopeEl.setAttribute("aria-expanded", "false");
    return;
  }

  if (Object.keys(lastDomainHitCount).length === 0 && lastBlocked === 0) {
    // Still show the detail if protection scope is visible (has domain counts)
    let hasDomainCounts = false;
    for (const purposeKey of PURPOSES_TO_SHOW) {
      if (!currentPurposesState[purposeKey] && purposeDomainCounts[purposeKey]) {
        hasDomainCounts = true;
        break;
      }
    }
    if (!hasDomainCounts) return;
  }

  // lastBlockedDomains maps purpose -> { domain -> count } from onRuleMatchedDebug
  detailEl.innerHTML = "";

  // Total blocked count
  if (lastBlocked > 0) {
    const totalEl = document.createElement("div");
    totalEl.className = "pc-detail-total";
    totalEl.appendChild(document.createTextNode(lastBlocked + " blocked "));
    const undercountEl = document.createElement("span");
    undercountEl.className = "pc-detail-info";
    const ucIcon = document.createElement("span");
    ucIcon.style.fontStyle = "normal";
    ucIcon.textContent = "\u2014 \u2139\uFE0F ";
    undercountEl.appendChild(ucIcon);
    undercountEl.appendChild(document.createTextNode("Counts may undercount"));
    totalEl.appendChild(undercountEl);
    detailEl.appendChild(totalEl);
  }

  const orderedPurposes = PURPOSES_TO_SHOW.filter(p => lastDomainHitCount[p] || lastBlockedDomains[p]);

  for (const purpose of orderedPurposes) {
    const domains = lastBlockedDomains[purpose] || {};
    const domainEntries = Object.entries(domains).sort((a, b) => b[1] - a[1]);
    const total = lastDomainHitCount[purpose] || domainEntries.reduce((sum, [, c]) => sum + c, 0);

    const row = document.createElement("div");
    row.className = "pc-detail-purpose";

    const label = document.createElement("span");
    label.className = "pc-detail-purpose-label";
    const cfg = purposesConfig[purpose];
    const purposeLabel = cfg ? cfg.label : purpose;

    if (domainEntries.length > 0) {
      const domainStr = domainEntries
        .map(([d, c]) => c > 1 ? d + " \u00d7" + c : d)
        .join(", ");
      label.textContent = purposeLabel + " (" + total + "): ";
      const domainsSpan = document.createElement("span");
      domainsSpan.className = "pc-detail-domains";
      domainsSpan.textContent = domainStr;
      row.appendChild(label);
      row.appendChild(domainsSpan);
    } else {
      label.textContent = purposeLabel + ": " + total + " blocked";
      row.appendChild(label);
    }

    detailEl.appendChild(row);
  }

  // Footnote explaining the blocked count
  const infoEl = document.createElement("div");
  infoEl.className = "pc-detail-info";
  const infoIcon = document.createElement("span");
  infoIcon.style.fontStyle = "normal";
  infoIcon.textContent = "\u2139\uFE0F ";
  infoEl.appendChild(infoIcon);
  infoEl.appendChild(document.createTextNode("Blocked trackers can\u2019t load additional scripts."));
  detailEl.appendChild(infoEl);

  detailEl.classList.remove("is-collapsed");
  const chevron = document.getElementById("pc-blocked-chevron");
  if (chevron) chevron.textContent = "▾";
  if (scopeEl) scopeEl.setAttribute("aria-expanded", "true");
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

  const scopeBtn = document.getElementById("pc-protection-scope");
  if (scopeBtn) {
    scopeBtn.addEventListener("click", toggleBlockedDetail);
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

  purposesConfig = await purposesRes.json();
  presetsConfig = await presetsRes.json();

  // Derive display order from config, sorted by the order field
  PURPOSES_TO_SHOW = Object.keys(purposesConfig)
    .sort((a, b) => (purposesConfig[a].order || 0) - (purposesConfig[b].order || 0));
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

// Init profile selector
function initProfileSelect() {
  const selectEl = document.getElementById("pc-profile-select");

  if (currentDomain && allRules[currentDomain] && allRules[currentDomain].profile) {
    currentProfile = allRules[currentDomain].profile;
  }

  // Show the custom option if the stored profile is custom
  if (currentProfile === "custom") {
    const customOption = selectEl.querySelector('option[value="custom"]');
    if (customOption) {
      customOption.disabled = false;
      customOption.hidden = false;
    }
  }

  selectEl.value = currentProfile;

  selectEl.addEventListener("change", () => {
    currentProfile = selectEl.value;
    // When switching to a named preset, hide the custom option
    if (currentProfile !== "custom") {
      const customOption = selectEl.querySelector('option[value="custom"]');
      if (customOption) {
        customOption.disabled = true;
        customOption.hidden = true;
      }
    }
    applyPresetToCurrentDomain();
    renderPurposesList();
    saveCurrentDomainRulesSafe();
    displayProtectionScope();
  });
}

// Init currentPurposesState for this domain, resolving profile inheritance
function initStateForDomain() {
  if (!currentDomain) return;

  const existing = allRules[currentDomain];

  if (existing && existing.profile) {
    currentProfile = existing.profile;
    const selectEl = document.getElementById("pc-profile-select");

    // Show the custom option if this domain uses it
    if (currentProfile === "custom") {
      const customOption = selectEl.querySelector('option[value="custom"]');
      if (customOption) {
        customOption.disabled = false;
        customOption.hidden = false;
      }
    }

    selectEl.value = currentProfile;

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
}

// Check if current toggles match the active preset; if not, switch to "custom".
// If already "custom", check if toggles match any named preset and revert.
function detectCustomProfile() {
  if (currentProfile === "custom") {
    // Try to match a named preset
    for (const [presetKey, presetDef] of Object.entries(presetsConfig)) {
      const purposes = presetDef.purposes || {};
      const matches = PURPOSES_TO_SHOW.every((key) => {
        return currentPurposesState[key] === (purposes[key] !== false);
      });
      if (matches) {
        currentProfile = presetKey;
        const selectEl = document.getElementById("pc-profile-select");
        const customOption = selectEl.querySelector('option[value="custom"]');
        if (customOption) {
          customOption.disabled = true;
          customOption.hidden = true;
        }
        selectEl.value = presetKey;
        return;
      }
    }
    return;
  }

  const profilePurposes = (presetsConfig[currentProfile] && presetsConfig[currentProfile].purposes) || {};
  const matchesPreset = PURPOSES_TO_SHOW.every((key) => {
    return currentPurposesState[key] === (profilePurposes[key] !== false);
  });

  if (!matchesPreset) {
    currentProfile = "custom";
    const selectEl = document.getElementById("pc-profile-select");
    const customOption = selectEl.querySelector('option[value="custom"]');
    if (customOption) {
      customOption.disabled = false;
      customOption.hidden = false;
    }
    selectEl.value = "custom";
  }
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
  checkboxEl.setAttribute("aria-label", cfg.label + " — " + (isAllowed ? "Allowed" : "Blocked"));

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
      checkboxEl.setAttribute("aria-label", cfg.label + " — Allowed");
    } else {
      switchEl.classList.remove("is-on");
      stateLabelEl.textContent = "Blocked";
      checkboxEl.setAttribute("aria-label", cfg.label + " — Blocked");
    }
  }

  // Sync internal state + visuals when checkbox changes
  checkboxEl.addEventListener("change", () => {
    const newValue = checkboxEl.checked;
    currentPurposesState[purposeKey] = newValue;
    updateSwitchVisual();
    detectCustomProfile();
    saveCurrentDomainRulesSafe();
    displayProtectionScope();
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
      purposes[key] = currentPurposesState[key] !== false;
    });
  } else {
    // Named preset: only store overrides that differ from profile
    const profilePurposes = (presetsConfig[currentProfile] && presetsConfig[currentProfile].purposes) || {};
    purposes = {};
    PURPOSES_TO_SHOW.forEach((key) => {
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
      } else {
        notifyBackgroundRulesUpdated();
      }
    });
  });
}

function notifyBackgroundRulesUpdated() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" }, () => {
    const err = chrome.runtime.lastError;
    // After rule rebuild, matched rule IDs are stale — prompt reload
    const scopeEl = document.getElementById("pc-protection-scope");
    if (scopeEl) {
      scopeEl.textContent = "Reload page to update stats";
      scopeEl.style.display = "";
    }
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "";
    const gpcEl = document.getElementById("pc-gpc-count");
    if (gpcEl) gpcEl.textContent = "";
    const detailEl = document.getElementById("pc-blocked-detail");
    if (detailEl) detailEl.classList.add("is-collapsed");
  });
}

// Show a message when the active tab is not an http(s) page
function showUnsupportedPage() {
  document.getElementById("pc-site-domain").textContent = "—";
  const listEl = document.getElementById("pc-purposes-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const msgEl = document.createElement("div");
  msgEl.className = "pc-unsupported-msg";
  msgEl.textContent = "ProtoConsent only works on regular web pages (http/https).";
  listEl.appendChild(msgEl);

  // Disable profile selector
  const selectEl = document.getElementById("pc-profile-select");
  if (selectEl) selectEl.disabled = true;

  // Hide stat bar and detail on unsupported pages
  const scopeEl = document.getElementById("pc-protection-scope");
  if (scopeEl) scopeEl.parentElement.style.display = "none";
  const gpcEl = document.getElementById("pc-gpc-count");
  if (gpcEl) gpcEl.style.display = "none";
  const detailEl = document.getElementById("pc-blocked-detail");
  if (detailEl) detailEl.style.display = "none";
}

// Cache TTL for .well-known declarations
const WELL_KNOWN_CACHE_TTL = 24 * 60 * 60 * 1000;
// Shorter TTL for negative results (site has no .well-known or invalid file)
const WELL_KNOWN_NEGATIVE_TTL = 6 * 60 * 60 * 1000;

// Load and display site declaration from .well-known/protoconsent.json
async function loadSiteDeclaration() {
  if (!currentDomain) return;

  const container = document.getElementById("pc-site-declaration");
  if (!container) return;

  try {
    const cacheKey = "wk_" + currentDomain;
    const cached = await new Promise(resolve =>
      chrome.storage.local.get([cacheKey], resolve)
    );
    if (cached[cacheKey]) {
      const entry = cached[cacheKey];
      const ttl = entry.data ? WELL_KNOWN_CACHE_TTL : WELL_KNOWN_NEGATIVE_TTL;
      if (Date.now() - entry.ts < ttl) {
        if (entry.data) renderSiteDeclaration(container, entry.data);
        return;
      }
    }

    // Fetch via executeScript: runs in the page context (same-origin, no extra permissions)
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: async () => {
        try {
          const res = await fetch("/.well-known/protoconsent.json");
          if (res.ok) return await res.json();
        } catch (_) {}
        return null;
      }
    });

    const data = results && results[0] && results[0].result;

    if (data && validateSiteDeclaration(data)) {
      // Cache valid declarations (24h TTL)
      chrome.storage.local.set({ [cacheKey]: { data, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
      renderSiteDeclaration(container, data);
    } else {
      // Cache negative/invalid result (6h TTL) to avoid re-fetching on every popup open
      chrome.storage.local.set({ [cacheKey]: { data: null, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
    }
  } catch (err) {
    console.error("[well-known] Error:", err);
  }
}

// Minimal validation of a .well-known/protoconsent.json file.
// See design/well-known-spec.md §4.2 for the rules.
function validateSiteDeclaration(json) {
  if (!json || typeof json !== "object") return false;
  if (!json.purposes || typeof json.purposes !== "object") return false;

  let hasValidPurpose = false;
  for (const key of Object.keys(json.purposes)) {
    if (!PURPOSES_TO_SHOW.includes(key)) continue;
    const entry = json.purposes[key];
    if (entry && typeof entry === "object" && typeof entry.used === "boolean") {
      hasValidPurpose = true;
      break;
    }
  }
  return hasValidPurpose;
}

function renderSiteDeclaration(container, declaration) {
  container.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "pc-declaration-title";
  titleEl.textContent = "Site declaration";
  container.appendChild(titleEl);

  // Render each purpose in display order
  for (const purposeKey of PURPOSES_TO_SHOW) {
    const cfg = purposesConfig[purposeKey];
    if (!cfg) continue;

    const row = document.createElement("div");
    row.className = "pc-declaration-row";

    const nameEl = document.createElement("span");
    nameEl.className = "pc-declaration-purpose";
    nameEl.textContent = cfg.short_label || cfg.label || purposeKey;

    const checkEl = document.createElement("span");
    checkEl.className = "pc-declaration-check";

    const basisEl = document.createElement("span");
    basisEl.className = "pc-declaration-basis";

    const entry = declaration.purposes[purposeKey];
    if (!entry) {
      checkEl.textContent = "—";
      checkEl.classList.add("not-declared");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Not declared");
    } else if (entry.used) {
      checkEl.textContent = "✓";
      checkEl.classList.add("used");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Used");

      if (typeof entry.legal_basis === "string") {
        const basisIcon = LEGAL_BASIS_ICONS[entry.legal_basis];
        if (basisIcon) {
          const iconImg = document.createElement("img");
          iconImg.src = basisIcon;
          iconImg.alt = "";
          iconImg.className = "pc-declaration-icon";
          iconImg.width = 14;
          iconImg.height = 14;
          iconImg.onerror = () => iconImg.remove();
          basisEl.appendChild(iconImg);
        }
        basisEl.appendChild(document.createTextNode(
          LEGAL_BASIS_LABELS[entry.legal_basis] || entry.legal_basis.replace(/_/g, " ")
        ));
      }
    } else {
      checkEl.textContent = "✗";
      checkEl.classList.add("not-used");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Not used");
    }

    row.appendChild(nameEl);
    row.appendChild(checkEl);
    row.appendChild(basisEl);
    container.appendChild(row);
  }

  // Collect providers and sharing info across purposes
  const providers = new Set();
  const sharingValues = new Set();
  for (const purposeKey of PURPOSES_TO_SHOW) {
    const entry = declaration.purposes[purposeKey];
    if (entry && entry.used) {
      if (typeof entry.provider === "string") providers.add(entry.provider);
      if (typeof entry.sharing === "string") sharingValues.add(entry.sharing.replace(/_/g, " "));
    }
  }

  // Data handling section (if present and valid)
  if (declaration.data_handling && typeof declaration.data_handling === "object") {
    const dh = declaration.data_handling;

    if (typeof dh.storage_region === "string") {
      const regionEl = document.createElement("div");
      regionEl.className = "pc-declaration-data";
      regionEl.textContent = "Stored: " + dh.storage_region.toUpperCase();
      container.appendChild(regionEl);
    }

    if (dh.international_transfers === true || dh.international_transfers === false) {
      const intlEl = document.createElement("div");
      intlEl.className = "pc-declaration-data";

      const intlIcon = document.createElement("img");
      intlIcon.src = dh.international_transfers
        ? "icons/declaration/intl_transfers_yes.png"
        : "icons/declaration/intl_transfers_no.png";
      intlIcon.alt = "";
      intlIcon.className = "pc-declaration-icon";
      intlIcon.width = 14;
      intlIcon.height = 14;
      intlIcon.onerror = () => intlIcon.remove();
      intlEl.appendChild(intlIcon);

      const intlText = dh.international_transfers ? " International transfers" : " No international transfers";
      intlEl.appendChild(document.createTextNode(intlText));
      container.appendChild(intlEl);
    }
  }

  if (providers.size > 0) {
    const provEl = document.createElement("div");
    provEl.className = "pc-declaration-data";
    provEl.textContent = "Provider: " + [...providers].join(", ");
    container.appendChild(provEl);
  }

  if (sharingValues.size > 0) {
    const shareEl = document.createElement("div");
    shareEl.className = "pc-declaration-data";

    const shareIcon = document.createElement("img");
    shareIcon.src = "icons/declaration/sharing.png";
    shareIcon.alt = "";
    shareIcon.className = "pc-declaration-icon";
    shareIcon.width = 14;
    shareIcon.height = 14;
    shareIcon.onerror = () => shareIcon.remove();
    shareEl.appendChild(shareIcon);

    const shareText = document.createTextNode(" Sharing: " + [...sharingValues].join(", "));
    shareEl.appendChild(shareText);
    container.appendChild(shareEl);
  }

  // Rights URL (only https:// or http:// to prevent javascript: / data: XSS)
  if (typeof declaration.rights_url === "string" &&
      /^https?:\/\//i.test(declaration.rights_url)) {
    const rightsEl = document.createElement("div");
    rightsEl.className = "pc-declaration-data";
    const rightsLink = document.createElement("a");
    rightsLink.href = declaration.rights_url;
    rightsLink.textContent = "Your rights";
    rightsLink.target = "_blank";
    rightsLink.rel = "noopener noreferrer";
    rightsLink.className = "pc-declaration-link";
    rightsEl.appendChild(rightsLink);
    container.appendChild(rightsEl);
  }

  // Show the side tab and wire toggle (guard against duplicate listeners)
  const sideTab = document.getElementById("pc-side-tab");
  const sidePanel = document.getElementById("pc-side-panel");
  if (sideTab && sidePanel && !sideTab.dataset.bound) {
    sideTab.dataset.bound = "1";
    sideTab.classList.add("is-visible");
    sideTab.addEventListener("click", () => {
      const isOpen = sidePanel.classList.toggle("is-open");
      sideTab.classList.toggle("is-open", isOpen);
      sideTab.setAttribute("aria-expanded", isOpen ? "true" : "false");
      sidePanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    });
  }
}

// Render debug info into the collapsible debug panel (only when DEBUG_RULES = true).
function renderDebugPanel({ blocked, gpc, domainHitCount, rulesetHitCount, blockedDomains }) {
  const panel = document.getElementById("pc-debug-panel");
  const content = document.getElementById("pc-debug-content");
  if (!panel || !content) return;

  panel.hidden = false;

  // Fetch background rebuild snapshot
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_DEBUG" }, (bg) => {
    const lines = [];

    // Global profile & purposes
    if (bg && bg.globalProfile) {
      lines.push("— global profile: " + bg.globalProfile + " —");
      if (bg.globalPurposes) {
        const purposeStr = Object.entries(bg.globalPurposes)
          .map(([k, v]) => k + ":" + (v ? "✓" : "✗")).join("  ");
        lines.push("  " + purposeStr);
      }
      lines.push("");
    }

    // Site profile (from popup state)
    lines.push("— site: " + (currentDomain || "?") + " (profile: " + currentProfile + ") —");
    if (currentPurposesState) {
      const siteStr = Object.entries(currentPurposesState)
        .map(([k, v]) => k + ":" + (v ? "✓" : "✗")).join("  ");
      lines.push("  " + siteStr);
    }
    lines.push("");

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
        bg.gpcGlobal + " GPC-g, " + bg.gpcPerSite + " GPC-s)");
      if (bg.error) lines.push("  ⚠ ERROR: " + bg.error);
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

    // Tab match info
    lines.push("— tab matches —");
    lines.push("  blocked: " + blocked + "  gpc: " + gpc);
    lines.push("");

    // Ruleset breakdown (domain vs path)
    if (Object.keys(rulesetHitCount).length) {
      lines.push("— ruleset hits —");
      for (const [id, count] of Object.entries(rulesetHitCount).sort()) {
        const tag = id.endsWith("_paths") ? " (path)" : id === "_dynamic_block" ? " (dynamic)" : " (domain)";
        lines.push("  " + id + ": " + count + tag);
      }
      lines.push("");
    }

    // Purpose breakdown
    if (Object.keys(domainHitCount).length) {
      lines.push("— purpose hits —");
      for (const [purpose, count] of Object.entries(domainHitCount).sort()) {
        lines.push("  " + purpose + ": " + count);
      }
      lines.push("");
    }

    // Blocked domains detail
    if (Object.keys(blockedDomains).length) {
      lines.push("— blocked domains —");
      for (const [purpose, domains] of Object.entries(blockedDomains).sort()) {
        for (const [domain, count] of Object.entries(domains).sort()) {
          lines.push("  [" + purpose + "] " + domain + " ×" + count);
        }
      }
    }

    content.textContent = lines.join("\n");
  });

  // Copy button
  const copyBtn = document.getElementById("pc-debug-copy");
  if (copyBtn && !copyBtn._bound) {
    copyBtn._bound = true;
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = content.textContent;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
    });
  }
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
