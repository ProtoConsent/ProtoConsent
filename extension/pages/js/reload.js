// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Tab reload and post-reload counter polling.
// Loaded after popup.js - uses globals: lastBlocked, lastGpcSignalsSent,
// activeMode, displayBlockedCount, refreshPopupState, isSupportedWebUrl.

function waitForTabReload(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!chrome.tabs || !chrome.tabs.onUpdated) {
      resolve(false);
      return;
    }

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

async function reloadActiveTab() {
  const reloadBtn = document.getElementById("pc-reload-btn");
  const countEl = document.getElementById("pc-blocked-count");
  if (!reloadBtn || !chrome.tabs) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || !isSupportedWebUrl(tab.url)) return;

    reloadBtn.disabled = true;
    reloadBtn.classList.remove("is-recommended");
    if (countEl) countEl.textContent = "Reloading page...";
    let protoStatus = document.getElementById("proto-status");
    if (protoStatus && typeof activeMode !== "undefined" && activeMode === "proto") {
      protoStatus.textContent = "Reloading page...";
    }

    chrome.tabs.reload(tab.id, {}, async () => {
      if (chrome.runtime.lastError) {
        console.error("ProtoConsent: reload request failed:", chrome.runtime.lastError);
        if (reloadBtn) reloadBtn.disabled = false;
        await displayBlockedCount();
        return;
      }

      const reloaded = await waitForTabReload(tab.id);
      const reloadBtnEl = document.getElementById("pc-reload-btn");

      if (reloadBtnEl) reloadBtnEl.disabled = false;

      await refreshPopupState();
      _schedulePostReloadRefreshes();
    });
  } catch (err) {
    console.error("ProtoConsent: reload failed:", err);
    reloadBtn.disabled = false;
    await displayBlockedCount();
  }
}

// After a page reload, poll for updated counters until they stabilise.
// Polls every 2s, stops after 5 consecutive polls with no change (max 60s).
let _postReloadTimer = null;
function _schedulePostReloadRefreshes() {
  if (_postReloadTimer) clearInterval(_postReloadTimer);
  let lastSnap = -1;
  let stableRounds = 0;
  const maxRounds = 30;
  let round = 0;
  let polling = false;
  _postReloadTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      round++;
      await displayBlockedCount();
      const cur = lastBlocked + (lastGpcSignalsSent || 0);
      if (cur === lastSnap) stableRounds++;
      else { stableRounds = 0; lastSnap = cur; }
      if (stableRounds >= 5 || round >= maxRounds) {
        clearInterval(_postReloadTimer);
        _postReloadTimer = null;
      }
    } finally { polling = false; }
  }, 2000);
}
