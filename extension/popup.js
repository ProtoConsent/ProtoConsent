// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// popup.js with safe chrome.storage.local

// For debugging: set to true to log rule saves and messages
const DEBUG_RULES = false;

// Consent Commons icons for legal_basis values in site declaration
const LEGAL_BASIS_ICONS = {
  consent: "icons/declaration/consent.png",
  contractual: "icons/declaration/contractual.png",
  legitimate_interest: "icons/declaration/legitimate_interest.png",
  public_interest: "icons/declaration/public_interest.png",
  vital_interest: "icons/declaration/vital_interest.png",
};

// Display labels for legal_basis values
const LEGAL_BASIS_LABELS = {
  legitimate_interest: "legit. interest",
};

let PURPOSES_TO_SHOW = [];
let blocklistsConfig = null;

let purposesConfig = {};
let presetsConfig = {};
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

/**
 * Get the count of matched DNR rules for the current tab.
 * Calls chrome.declarativeNetRequest.getMatchedRules({ tabId })
 * @returns {Promise<{blocked, gpc, domainHitCount}>}
 */
async function getBlockedRulesCount() {
  try {
    if (!chrome.declarativeNetRequest || !chrome.tabs) {
      return { blocked: 0, gpc: 0, domainHitCount: {} };
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return { blocked: 0, gpc: 0, domainHitCount: {} };

    const tabId = tabs[0].id;

    const [matched, dynamicRules] = await Promise.all([
      chrome.declarativeNetRequest.getMatchedRules({ tabId }),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);

    if (!matched || !matched.rulesMatchedInfo) return { blocked: 0, gpc: 0, domainHitCount: {} };

    // Classify rule IDs by action type and map block IDs to domains
    const blockRuleIds = new Set();
    const headerRuleIds = new Set();
    const ruleIdToDomain = {};
    for (const rule of dynamicRules) {
      if (rule.action.type === "block") {
        blockRuleIds.add(rule.id);
        // Extract domain from urlFilter "||domain"
        const filter = rule.condition && rule.condition.urlFilter;
        if (filter && filter.startsWith("||")) {
          ruleIdToDomain[rule.id] = filter.slice(2);
        }
      } else if (rule.action.type === "modifyHeaders") {
        headerRuleIds.add(rule.id);
      }
    }

    let blocked = 0;
    let gpc = 0;
    const domainHitCount = {};
    for (const info of matched.rulesMatchedInfo) {
      if (blockRuleIds.has(info.rule.ruleId)) {
        blocked++;
        const domain = ruleIdToDomain[info.rule.ruleId];
        if (domain) domainHitCount[domain] = (domainHitCount[domain] || 0) + 1;
      } else if (headerRuleIds.has(info.rule.ruleId)) {
        gpc++;
      }
    }

    if (DEBUG_RULES) {
      console.debug(`ProtoConsent: ${blocked} blocked, ${gpc} GPC for tab ${tabId}`);
      console.debug("ProtoConsent: all matched rules:", matched.rulesMatchedInfo);
      console.debug("ProtoConsent: dynamic block rule IDs:", [...blockRuleIds]);
      console.debug("ProtoConsent: dynamic header rule IDs:", [...headerRuleIds]);
      // Show debug panel in popup
      const dbg = document.createElement("pre");
      dbg.style.cssText = "font-size:9px;max-height:150px;overflow:auto;background:#f0f0f0;padding:4px;margin:4px;";
      dbg.textContent = "Block IDs: " + [...blockRuleIds].join(",") +
        "\nHeader IDs: " + [...headerRuleIds].join(",") +
        "\nMatches:\n" + matched.rulesMatchedInfo.map(m =>
          "  rule " + m.rule.ruleId + " @ " + new Date(m.timeStamp).toISOString()
        ).join("\n");
      document.getElementById("popup-root").appendChild(dbg);
    }

    return { blocked, gpc, domainHitCount };
  } catch (err) {
    console.error("ProtoConsent: error fetching matched rules count:", err);
    return { blocked: 0, gpc: 0, domainHitCount: {} };
  }
}

/**
 * Fetch and display the blocked rules count on the popup.
 */
let lastDomainHitCount = {};

async function displayBlockedCount() {
  const countEl = document.getElementById("pc-blocked-count");
  if (!countEl) return;

  try {
    const { blocked, gpc, domainHitCount } = await getBlockedRulesCount();
    lastDomainHitCount = domainHitCount;

    const parts = [];
    if (blocked > 0) parts.push(blocked + " blocked");
    if (gpc > 0) parts.push(gpc + " GPC signals sent");

    countEl.textContent = parts.length > 0
      ? parts.join(" · ")
      : "Nothing blocked";

    if (blocked > 0) {
      countEl.classList.add("has-blocked", "clickable");
      const chevron = document.getElementById("pc-blocked-chevron");
      if (chevron) chevron.textContent = "▸";
    } else {
      countEl.classList.remove("has-blocked", "clickable");
    }
  } catch (err) {
    console.error("ProtoConsent: error displaying blocked count:", err);
    countEl.textContent = "? requests blocked";
  }
}

// Load blocklists.json and build inverse map: domain → purpose
async function loadBlocklists() {
  if (blocklistsConfig) return blocklistsConfig;
  try {
    const url = chrome.runtime.getURL("config/blocklists.json");
    const res = await fetch(url);
    blocklistsConfig = await res.json();
  } catch (_) {
    blocklistsConfig = {};
  }
  return blocklistsConfig;
}

function buildDomainToPurposeMap(blocklists) {
  const map = {};
  for (const [purpose, data] of Object.entries(blocklists)) {
    if (purpose === "metadata") continue;
    if (!data || !Array.isArray(data.domains)) continue;
    for (const domain of data.domains) {
      map[domain] = purpose;
    }
  }
  return map;
}

// Toggle detail breakdown on counter click
async function toggleBlockedDetail() {
  const detailEl = document.getElementById("pc-blocked-detail");
  const countEl = document.getElementById("pc-blocked-count");
  if (!detailEl) return;

  if (!detailEl.classList.contains("is-collapsed")) {
    detailEl.classList.add("is-collapsed");
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "▸";
    return;
  }

  if (Object.keys(lastDomainHitCount).length === 0) return;

  const blocklists = await loadBlocklists();
  const domainToPurpose = buildDomainToPurposeMap(blocklists);

  // Group blocked domains by purpose
  const byPurpose = {};
  for (const domain of Object.keys(lastDomainHitCount)) {
    const purpose = domainToPurpose[domain] || "other";
    if (!byPurpose[purpose]) byPurpose[purpose] = [];
    byPurpose[purpose].push(domain);
  }

  // Render grouped by purpose, respecting display order
  detailEl.innerHTML = "";
  const orderedPurposes = PURPOSES_TO_SHOW.filter(p => byPurpose[p]);
  if (byPurpose["other"]) orderedPurposes.push("other");

  for (const purpose of orderedPurposes) {
    const domains = byPurpose[purpose];
    const row = document.createElement("div");
    row.className = "pc-detail-purpose";

    const label = document.createElement("span");
    label.className = "pc-detail-purpose-label";
    const cfg = purposesConfig[purpose];
    const purposeHits = domains.reduce((sum, d) => sum + (lastDomainHitCount[d] || 1), 0);
    label.textContent = (cfg ? cfg.label : purpose) + " (" + purposeHits + "): ";

    const domainList = document.createElement("span");
    domainList.className = "pc-detail-domains";
    domainList.textContent = domains.map(d => {
      const hits = lastDomainHitCount[d];
      return hits > 1 ? d + " ×" + hits : d;
    }).join(", ");

    row.appendChild(label);
    row.appendChild(domainList);
    detailEl.appendChild(row);
  }

  detailEl.classList.remove("is-collapsed");
  const chevron = document.getElementById("pc-blocked-chevron");
  if (chevron) chevron.textContent = "▾";
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

  const countEl = document.getElementById("pc-blocked-count");
  if (countEl) {
    countEl.addEventListener("click", toggleBlockedDetail);
  }

  const toggleDescBtn = document.getElementById("pc-toggle-descriptions");
  if (toggleDescBtn) {
    toggleDescBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const descriptions = document.querySelectorAll(".pc-purpose-description");
      const chevrons = document.querySelectorAll(".pc-purpose-chevron");
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
      toggleDescBtn.textContent = shouldExpand ? "Hide details" : "Show details";
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
    imgEl.alt = cfg.short || "";
    imgEl.className = "pc-purpose-icon-img";
    imgEl.width = 18;
    imgEl.height = 18;
    iconEl.appendChild(imgEl);
  } else {
    iconEl.textContent = cfg.short || (cfg.label?.charAt(0) || "?");
  }

  const nameEl = document.createElement("div");
  nameEl.className = "pc-purpose-name";

  const nameTxt = document.createTextNode(cfg.label || purposeKey);
  const chevronEl = document.createElement("span");
  chevronEl.className = "pc-purpose-chevron";
  chevronEl.textContent = " ▾";
  nameEl.appendChild(nameTxt);
  nameEl.appendChild(chevronEl);

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
    detectCustomProfile();
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
  function updateDescriptionVisibility(collapsed) {
    if (collapsed) {
      descEl.classList.add("is-collapsed");
      chevronEl.textContent = " ▸";
    } else {
      descEl.classList.remove("is-collapsed");
      chevronEl.textContent = " ▾";
    }
  }

  leftEl.addEventListener("click", () => {
    const nowCollapsed = !descEl.classList.contains("is-collapsed");
    updateDescriptionVisibility(nowCollapsed);
  });

  // Start collapsed
  updateDescriptionVisibility(true);

  // Final assembly
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
        if (DEBUG_RULES) {
          console.debug("ProtoConsent: saved rules for", currentDomain, {
            profile: currentProfile,
            purposes: currentPurposesState
          });
        }
        notifyBackgroundRulesUpdated();
      }
    });
  });
}

function notifyBackgroundRulesUpdated() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" }, () => {
    const err = chrome.runtime.lastError;
    if (err && DEBUG_RULES) {
      console.debug("ProtoConsent: background may be sleeping:", err.message);
    }
    // After rule rebuild, matched rule IDs are stale — prompt reload
    const countEl = document.getElementById("pc-blocked-count");
    if (countEl) {
      countEl.textContent = "Reload page to update counter";
      countEl.classList.remove("has-blocked", "clickable");
    }
    const chevron = document.getElementById("pc-blocked-chevron");
    if (chevron) chevron.textContent = "";
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
  const statEl = document.getElementById("pc-blocked-count");
  if (statEl) statEl.parentElement.style.display = "none";
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
        if (chrome.runtime.lastError && DEBUG_RULES) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
      renderSiteDeclaration(container, data);
    } else {
      // Cache negative/invalid result (6h TTL) to avoid re-fetching on every popup open
      chrome.storage.local.set({ [cacheKey]: { data: null, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError && DEBUG_RULES) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
    }
  } catch (err) {
    if (DEBUG_RULES) console.error("[well-known] Error:", err);
  }
}

/**
 * Minimal validation of a .well-known/protoconsent.json file.
 * See design/well-known-spec.md §4.2 for the rules.
 */
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
    } else if (entry.used) {
      checkEl.textContent = "✓";
      checkEl.classList.add("used");

      if (typeof entry.legal_basis === "string") {
        const basisIcon = LEGAL_BASIS_ICONS[entry.legal_basis];
        if (basisIcon) {
          const iconImg = document.createElement("img");
          iconImg.src = basisIcon;
          iconImg.alt = "";
          iconImg.className = "pc-declaration-icon";
          iconImg.width = 14;
          iconImg.height = 14;
          basisEl.appendChild(iconImg);
        }
        basisEl.appendChild(document.createTextNode(
          LEGAL_BASIS_LABELS[entry.legal_basis] || entry.legal_basis.replace(/_/g, " ")
        ));
      }
    } else {
      checkEl.textContent = "✗";
      checkEl.classList.add("not-used");
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
  buttonEl.className = "pc-popup-error-button";
  buttonEl.textContent = "Try again";

  buttonEl.addEventListener("click", () => {
    initPopup();
  });

  listEl.appendChild(errorEl);
  listEl.appendChild(buttonEl);
}
