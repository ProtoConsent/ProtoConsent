// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// ProtoConsent Core group helpers: renders the 5 protoconsent_* sub-lists
// as a single "ProtoConsent Core" card in the Enhanced tab.
// Loaded before enhanced.js - shares globals: epCatalog, epLists,
// epConsentLinkedIds, ENHANCED_ICON, _epFocusListId,
// refreshEnhancedState, ensurePresetForDownload, formatRelativeTime,
// getEnhancedCategoryInfo.

const CORE_PREFIX = "protoconsent_";
function getCoreIds() {
  return Object.keys(epCatalog).filter(id =>
    id.startsWith(CORE_PREFIX) && epCatalog[id].type !== "cmp");
}

function renderCoreCard(coreIds) {
  // Aggregate state across all core sub-lists
  const coreData = coreIds.map(id => epLists[id]).filter(Boolean);
  const allDownloaded = coreData.length === coreIds.length;
  const anyDownloaded = coreData.length > 0;
  const isCoreConsentLinked = coreIds.some(id => epConsentLinkedIds.has(id));
  const allEnabled = anyDownloaded && coreData.every(d => d.enabled);
  const anyEnabled = anyDownloaded && (coreData.some(d => d.enabled) || isCoreConsentLinked);

  const card = document.createElement("div");
  card.className = "ep-list-card";
  card.dataset.listId = "protoconsent_core";
  if (anyEnabled) card.classList.add("is-enabled");

  // Header
  const header = document.createElement("div");
  header.className = "ep-list-header";

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
  nameEl.title = "ProtoConsent Core";
  const nameTxt = document.createTextNode("ProtoConsent Core");
  const chevron = document.createElement("span");
  chevron.className = "ep-list-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = " \u25BE";
  nameEl.appendChild(nameTxt);
  nameEl.appendChild(chevron);
  header.appendChild(nameEl);

  // CEL icon when any core sub-list is consent-linked
  if (isCoreConsentLinked) {
    const celIcon = document.createElement("img");
    celIcon.src = "../icons/protoconsent_icon_32.png";
    celIcon.width = 14;
    celIcon.height = 14;
    celIcon.alt = "";
    celIcon.className = "ep-cel-icon";
    const linkedPurposes = coreIds
      .filter(id => epConsentLinkedIds.has(id))
      .map(id => {
        const ci = typeof getEnhancedCategoryInfo === "function" ? getEnhancedCategoryInfo(id) : null;
        return ci ? ci.label : id;
      });
    celIcon.title = "Consent-linked: activated by denied " + linkedPurposes.join(", ");
    header.appendChild(celIcon);
  }

  // Core pill
  const pill = document.createElement("span");
  pill.className = "ep-category-pill ep-core-pill";
  pill.title = "ProtoConsent own blocklist";
  pill.textContent = "\u25C9 Core";
  header.appendChild(pill);

  if (anyDownloaded) {
    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ep-list-remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove ProtoConsent Core data";
    removeBtn.setAttribute("aria-label", "Remove ProtoConsent Core");
    removeBtn.addEventListener("click", () => removeCoreGroup(coreIds));
    header.appendChild(removeBtn);

    // Toggle (controls all 5)
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "ep-list-toggle";
    toggle.checked = allEnabled || isCoreConsentLinked;
    if (isCoreConsentLinked) {
      toggle.disabled = true;
      toggle.title = "ProtoConsent Core - activated by consent link";
    } else {
      toggle.title = allEnabled ? "Disable ProtoConsent Core" : "Enable ProtoConsent Core";
    }
    toggle.setAttribute("aria-label", (allEnabled ? "Disable" : "Enable") + " ProtoConsent Core");
    toggle.addEventListener("change", () => toggleCoreGroup(coreIds, toggle.checked));
    header.appendChild(toggle);
  } else {
    // Download button
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "ep-list-download-btn";
    dlBtn.textContent = "Download";
    dlBtn.title = "Download ProtoConsent Core";
    dlBtn.setAttribute("aria-label", "Download ProtoConsent Core");
    dlBtn.dataset.listId = "protoconsent_core";
    dlBtn.addEventListener("click", () => fetchCoreGroup(coreIds, dlBtn));
    header.appendChild(dlBtn);
  }

  card.appendChild(header);

  // Expand/collapse
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

  // Info row
  const info = document.createElement("div");
  info.className = "ep-list-info";

  const desc = document.createElement("span");
  desc.className = "ep-list-desc";
  desc.textContent = "Aggregated core blocklist covering all purposes";
  info.appendChild(desc);

  if (anyDownloaded) {
    const stats = document.createElement("span");
    stats.className = "ep-list-stats";
    let totalDomains = 0;
    let totalPaths = 0;
    for (const d of coreData) {
      totalDomains += d.domainCount || 0;
      totalPaths += d.pathRuleCount || 0;
    }
    const parts = [];
    if (totalDomains) parts.push(totalDomains.toLocaleString() + " tracking rules");
    if (totalPaths) parts.push(totalPaths.toLocaleString() + " path rules");
    if (coreData[0]?.version) parts.push("v" + coreData[0].version);
    stats.textContent = parts.join(" \u00B7 ");
    info.appendChild(stats);
  }

  card.appendChild(info);

  // Meta row
  const meta = document.createElement("div");
  meta.className = "ep-list-meta";
  meta.textContent = "GPL-3.0-or-later";
  const latest = coreData.reduce((max, d) => Math.max(max, d?.lastFetched || 0), 0);
  if (latest) {
    meta.textContent += " \u00B7 Updated " + formatRelativeTime(latest);
  }
  card.appendChild(meta);

  return card;
}

// Fetch all core sub-lists as a group
function fetchCoreGroup(coreIds, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Downloading\u2026";
  }
  const doFetch = () => {
    let completed = 0;
    let failed = 0;
    for (const listId of coreIds) {
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
        if (chrome.runtime.lastError) resp = null;
        completed++;
        if (!resp?.ok) failed++;
        if (btnEl) btnEl.textContent = completed + "/" + coreIds.length + "\u2026";
        if (completed >= coreIds.length) {
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = failed > 0 ? failed + " failed" : "Done";
          }
          refreshEnhancedState();
        }
      });
    }
  };
  ensurePresetForDownload(doFetch);
}

// Toggle all core sub-lists together
function toggleCoreGroup(coreIds, enabled) {
  _epFocusListId = "protoconsent_core";
  let pending = coreIds.length;
  for (const listId of coreIds) {
    chrome.runtime.sendMessage({
      type: "PROTOCONSENT_ENHANCED_TOGGLE", listId, enabled,
    }, () => {
      pending--;
      if (pending <= 0) refreshEnhancedState();
    });
  }
}

// Remove all core sub-lists together
function removeCoreGroup(coreIds) {
  _epFocusListId = "protoconsent_core";
  let pending = coreIds.length;
  for (const listId of coreIds) {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_REMOVE", listId }, () => {
      pending--;
      if (pending <= 0) refreshEnhancedState();
    });
  }
}
