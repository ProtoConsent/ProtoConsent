// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Enhanced tab: DOM rendering for presets, action bar, list grid, list cards.
// Reads shared state + config/ui globals. Inline event wiring kept with its view.


function setHeaderDownloadIndicator(active) {
  const el = document.getElementById("pc-download-indicator");
  if (el) el.hidden = !active;
  if (active && !_fetchPollTimer) {
    _fetchPollTimer = setInterval(_pollActiveFetches, 1500);
  }
  if (!active && _fetchPollTimer) {
    clearInterval(_fetchPollTimer);
    _fetchPollTimer = null;
  }
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
      const openMenu = document.querySelector(".ep-preset-menu:not([hidden])");
      const openBtn = document.querySelector(".ep-preset-btn");
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

function renderEnhancedLists() {
  const container = document.getElementById("ep-lists");
  if (!container) return;

  // Preserve which grid card was expanded
  let prevExpanded = null;
  const prev = container.querySelector(".pc-grid-card.is-expanded");
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
  const enhancedLists = [];   // optional/enhanced editorial lists
  const cosmeticLists = [];   // cosmetic + regional cosmetic
  const bannerLists = [];     // non-grouped CMP
  const detectionLists = [];  // informational + tracking_params

  for (const [listId, listDef] of catalogEntries) {
    if (CORE_IDS.has(listId) || CMP_IDS.has(listId)) continue;
    if (listDef.type === "revoke") continue;
    if (listDef.preset === "optional") {
      enhancedLists.push(listId);
    } else if (listDef.type === "cosmetic") {
      cosmeticLists.push(listId);
    } else if (listDef.type === "cmp" || listDef.type === "cmp_detectors" || listDef.type === "cmp_site") {
      bannerLists.push(listId);
    } else if (listDef.type === "informational" || listDef.type === "tracking_params" || listDef.type === "tracking_params_sites") {
      detectionLists.push(listId);
    } else {
      blockingLists.push(listId);
    }
  }

  // Build 2-column grid
  const grid = document.createElement("div");
  grid.className = "pc-grid-2col ep-grid";

  // 1. Overview card (full-width)
  const stats = getEnhancedStats();
  const enhancedEnabled = enhancedLists.filter(function (id) { return epLists[id] && (epLists[id].enabled || epConsentLinkedIds.has(id)); }).length;
  let overviewMetric;
  if (stats.enabledCount > 0) {
    overviewMetric = stats.enabledCount + " active \u00b7 " + stats.totalRules.toLocaleString() + " rules";
    if (stats.infoDomains > 0) {
      overviewMetric += " + " + stats.infoDomains.toLocaleString() + " \u2139";
    }
  } else {
    overviewMetric = "Off";
  }
  const GRID_ICONS = "../icons/grid/";
  const ov = createGridCard({ id: "ep-card-overview", iconSrc: GRID_ICONS + "overview.svg", title: "Overview", metric: overviewMetric, full: true });
  const ovBody = ov.body;
  if (stats.updatesAvailable > 0) {
    const ovLines = document.createElement("div");
    ovLines.className = "ep-overview-lines";
    const updRow = document.createElement("div");
    updRow.className = "ep-overview-stat ep-overview-stat-update";
    const updStrong = document.createElement("strong"); updStrong.textContent = stats.updatesAvailable + " update" + (stats.updatesAvailable !== 1 ? "s" : "");
    const updDetail = document.createElement("span"); updDetail.className = "ep-overview-detail"; updDetail.textContent = "available";
    updRow.appendChild(updStrong); updRow.appendChild(updDetail);
    ovLines.appendChild(updRow);
    ovBody.appendChild(ovLines);
  }

  // Active lists: proto-card style accordions by type
  const hotfixActive = !!epLists["protoconsent_hotfix"];
  const hotfixCount = hotfixActive ? (epLists["protoconsent_hotfix"].hotfixCount || 0) : 0;

  if (stats.enabledCount > 0) {
    const activeWrap = document.createElement("div");
    activeWrap.className = "ep-overview-active";

    const activeTitle = document.createElement("div");
    activeTitle.className = "ep-overview-active-title";
    const activeTitleText = document.createElement("span");
    activeTitleText.textContent = "Active lists \u00b7 " + stats.downloadedCount + "/" + stats.catalogCount + " downloaded";
    activeTitle.appendChild(activeTitleText);
    const activeTitleFlags = document.createElement("a");
    activeTitleFlags.href = "purposes-settings.html#regional-filters";
    activeTitleFlags.target = "_blank";
    activeTitleFlags.className = "ep-overview-active-flags";
    activeTitleFlags.hidden = true;
    if (typeof buildRegionalFlags === "function") {
      buildRegionalFlags(activeTitleFlags, { maxFlags: 3 });
    }
    activeTitle.appendChild(activeTitleFlags);
    activeWrap.appendChild(activeTitle);

    const coreActive = coreIds.some(function (id) {
      return epLists[id] && (epLists[id].enabled || epConsentLinkedIds.has(id));
    });
    const cmpActive = cmpIds.some(function (id) {
      return epLists[id] && (epLists[id].enabled || epConsentLinkedIds.has(id));
    });

    const typeGroups = [
      { label: "Blocking", icon: GRID_ICONS + "blocking.svg", grouped: coreActive ? ["ProtoConsent Core"] : [], ids: blockingLists, detail: stats.totalDomains.toLocaleString() + " domains" },
      { label: "Optional", icon: GRID_ICONS + "optional.svg", grouped: [], ids: enhancedLists, detail: enhancedEnabled + " active" },
      { label: "Cosmetic", icon: GRID_ICONS + "cosmetic.svg", grouped: [], ids: cosmeticLists, detail: stats.cosmeticRules.toLocaleString() + " rules" },
      { label: "Banners", icon: GRID_ICONS + "banners.svg", grouped: cmpActive ? ["ProtoConsent Banners"] : [], ids: bannerLists, detail: stats.cmpTemplates.toLocaleString() + " templates" },
      { label: "Detection", icon: GRID_ICONS + "detection.svg", grouped: [], ids: detectionLists, detail: stats.paramsTotal.toLocaleString() + " params \u00b7 " + stats.infoDomains.toLocaleString() + " entries" },
      { label: "Exceptions", icon: GRID_ICONS + "exception.svg", grouped: hotfixActive ? ["ProtoConsent Hotfix"] : [], ids: [], detail: hotfixCount + " domain" + (hotfixCount !== 1 ? "s" : "") },
    ];
    for (let g = 0; g < typeGroups.length; g++) {
      const group = typeGroups[g];
      const activeNames = group.grouped.slice();
      for (let a = 0; a < group.ids.length; a++) {
        const aid = group.ids[a];
        const aData = epLists[aid];
        if (aData && (aData.enabled || epConsentLinkedIds.has(aid))) {
          activeNames.push(epCatalog[aid] ? epCatalog[aid].name : aid);
        }
      }
      if (activeNames.length === 0) continue;

      let card = document.createElement("div");
      card.className = "ep-active-card";
      const cardHeader = document.createElement("div");
      cardHeader.className = "ep-active-card-header";
      cardHeader.setAttribute("role", "button");
      cardHeader.setAttribute("tabindex", "0");
      cardHeader.setAttribute("aria-expanded", "false");
      const chevron = document.createElement("span");
      chevron.className = "ep-active-card-chevron pc-chevron";
      chevron.setAttribute("aria-hidden", "true");
      const iconEl = document.createElement("img");
      iconEl.src = group.icon;
      iconEl.width = 18;
      iconEl.height = 18;
      iconEl.alt = "";
      const nameEl = document.createElement("span");
      nameEl.className = "ep-active-card-name";
      nameEl.textContent = group.label;
      const countEl = document.createElement("span");
      countEl.className = "ep-active-card-count";
      countEl.textContent = activeNames.length + " lists \u00b7 " + group.detail;
      cardHeader.appendChild(chevron);
      cardHeader.appendChild(iconEl);
      cardHeader.appendChild(nameEl);
      cardHeader.appendChild(countEl);

      const cardBody = document.createElement("div");
      cardBody.className = "ep-active-card-body";
      cardBody.hidden = true;
      for (let n = 0; n < activeNames.length; n++) {
        const entry = document.createElement("div");
        entry.className = "ep-active-card-entry";
        entry.textContent = activeNames[n];
        cardBody.appendChild(entry);
      }

      const toggle = (function (c, h, b) {
        return function () {
          const exp = c.classList.toggle("is-expanded");
          h.setAttribute("aria-expanded", exp ? "true" : "false");
          b.hidden = !exp;
        };
      })(card, cardHeader, cardBody);
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
  let blockTotal = coreIds.length > 0 ? 1 : 0;
  blockTotal += blockingLists.length;
  const bk = createGridCard({ id: "ep-card-blocking", iconSrc: GRID_ICONS + "blocking.svg", title: "Blocking", metric: stats.blockingCount + " lists \u00b7 " + stats.totalDomains.toLocaleString() + " domains" });
  const bkBody = bk.body;
  if (coreIds.length > 0) bkBody.appendChild(renderCoreCard(coreIds));
  for (let i = 0; i < blockingLists.length; i++) {
    let lid = blockingLists[i];
    if (isRegionalEntry(epCatalog[lid]) && !epRegionalLanguages.includes(epCatalog[lid].region)) continue;
    bkBody.appendChild(_renderEpListCard(lid));
  }
  grid.appendChild(bk.card);
  grid.appendChild(bk.body);

  // 3. Optional card (optional editorial lists)
  const enhancedMetric = enhancedEnabled > 0
    ? enhancedEnabled + " active"
    : "None active";
  const en = createGridCard({ id: "ep-card-enhanced", iconSrc: GRID_ICONS + "optional.svg", title: "Optional", metric: enhancedMetric });
  const enBody = en.body;
  const disclaimer = document.createElement("div");
  disclaimer.className = "ep-optional-disclaimer";
  disclaimer.textContent = "Community lists for advanced users. May increase blocking aggressiveness or overlap with existing lists.";
  enBody.appendChild(disclaimer);
  enhancedLists.sort(function (a, b) {
    const ae = (epLists[a] && epLists[a].enabled) || epConsentLinkedIds.has(a) ? 0 : 1;
    const be = (epLists[b] && epLists[b].enabled) || epConsentLinkedIds.has(b) ? 0 : 1;
    return ae - be || (epCatalog[a].order || 0) - (epCatalog[b].order || 0);
  });
  for (let i = 0; i < enhancedLists.length; i++) {
    enBody.appendChild(_renderEpListCard(enhancedLists[i]));
  }
  grid.appendChild(en.card);
  grid.appendChild(en.body);

  // 4. Cosmetic card
  const cm = createGridCard({ id: "ep-card-cosmetic", iconSrc: GRID_ICONS + "cosmetic.svg", title: "Cosmetic", metric: stats.cosmeticRules.toLocaleString() + " rules" });
  const cmBody = cm.body;
  for (let i = 0; i < cosmeticLists.length; i++) {
    let lid = cosmeticLists[i];
    if (isRegionalEntry(epCatalog[lid]) && !epRegionalLanguages.includes(epCatalog[lid].region)) continue;
    cmBody.appendChild(_renderEpListCard(lid));
  }
  grid.appendChild(cm.card);
  grid.appendChild(cm.body);

  // 5. Banners card
  const bn = createGridCard({ id: "ep-card-banners", iconSrc: GRID_ICONS + "banners.svg", title: "Banners", metric: stats.cmpTemplates.toLocaleString() + " templates" });
  const bnBody = bn.body;
  if (cmpIds.length > 0) bnBody.appendChild(renderCmpCard(cmpIds));
  for (let i = 0; i < bannerLists.length; i++) {
    bnBody.appendChild(_renderEpListCard(bannerLists[i]));
  }
  grid.appendChild(bn.card);
  grid.appendChild(bn.body);

  // 6. Detection card
  const dt = createGridCard({ id: "ep-card-detection", iconSrc: GRID_ICONS + "detection.svg", title: "Detection", metric: stats.infoCount + " info \u00b7 " + stats.paramsTotal + " params" });
  const dtBody = dt.body;
  for (let i = 0; i < detectionLists.length; i++) {
    dtBody.appendChild(_renderEpListCard(detectionLists[i]));
  }
  grid.appendChild(dt.card);
  grid.appendChild(dt.body);

  // 7. Exceptions card (hotfix domains - always visible)
  const exMetric = hotfixActive && hotfixCount > 0
    ? hotfixCount + " domain" + (hotfixCount !== 1 ? "s" : "")
    : "No corrections";
  const ex = createGridCard({ id: "ep-card-exceptions", iconSrc: GRID_ICONS + "exception.svg", title: "Exceptions", metric: exMetric });
  const exBody = ex.body;
  (function (body) {
    chrome.storage.local.get(["enhancedData_protoconsent_hotfix"], function (result) {
      const data = result.enhancedData_protoconsent_hotfix;
      if (!data || !data.domains || !data.domains.length) {
        body.textContent = "No active corrections. Hotfix domains will appear here when blocking corrections are applied between extension releases.";
        return;
      }
      const domains = data.domains;
      const MAX_LISTED = 50;
      const wrap = document.createElement("div");
      wrap.className = "ep-hotfix-domains";
      const desc = document.createElement("div");
      desc.className = "ep-hotfix-desc";
      desc.textContent = "Domains excluded from blocking lists to correct false positives or remove inactive entries.";
      wrap.appendChild(desc);
      const limit = Math.min(domains.length, MAX_LISTED);
      for (let i = 0; i < limit; i++) {
        const entry = document.createElement("div");
        entry.className = "ep-hotfix-domain-entry";
        entry.textContent = domains[i];
        wrap.appendChild(entry);
      }
      if (domains.length > MAX_LISTED) {
        const remaining = domains.length - MAX_LISTED;
        const toggle = document.createElement("div");
        toggle.className = "ep-hotfix-domain-entry ep-hotfix-toggle";
        toggle.textContent = "and " + remaining.toLocaleString() + " more...";
        toggle.style.cursor = "pointer";
        toggle.style.opacity = "0.7";
        let expanded = false;
        const extra = document.createElement("div");
        extra.style.display = "none";
        for (let j = MAX_LISTED; j < domains.length; j++) {
          const el = document.createElement("div");
          el.className = "ep-hotfix-domain-entry";
          el.textContent = domains[j];
          extra.appendChild(el);
        }
        toggle.addEventListener("click", function () {
          expanded = !expanded;
          extra.style.display = expanded ? "" : "none";
          toggle.textContent = expanded
            ? "show less"
            : "and " + remaining.toLocaleString() + " more...";
        });
        wrap.appendChild(toggle);
        wrap.appendChild(extra);
      }
      body.appendChild(wrap);
    });
  })(exBody);
  grid.appendChild(ex.card);
  grid.appendChild(ex.body);

  container.appendChild(grid);

  const MASTER_OFF_TIP = "Disabled - enable via quick toggles in header";
  chrome.storage.local.get(["enhancedCosmeticEnabled", "cmpAutoResponse", "paramStrippingEnabled"], function (r) {
    if (r.enhancedCosmeticEnabled === false) {
      const c = document.getElementById("ep-card-cosmetic");
      if (c) { c.classList.add("is-master-off"); c.title = MASTER_OFF_TIP; }
    }
    if (r.cmpAutoResponse === false) {
      const b = document.getElementById("ep-card-banners");
      if (b) { b.classList.add("is-master-off"); b.title = MASTER_OFF_TIP; }
    }
    if (r.paramStrippingEnabled === false) {
      container.querySelectorAll('.ep-list-card[data-list-type="tracking_params"], .ep-list-card[data-list-type="tracking_params_sites"]')
        .forEach(function (el) { el.classList.add("is-master-off"); el.title = MASTER_OFF_TIP; });
    }
  });

  // Restore expanded card
  if (prevExpanded) {
    let card = document.getElementById(prevExpanded);
    if (card) {
      let toggle = card.querySelector(".pc-grid-card-toggle");
      if (toggle) toggle.click();
    }
  }

  // Restore focus to the control of the list that was just acted on
  if (_epFocusListId) {
    const target = container.querySelector('.ep-list-card[data-list-id="' + _epFocusListId + '"]');
    if (target) {
      const focusable = target.querySelector("input, button");
      if (focusable) focusable.focus();
      target.scrollIntoView({ block: "nearest", behavior: "instant" });
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
  if (listId.startsWith("protoconsent_")) card.classList.add("is-own");
  card.dataset.listId = listId;
  if (listDef) card.dataset.listType = listDef.type;
  if (listData?.enabled || isConsentLinked) card.classList.add("is-enabled");

  const header = document.createElement("div");
  header.className = "ep-list-header";

  const chevron = document.createElement("span");
  chevron.className = "ep-list-chevron pc-chevron";
  chevron.setAttribute("aria-hidden", "true");
  header.appendChild(chevron);

  const icon = document.createElement("img");
  icon.src = ENHANCED_ICON;
  icon.width = 16;
  icon.height = 16;
  icon.alt = "";
  icon.className = "ep-list-icon";
  icon.onerror = function() { this.style.display = "none"; };
  header.appendChild(icon);

  // Regional flag(s)
  if (listDef.flag) {
    const flags = Array.isArray(listDef.flag) ? listDef.flag : [listDef.flag];
    const maxFlags = 2;
    for (let fi = 0; fi < flags.length && fi < maxFlags; fi++) {
      const flagImg = document.createElement("img");
      flagImg.src = "../icons/flags/" + flags[fi].toLowerCase() + ".svg";
      flagImg.width = 16;
      flagImg.height = 12;
      flagImg.alt = flags[fi];
      flagImg.className = "ep-regional-flag";
      flagImg.onerror = function() { this.style.display = "none"; };
      header.appendChild(flagImg);
    }
    if (flags.length > maxFlags) {
      const overflow = document.createElement("span");
      overflow.className = "ep-regional-flag-text";
      overflow.textContent = "+" + (flags.length - maxFlags);
      header.appendChild(overflow);
    }
  }

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
  if (listDef.type === "cosmetic") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-cosmetic-pill";
    pill.title = "Cosmetic filtering - hides ad elements on pages";
    pill.setAttribute("aria-label", "Cosmetic filtering");
    pill.textContent = "\u25D0 Cosmetic";
    header.appendChild(pill);
  } else if (listDef.type === "cmp" || listDef.type === "cmp_detectors" || listDef.type === "cmp_site") {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-cmp-pill";
    pill.title = "Cookie banner management";
    pill.setAttribute("aria-label", "Cookie banner management");
    const cmpIcon = document.createElement("img");
    cmpIcon.src = "../icons/grid/banners.svg";
    cmpIcon.width = 12;
    cmpIcon.height = 12;
    cmpIcon.alt = "";
    cmpIcon.onerror = function() { this.style.display = "none"; };
    pill.appendChild(cmpIcon);
    pill.appendChild(document.createTextNode(" Banners"));
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
    const pcfg = typeof purposesConfig !== "undefined" && listDef.category ? purposesConfig[listDef.category] : null;
    catLabel.textContent = (pcfg && pcfg.short_label) || catInfo.label;
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
    } else if (listData.type === "cmp" || listData.type === "cmp_detectors" || listData.type === "cmp_site") {
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

    const remoteTS = listDef && (listDef.generated || listDef.version);
    const localTS = listData.generated || listData.version;
    if (remoteTS && localTS && remoteTS > localTS) {
      const updateBadge = document.createElement("span");
      updateBadge.className = "ep-update-badge";
      updateBadge.textContent = "Update available";
      updateBadge.title = "Remote: " + remoteTS + " (installed: " + localTS + ")";
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
