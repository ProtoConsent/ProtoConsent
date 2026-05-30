// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Enhanced tab: list toggle/fetch/remove, batch download/update, master-toggle listener.
// Sends messages to the service worker and re-invokes enhanced-render.js functions.

function _pollActiveFetches() {
  // Don't turn off the spinner while a UI-initiated batch is running
  if (_batchInProgress) return;
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_FETCH_COUNT" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.activeFetches === 0) setHeaderDownloadIndicator(false);
  });
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

function setEnhancedPreset(preset) {
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_SET_PRESET", preset }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    epPreset = preset;
    // If switching to basic or full, auto-download missing lists
    if (preset === "basic" || preset === "full") {
      chrome.storage.local.get(["regionalLanguages"], (rl) => {
        const langs = Array.isArray(rl.regionalLanguages) ? rl.regionalLanguages : [];
        const missing = Object.keys(epCatalog).filter(id => {
          if (epLists[id]) return false;
          if (isRegionalEntry(epCatalog[id]) && !langs.includes(epCatalog[id].region)) return false;
          if (epCatalog[id].preset === "optional") return false;
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
  _epFocusListId = listId;
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
  if (filterIds) {
    _downloadEnhancedBatch(btnEl, filterIds);
  } else {
    chrome.storage.local.get(["regionalLanguages"], (rl) => {
      const langs = Array.isArray(rl.regionalLanguages) ? rl.regionalLanguages : [];
      const notDownloaded = Object.keys(epCatalog).filter(id => {
        if (epLists[id]) return false;
        if (isRegionalEntry(epCatalog[id]) && !langs.includes(epCatalog[id].region)) return false;
        if (epCatalog[id].preset === "optional") return false;
        if (epPreset === "basic" && epCatalog[id].preset !== "basic") return false;
        return true;
      });
      _downloadEnhancedBatch(btnEl, notDownloaded);
    });
  }
}

function _downloadEnhancedBatch(btnEl, notDownloaded) {
  if (notDownloaded.length === 0) return;

  const startDownloads = () => {
    const total = notDownloaded.length;
    _batchInProgress = true;
    setHeaderDownloadIndicator(true);
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
          _batchInProgress = false;
          setHeaderDownloadIndicator(false);
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
  if (Object.keys(epLists).length === 0) return;

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

    const downloadedIds = Object.keys(epLists);
    // Include undownloaded per-source regional lists whose language is selected
    const pendingRegional = epHasRegionalLanguages
      ? Object.keys(epCatalog).filter(id => isRegionalEntry(epCatalog[id]) && epRegionalLanguages.includes(epCatalog[id].region) && !epLists[id])
      : [];
    // Skip old aggregate regional IDs and per-source entries whose region isn't selected
    const filtered = downloadedIds.filter(id => !(isRegionalEntry(epCatalog[id]) && !epRegionalLanguages.includes(epCatalog[id]?.region)));
    const allIds = filtered.concat(pendingRegional);
    const total = allIds.length;
    if (btnEl) btnEl.textContent = "Checking…";
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let updated = 0;
    for (const listId of allIds) {
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_FETCH", listId }, (resp) => {
        if (chrome.runtime.lastError) {
          resp = null;
        }
        completed++;
        if (!resp?.ok) {
          failed++;
        }
        else if (resp.skipped) skipped++;
        else updated++;
        if (btnEl) {
          if (updated > 0 || failed > 0) btnEl.textContent = updated + " updated…";
          else btnEl.textContent = "Checking…";
        }
        if (completed >= total) {
          if (btnEl) {
            btnEl.disabled = false;
            if (failed > 0) btnEl.textContent = failed + " failed";
            else if (updated === 0) btnEl.textContent = "Up to date";
            else btnEl.textContent = updated + " updated";
          }
          // Announce completion via aria-live region
          const statusEl = document.getElementById("ep-status");
          if (statusEl) {
            if (failed > 0) {
              statusEl.textContent = updated + " updated, " + failed + " failed (" + total + " checked)";
              statusEl.className = "ep-status ep-status-warn";
            } else if (updated === 0) {
              statusEl.textContent = "All " + total + " lists already up to date";
              statusEl.className = "ep-status ep-status-active";
            } else {
              statusEl.textContent = updated + " updated, " + skipped + " already current";
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

const MASTER_OFF_TIP = "Disabled - enable via quick toggles in header";
chrome.storage.onChanged.addListener(function (changes) {
  if ("enhancedCosmeticEnabled" in changes) {
    let off = changes.enhancedCosmeticEnabled.newValue === false;
    const c = document.getElementById("ep-card-cosmetic");
    if (c) { c.classList.toggle("is-master-off", off); c.title = off ? MASTER_OFF_TIP : ""; }
  }
  if ("cmpAutoResponse" in changes) {
    let off = changes.cmpAutoResponse.newValue === false;
    const b = document.getElementById("ep-card-banners");
    if (b) { b.classList.toggle("is-master-off", off); b.title = off ? MASTER_OFF_TIP : ""; }
  }
  if ("paramStrippingEnabled" in changes) {
    let off = changes.paramStrippingEnabled.newValue === false;
    document.querySelectorAll('.ep-list-card[data-list-type="tracking_params"], .ep-list-card[data-list-type="tracking_params_sites"]')
      .forEach(function (el) { el.classList.toggle("is-master-off", off); el.title = off ? MASTER_OFF_TIP : ""; });
  }
});
