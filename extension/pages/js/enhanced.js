// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Enhanced Protection tab: preset selector, per-list toggles, fetch triggers.
// Loaded after popup.js - shares globals: activeMode.
// Communicates with background.js via PROTOCONSENT_ENHANCED_* messages.

let epCatalog = {};
let epLists = {};
let epPreset = "off";
let epDynamicConsent = false;
let epConsentEnhancedLink = false;
let epConsentLinkedIds = new Set();
let _epFocusListId = null; // list to refocus after re-render
let _celAutoFetchInProgress = false;

// --- Shared stats helper ---
function getEnhancedStats() {
  // Include consent-linked lists as active even if not manually enabled
  const activeLists = Object.entries(epLists)
    .filter(([id, l]) => l.enabled || epConsentLinkedIds.has(id))
    .map(([, l]) => l);
  const blockingLists = activeLists.filter(l => !l.type);
  const infoLists = activeLists.filter(l => l.type === "informational");
  const cosmeticLists = activeLists.filter(l => l.type === "cosmetic");
  const cmpLists = activeLists.filter(l => l.type === "cmp" || l.type === "cmp_detectors" || l.type === "cmp_site");
  const paramsLists = activeLists.filter(l => l.type === "tracking_params" || l.type === "tracking_params_sites");
  const paramsTotal = Object.entries(epLists)
    .filter(([id, l]) => (l.enabled || epConsentLinkedIds.has(id)) && (l.type === "tracking_params" || l.type === "tracking_params_sites"))
    .reduce((sum, [id, l]) => sum + (l.paramCount || (epCatalog[id] && epCatalog[id].param_count) || 0), 0);
  let updatesAvailable = 0;
  for (const id of Object.keys(epLists)) {
    if (CORE_IDS.has(id) || CMP_IDS.has(id)) continue;
    if (epLists[id].bundled) continue;
    const catalogDef = epCatalog[id];
    if (catalogDef && catalogDef.version && epLists[id].version &&
        catalogDef.version > epLists[id].version) {
      updatesAvailable++;
    }
  }
  const cosmeticRules = cosmeticLists.reduce((sum, l) =>
    sum + (l.genericCount || 0) + (l.domainRuleCount || 0), 0);
  const cmpTemplates = cmpLists.reduce((sum, l) => sum + (l.cmpCount || 0), 0);

  // Count grouped lists (Core = 5, CMP = 3) as 1 each for display
  const isGroupedId = (id) => CORE_IDS.has(id) || CMP_IDS.has(id);
  const coreActiveIds = Object.keys(epLists).filter(id =>
    CORE_IDS.has(id) && (epLists[id].enabled || epConsentLinkedIds.has(id)));
  const coreDownloadedIds = Object.keys(epLists).filter(id => CORE_IDS.has(id));
  const coreCatalogIds = Object.keys(epCatalog).filter(id => CORE_IDS.has(id));
  const cmpActiveIds = Object.keys(epLists).filter(id =>
    CMP_IDS.has(id) && (epLists[id].enabled || epConsentLinkedIds.has(id)));
  const cmpDownloadedIds = Object.keys(epLists).filter(id => CMP_IDS.has(id));
  const cmpCatalogIds = Object.keys(epCatalog).filter(id => CMP_IDS.has(id));
  const coreExtraEnabled = Math.max(0, coreActiveIds.length - 1);
  const coreExtraDownloaded = Math.max(0, coreDownloadedIds.length - 1);
  const coreExtraCatalog = Math.max(0, coreCatalogIds.length - 1);
  const cmpExtraEnabled = Math.max(0, cmpActiveIds.length - 1);
  const cmpExtraDownloaded = Math.max(0, cmpDownloadedIds.length - 1);
  const cmpExtraCatalog = Math.max(0, cmpCatalogIds.length - 1);

  return {
    enabledCount: activeLists.length - coreExtraEnabled - cmpExtraEnabled,
    blockingCount: blockingLists.length - coreExtraEnabled,
    infoCount: infoLists.length,
    infoDomains: infoLists.reduce((sum, l) => sum + (l.domainCount || 0), 0),
    cosmeticCount: cosmeticLists.length,
    cmpCount: cmpLists.length - cmpExtraEnabled,
    paramsCount: paramsLists.length,
    paramsTotal,
    totalDomains: blockingLists.reduce((sum, l) => sum + (l.domainCount || 0), 0),
    cosmeticRules,
    cmpTemplates,
    totalRules: blockingLists.reduce((sum, l) => sum + (l.domainCount || 0), 0) + cosmeticRules + cmpTemplates,
    downloadedCount: Object.keys(epLists).length - coreExtraDownloaded - cmpExtraDownloaded,
    catalogCount: Object.keys(epCatalog).length - coreExtraCatalog - cmpExtraCatalog,
    notDownloaded: Object.keys(epCatalog).filter(id => !epLists[id] && !isGroupedId(id) && !REGIONAL_IDS.has(id))
      .concat(coreCatalogIds.length > 0 && !coreDownloadedIds.length ? [coreCatalogIds[0]] : [])
      .concat(cmpCatalogIds.length > 0 && !cmpDownloadedIds.length ? [cmpCatalogIds[0]] : []),
    updatesAvailable,
  };
}

// Auto-switch stored preset from off to basic before downloading,
// so newly fetched lists get enabled. Does NOT touch existing list toggles.
function ensurePresetForDownload(callback) {
  if (epPreset === "off") {
    chrome.storage.local.set({ enhancedPreset: "basic" }, () => {
      epPreset = "basic";
      callback();
    });
  } else {
    callback();
  }
}

const EP_PRESETS = [
  { id: "off", label: "Off", description: "Only ProtoConsent core lists" },
  { id: "basic", label: "Balanced", description: "Conservative third-party lists" },
  { id: "full", label: "Full", description: "All available third-party lists" },
];

function initEnhancedTab() {
  refreshEnhancedState();
}

function refreshEnhancedState() {
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    epCatalog = resp.catalog || {};
    epLists = resp.lists || {};
    epPreset = resp.preset || "off";
    epDynamicConsent = resp.dynamicConsent === true;
    epConsentEnhancedLink = resp.consentEnhancedLink === true;
    epConsentLinkedIds = new Set(resp.consentLinkedListIds || []);
    renderEnhancedPresets();
    renderEnhancedLists();
    updateEnhancedStatus();
    // Auto-download consent-linked lists not yet downloaded
    const celPending = resp.celPendingDownload || [];
    if (celPending.length > 0 && !_celAutoFetchInProgress) {
      _celAutoFetchInProgress = true;
      downloadAllEnhancedLists(null, celPending);
    } else if (celPending.length === 0) {
      _celAutoFetchInProgress = false;
    }
  });
}

// --- Preset buttons + contextual action ---

function renderEnhancedPresets() {
  const container = document.getElementById("ep-preset-buttons");
  if (!container) return;
  container.innerHTML = "";

  // --- Bottom row: preset dropdown + shields ---
  const bottom = document.createElement("div");
  bottom.className = "ep-preset-bottom";

  // Dropdown
  const dropdown = document.createElement("div");
  dropdown.className = "ep-preset-dropdown";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ep-preset-btn";
  btn.title = "Enhanced Protection preset";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const activePreset = EP_PRESETS.find(p => p.id === epPreset);
  const btnText = document.createElement("span");
  btnText.id = "ep-preset-btn-text";
  btnText.textContent = activePreset ? activePreset.label : (epPreset === "custom" ? "Custom" : "Off");
  btn.appendChild(btnText);
  const chevron = document.createElement("span");
  chevron.className = "ep-preset-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "\u25BE";
  btn.appendChild(chevron);
  dropdown.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "ep-preset-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Enhanced protection preset");
  menu.hidden = true;

  const allOptions = EP_PRESETS.slice();
  if (epPreset === "custom") {
    allOptions.push({ id: "custom", label: "Custom", description: "Custom: you have toggled individual lists" });
  }
  for (const preset of allOptions) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "ep-preset-option" + (epPreset === preset.id ? " is-active" : "");
    opt.dataset.value = preset.id;
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", epPreset === preset.id ? "true" : "false");
    opt.textContent = preset.label;
    opt.title = preset.description || "";
    menu.appendChild(opt);
  }
  dropdown.appendChild(menu);

  // Toggle menu
  btn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  // Select option
  menu.addEventListener("click", (e) => {
    const opt = e.target.closest(".ep-preset-option");
    if (!opt) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    setEnhancedPreset(opt.dataset.value);
  });
  // Close on outside click (use capture to avoid accumulating listeners)
  if (!renderEnhancedPresets._outsideClick) {
    renderEnhancedPresets._outsideClick = (e) => {
      var openMenu = document.querySelector(".ep-preset-menu:not([hidden])");
      var openBtn = document.querySelector(".ep-preset-btn");
      if (openMenu && openBtn && !openBtn.contains(e.target) && !openMenu.contains(e.target)) {
        openMenu.hidden = true;
        openBtn.setAttribute("aria-expanded", "false");
      }
    };
    document.addEventListener("click", renderEnhancedPresets._outsideClick);
  }
  // Escape closes and returns focus
  dropdown.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.focus();
    }
  });

  bottom.appendChild(dropdown);

  // Shield level indicator
  const shieldCount = epPreset === "full" ? 3 : epPreset === "basic" ? 2 : epPreset === "custom" ? 1 : 0;
  const shieldSpan = document.createElement("span");
  shieldSpan.className = "ep-preset-shields";
  for (let i = 0; i < shieldCount; i++) {
    const img = document.createElement("img");
    img.src = ENHANCED_ICON;
    img.width = 12;
    img.height = 12;
    img.className = "ep-preset-shield";
    img.alt = "";
    shieldSpan.appendChild(img);
  }
  if (epPreset === "custom") {
    const icon = document.createElement("span");
    icon.className = "ep-preset-custom-icon";
    icon.textContent = "\u270E";
    icon.title = "Custom: you have toggled individual lists";
    icon.setAttribute("aria-label", "Custom preset (set by individual list toggles)");
    shieldSpan.appendChild(icon);
  }
  bottom.appendChild(shieldSpan);

  container.appendChild(bottom);

  // Contextual action button (right side of preset bar)
  renderPresetAction();
}


function renderPresetAction() {
  const bar = document.getElementById("ep-preset-bar");
  if (!bar) return;

  // Remove previous top row if any
  const prevTop = bar.querySelector(".ep-preset-top");
  if (prevTop) prevTop.remove();

  // Single row: Sync + CEL + action button
  const top = document.createElement("div");
  top.className = "ep-preset-top";

  const { enabledCount, downloadedCount, catalogCount, notDownloaded, updatesAvailable } = getEnhancedStats();

  // Sync consent pill (before action button)
  const pill = document.createElement("span");
  pill.className = "ep-sync-pill" + (epDynamicConsent ? " is-active" : " is-disabled");
  pill.setAttribute("role", "switch");
  pill.setAttribute("aria-checked", epDynamicConsent ? "true" : "false");
  pill.setAttribute("aria-label", "Enhanced list sync");
  pill.setAttribute("tabindex", "0");
  const dot = document.createElement("span");
  dot.className = "ep-sync-dot";
  dot.setAttribute("aria-hidden", "true");
  pill.appendChild(dot);
  pill.appendChild(document.createTextNode("Sync"));
  pill.title = epDynamicConsent
    ? "Enhanced list sync enabled - click to disable"
    : "Enhanced list sync disabled - click to enable";
  const toggleSync = () => {
    const newVal = !epDynamicConsent;
    setDynamicListsConsent(newVal, () => {
      epDynamicConsent = newVal;
      // Force-refresh catalog to pick up new consent state
      chrome.runtime.sendMessage(
        { type: "PROTOCONSENT_ENHANCED_GET_STATE", forceRefresh: true },
        (resp) => {
          if (chrome.runtime.lastError || !resp) return;
          epCatalog = resp.catalog || {};
          epLists = resp.lists || {};
          epPreset = resp.preset || "off";
          epDynamicConsent = resp.dynamicConsent === true;
          epConsentEnhancedLink = resp.consentEnhancedLink === true;
          epConsentLinkedIds = new Set(resp.consentLinkedListIds || []);
          renderEnhancedPresets();
          renderEnhancedLists();
          updateEnhancedStatus();
          // Restore focus to the re-rendered sync pill
          const newPill = document.querySelector(".ep-sync-pill");
          if (newPill) newPill.focus();
        }
      );
    });
  };
  pill.addEventListener("click", toggleSync);
  pill.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSync();
    }
  });
  // Add pill to top row
  top.appendChild(pill);

  // Consent-Enhanced Link pill
  const celPill = document.createElement("span");
  celPill.className = "ep-cel-pill" + (epConsentEnhancedLink ? " is-active" : " is-disabled");
  celPill.setAttribute("role", "switch");
  celPill.setAttribute("aria-checked", epConsentEnhancedLink ? "true" : "false");
  celPill.setAttribute("aria-label", "Consent-enhanced link");
  celPill.setAttribute("tabindex", "0");
  const celImg = document.createElement("img");
  celImg.src = "../icons/protoconsent_icon_32.png";
  celImg.width = 14;
  celImg.height = 14;
  celImg.className = "ep-cel-pill-icon";
  celImg.alt = "";
  celImg.setAttribute("aria-hidden", "true");
  celPill.appendChild(celImg);
  celPill.title = epConsentEnhancedLink
    ? "Consent link active - denied purposes auto-activate matching lists. Click to disable"
    : "Consent link off - click to enable";
  const toggleCel = () => {
    const newVal = !epConsentEnhancedLink;
    setConsentEnhancedLink(newVal, () => {
      // Trigger rebuild so lastConsentLinkedListIds updates before we read state
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" }, () => {
        void chrome.runtime.lastError;
        epConsentEnhancedLink = newVal;
        chrome.runtime.sendMessage(
          { type: "PROTOCONSENT_ENHANCED_GET_STATE", forceRefresh: true },
          (resp) => {
            if (chrome.runtime.lastError || !resp) return;
            epCatalog = resp.catalog || {};
            epLists = resp.lists || {};
            epPreset = resp.preset || "off";
            epDynamicConsent = resp.dynamicConsent === true;
            epConsentEnhancedLink = resp.consentEnhancedLink === true;
            epConsentLinkedIds = new Set(resp.consentLinkedListIds || []);
            renderEnhancedPresets();
            renderEnhancedLists();
            updateEnhancedStatus();
            const newCelPill = document.querySelector(".ep-cel-pill");
            if (newCelPill) newCelPill.focus();
          }
        );
      });
    });
  };
  celPill.addEventListener("click", toggleCel);
  celPill.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCel();
    }
  });
  top.appendChild(celPill);

  if (notDownloaded.length > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ep-preset-action ep-preset-action-download";
    btn.textContent = "↓ Download all";
    btn.title = "Download " + notDownloaded.length + " remaining lists";
    btn.addEventListener("click", () => downloadAllEnhancedLists(btn));
    top.appendChild(btn);
  } else if (enabledCount > 0 && notDownloaded.length === 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ep-preset-action ep-preset-action-update";
    btn.textContent = updatesAvailable > 0
      ? "↻ Update " + updatesAvailable + (updatesAvailable === 1 ? " list" : " lists")
      : "↻ Update all";
    btn.title = updatesAvailable > 0
      ? updatesAvailable + " update(s) available"
      : "Refresh all downloaded lists";
    btn.addEventListener("click", () => updateAllEnhancedLists(btn));
    top.appendChild(btn);
  } else if (downloadedCount > 0) {
    const span = document.createElement("span");
    span.className = "ep-preset-action ep-preset-action-summary";
    span.textContent = downloadedCount + "/" + catalogCount + " downloaded";
    top.appendChild(span);
  }

  // Insert top row after the preset-buttons container (same line, right side)
  bar.appendChild(top);
}

function setEnhancedPreset(preset) {
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_SET_PRESET", preset }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    epPreset = preset;
    // If switching to basic or full, auto-download missing lists
    if (preset === "basic" || preset === "full") {
      chrome.storage.local.get(["regionalLanguages"], (rl) => {
        const hasLangs = Array.isArray(rl.regionalLanguages) && rl.regionalLanguages.length > 0;
        const missing = Object.keys(epCatalog).filter(id => {
          if (epLists[id]) return false;
          // Skip regional lists if no languages selected
          if (REGIONAL_IDS.has(id) && !hasLangs) return false;
          if (preset === "basic") return epCatalog[id].preset === "basic";
          return true;
        });
        if (missing.length > 0) {
          const dlBtn = document.querySelector(".ep-preset-action-download");
          downloadAllEnhancedLists(dlBtn, missing);
          return;
        }
        refreshEnhancedState();
      });
    } else {
      refreshEnhancedState();
    }
  });
}

function renderEnhancedLists() {
  const container = document.getElementById("ep-lists");
  if (!container) return;

  // Preserve which grid card was expanded
  var prevExpanded = null;
  var prev = container.querySelector(".pc-grid-card.is-expanded");
  if (prev) prevExpanded = prev.id;
  container.innerHTML = "";

  const catalogEntries = Object.entries(epCatalog)
    .sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
  if (catalogEntries.length === 0) {
    container.innerHTML = '<div class="ep-empty">No enhanced lists available.</div>';
    return;
  }

  // Categorize lists
  const coreIds = getCoreIds();
  const cmpIds = getCmpIds();
  const blockingLists = [];   // non-core domain/path blocking + regional blocking
  const cosmeticLists = [];   // cosmetic + regional cosmetic
  const bannerLists = [];     // non-grouped CMP
  const detectionLists = [];  // informational + tracking_params

  for (const [listId, listDef] of catalogEntries) {
    if (CORE_IDS.has(listId) || CMP_IDS.has(listId)) continue;
    if (listDef.type === "cosmetic" || listDef.type === "regional_cosmetic") {
      cosmeticLists.push(listId);
    } else if (listDef.type === "cmp") {
      bannerLists.push(listId);
    } else if (listDef.type === "informational" || listDef.type === "tracking_params" || listDef.type === "tracking_params_sites") {
      detectionLists.push(listId);
    } else {
      // default blocking + regional_blocking
      blockingLists.push(listId);
    }
  }

  // Build 2-column grid
  var grid = document.createElement("div");
  grid.className = "pc-grid-2col ep-grid";

  // 1. Overview card (full-width)
  var stats = getEnhancedStats();
  var overviewMetric = stats.enabledCount > 0
    ? stats.enabledCount + " active \u00b7 " + stats.totalRules.toLocaleString() + " rules"
    : "Off";
  var GRID_ICONS = "../icons/grid/";
  var ov = createGridCard({ id: "ep-card-overview", iconSrc: GRID_ICONS + "overview.svg", title: "Overview", metric: overviewMetric, full: true });
  var ovBody = ov.body;
  // Overview body: summary stats
  var ovLines = document.createElement("div");
  ovLines.className = "ep-overview-lines";
  var ovStats = [
    { icon: GRID_ICONS + "blocking.svg", count: stats.blockingCount, label: "blocking", detail: stats.totalDomains.toLocaleString() + " domains" },
    { icon: GRID_ICONS + "cosmetic.svg", count: stats.cosmeticCount, label: "cosmetic", detail: stats.cosmeticRules.toLocaleString() + " rules" },
    { icon: GRID_ICONS + "banners.svg", count: stats.cmpCount, label: "banner", detail: stats.cmpTemplates.toLocaleString() + " templates" },
    { icon: GRID_ICONS + "detection.svg", count: stats.paramsCount + stats.infoCount, label: "detection", detail: stats.paramsTotal.toLocaleString() + " params \u00b7 " + stats.infoDomains.toLocaleString() + " entries" },
  ];
  for (var s = 0; s < ovStats.length; s++) {
    if (ovStats[s].count === 0) continue;
    var row = document.createElement("div");
    row.className = "ep-overview-stat";
    row.innerHTML = '<img src="' + ovStats[s].icon + '" width="16" height="16" alt="">' +
      '<strong>' + ovStats[s].count + ' ' + ovStats[s].label + '</strong>' +
      '<span class="ep-overview-detail">' + ovStats[s].detail + '</span>';
    ovLines.appendChild(row);
  }
  if (stats.updatesAvailable > 0) {
    var updRow = document.createElement("div");
    updRow.className = "ep-overview-stat ep-overview-stat-update";
    updRow.innerHTML = '<strong>' + stats.updatesAvailable + ' update' + (stats.updatesAvailable !== 1 ? 's' : '') + '</strong>' +
      '<span class="ep-overview-detail">available</span>';
    ovLines.appendChild(updRow);
  }
  var dlRow = document.createElement("div");
  dlRow.className = "ep-overview-stat ep-overview-stat-dl";
  dlRow.innerHTML = '<strong>' + stats.downloadedCount + '/' + stats.catalogCount + '</strong>' +
    '<span class="ep-overview-detail">downloaded</span>';
  ovLines.appendChild(dlRow);
  ovBody.appendChild(ovLines);

  // Active lists: proto-card style accordions by type
  if (stats.enabledCount > 0) {
    var activeWrap = document.createElement("div");
    activeWrap.className = "ep-overview-active";

    var activeTitle = document.createElement("div");
    activeTitle.className = "ep-overview-active-title";
    var activeTitleText = document.createElement("span");
    activeTitleText.textContent = "Active lists";
    activeTitle.appendChild(activeTitleText);
    var activeTitleFlags = document.createElement("a");
    activeTitleFlags.href = "purposes-settings.html#regional-filters";
    activeTitleFlags.target = "_blank";
    activeTitleFlags.className = "ep-overview-active-flags";
    activeTitleFlags.hidden = true;
    if (typeof buildRegionalFlags === "function") {
      buildRegionalFlags(activeTitleFlags, { maxFlags: 3 });
    }
    activeTitle.appendChild(activeTitleFlags);
    activeWrap.appendChild(activeTitle);

    var coreActive = coreIds.some(function (id) {
      return epLists[id] && (epLists[id].enabled || epConsentLinkedIds.has(id));
    });
    var cmpActive = cmpIds.some(function (id) {
      return epLists[id] && (epLists[id].enabled || epConsentLinkedIds.has(id));
    });

    var typeGroups = [
      { label: "Blocking", icon: GRID_ICONS + "blocking.svg", grouped: coreActive ? ["ProtoConsent Core"] : [], ids: blockingLists, detail: stats.totalDomains.toLocaleString() + " domains" },
      { label: "Cosmetic", icon: GRID_ICONS + "cosmetic.svg", grouped: [], ids: cosmeticLists, detail: stats.cosmeticRules.toLocaleString() + " rules" },
      { label: "Banners", icon: GRID_ICONS + "banners.svg", grouped: cmpActive ? ["ProtoConsent Banners"] : [], ids: bannerLists, detail: stats.cmpTemplates.toLocaleString() + " templates" },
      { label: "Detection", icon: GRID_ICONS + "detection.svg", grouped: [], ids: detectionLists, detail: stats.paramsTotal.toLocaleString() + " params" },
    ];
    for (var g = 0; g < typeGroups.length; g++) {
      var group = typeGroups[g];
      var activeNames = group.grouped.slice();
      for (var a = 0; a < group.ids.length; a++) {
        var aid = group.ids[a];
        var aData = epLists[aid];
        if (aData && (aData.enabled || epConsentLinkedIds.has(aid))) {
          activeNames.push(epCatalog[aid] ? epCatalog[aid].name : aid);
        }
      }
      if (activeNames.length === 0) continue;

      var card = document.createElement("div");
      card.className = "ep-active-card";
      var cardHeader = document.createElement("div");
      cardHeader.className = "ep-active-card-header";
      cardHeader.setAttribute("role", "button");
      cardHeader.setAttribute("tabindex", "0");
      cardHeader.setAttribute("aria-expanded", "false");
      var chevron = document.createElement("span");
      chevron.className = "ep-active-card-chevron";
      chevron.textContent = "\u25B8";
      var iconEl = document.createElement("img");
      iconEl.src = group.icon;
      iconEl.width = 18;
      iconEl.height = 18;
      iconEl.alt = "";
      var nameEl = document.createElement("span");
      nameEl.className = "ep-active-card-name";
      nameEl.textContent = group.label;
      var countEl = document.createElement("span");
      countEl.className = "ep-active-card-count";
      countEl.textContent = activeNames.length + " lists \u00b7 " + group.detail;
      cardHeader.appendChild(chevron);
      cardHeader.appendChild(iconEl);
      cardHeader.appendChild(nameEl);
      cardHeader.appendChild(countEl);

      var cardBody = document.createElement("div");
      cardBody.className = "ep-active-card-body";
      cardBody.hidden = true;
      for (var n = 0; n < activeNames.length; n++) {
        var entry = document.createElement("div");
        entry.className = "ep-active-card-entry";
        entry.textContent = activeNames[n];
        cardBody.appendChild(entry);
      }

      var toggle = (function (c, h, ch, b) {
        return function () {
          var exp = c.classList.toggle("is-expanded");
          h.setAttribute("aria-expanded", exp ? "true" : "false");
          ch.textContent = exp ? "\u25BE" : "\u25B8";
          b.hidden = !exp;
        };
      })(card, cardHeader, chevron, cardBody);
      cardHeader.addEventListener("click", toggle);
      cardHeader.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });

      card.appendChild(cardHeader);
      card.appendChild(cardBody);
      activeWrap.appendChild(card);
    }
    ovBody.appendChild(activeWrap);
  }

  grid.appendChild(ov.card);
  grid.appendChild(ov.body);

  // 2. Blocking card
  var blockTotal = coreIds.length > 0 ? 1 : 0;
  blockTotal += blockingLists.length;
  var bk = createGridCard({ id: "ep-card-blocking", iconSrc: GRID_ICONS + "blocking.svg", title: "Blocking", metric: stats.blockingCount + " lists \u00b7 " + stats.totalDomains.toLocaleString() + " domains" });
  var bkBody = bk.body;
  if (coreIds.length > 0) bkBody.appendChild(renderCoreCard(coreIds));
  for (var i = 0; i < blockingLists.length; i++) {
    var lid = blockingLists[i];
    if (REGIONAL_IDS.has(lid) && typeof renderRegionalCard === "function") {
      var rc = renderRegionalCard(lid);
      if (rc) bkBody.appendChild(rc);
    } else {
      bkBody.appendChild(_renderEpListCard(lid));
    }
  }
  grid.appendChild(bk.card);
  grid.appendChild(bk.body);

  // 3. Cosmetic card
  var cm = createGridCard({ id: "ep-card-cosmetic", iconSrc: GRID_ICONS + "cosmetic.svg", title: "Cosmetic", metric: stats.cosmeticRules.toLocaleString() + " rules" });
  var cmBody = cm.body;
  for (var i = 0; i < cosmeticLists.length; i++) {
    var lid = cosmeticLists[i];
    if (REGIONAL_IDS.has(lid) && typeof renderRegionalCard === "function") {
      var rc = renderRegionalCard(lid);
      if (rc) cmBody.appendChild(rc);
    } else {
      cmBody.appendChild(_renderEpListCard(lid));
    }
  }
  grid.appendChild(cm.card);
  grid.appendChild(cm.body);

  // 4. Banners card
  var bn = createGridCard({ id: "ep-card-banners", iconSrc: GRID_ICONS + "banners.svg", title: "Banners", metric: stats.cmpTemplates.toLocaleString() + " templates" });
  var bnBody = bn.body;
  if (cmpIds.length > 0) bnBody.appendChild(renderCmpCard(cmpIds));
  for (var i = 0; i < bannerLists.length; i++) {
    bnBody.appendChild(_renderEpListCard(bannerLists[i]));
  }
  grid.appendChild(bn.card);
  grid.appendChild(bn.body);

  // 5. Detection card
  var dt = createGridCard({ id: "ep-card-detection", iconSrc: GRID_ICONS + "detection.svg", title: "Detection", metric: stats.infoCount + " info \u00b7 " + stats.paramsTotal + " params" });
  var dtBody = dt.body;
  for (var i = 0; i < detectionLists.length; i++) {
    dtBody.appendChild(_renderEpListCard(detectionLists[i]));
  }
  grid.appendChild(dt.card);
  grid.appendChild(dt.body);

  container.appendChild(grid);

  // Restore expanded card
  if (prevExpanded) {
    var card = document.getElementById(prevExpanded);
    if (card) {
      var toggle = card.querySelector(".pc-grid-card-toggle");
      if (toggle) toggle.click();
    }
  }

  // Restore focus to the control of the list that was just acted on
  if (_epFocusListId) {
    const target = container.querySelector('.ep-list-card[data-list-id="' + _epFocusListId + '"]');
    if (target) {
      const focusable = target.querySelector("input, button");
      if (focusable) focusable.focus();
    }
    _epFocusListId = null;
  }
}

// Render a single non-grouped ep-list-card for use inside grid card bodies
function _renderEpListCard(listId) {
  const listDef = epCatalog[listId];
  const listData = epLists[listId];
  const isConsentLinked = epConsentLinkedIds.has(listId);

  const card = document.createElement("div");
  card.className = "ep-list-card";
  card.dataset.listId = listId;
  if (listData?.enabled || isConsentLinked) card.classList.add("is-enabled");

  const header = document.createElement("div");
  header.className = "ep-list-header";

  const chevron = document.createElement("span");
  chevron.className = "ep-list-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "\u25BE";
  header.appendChild(chevron);

  const icon = document.createElement("img");
  icon.src = ENHANCED_ICON;
  icon.width = 16;
  icon.height = 16;
  icon.alt = "";
  icon.className = "ep-list-icon";
  icon.onerror = function() { this.style.display = "none"; };
  header.appendChild(icon);

  const nameEl = document.createElement("span");
  nameEl.className = "ep-list-name";
  nameEl.title = listDef.name;
  nameEl.textContent = listDef.name;
  header.appendChild(nameEl);

  // Category pill + consent-linked icon
  const catInfo = typeof getEnhancedCategoryInfo === "function" ? getEnhancedCategoryInfo(listId) : null;
  if (isConsentLinked) {
    const celIcon = document.createElement("img");
    celIcon.src = "../icons/protoconsent_icon_32.png";
    celIcon.width = 14;
    celIcon.height = 14;
    celIcon.alt = "";
    celIcon.className = "ep-cel-icon";
    celIcon.title = "Consent-linked: activated by denied " + (catInfo ? catInfo.label : "purpose");
    header.appendChild(celIcon);
  }
  if (listDef.type === "cosmetic" || listDef.type === "regional_cosmetic") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-cosmetic-pill";
    pill.title = "Cosmetic filtering - hides ad elements on pages";
    pill.setAttribute("aria-label", "Cosmetic filtering");
    pill.textContent = "\u25D0 Cosmetic";
    header.appendChild(pill);
  } else if (listDef.type === "cmp") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-cmp-pill";
    pill.title = "CMP auto-response - handles cookie consent banners";
    pill.setAttribute("aria-label", "Banner auto-response");
    pill.textContent = "\u26A1 Banners";
    header.appendChild(pill);
  } else if (listDef.type === "tracking_params" || listDef.type === "tracking_params_sites") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-params-pill";
    pill.title = "URL parameter stripping - removes tracking parameters from URLs";
    pill.setAttribute("aria-label", "URL parameter stripping");
    pill.textContent = "\u2702 Params";
    header.appendChild(pill);
  } else if (catInfo) {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill";
    pill.title = catInfo.label;
    const catIcon = document.createElement("img");
    catIcon.src = catInfo.icon;
    catIcon.width = 12;
    catIcon.height = 12;
    catIcon.alt = "";
    catIcon.onerror = function() { this.style.display = "none"; };
    pill.appendChild(catIcon);
    const catLabel = document.createElement("span");
    catLabel.textContent = catInfo.label;
    pill.appendChild(catLabel);
    header.appendChild(pill);
  } else if (listDef.type === "informational") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-info-pill";
    pill.title = "Informational only, does not block requests";
    pill.textContent = "\u2139 Info";
    header.appendChild(pill);
  }

  if (listData) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ep-list-remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove downloaded data for " + listDef.name;
    removeBtn.setAttribute("aria-label", "Remove " + listDef.name);
    removeBtn.addEventListener("click", () => removeEnhancedList(listId));
    header.appendChild(removeBtn);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "ep-list-toggle";
    const isActive = !!listData.enabled || isConsentLinked;
    toggle.checked = isActive;
    if (isConsentLinked) {
      toggle.disabled = true;
      toggle.title = listDef.name + " - activated by consent link";
    } else {
      toggle.title = listData.enabled ? "Disable " + listDef.name : "Enable " + listDef.name;
    }
    toggle.setAttribute("aria-label", (isActive ? "Disable " : "Enable ") + listDef.name);
    toggle.addEventListener("change", () => toggleEnhancedList(listId, toggle.checked));
    header.appendChild(toggle);
  } else {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "ep-list-download-btn";
    dlBtn.textContent = "Download";
    dlBtn.title = "Download " + listDef.name;
    dlBtn.setAttribute("aria-label", "Download " + listDef.name);
    dlBtn.dataset.listId = listId;
    dlBtn.addEventListener("click", () => fetchEnhancedList(listId, dlBtn));
    header.appendChild(dlBtn);
  }

  card.appendChild(header);

  header.setAttribute("tabindex", "0");
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", "false");
  header.addEventListener("click", (e) => {
    if (e.target.closest("input, button")) return;
    const expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const expanded = card.classList.toggle("is-expanded");
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  });

  const info = document.createElement("div");
  info.className = "ep-list-info";
  const desc = document.createElement("span");
  desc.className = "ep-list-desc";
  desc.textContent = listDef.description;
  info.appendChild(desc);

  if (listData) {
    const stats = document.createElement("span");
    stats.className = "ep-list-stats";
    const parts = [];
    if (listData.type === "informational") {
      if (listData.domainCount) parts.push(listData.domainCount.toLocaleString() + " entries");
    } else if (listData.type === "cosmetic") {
      if (listData.genericCount) parts.push(listData.genericCount.toLocaleString() + " generic rules");
      if (listData.domainRuleCount) parts.push(listData.domainRuleCount.toLocaleString() + " site rules");
    } else if (listData.type === "cmp") {
      if (listData.cmpCount) parts.push(listData.cmpCount.toLocaleString() + " banner templates");
    } else if (listData.type === "tracking_params") {
      if (listData.paramCount) parts.push(listData.paramCount.toLocaleString() + " global params");
    } else if (listData.type === "tracking_params_sites") {
      if (listData.paramCount) parts.push(listData.paramCount.toLocaleString() + " params");
      if (listData.domainCount) parts.push(listData.domainCount.toLocaleString() + " domains");
    } else {
      if (listData.domainCount) parts.push(listData.domainCount.toLocaleString() + " tracking rules");
      if (listData.pathRuleCount) parts.push(listData.pathRuleCount.toLocaleString() + " path rules");
    }
    if (listData.version) parts.push("v" + listData.version);
    stats.textContent = parts.join(" \u00b7 ");
    info.appendChild(stats);

    if (listData.version && listDef.version && listDef.version > listData.version) {
      const updateBadge = document.createElement("span");
      updateBadge.className = "ep-update-badge";
      updateBadge.textContent = "Update available";
      updateBadge.title = "Remote version: " + listDef.version + " (installed: " + listData.version + ")";
      info.appendChild(updateBadge);
    }
  }

  card.appendChild(info);

  const meta = document.createElement("div");
  meta.className = "ep-list-meta";
  meta.textContent = listDef.license;
  if (listData?.lastFetched) {
    meta.textContent += " \u00b7 Updated " + formatRelativeTime(listData.lastFetched);
  }
  card.appendChild(meta);

  return card;
}

function toggleEnhancedList(listId, enabled) {
  _epFocusListId = listId;
  chrome.runtime.sendMessage({
    type: "PROTOCONSENT_ENHANCED_TOGGLE", listId, enabled,
  }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    refreshEnhancedState();
  });
}

function fetchEnhancedList(listId, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Downloading...";
  }
  const doFetch = () => {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
    if (chrome.runtime.lastError) {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Failed"; }
      const statusEl = document.getElementById("ep-status");
      if (statusEl) {
        statusEl.textContent = "Failed to download: service unavailable";
        statusEl.className = "ep-status ep-status-error";
      }
      return;
    }
    if (!resp?.ok) {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = "Failed";
        btnEl.title = resp?.error || "Download failed";
      }
      const statusEl = document.getElementById("ep-status");
      if (statusEl) {
        statusEl.textContent = "Failed to download: " + (resp?.error || "unknown error");
        statusEl.className = "ep-status ep-status-error";
      }
      return;
    }
    refreshEnhancedState();
  });
  };
  // If preset is off, auto-switch to basic so the downloaded list gets enabled
  ensurePresetForDownload(doFetch);
}

function removeEnhancedList(listId) {
  _epFocusListId = listId;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_REMOVE", listId }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    refreshEnhancedState();
  });
}

function downloadAllEnhancedLists(btnEl, filterIds) {
  const notDownloaded = filterIds || Object.keys(epCatalog).filter(id => !epLists[id] && !REGIONAL_IDS.has(id));
  if (notDownloaded.length === 0) return;

  const startDownloads = () => {
    const total = notDownloaded.length;
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = "0/" + total + "\u2026";
    }
    // Disable preset buttons to prevent re-render mid-download
    const presetBtns = document.querySelectorAll(".ep-preset-btn");
    for (const b of presetBtns) b.disabled = true;
    // Mark each card's Download button as pending
    // For grouped sub-lists, target the group card button
    const coreBtn = document.querySelector('.ep-list-download-btn[data-list-id="protoconsent_core"]');
    const cmpBtn = document.querySelector('.ep-list-download-btn[data-list-id="protoconsent_cmp"]');
    let corePending = false;
    let cmpPending = false;
    for (const listId of notDownloaded) {
      if (CORE_IDS.has(listId)) {
        if (!corePending && coreBtn) {
          coreBtn.disabled = true;
          coreBtn.textContent = "Pending\u2026";
          coreBtn.classList.add("is-pending");
          corePending = true;
        }
        continue;
      }
      if (CMP_IDS.has(listId)) {
        if (!cmpPending && cmpBtn) {
          cmpBtn.disabled = true;
          cmpBtn.textContent = "Pending\u2026";
          cmpBtn.classList.add("is-pending");
          cmpPending = true;
        }
        continue;
      }
      const cardBtn = document.querySelector('.ep-list-download-btn[data-list-id="' + listId + '"]');
      if (cardBtn) {
        cardBtn.disabled = true;
        cardBtn.textContent = "Pending\u2026";
        cardBtn.classList.add("is-pending");
      }
    }
    let completed = 0;
    let failed = 0;
    let coreCompleted = 0;
    let coreFailed = 0;
    let cmpCompleted = 0;
    let cmpFailed = 0;
    const isGroupedInDownload = (id) => CORE_IDS.has(id) || CMP_IDS.has(id);
    const coreTotal = notDownloaded.filter(id => CORE_IDS.has(id)).length;
    const cmpTotal = notDownloaded.filter(id => CMP_IDS.has(id)).length;
    for (const listId of notDownloaded) {
      const cardBtn = isGroupedInDownload(listId)
        ? null
        : document.querySelector('.ep-list-download-btn[data-list-id="' + listId + '"]');
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
        if (chrome.runtime.lastError) resp = null;
        completed++;
        if (!resp?.ok) {
          failed++;
          if (CORE_IDS.has(listId)) coreFailed++;
          if (CMP_IDS.has(listId)) cmpFailed++;
          if (cardBtn) {
            cardBtn.textContent = "Failed";
            cardBtn.classList.remove("is-pending");
            cardBtn.classList.add("is-failed");
          }
        } else if (cardBtn) {
          cardBtn.textContent = "Done";
          cardBtn.classList.remove("is-pending");
        }
        // Update Core card button progress
        if (CORE_IDS.has(listId)) {
          coreCompleted++;
          if (coreBtn && coreCompleted >= coreTotal) {
            coreBtn.textContent = coreFailed > 0 ? coreFailed + " failed" : "Done";
            coreBtn.classList.remove("is-pending");
            if (coreFailed > 0) coreBtn.classList.add("is-failed");
          } else if (coreBtn) {
            coreBtn.textContent = coreCompleted + "/" + coreTotal + "\u2026";
          }
        }
        // Update CMP card button progress
        if (CMP_IDS.has(listId)) {
          cmpCompleted++;
          if (cmpBtn && cmpCompleted >= cmpTotal) {
            cmpBtn.textContent = cmpFailed > 0 ? cmpFailed + " failed" : "Done";
            cmpBtn.classList.remove("is-pending");
            if (cmpFailed > 0) cmpBtn.classList.add("is-failed");
          } else if (cmpBtn) {
            cmpBtn.textContent = cmpCompleted + "/" + cmpTotal + "\u2026";
          }
        }
        if (btnEl) {
          btnEl.textContent = completed + "/" + total + "…";
        }
        if (completed >= total) {
          _celAutoFetchInProgress = false;
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = failed > 0
              ? failed + " failed"
              : "Done";
          }
          const statusEl = document.getElementById("ep-status");
          if (statusEl) {
            statusEl.textContent = failed > 0
              ? "Downloaded " + (total - failed) + " of " + total + " lists, " + failed + " failed"
              : "All " + total + " lists downloaded";
            statusEl.className = "ep-status" + (failed > 0 ? " ep-status-warn" : " ep-status-active");
            _protectEpStatus(6000);
          }
          // Re-enable preset buttons
          const btns = document.querySelectorAll(".ep-preset-btn");
          for (const b of btns) b.disabled = false;
          setTimeout(() => refreshEnhancedState(), 500);
        }
      });
    }
  };

  // If preset is off, auto-switch to basic so downloaded lists get enabled
  ensurePresetForDownload(startDownloads);
}

function updateAllEnhancedLists(btnEl) {
  const downloadedIds = Object.keys(epLists);
  if (downloadedIds.length === 0) return;

  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Checking…";
  }

  // Force-refresh remote catalog first to get latest version info
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE", forceRefresh: true }, (resp) => {
    if (chrome.runtime.lastError) resp = null;
    if (resp) {
      epCatalog = resp.catalog || {};
      epLists = resp.lists || {};
      epPreset = resp.preset || "off";
    }

    const total = downloadedIds.length;
    if (btnEl) btnEl.textContent = "0/" + total + "…";
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    for (const listId of downloadedIds) {
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
        if (chrome.runtime.lastError) resp = null;
        completed++;
        if (!resp?.ok) failed++;
        else if (resp.skipped) skipped++;
        if (btnEl) {
          btnEl.textContent = completed + "/" + total + "…";
        }
        if (completed >= total) {
          if (btnEl) {
            btnEl.disabled = false;
            if (failed > 0) btnEl.textContent = failed + " failed";
            else if (skipped === total) btnEl.textContent = "Up to date";
            else btnEl.textContent = "Done";
          }
          // Announce completion via aria-live region
          const statusEl = document.getElementById("ep-status");
          if (statusEl) {
            if (failed > 0) {
              statusEl.textContent = "Updated " + (total - failed) + " of " + total + " lists, " + failed + " failed";
              statusEl.className = "ep-status ep-status-warn";
            } else if (skipped === total) {
              statusEl.textContent = "All " + total + " lists already up to date";
              statusEl.className = "ep-status ep-status-active";
            } else {
              statusEl.textContent = (total - skipped) + " of " + total + " lists updated" + (skipped > 0 ? ", " + skipped + " already current" : "");
              statusEl.className = "ep-status ep-status-active";
            }
            _protectEpStatus(6000);
          }
          setTimeout(() => refreshEnhancedState(), 500);
        }
      });
    }
  });
}

let _epStatusProtectedUntil = 0;
let _epStatusClearTimer = null;

function updateEnhancedStatus() {
  if (Date.now() < _epStatusProtectedUntil) return;
  const statusEl = document.getElementById("ep-status");
  if (statusEl) statusEl.textContent = "";
}

function _protectEpStatus(ms) {
  _epStatusProtectedUntil = Date.now() + ms;
  if (_epStatusClearTimer) clearTimeout(_epStatusClearTimer);
  _epStatusClearTimer = setTimeout(() => {
    _epStatusProtectedUntil = 0;
    updateEnhancedStatus();
  }, ms);
}

function formatRelativeTime(ts) {
  if (!Number.isFinite(ts)) return "unknown";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}
