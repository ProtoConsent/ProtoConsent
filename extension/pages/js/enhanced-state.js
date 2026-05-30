// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Enhanced tab: in-memory state, presets data, stats calc, refresh orchestrator.
// Shared globals owned here; read by enhanced-render.js and enhanced-core.js.

let epCatalog = {};
let epLists = {};
let epPreset = "off";
let epDynamicConsent = false;
let epConsentEnhancedLink = false;
let epConsentLinkedIds = new Set();
let epHasRegionalLanguages = false;
let epRegionalLanguages = [];
let _epFocusListId = null; // list to refocus after re-render
let _celAutoFetchInProgress = false;
let _fetchPollTimer = null;
let _batchInProgress = false;

// --- Shared stats helper ---
function getEnhancedStats() {
  // Include consent-linked lists as active even if not manually enabled
  const activeLists = Object.entries(epLists)
    .filter(([id, l]) => (l.enabled || epConsentLinkedIds.has(id)) && l.type !== "revoke")
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
  let coreUpdate = false;
  let cmpUpdate = false;
  for (const id of Object.keys(epLists)) {
    if (epLists[id].bundled) continue;
    const catalogDef = epCatalog[id];
    let hasUpdate = false;
    const catTS = catalogDef && (catalogDef.generated || catalogDef.version);
    const localTS = epLists[id].generated || epLists[id].version;
    hasUpdate = catTS && localTS && catTS > localTS;
    if (!hasUpdate) continue;
    if (CORE_IDS.has(id)) { coreUpdate = true; continue; }
    if (CMP_IDS.has(id)) { cmpUpdate = true; continue; }
    updatesAvailable++;
  }
  if (coreUpdate) updatesAvailable++;
  if (cmpUpdate) updatesAvailable++;
  if (epHasRegionalLanguages) {
    for (const id of Object.keys(epCatalog)) {
      if (isRegionalEntry(epCatalog[id]) && epRegionalLanguages.includes(epCatalog[id].region) && !epLists[id]) updatesAvailable++;
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
    downloadedCount: Object.keys(epLists).filter(id => !(isRegionalEntry(epCatalog[id]) && !epRegionalLanguages.includes(epCatalog[id]?.region)) && epLists[id].type !== "revoke" && (!epCatalog[id] || epCatalog[id].preset !== "optional")).length - coreExtraDownloaded - cmpExtraDownloaded,
    catalogCount: Object.keys(epCatalog).filter(id => !(isRegionalEntry(epCatalog[id]) && !epRegionalLanguages.includes(epCatalog[id].region)) && epCatalog[id].type !== "revoke" && epCatalog[id].preset !== "optional").length - coreExtraCatalog - cmpExtraCatalog,
    notDownloaded: Object.keys(epCatalog).filter(id => !epLists[id] && !isGroupedId(id) && !(isRegionalEntry(epCatalog[id]) && !epRegionalLanguages.includes(epCatalog[id].region)) && epCatalog[id].type !== "revoke" && epCatalog[id].preset !== "optional" && !(epPreset === "basic" && epCatalog[id].preset !== "basic"))
      .concat(coreCatalogIds.length > 0 && !coreDownloadedIds.length ? [coreCatalogIds[0]] : [])
      .concat(cmpCatalogIds.length > 0 && !cmpDownloadedIds.length ? [cmpCatalogIds[0]] : []),
    updatesAvailable,
  };
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
    // Read regional languages to determine if regional lists should be included
    chrome.storage.local.get(["regionalLanguages"], (rl) => {
      epRegionalLanguages = Array.isArray(rl.regionalLanguages) ? rl.regionalLanguages : [];
      epHasRegionalLanguages = epRegionalLanguages.length > 0;
      renderEnhancedPresets();
      renderEnhancedLists();
      updateEnhancedStatus();
      // Show header indicator if background is mid-download
      if (resp.activeFetches > 0) setHeaderDownloadIndicator(true);
      // Auto-download consent-linked lists not yet downloaded
      const celPending = resp.celPendingDownload || [];
      if (celPending.length > 0 && !_celAutoFetchInProgress) {
        _celAutoFetchInProgress = true;
        downloadAllEnhancedLists(null, celPending);
      } else if (celPending.length === 0) {
        _celAutoFetchInProgress = false;
      }
    });
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
