// ProtoConsent regional list card renderer for Enhanced tab
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders a single card for regional_cosmetic or regional_blocking in the
// Enhanced tab.  Extracted from enhanced-core.js.
//
// Globals from enhanced-core.js:
//   epCatalog, epLists, ENHANCED_ICON, _epFocusListId,
//   refreshEnhancedState, ensurePresetForDownload, formatRelativeTime

// global epCatalog, epLists, ENHANCED_ICON, _epFocusListId,
//        refreshEnhancedState, ensurePresetForDownload, formatRelativeTime */

function renderRegionalCard(listId) {
  const def = epCatalog[listId];
  if (!def) return null;
  const data = epLists[listId];
  const isDownloaded = !!data;
  const isEnabled = isDownloaded && data.enabled;
  const isCosmetic = def.type === "regional_cosmetic";

  const card = document.createElement("div");
  card.className = "ep-list-card";
  card.dataset.listId = listId;
  if (isEnabled) card.classList.add("is-enabled");

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
  nameEl.title = def.name;
  nameEl.textContent = def.name;
  header.appendChild(nameEl);

  // Active languages indicator (shown in header, visible when collapsed)
  // Always a link to regional settings for easy language configuration
  var langBadge = document.createElement("a");
  langBadge.href = "purposes-settings.html#regional-filters";
  langBadge.target = "_blank";
  langBadge.className = "ep-regional-langs";
  header.appendChild(langBadge);

  if (isCosmetic) {
    const pill = document.createElement("span");
    pill.className = "ep-category-pill ep-cosmetic-pill";
    pill.title = "Cosmetic filtering - hides ad elements on pages";
    pill.setAttribute("aria-label", "Cosmetic filtering");
    pill.textContent = "\u25D0 Cosmetic";
    header.appendChild(pill);
  }

  if (isDownloaded) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ep-list-remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove " + def.name;
    removeBtn.setAttribute("aria-label", "Remove " + def.name);
    removeBtn.addEventListener("click", () => {
      _epFocusListId = listId;
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_REMOVE", listId }, () => {
        refreshEnhancedState();
      });
    });
    header.appendChild(removeBtn);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "ep-list-toggle";
    toggle.checked = isEnabled;
    toggle.title = (isEnabled ? "Disable " : "Enable ") + def.name;
    toggle.setAttribute("aria-label", (isEnabled ? "Disable" : "Enable") + " " + def.name);
    toggle.addEventListener("change", () => {
      _epFocusListId = listId;
      chrome.runtime.sendMessage({
        type: "PROTOCONSENT_ENHANCED_TOGGLE", listId, enabled: toggle.checked,
      }, () => refreshEnhancedState());
    });
    header.appendChild(toggle);
  } else {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "ep-list-download-btn";
    dlBtn.textContent = "Download";
    dlBtn.title = "Download " + def.name;
    dlBtn.setAttribute("aria-label", "Download " + def.name);
    dlBtn.dataset.listId = listId;
    dlBtn.addEventListener("click", () => {
      dlBtn.disabled = true;
      dlBtn.textContent = "Downloading\u2026";
      ensurePresetForDownload(() => {
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
          if (chrome.runtime.lastError) resp = null;
          dlBtn.disabled = false;
          dlBtn.textContent = resp?.ok ? "Done" : (resp?.error || "Failed");
          refreshEnhancedState();
        });
      });
    });
    header.appendChild(dlBtn);
  }

  card.appendChild(header);

  // Expand/collapse: click on header toggles info + meta visibility
  header.setAttribute("tabindex", "0");
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", "false");
  header.addEventListener("click", (e) => {
    if (e.target.closest("input, button, a")) return;
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

  // Load active languages async - update badge with flag images (max 2 + overflow)
  buildRegionalFlags(langBadge, {
    maxFlags: 2,
    emptyText: isDownloaded ? "No regions" : "Select regions",
  });

  // Info row: description + stats
  const info = document.createElement("div");
  info.className = "ep-list-info";

  const desc = document.createElement("span");
  desc.className = "ep-list-desc";
  desc.textContent = def.description;
  info.appendChild(desc);

  if (isDownloaded) {
    const stats = document.createElement("span");
    stats.className = "ep-list-stats";
    const parts = [];
    if (data.regions) {
      parts.push(data.regions.length + " region" + (data.regions.length !== 1 ? "s" : ""));
    }
    if (isCosmetic) {
      if (data.genericCount) parts.push(data.genericCount.toLocaleString() + " generic");
      if (data.domainRuleCount) parts.push(data.domainRuleCount.toLocaleString() + " site rules");
    } else {
      if (data.domainCount) parts.push(data.domainCount.toLocaleString() + " domains");
      if (data.pathRuleCount) parts.push(data.pathRuleCount.toLocaleString() + " path rules");
    }
    if (data.version) parts.push("v" + data.version);
    stats.textContent = parts.join(" \u00B7 ");
    info.appendChild(stats);
  }

  card.appendChild(info);

  // Meta row: license + update time
  const meta = document.createElement("div");
  meta.className = "ep-list-meta";
  meta.textContent = def.license || "GPL-3.0-or-later";
  if (isDownloaded && data.lastFetched) {
    meta.textContent += " \u00B7 Updated " + formatRelativeTime(data.lastFetched);
  }
  card.appendChild(meta);

  return card;
}
