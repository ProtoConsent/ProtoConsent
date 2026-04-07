// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Enhanced Protection tab: preset selector, per-list toggles, fetch triggers.
// Loaded after popup.js - shares globals: activeMode.
// Communicates with background.js via PROTOCONSENT_ENHANCED_* messages.

let epCatalog = {};
let epLists = {};
let epPreset = "off";
let _epFocusListId = null; // list to refocus after re-render

// --- Shared stats helper ---
function getEnhancedStats() {
  const enabledLists = Object.values(epLists).filter(l => l.enabled);
  const blockingLists = enabledLists.filter(l => l.type !== "informational");
  const infoLists = enabledLists.filter(l => l.type === "informational");
  return {
    enabledCount: enabledLists.length,
    blockingCount: blockingLists.length,
    infoCount: infoLists.length,
    totalDomains: blockingLists.reduce((sum, l) => sum + (l.domainCount || 0), 0),
    downloadedCount: Object.keys(epLists).length,
    catalogCount: Object.keys(epCatalog).length,
    notDownloaded: Object.keys(epCatalog).filter(id => !epLists[id]),
  };
}

// Auto-switch preset from off to basic before downloading
function ensurePresetForDownload(callback) {
  if (epPreset === "off") {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_SET_PRESET", preset: "basic" }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        // Proceed anyway - download will still work, just won't auto-enable
        callback();
        return;
      }
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
    renderEnhancedPresets();
    renderEnhancedLists();
    updateEnhancedStatus();
    if (typeof displayEnhancedScope === "function") displayEnhancedScope();
  });
}

// --- Preset buttons + contextual action ---

function renderEnhancedPresets() {
  const container = document.getElementById("ep-preset-buttons");
  if (!container) return;
  container.innerHTML = "";

  const allPresets = epPreset === "custom"
    ? [...EP_PRESETS, { id: "custom", label: "Custom", description: "You have customized individual list toggles" }]
    : EP_PRESETS;

  for (let i = 0; i < allPresets.length; i++) {
    const preset = allPresets[i];
    const isActive = epPreset === preset.id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ep-preset-btn" + (isActive ? " is-active" : "");
    btn.textContent = preset.label;
    btn.title = preset.description;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
    btn.setAttribute("tabindex", isActive ? "0" : "-1");
    if (preset.id === "custom") {
      btn.disabled = true;
      btn.setAttribute("aria-label", "Custom preset (set by individual list toggles)");
    } else {
      btn.addEventListener("click", () => setEnhancedPreset(preset.id));
    }
    container.appendChild(btn);
  }

  // Contextual action button (right side of preset bar)
  renderPresetAction();
}

// Arrow-key navigation for radiogroup (roving tabindex).
// Attached once - queries children dynamically so it works after re-renders.
(function() {
  const container = document.getElementById("ep-preset-buttons");
  if (!container) return;
  container.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const radios = [...container.querySelectorAll('[role="radio"]:not(:disabled)')];
    const current = radios.indexOf(document.activeElement);
    if (current < 0) return;
    const next = (e.key === "ArrowRight" || e.key === "ArrowDown")
      ? (current + 1) % radios.length
      : (current - 1 + radios.length) % radios.length;
    radios[current].setAttribute("tabindex", "-1");
    radios[next].setAttribute("tabindex", "0");
    radios[next].focus();
    radios[next].click();
  });
})();

function renderPresetAction() {
  const bar = document.getElementById("ep-preset-bar");
  if (!bar) return;

  // Remove previous action if any
  const prev = bar.querySelector(".ep-preset-action");
  if (prev) prev.remove();

  const { enabledCount, downloadedCount, catalogCount, notDownloaded } = getEnhancedStats();

  if (notDownloaded.length > 0) {
    // Some lists not downloaded: show "↓ Download all"
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ep-preset-action ep-preset-action-download";
    btn.textContent = "↓ Download all";
    btn.title = "Download " + notDownloaded.length + " remaining lists";
    btn.addEventListener("click", () => downloadAllEnhancedLists(btn));
    bar.appendChild(btn);
  } else if (enabledCount > 0 && notDownloaded.length === 0) {
    // All downloaded, some enabled: show "↻ Update all"
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ep-preset-action ep-preset-action-update";
    btn.textContent = "↻ Update all";
    btn.title = "Refresh all downloaded lists";
    btn.addEventListener("click", () => updateAllEnhancedLists(btn));
    bar.appendChild(btn);
  } else if (downloadedCount > 0) {
    // Downloaded but none enabled (preset off or custom): summary
    const span = document.createElement("span");
    span.className = "ep-preset-action ep-preset-action-summary";
    span.textContent = downloadedCount + "/" + catalogCount + " downloaded";
    bar.appendChild(span);
  }
}

function setEnhancedPreset(preset) {
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_SET_PRESET", preset }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    epPreset = preset;
    // If switching to basic or full, auto-download missing lists
    if (preset === "basic" || preset === "full") {
      const missing = Object.keys(epCatalog).filter(id => {
        if (epLists[id]) return false;
        if (preset === "basic") return epCatalog[id].preset === "basic";
        return true;
      });
      if (missing.length > 0) {
        const dlBtn = document.querySelector(".ep-preset-action-download");
        downloadAllEnhancedLists(dlBtn, missing);
        return;
      }
    }
    refreshEnhancedState();
  });
}

// --- List cards ---

function renderEnhancedLists() {
  const container = document.getElementById("ep-lists");
  if (!container) return;
  container.innerHTML = "";

  const catalogEntries = Object.entries(epCatalog);
  if (catalogEntries.length === 0) {
    container.innerHTML = '<div class="ep-empty">No enhanced lists available.</div>';
    return;
  }

  for (const [listId, listDef] of catalogEntries) {
    const listData = epLists[listId];
    const card = document.createElement("div");
    card.className = "ep-list-card";
    card.dataset.listId = listId;
    if (listData?.enabled) card.classList.add("is-enabled");

    // Header row: icon + name + actions
    const header = document.createElement("div");
    header.className = "ep-list-header";

    const icon = document.createElement("img");
    icon.src = ENHANCED_ICON;
    icon.width = 16;
    icon.height = 16;
    icon.alt = "";
    icon.className = "ep-list-icon";
    icon.onerror = function() {
      this.style.display = "none";
    };
    header.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "ep-list-name";
    nameEl.title = listDef.name;
    const nameTxt = document.createTextNode(listDef.name);
    const chevron = document.createElement("span");
    chevron.className = "ep-list-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = " ▾";
    nameEl.appendChild(nameTxt);
    nameEl.appendChild(chevron);
    header.appendChild(nameEl);

    // Category pill (CC icon + label) for lists with a mapped purpose
    const catInfo = typeof getEnhancedCategoryInfo === "function" ? getEnhancedCategoryInfo(listId) : null;
    if (catInfo) {
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
      // Remove button (delete downloaded data)
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ep-list-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove downloaded data for " + listDef.name;
      removeBtn.setAttribute("aria-label", "Remove " + listDef.name);
      removeBtn.addEventListener("click", () => removeEnhancedList(listId));
      header.appendChild(removeBtn);

      // Toggle
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "ep-list-toggle";
      toggle.checked = !!listData.enabled;
      toggle.title = listData.enabled ? "Disable " + listDef.name : "Enable " + listDef.name;
      toggle.setAttribute("aria-label", (listData.enabled ? "Disable " : "Enable ") + listDef.name);
      toggle.addEventListener("change", () => {
        toggleEnhancedList(listId, toggle.checked);
      });
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

    // Expand/collapse: click on header toggles info + meta visibility
    header.setAttribute("tabindex", "0");
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", "false");
    header.addEventListener("click", (e) => {
      // Don't toggle when clicking on interactive elements (toggle, buttons)
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

    // Info row: description + stats
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
      } else {
        if (listData.domainCount) parts.push(listData.domainCount.toLocaleString() + " tracking rules");
        if (listData.pathRuleCount) parts.push(listData.pathRuleCount.toLocaleString() + " path rules");
      }
      if (listData.version) parts.push("v" + listData.version);
      stats.textContent = parts.join(" · ");
      info.appendChild(stats);
    }

    card.appendChild(info);

    // Meta row: license + last fetched
    const meta = document.createElement("div");
    meta.className = "ep-list-meta";
    meta.textContent = listDef.license;
    if (listData?.lastFetched) {
      meta.textContent += " · Updated " + formatRelativeTime(listData.lastFetched);
    }
    card.appendChild(meta);

    container.appendChild(card);
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
  const notDownloaded = filterIds || Object.keys(epCatalog).filter(id => !epLists[id]);
  if (notDownloaded.length === 0) return;

  const startDownloads = () => {
    const total = notDownloaded.length;
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = "0/" + total + "…";
    }
    // Disable preset buttons to prevent re-render mid-download
    const presetBtns = document.querySelectorAll(".ep-preset-btn");
    for (const b of presetBtns) b.disabled = true;
    // Mark each card's Download button as pending
    for (const listId of notDownloaded) {
      const cardBtn = document.querySelector('.ep-list-download-btn[data-list-id="' + listId + '"]');
      if (cardBtn) {
        cardBtn.disabled = true;
        cardBtn.textContent = "Pending…";
        cardBtn.classList.add("is-pending");
      }
    }
    let completed = 0;
    let failed = 0;
    for (const listId of notDownloaded) {
      // Mark as actively downloading
      const cardBtn = document.querySelector('.ep-list-download-btn[data-list-id="' + listId + '"]');
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
        if (chrome.runtime.lastError) resp = null;
        completed++;
        if (!resp?.ok) {
          failed++;
          if (cardBtn) {
            cardBtn.textContent = "Failed";
            cardBtn.classList.remove("is-pending");
            cardBtn.classList.add("is-failed");
          }
        } else if (cardBtn) {
          cardBtn.textContent = "Done";
          cardBtn.classList.remove("is-pending");
        }
        if (btnEl) {
          btnEl.textContent = completed + "/" + total + "…";
        }
        if (completed >= total) {
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
  const total = downloadedIds.length;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "0/" + total + "…";
  }
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
        }
        setTimeout(() => refreshEnhancedState(), 500);
      }
    });
  }
}

function updateEnhancedStatus() {
  const statusEl = document.getElementById("ep-status");
  if (!statusEl) return;

  const { enabledCount, blockingCount, infoCount, totalDomains } = getEnhancedStats();
  const infoDomains = Object.values(epLists)
    .filter(l => l.enabled && l.type === "informational")
    .reduce((sum, l) => sum + (l.domainCount || 0), 0);

  if (enabledCount > 0) {
    const parts = [];
    if (blockingCount > 0) {
      parts.push(blockingCount + " " + (blockingCount === 1 ? "blocklist" : "blocklists") +
        " \u00b7 " + totalDomains.toLocaleString() + " rules");
    }
    if (infoCount > 0) {
      parts.push(infoCount + " info " + (infoCount === 1 ? "list" : "lists") +
        " \u00b7 " + infoDomains.toLocaleString() + " entries");
    }
    statusEl.textContent = parts.join(" \u00b7 ");
    statusEl.className = "ep-status ep-status-active";
  } else {
    statusEl.textContent = "No enhanced lists active - using ProtoConsent core lists only";
    statusEl.className = "ep-status";
  }
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
