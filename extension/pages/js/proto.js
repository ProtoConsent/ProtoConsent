// ProtoConsent browser extension - Proto tab
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders Monitoring mode observability: coverage metrics,
// attributed purpose cards, signaling status, unattributed buffer.
// Classic script - globals from config.js + popup.js available.

let protoInitialized = false;
let _protoRefreshTimer = null;

function initProtoTab() {
  if (protoInitialized) {
    refreshProtoView();
    _startProtoAutoRefresh();
    return;
  }
  protoInitialized = true;
  refreshProtoView();
  _startProtoAutoRefresh();
}

function _startProtoAutoRefresh() {
  _stopProtoAutoRefresh();
  _protoRefreshTimer = setInterval(() => {
    if (typeof activeMode !== "undefined" && activeMode === "proto") {
      refreshProtoView();
    } else {
      _stopProtoAutoRefresh();
    }
  }, 3000);
}

function _stopProtoAutoRefresh() {
  if (_protoRefreshTimer) {
    clearInterval(_protoRefreshTimer);
    _protoRefreshTimer = null;
  }
}

function refreshProtoView() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    let tabId = tabs[0].id;
    chrome.runtime.sendMessage(
      { type: "PROTOCONSENT_GET_PROTO_DATA", tabId: tabId },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        renderProtoStatus(resp);

        // Gather .well-known + TCF + blocker detection data, then render all
        let domain = (typeof currentDomain !== "undefined") ? currentDomain : "";
        let wkKey = domain ? ("wk_" + domain) : "";
        let pending = 3;
        let wkData = null;
        let tcfData = null;
        let blockerState = null;

        let finishRender = function () {
          pending--;
          if (pending > 0) return;
          _syncProtoPills(tcfData);
          renderProtoDeclarations(wkData, resp.blocked);
          renderProtoScope();
          renderProtoCoverage(resp.coverage, resp.mode);
          renderProtoGpcSignal(resp);
          renderProtoTcfAccord(tcfData);
          renderProtoCmpDetect(resp);
          renderProtoCosmeticSignal(resp);
          renderProtoParamStrip(resp);
          renderProtoPurposes(resp.blocked, wkData);
          renderProtoCmp(resp);
          renderProtoUnattributed(resp.unattributed);
          _updateCnamePill(resp.blocked);
          renderBlockerDetectionBanner(blockerState, resp.mode);
        };

        // Fetch .well-known cache
        if (wkKey) {
          chrome.storage.local.get([wkKey], function (wkResult) {
            wkData = (wkResult && wkResult[wkKey] && wkResult[wkKey].data) ? wkResult[wkKey].data : null;
            finishRender();
          });
        } else {
          finishRender();
        }

        // Fetch TCF data
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_TCF", tabId: tabId }, function (tcfResp) {
          if (!chrome.runtime.lastError && tcfResp && tcfResp.tcf) {
            tcfData = tcfResp.tcf;
          }
          finishRender();
        });

        // Fetch blocker detection state
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_BLOCKER_DETECTION" }, function (bdResp) {
          if (!chrome.runtime.lastError && bdResp) {
            blockerState = bdResp;
          }
          finishRender();
        });
      }
    );
  });
}

// --- Interactive element helper ---

function _makeInteractive(el, handler) {
  el.setAttribute("tabindex", "0");
  el.setAttribute("role", "button");
  el.style.cursor = "pointer";
  el.addEventListener("click", handler);
  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(e); }
  });
}

// --- CNAME pill ---

let _cnameDataLoaded = false;

function _updateCnamePill(blocked) {
  let pill = document.getElementById("proto-cname-pill");
  let countEl = document.getElementById("proto-cname-count");
  if (!pill || !countEl) return;

  let doCount = function (listLoaded) {
    let count = 0;
    if (listLoaded && blocked && typeof lookupCname === "function") {
      let purposes = Object.keys(blocked);
      for (let i = 0; i < purposes.length; i++) {
        let domains = blocked[purposes[i]];
        if (!domains) continue;
        let hosts = Object.keys(domains);
        for (let j = 0; j < hosts.length; j++) {
          if (lookupCname(hosts[j])) count++;
        }
      }
    }
    countEl.textContent = String(count);
    pill.classList.toggle("is-active", count > 0);
    pill.classList.toggle("is-disabled", count === 0 && listLoaded);
    if (!listLoaded) {
      pill.classList.add("is-disabled");
      pill.title = "CNAME cloaking: enable AdGuard CNAME Trackers list in Enhanced Protection to detect DNS-aliased trackers";
    } else if (count > 0) {
      pill.title = "CNAME cloaking: " + count + " domain" + (count > 1 ? "s" : "") + " disguised via DNS aliases";
    } else {
      pill.title = "CNAME cloaking: no DNS-aliased trackers detected on this page";
    }
    // Bind click + keyboard to Log > Domains if count > 0
    if (count > 0 && !pill._boundCnameClick) {
      _makeInteractive(pill, function () {
        if (typeof navigateToLog === "function") navigateToLog("domains");
      });
      pill._boundCnameClick = true;
    }
  };

  if (_cnameDataLoaded || (typeof cnameMap !== "undefined" && cnameMap)) {
    _cnameDataLoaded = true;
    doCount(true);
  } else if (typeof loadCnameData === "function") {
    loadCnameData(function (loaded) {
      _cnameDataLoaded = loaded;
      doCount(loaded);
    });
  } else {
    doCount(false);
  }
}

// --- Status banner ---

function renderProtoStatus(data) {
  const el = document.getElementById("proto-status");
  if (!el) return;
  el.textContent = "";
  el.classList.remove("is-standalone");

  let isBlocking = data.mode !== "protoconsent";
  if (isBlocking) el.classList.add("is-standalone");

  let capabilities = [
    { label: "Express", active: true, tip: "Send your privacy preferences to websites" },
    { label: "Enforce", active: isBlocking, tip: "Block tracking requests before they load" },
    { label: "Observe", active: true, tip: "Monitor what trackers do on every page" },
  ];

  for (let i = 0; i < capabilities.length; i++) {
    let cap = capabilities[i];
    let badge = document.createElement("span");
    badge.className = "proto-status-badge" + (cap.active ? " is-on" : " is-off");
    badge.title = cap.tip;
    let check = document.createElement("span");
    check.className = "proto-status-check";
    check.textContent = cap.active ? "\u2713" : "\u2717";
    badge.appendChild(check);
    badge.appendChild(document.createTextNode(" " + cap.label));
    el.appendChild(badge);
  }
}

// --- Scope summary (populates text spans inside #proto-scope, mirrors Consent tab) ---

function renderProtoScope() {
  let coreEl = document.getElementById("proto-scope-core");
  let enhEl = document.getElementById("proto-scope-enhanced");
  if (!coreEl) return;

  // Core rules count (same as displayProtectionScope in popup.js)
  let coreRules = 0;
  if (typeof purposeDomainCounts !== "undefined" && typeof purposePathCounts !== "undefined") {
    let pkeys = typeof PURPOSES_TO_SHOW !== "undefined" ? PURPOSES_TO_SHOW : [];
    for (let i = 0; i < pkeys.length; i++) {
      if (purposeDomainCounts[pkeys[i]]) coreRules += purposeDomainCounts[pkeys[i]];
      if (purposePathCounts[pkeys[i]]) coreRules += purposePathCounts[pkeys[i]];
    }
  }

  coreEl.textContent = "Core \u00b7 " + compactNumber(coreRules) + " rules";

  // Enhanced part
  if (!enhEl) return;
  enhEl.textContent = "";

  // Make scope text (left side) clickable to Enhanced tab — not the whole row (pills have own handlers)
  let scopeLeft = document.getElementById("proto-scope");
  scopeLeft = scopeLeft ? scopeLeft.querySelector(".pc-scope-left") : null;
  if (scopeLeft && !scopeLeft._boundProtoScope) {
    _makeInteractive(scopeLeft, function () {
      if (typeof setActiveMode === "function") setActiveMode("enhanced");
      if (typeof initEnhancedTab === "function") initEnhancedTab();
    });
    scopeLeft._boundProtoScope = true;
  }

  if (typeof epLists !== "undefined" && epLists && Object.keys(epLists).length > 0) {
    let stats = (typeof getEnhancedStats === "function") ? getEnhancedStats() : null;
    if (stats) _fillEnhancedScope(enhEl, stats);
  } else {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      let lists = resp.lists || {};
      let celIds = resp.consentLinkedListIds || [];
      let celSet = {};
      for (let c = 0; c < celIds.length; c++) celSet[celIds[c]] = true;
      let blockCount = 0, blockRules = 0, infoCount = 0, infoDomains = 0;
      let ids = Object.keys(lists);
      for (let j = 0; j < ids.length; j++) {
        let l = lists[ids[j]];
        if (!l.enabled && !celSet[ids[j]]) continue;
        if (l.type === "informational") {
          infoCount++;
          infoDomains += (l.domainCount || 0);
        } else {
          blockCount++;
          if (l.type === "cosmetic") {
            blockRules += (l.genericCount || 0) + (l.domainRuleCount || 0);
          } else if (l.type === "cmp") {
            blockRules += (l.cmpCount || 0);
          } else {
            blockRules += (l.domainCount || 0);
          }
        }
      }
      _fillEnhancedScope(enhEl, { blockingCount: blockCount, cosmeticCount: 0, cmpCount: 0, totalRules: blockRules, infoCount: infoCount, infoDomains: infoDomains });
    });
  }
}

function _fillEnhancedScope(el, stats) {
  let totalLists = (stats.blockingCount || 0) + (stats.cosmeticCount || 0) + (stats.cmpCount || 0) + (stats.infoCount || 0);
  if (totalLists === 0) return;
  let sep = document.createTextNode("  ");
  el.appendChild(sep);
  let icon = document.createElement("img");
  icon.src = ENHANCED_ICON;
  icon.width = 12;
  icon.height = 12;
  icon.alt = "Enhanced";
  icon.style.verticalAlign = "text-bottom";
  icon.style.position = "relative";
  icon.style.top = "-1px";
  icon.style.marginRight = "4px";
  el.appendChild(icon);
  let text = totalLists + (totalLists === 1 ? " list" : " lists") +
    " \u00b7 " + compactNumber(stats.totalRules || 0) + " rules";
  if (stats.infoCount > 0 && stats.infoDomains > 0) {
    text += " + " + compactNumber(stats.infoDomains);
  }
  el.appendChild(document.createTextNode(text));
  if (stats.infoCount > 0 && stats.infoDomains > 0) {
    let infoIcon = document.createElement("span");
    infoIcon.textContent = " \u2139";
    infoIcon.title = "Informational entries (not blocking)";
    el.appendChild(infoIcon);
  }
}

// --- Proto pills (sync state from Consent tab + own TCF data) ---

function _syncProtoPills(tcfData) {
  // Mirror GPC, CH, WK from Consent tab indicators (synchronous sources, always current)
  let _mirrorPills = [
    { src: "pc-gpc-indicator", dst: "proto-gpc-pill" },
    { src: "pc-ch-indicator",  dst: "proto-ch-pill"  },
    { src: "pc-wk-indicator",  dst: "proto-wk-pill"  },
  ];
  for (let i = 0; i < _mirrorPills.length; i++) {
    let srcEl = document.getElementById(_mirrorPills[i].src);
    let dstEl = document.getElementById(_mirrorPills[i].dst);
    if (!srcEl || !dstEl) continue;
    dstEl.classList.toggle("is-active", srcEl.classList.contains("is-active"));
    dstEl.classList.toggle("is-inactive", srcEl.classList.contains("is-inactive"));
    dstEl.classList.toggle("is-disabled", srcEl.classList.contains("is-disabled"));
    dstEl.title = srcEl.title;
  }
  // TCF pill: set directly from data (async source, avoid race with Consent tab)
  let tcfPill = document.getElementById("proto-tcf-pill");
  if (tcfPill) {
    if (tcfData && tcfData.detected) {
      tcfPill.classList.remove("is-disabled", "is-inactive");
      tcfPill.classList.add("is-active");
      let tip = "Cookie banner detected";
      if (tcfData.purposeConsents) {
        let total = Object.keys(tcfData.purposeConsents).length;
        if (total > 0) {
          let accepted = Object.values(tcfData.purposeConsents).filter(function (v) { return v; }).length;
          tip += " \u00b7 " + accepted + "/" + total + " purposes accepted";
        } else {
          tip += " \u00b7 Banner not accepted or rejected";
        }
      }
      tcfPill.title = tip;
    } else {
      tcfPill.classList.remove("is-active", "is-inactive");
      tcfPill.classList.add("is-disabled");
      tcfPill.title = "TCF CMP not detected";
    }
  }
  // Bind Proto TCF pill click to expand accordion
  let protoPill = document.getElementById("proto-tcf-pill");
  if (protoPill && !protoPill._boundProtoTcf) {
    _makeInteractive(protoPill, navigateToProtoTcf);
    protoPill._boundProtoTcf = true;
  }
  // Bind Proto WK pill to toggle side panel
  let wkPill = document.getElementById("proto-wk-pill");
  if (wkPill && !wkPill._boundProtoWk && typeof toggleSidePanel === "function") {
    _makeInteractive(wkPill, toggleSidePanel);
    wkPill._boundProtoWk = true;
  }
  // Bind Proto GPC pill to navigate to Log > GPC
  let gpcPill = document.getElementById("proto-gpc-pill");
  if (gpcPill && !gpcPill._boundProtoGpc && typeof navigateToLog === "function") {
    _makeInteractive(gpcPill, function () { navigateToLog("gpc"); });
    gpcPill._boundProtoGpc = true;
  }
  // Bind Proto CH pill to open Settings page
  let chPill = document.getElementById("proto-ch-pill");
  if (chPill && !chPill._boundProtoCh) {
    _makeInteractive(chPill, function () {
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/purposes-settings.html") });
    });
    chPill._boundProtoCh = true;
  }
}

// Navigate to Proto tab and expand the Consent Status accordion.
// Called by both the Consent tab TCF pill and the Proto tab TCF pill.
function navigateToProtoTcf() {
  if (typeof setActiveMode === "function") setActiveMode("proto");
  if (typeof initProtoTab === "function") initProtoTab();
  // Toggle the tcf-consent card after a short delay for render
  setTimeout(function () {
    let card = document.querySelector('#proto-tcf-accord .proto-card[data-key="tcf-consent"]');
    if (card) {
      let header = card.querySelector(".proto-card-header");
      if (header) header.click();
    }
  }, 100);
}

// --- Declaration/TCF/Mismatch accordions ---

function renderProtoDeclarations(wkData, blocked) {
  let el = document.getElementById("proto-declarations");
  if (!el) return;

  // Preserve expanded state
  let wasExpanded = new Set();
  el.querySelectorAll(".proto-card.is-expanded").forEach(function (c) {
    if (c.dataset.key) wasExpanded.add(c.dataset.key);
  });
  el.textContent = "";

  let hasWk = !!(wkData && wkData.purposes);
  let hasBlocked = !!(blocked && Object.keys(blocked).length > 0);

  // Mismatch detection (declaration vs observation)
  if (hasWk && hasBlocked) {
    let mismatches = _detectMismatches(wkData, blocked);
    if (mismatches.length > 0) {
      el.appendChild(_makeMismatchCard(mismatches, wasExpanded));
    }
  }
}

// Known IAB CMP IDs (mirrors well-known.js CMP_NAMES)
const _protoCmpNames = {
  2: "Quantcast", 6: "SourcePoint", 10: "Didomi", 12: "TrustArc",
  28: "OneTrust", 47: "Borlabs", 49: "Uniconsent", 92: "Didomi",
  128: "LiveRamp", 253: "Cookiebot", 300: "Cookie Information",
  407: "Sirdata",
};

const _iabPurposeNames = {
  1: "Store/access device", 2: "Basic ads", 3: "Ad profile",
  4: "Personalized ads", 5: "Content profile", 6: "Personalized content",
  7: "Ad measurement", 8: "Content measurement", 9: "Market research",
  10: "Product development", 11: "Special purposes",
};

function renderProtoTcfAccord(tcfData) {
  let el = document.getElementById("proto-tcf-accord");
  if (!el) return;

  let wasExpanded = el.querySelector(".proto-card.is-expanded") !== null;
  el.textContent = "";

  if (!tcfData) return;

  let consents = tcfData.purposeConsents || {};
  let ids = Object.keys(consents).sort(function (a, b) { return Number(a) - Number(b); });
  let hasConsents = ids.length > 0;
  let accepted = hasConsents ? ids.filter(function (id) { return consents[id]; }).length : 0;

  let headerDetail = hasConsents
    ? accepted + "/" + ids.length + " purposes accepted"
    : "Banner not accepted or rejected";

  let card = document.createElement("div");
  card.className = "proto-card";
  card.dataset.key = "tcf-consent";
  if (wasExpanded) card.classList.add("is-expanded");

  let header = document.createElement("div");
  header.className = "proto-card-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", wasExpanded ? "true" : "false");

  let chevron = document.createElement("span");
  chevron.className = "proto-card-chevron";
  chevron.textContent = wasExpanded ? " \u25BE" : " \u25B8";

  let dot = document.createElement("span");
  dot.className = "proto-signal-dot is-active";
  dot.style.marginRight = "4px";

  let nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = "Consent Status";

  let detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count";
  detailSpan.textContent = headerDetail;

  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(chevron);
  header.appendChild(detailSpan);

  let body = document.createElement("div");
  body.className = "proto-card-body proto-tcf-body";

  // CMP provider (mirrors side panel)
  let provEl = document.createElement("div");
  provEl.className = "pc-tcf-provider";
  provEl.textContent = (tcfData.cmpId && _protoCmpNames[tcfData.cmpId])
    ? "Managed by " + _protoCmpNames[tcfData.cmpId]
    : "Cookie consent manager detected";
  body.appendChild(provEl);

  // Purpose consents grid (mirrors side panel layout)
  if (hasConsents) {
    let grid = document.createElement("div");
    grid.className = "pc-tcf-purposes";
    for (let i = 0; i < ids.length; i++) {
      let id = ids[i];
      let row = document.createElement("div");
      row.className = "pc-tcf-purpose-row";
      let check = document.createElement("span");
      check.className = consents[id] ? "pc-tcf-accepted" : "pc-tcf-denied";
      check.textContent = consents[id] ? "\u2713" : "\u2717";
      let label = document.createElement("span");
      label.textContent = _iabPurposeNames[id] || ("Purpose " + id);
      row.appendChild(check);
      row.appendChild(label);
      grid.appendChild(row);
    }
    body.appendChild(grid);
  } else {
    let pendingEl = document.createElement("div");
    pendingEl.className = "pc-tcf-pending";
    pendingEl.textContent = "Banner not accepted or rejected";
    body.appendChild(pendingEl);
  }

  // Reassurance note (mirrors side panel)
  let noteEl = document.createElement("div");
  noteEl.className = "pc-tcf-note";
  noteEl.textContent = "Your choices are applied by ProtoConsent independently of the site consent status shown above.";
  body.appendChild(noteEl);

  let toggle = function () {
    let expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.textContent = expanded ? " \u25BE" : " \u25B8";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  el.appendChild(card);
}

function _detectMismatches(wkData, blocked) {
  let mismatches = [];
  let purposes = (typeof PURPOSES_TO_SHOW !== "undefined") ? PURPOSES_TO_SHOW : [];
  for (let i = 0; i < purposes.length; i++) {
    let pk = purposes[i];
    let declEntry = wkData.purposes[pk];
    let hasBlocks = blocked[pk] && Object.keys(blocked[pk]).length > 0;
    let blockCount = hasBlocks ? Object.values(blocked[pk]).reduce(function (s, c) { return s + c; }, 0) : 0;

    if (declEntry && declEntry.used === false && blockCount > 0) {
      // Site says "not used" but we're blocking trackers for this purpose
      mismatches.push({
        purpose: pk,
        type: "declared_not_used_but_blocked",
        detail: "Declared not used, " + blockCount + " blocked",
      });
    }
  }
  return mismatches;
}

function _makeMismatchCard(mismatches, wasExpanded) {
  let card = document.createElement("div");
  card.className = "proto-card proto-card-mismatch";
  card.dataset.key = "mismatch";
  if (wasExpanded.has("mismatch")) card.classList.add("is-expanded");

  let header = document.createElement("div");
  header.className = "proto-card-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", wasExpanded.has("mismatch") ? "true" : "false");

  let chevron = document.createElement("span");
  chevron.className = "proto-card-chevron";
  chevron.textContent = wasExpanded.has("mismatch") ? " \u25BE" : " \u25B8";

  let dot = document.createElement("span");
  dot.className = "proto-signal-dot proto-mismatch-dot";
  dot.style.marginRight = "4px";

  let nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = "Needs review";

  let detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count proto-mismatch-count";
  detailSpan.textContent = mismatches.length + " " + (mismatches.length === 1 ? "purpose" : "purposes");

  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(chevron);
  header.appendChild(detailSpan);

  let body = document.createElement("div");
  body.className = "proto-card-body";

  for (let i = 0; i < mismatches.length; i++) {
    let m = mismatches[i];
    let row = document.createElement("div");
    row.className = "proto-mismatch-row";

    let pName = document.createElement("span");
    pName.className = "proto-mismatch-purpose";
    pName.textContent = (typeof getPurposeLabel === "function") ? getPurposeLabel(m.purpose) : m.purpose;

    let pDetail = document.createElement("span");
    pDetail.className = "proto-mismatch-detail";
    pDetail.textContent = m.detail;

    row.appendChild(pName);
    row.appendChild(pDetail);
    body.appendChild(row);
  }

  let toggle = function () {
    let expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.textContent = expanded ? " \u25BE" : " \u25B8";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// --- Coverage bar ---

function renderProtoCoverage(coverage, mode) {
  const el = document.getElementById("proto-coverage");
  if (!el) return;
  el.textContent = "";

  if (!coverage || coverage.observed === 0) return;

  const observed = coverage.observed || 0;
  const attributed = coverage.attributed || 0;
  const ratio = observed > 0 ? Math.round((attributed / observed) * 100) : 0;
  const isMonitoring = mode === "protoconsent";

  // Block provenance: own vs external (both modes)
  let prov = computeBlockProvenance(coverage);

  let ownEl = document.createElement("div");
  ownEl.className = "proto-coverage-label";
  ownEl.textContent = "Blocked by ProtoConsent: " + prov.own;
  el.appendChild(ownEl);

  if (prov.external > 0) {
    let extEl = document.createElement("div");
    extEl.className = "proto-coverage-label";
    extEl.textContent = "Blocked by external: " + prov.external;
    el.appendChild(extEl);
  }

  const labelEl = document.createElement("div");
  labelEl.className = "proto-coverage-label";
  labelEl.textContent = "Attribution: " + attributed + " / " + observed + " matched to purposes";

  const barEl = document.createElement("div");
  barEl.className = "proto-coverage-bar";
  barEl.setAttribute("role", "progressbar");
  barEl.setAttribute("aria-valuenow", String(ratio));
  barEl.setAttribute("aria-valuemin", "0");
  barEl.setAttribute("aria-valuemax", "100");
  barEl.setAttribute("aria-label", ratio + "% of blocked requests matched to purposes");
  const fillEl = document.createElement("div");
  fillEl.className = "proto-coverage-fill";
  fillEl.style.width = ratio + "%";
  barEl.appendChild(fillEl);

  const textEl = document.createElement("div");
  textEl.className = "proto-coverage-text";
  const leftSpan = document.createElement("span");
  leftSpan.textContent = ratio + "% attributed";
  const rightSpan = document.createElement("span");
  rightSpan.textContent = (observed - attributed) + " unmatched";
  textEl.appendChild(leftSpan);
  textEl.appendChild(rightSpan);

  el.appendChild(labelEl);
  el.appendChild(barEl);
  el.appendChild(textEl);

  // Link to Log > Domains
  if (!el._boundCoverageClick && typeof navigateToLog === "function") {
    _makeInteractive(el, function () { navigateToLog("domains"); });
    el._boundCoverageClick = true;
  }
}

// --- Individual signal rows (GPC and Cosmetic, separated for ordering) ---

function renderProtoGpcSignal(data) {
  let el = document.getElementById("proto-gpc-signal");
  if (!el) return;
  el.textContent = "";

  let bgGpcDomains = data.gpcDomains ? Object.keys(data.gpcDomains) : [];
  let popupGpcCount = (typeof lastGpcSignalsSent !== "undefined") ? lastGpcSignalsSent : 0;
  let popupGpcDomains = (typeof lastGpcDomains !== "undefined") ? lastGpcDomains : [];
  let gpcDomainCount = bgGpcDomains.length > 0 ? bgGpcDomains.length : popupGpcDomains.length;
  let gpcRequestCount = popupGpcCount;
  let gpcActive = gpcDomainCount > 0 || gpcRequestCount > 0;

  let gpcDetail;
  if (gpcDomainCount > 0) {
    gpcDetail = gpcDomainCount + " " + (gpcDomainCount === 1 ? "domain" : "domains");
    if (gpcRequestCount > 0) gpcDetail += " (" + gpcRequestCount + " requests)";
  } else if (gpcRequestCount > 0) {
    gpcDetail = gpcRequestCount + " requests (domain names not captured)";
  } else {
    gpcDetail = "No signals";
  }

  let row = _makeSignalRow("GPC", gpcActive, gpcDetail, _gotoLogGpc);
  row.title = "GPC is sent on requests that reach the server. Blocked requests never leave your browser.";
  el.appendChild(row);
}

function renderProtoCosmeticSignal(data) {
  let el = document.getElementById("proto-cosmetic-signal");
  if (!el) return;
  el.textContent = "";

  let cosmActive = !!(data.cosmetic && data.cosmetic.domain);
  let cosmDetail = cosmActive
    ? (data.cosmetic.siteRules || 0) + " rules on " + data.cosmetic.domain
    : "No filters applied";
  el.appendChild(_makeSignalRow("Cosmetic", cosmActive, cosmDetail, function () {
    if (typeof setActiveMode === "function") setActiveMode("enhanced");
    if (typeof initEnhancedTab === "function") initEnhancedTab();
  }));
}

// --- Param stripping accordion ---

function renderProtoParamStrip(data) {
  let el = document.getElementById("proto-param-strip");
  if (!el) return;

  let wasExpanded = el.querySelector(".proto-card.is-expanded") !== null;
  el.textContent = "";

  let strips = data.paramStrips || {};
  let domains = Object.keys(strips);
  if (domains.length === 0) return;

  let totalStrips = 0;
  let allParams = [];
  for (let i = 0; i < domains.length; i++) {
    let info = strips[domains[i]];
    totalStrips += (typeof info === "object" ? info.count : info) || 0;
    if (typeof info === "object" && info.params) {
      for (let p = 0; p < info.params.length; p++) {
        if (allParams.indexOf(info.params[p]) === -1) allParams.push(info.params[p]);
      }
    }
  }

  let headerDetail = totalStrips + " stripped" +
    (allParams.length > 0 ? " (" + allParams.length + " param types)" : "");

  let card = document.createElement("div");
  card.className = "proto-card";
  card.dataset.key = "param-strip";
  if (wasExpanded) card.classList.add("is-expanded");

  let header = document.createElement("div");
  header.className = "proto-card-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", wasExpanded ? "true" : "false");
  header.setAttribute("aria-controls", "proto-param-strip-body");

  let chevron = document.createElement("span");
  chevron.className = "proto-card-chevron";
  chevron.textContent = wasExpanded ? " \u25BE" : " \u25B8";

  let dot = document.createElement("span");
  dot.className = "proto-signal-dot is-active";
  dot.style.marginRight = "4px";

  let nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = "Param Stripping";

  let detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count";
  detailSpan.textContent = headerDetail;

  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(chevron);
  header.appendChild(detailSpan);

  let body = document.createElement("div");
  body.className = "proto-card-body";
  body.id = "proto-param-strip-body";
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "Param Stripping details");

  let sorted = domains.sort(function (a, b) {
    let ca = typeof strips[b] === "object" ? strips[b].count : strips[b];
    let cb = typeof strips[a] === "object" ? strips[a].count : strips[a];
    return ca - cb;
  });
  let shown = sorted.slice(0, 10);

  for (let j = 0; j < shown.length; j++) {
    let info = strips[shown[j]];
    let params = (typeof info === "object" && info.params && info.params.length > 0)
      ? info.params : [];
    if (params.length === 0) {
      // Fallback: just show domain + count
      let row = document.createElement("div");
      row.className = "proto-purpose-domain";
      let dName = document.createElement("span");
      dName.className = "proto-purpose-domain-name";
      dName.textContent = shown[j];
      let dCount = document.createElement("span");
      dCount.className = "proto-purpose-domain-count";
      dCount.textContent = typeof info === "object" ? info.count : info;
      row.appendChild(dName);
      row.appendChild(dCount);
      body.appendChild(row);
    } else {
      for (let k = 0; k < params.length; k++) {
        let row = document.createElement("div");
        row.className = "proto-purpose-domain";
        let dName = document.createElement("span");
        dName.className = "proto-purpose-domain-name";
        dName.textContent = params[k];
        row.appendChild(dName);
        body.appendChild(row);
      }
    }
  }

  if (domains.length > 10) {
    let moreEl = document.createElement("div");
    moreEl.className = "proto-card-more";
    moreEl.textContent = "+" + (domains.length - 10) + " more";
    body.appendChild(moreEl);
  }

  let toggle = function () {
    let expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.textContent = expanded ? " \u25BE" : " \u25B8";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  el.appendChild(card);
}

function _makeSignalRow(label, active, detail, onClick) {
  const row = document.createElement("div");
  row.className = "proto-signal-row";
  if (onClick) row.classList.add("proto-signal-link");

  const dot = document.createElement("span");
  dot.className = "proto-signal-dot " + (active ? "is-active" : "is-inactive");

  const lbl = document.createElement("span");
  lbl.className = "proto-signal-label";
  lbl.textContent = label;

  const det = document.createElement("span");
  det.className = "proto-signal-detail";
  det.textContent = detail;

  row.appendChild(dot);
  row.appendChild(lbl);
  row.appendChild(det);

  if (onClick) {
    _makeInteractive(row, onClick);
  }

  return row;
}

function _gotoLogGpc() {
  if (typeof navigateToLog === "function") navigateToLog("gpc");
}

// --- CMP Detection (accordion, between signals and purposes) ---

function renderProtoCmpDetect(data) {
  const el = document.getElementById("proto-cmp-detect");
  if (!el) return;

  const wasExpanded = el.querySelector(".proto-card.is-expanded") !== null;
  el.textContent = "";

  let cd = data.cmpDetect;
  let detectActive = !!(cd && cd.detected && cd.detected.length > 0);
  let detectCount = detectActive ? cd.detected.length : 0;

  // Count conflicts from observation + storageObservation
  let conflictCount = _countConflicts(cd);

  // Header detail: "1 banner, 2 conflicts" / "1 banner detected" / "No banners detected"
  let parts = [];
  if (detectCount > 0) parts.push(detectCount + " banner" + (detectCount > 1 ? "s" : ""));
  if (conflictCount > 0) parts.push(conflictCount + " conflict" + (conflictCount > 1 ? "s" : ""));
  let detectDetail = parts.length > 0 ? parts.join(", ") : "No banners detected";

  // Build body content
  let card = document.createElement("div");
  card.className = "proto-card proto-card-cmp";
  card.dataset.key = "cmp-detect";
  if (wasExpanded) card.classList.add("is-expanded");

  let header = document.createElement("div");
  header.className = "proto-card-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", wasExpanded ? "true" : "false");

  let chevron = document.createElement("span");
  chevron.className = "proto-card-chevron";
  chevron.textContent = wasExpanded ? " \u25BE" : " \u25B8";

  let dot = document.createElement("span");
  dot.className = "proto-signal-dot " + (detectActive ? "is-active" : "is-inactive");
  dot.style.marginRight = "4px";

  let nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = "CMP Detection";

  let detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count";
  if (conflictCount > 0) detailSpan.classList.add("proto-mismatch-count");
  detailSpan.textContent = detectDetail;

  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(chevron);
  header.appendChild(detailSpan);

  let body = document.createElement("div");
  body.className = "proto-card-body";

  // Banner lines
  if (detectActive) {
    for (let i = 0; i < cd.detected.length; i++) {
      let d = cd.detected[i];
      let line = document.createElement("div");
      line.className = "proto-cmp-line";
      line.textContent = d.cmpId + " (" + (d.showing ? "showing" : "present") + ")";
      body.appendChild(line);
    }
  }

  // Full observation: show all decoded consent values per CMP source
  let allObs = _gatherObservations(cd);
  if (allObs.length > 0) {
    for (let oi = 0; oi < allObs.length; oi++) {
      let obs = allObs[oi];
      // Source header: "onetrust (OptanonConsent)"
      let srcLine = document.createElement("div");
      srcLine.className = "proto-cmp-source";
      srcLine.textContent = obs.cmpId + (obs.source ? " (" + obs.source + ")" : "");
      body.appendChild(srcLine);
      // Build conflict lookup for this observation
      let conflictMap = {};
      if (obs.conflicts) {
        for (let ci = 0; ci < obs.conflicts.length; ci++) {
          conflictMap[obs.conflicts[ci].purpose] = obs.conflicts[ci];
        }
      }
      // Render each decoded purpose
      if (obs.decoded) {
        let keys = Object.keys(obs.decoded);
        for (let ki = 0; ki < keys.length; ki++) {
          let purp = keys[ki];
          if (purp === "_summary") continue;
          let cmpVal = obs.decoded[purp];
          let isConflict = conflictMap.hasOwnProperty(purp);
          let row = document.createElement("div");
          row.className = "proto-cmp-purpose-row" + (isConflict ? " is-conflict" : " is-match");
          let label = (typeof getPurposeLabel === "function") ? getPurposeLabel(purp) : purp;
          let icon = isConflict ? "\u2717" : "\u2713";
          row.textContent = icon + " " + label + ": " + (cmpVal ? "allow" : "deny");
          body.appendChild(row);
        }
      }
    }
  }

  if (!body.hasChildNodes()) {
    body.textContent = "No data available";
    body.classList.add("proto-card-empty");
  }

  let toggle = function () {
    let expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.textContent = expanded ? " \u25BE" : " \u25B8";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  el.appendChild(card);
}

function _gatherObservations(cd) {
  let out = [];
  if (!cd) return out;
  _pushObservations(cd.observation, "cookie", out);
  _pushObservations(cd.storageObservation, "storage", out);
  return out;
}

function _pushObservations(arr, kind, out) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    let obs = arr[i];
    if (!obs) continue;
    if (obs.summary && obs.decoded) continue;
    if (!obs.decoded) continue;
    out.push({
      cmpId: obs.cmpId,
      source: obs.cookieName || obs.key || "",
      decoded: obs.decoded,
      conflicts: obs.conflicts || []
    });
  }
}

function _countConflicts(cd) {
  let count = 0;
  let sources = [cd ? cd.observation : null, cd ? cd.storageObservation : null];
  for (let s = 0; s < sources.length; s++) {
    if (!Array.isArray(sources[s])) continue;
    for (let i = 0; i < sources[s].length; i++) {
      let obs = sources[s][i];
      if (obs.summary) continue;
      if (obs.conflicts) count += obs.conflicts.length;
    }
  }
  return count;
}

// --- Purpose cards (accordion) ---

function renderProtoPurposes(blocked, wkData) {
  const el = document.getElementById("proto-purposes");
  if (!el) return;

  // Preserve expanded state across refreshes
  const wasExpanded = new Set();
  el.querySelectorAll(".proto-card.is-expanded").forEach((c) => {
    if (c.dataset.key) wasExpanded.add(c.dataset.key);
  });

  el.textContent = "";

  if (!blocked || Object.keys(blocked).length === 0) return;

  let wkPurposes = (wkData && wkData.purposes) ? wkData.purposes : null;

  const entries = Object.entries(blocked).sort((a, b) => {
    const totalA = Object.values(a[1]).reduce((s, c) => s + c, 0);
    const totalB = Object.values(b[1]).reduce((s, c) => s + c, 0);
    return totalB - totalA;
  });

  for (const [purpose, domains] of entries) {
    const total = Object.values(domains).reduce((s, c) => s + c, 0);
    if (total === 0) continue;

    const card = document.createElement("div");
    card.className = "proto-card";
    card.dataset.key = purpose;
    if (wasExpanded.has(purpose)) card.classList.add("is-expanded");

    // Header (clickable)
    const header = document.createElement("div");
    header.className = "proto-card-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", wasExpanded.has(purpose) ? "true" : "false");

    const chevron = document.createElement("span");
    chevron.className = "proto-card-chevron";
    chevron.textContent = wasExpanded.has(purpose) ? " \u25BE" : " \u25B8";

    // Resolve icon and label - handle enhanced:* keys
    let isEnhanced = purpose.startsWith("enhanced:");
    let enhListId = isEnhanced ? purpose.split(":")[1] : null;
    let cfg = (!isEnhanced && typeof purposesConfig !== "undefined" && purposesConfig[purpose]) ? purposesConfig[purpose] : {};

    let displayName;
    if (isEnhanced) {
      let catalog = (typeof enhancedCatalogConfig !== "undefined") ? enhancedCatalogConfig : null;
      displayName = (catalog && catalog[enhListId] && catalog[enhListId].name) ? catalog[enhListId].name : enhListId;
    } else {
      displayName = (typeof getPurposeLabel === "function") ? getPurposeLabel(purpose) : purpose;
    }

    // Shield icon for enhanced lists
    if (isEnhanced && typeof ENHANCED_ICON !== "undefined") {
      let shieldEl = document.createElement("img");
      shieldEl.src = ENHANCED_ICON;
      shieldEl.width = 16;
      shieldEl.height = 16;
      shieldEl.alt = "EP";
      shieldEl.className = "proto-card-icon";
      header.appendChild(shieldEl);
      // Category icon (same size as purpose icons)
      if (typeof getEnhancedCategoryInfo === "function") {
        let catInfo = getEnhancedCategoryInfo(enhListId);
        if (catInfo && catInfo.icon) {
          let catEl = document.createElement("img");
          catEl.src = catInfo.icon;
          catEl.width = 20;
          catEl.height = 20;
          catEl.alt = "";
          catEl.className = "proto-card-icon proto-card-icon-cat";
          header.appendChild(catEl);
        }
      }
    } else if (cfg.icon) {
      let iconEl = document.createElement("img");
      iconEl.src = cfg.icon;
      iconEl.width = 20;
      iconEl.height = 20;
      iconEl.alt = "";
      iconEl.className = "proto-card-icon";
      header.appendChild(iconEl);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "proto-card-name";
    nameSpan.textContent = displayName;

    const countSpan = document.createElement("span");
    countSpan.className = "proto-card-count";
    countSpan.textContent = total + " blocked";

    header.appendChild(nameSpan);
    header.appendChild(chevron);
    header.appendChild(countSpan);

    // Declaration badge (from .well-known) - only for core purposes, not enhanced lists
    if (wkPurposes && !isEnhanced) {
      let declBadge = document.createElement("span");
      declBadge.className = "proto-card-decl";
      let declEntry = wkPurposes[purpose];
      if (declEntry) {
        let used = declEntry.used;
        if (used === true) {
          declBadge.textContent = "Declared: used";
          declBadge.classList.add("proto-decl-used");
          // Mismatch: site declares used but we're blocking it
          declBadge.title = "Site declares this purpose as used";
        } else if (used === false) {
          declBadge.textContent = "Review";
          declBadge.classList.add("proto-decl-mismatch");
          declBadge.title = "Site declares this purpose as not used, but activity observed";
        } else {
          declBadge.textContent = "Declared";
          declBadge.classList.add("proto-decl-used");
          declBadge.title = "Site declares this purpose (no usage specified)";
        }
      } else {
        declBadge.textContent = "Not declared";
        declBadge.classList.add("proto-decl-none");
        declBadge.title = "Site does not declare this purpose in .well-known";
      }
      header.appendChild(declBadge);
    }

    // Body (domain list)
    const body = document.createElement("div");
    body.className = "proto-card-body";

    const domainEntries = Object.entries(domains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    for (const [domain, count] of domainEntries) {
      const row = document.createElement("div");
      row.className = "proto-purpose-domain";
      const dName = document.createElement("span");
      dName.className = "proto-purpose-domain-name";
      dName.textContent = domain;
      dName.title = domain;
      const dCount = document.createElement("span");
      dCount.className = "proto-purpose-domain-count";
      dCount.textContent = count;
      row.appendChild(dName);
      row.appendChild(dCount);
      body.appendChild(row);
    }

    if (Object.keys(domains).length > 10) {
      const moreEl = document.createElement("div");
      moreEl.className = "proto-card-more";
      moreEl.textContent = "+" + (Object.keys(domains).length - 10) + " more";
      body.appendChild(moreEl);
    }

    // Toggle handler
    const toggle = () => {
      const expanded = card.classList.toggle("is-expanded");
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
      chevron.textContent = expanded ? " \u25BE" : " \u25B8";
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    card.appendChild(header);
    card.appendChild(body);
    el.appendChild(card);
  }
}

// --- CMP cards (accordion, informational, last) ---

function renderProtoCmp(data) {
  const el = document.getElementById("proto-cmp");
  if (!el) return;

  const wasExpanded = new Set();
  el.querySelectorAll(".proto-card.is-expanded").forEach((c) => {
    if (c.dataset.key) wasExpanded.add(c.dataset.key);
  });

  el.textContent = "";

  // CMP Auto-response
  const cmpActive = !!(data.cmp && data.cmp.domain);
  const cmpDetail = cmpActive
    ? (data.cmp.cmpIds || []).length + " templates on " + data.cmp.domain
    : "No auto-response";
  const cmpBody = cmpActive ? (data.cmp.cmpIds || []).join(", ") : null;
  el.appendChild(_makeCmpCard("cmp-auto", "CMP Auto-response", cmpActive, cmpDetail, cmpBody, wasExpanded));
}

function _makeCmpCard(key, label, active, detail, bodyText, wasExpanded) {
  const card = document.createElement("div");
  card.className = "proto-card proto-card-cmp";
  card.dataset.key = key;
  if (wasExpanded.has(key)) card.classList.add("is-expanded");

  const header = document.createElement("div");
  header.className = "proto-card-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", wasExpanded.has(key) ? "true" : "false");

  const chevron = document.createElement("span");
  chevron.className = "proto-card-chevron";
  chevron.textContent = wasExpanded.has(key) ? " \u25BE" : " \u25B8";

  const dot = document.createElement("span");
  dot.className = "proto-signal-dot " + (active ? "is-active" : "is-inactive");
  dot.style.marginRight = "4px";

  const nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = label;

  const detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count";
  detailSpan.textContent = detail;

  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(chevron);
  header.appendChild(detailSpan);

  const body = document.createElement("div");
  body.className = "proto-card-body";
  if (bodyText) {
    body.textContent = bodyText;
  } else {
    body.textContent = "No data available";
    body.classList.add("proto-card-empty");
  }

  const toggle = () => {
    const expanded = card.classList.toggle("is-expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.textContent = expanded ? " \u25BE" : " \u25B8";
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// --- Unattributed hostnames ---

function renderProtoUnattributed(list) {
  const container = document.getElementById("proto-unattributed");
  const listEl = document.getElementById("proto-unattributed-list");
  if (!container || !listEl) return;

  if (!list || list.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  listEl.textContent = "";

  for (const entry of list) {
    const div = document.createElement("div");
    div.textContent = entry.hostname;
    listEl.appendChild(div);
  }
}

// --- Show/Hide details integration ---
// Called from popup.js toggleDescBtn handler

function toggleProtoDetails(shouldExpand) {
  const cards = document.querySelectorAll("#pc-view-proto .proto-card");
  cards.forEach((card) => {
    card.classList.toggle("is-expanded", shouldExpand);
    const header = card.querySelector(".proto-card-header");
    if (header) header.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
    const chevron = card.querySelector(".proto-card-chevron");
    if (chevron) chevron.textContent = shouldExpand ? " \u25BE" : " \u25B8";
  });
}

// --- Blocker detection banner ---

function renderBlockerDetectionBanner(state, mode, targetId) {
  let el = document.getElementById(targetId || "proto-blocker-banner");
  if (!el) return;
  el.textContent = "";
  el.hidden = true;
  el.classList.remove("is-active");
  if (!state) return;

  // Determine which case applies
  let config = null;
  if (state.suggestMonitoring && mode !== "protoconsent") {
    config = {
      title: "External blocker detected",
      detail: "Switch to Monitoring mode to complement your blocker with privacy signals, banner management and consent control.",
      primaryLabel: "Switch to Monitoring",
      dismissLabel: "Dismiss",
      dismissTarget: "suggestion",
      onPrimary: function () {
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_SET_OPERATING_MODE", mode: "protoconsent" }, function (resp) {
          void chrome.runtime.lastError;
          if (resp && !resp.ok) return;
          if (typeof operatingMode !== "undefined") operatingMode = "protoconsent";
          if (typeof updateModeIndicator === "function") updateModeIndicator("protoconsent");
          if (typeof setActiveMode === "function") setActiveMode("proto");
          if (typeof initProtoTab === "function") initProtoTab();
        });
      },
    };
  } else if (state.warnNoBlocker && mode === "protoconsent") {
    config = {
      title: "No external blocking observed",
      detail: "Monitoring mode does not block network requests. No other blocker appears to be active. Switch to Blocking mode for full protection.",
      primaryLabel: "Switch to Blocking",
      dismissLabel: "Keep Monitoring",
      dismissTarget: "warning",
      onPrimary: function () {
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_SET_OPERATING_MODE", mode: "standalone" }, function (resp) {
          void chrome.runtime.lastError;
          if (resp && !resp.ok) return;
          if (typeof operatingMode !== "undefined") operatingMode = "standalone";
          if (typeof updateModeIndicator === "function") updateModeIndicator("standalone");
          if (typeof setActiveMode === "function") setActiveMode("consent");
        });
      },
    };
  }
  if (!config) return;

  el.hidden = false;
  el.classList.add("is-active");

  let text = document.createElement("div");
  text.className = "proto-blocker-banner-text";
  text.textContent = config.title;
  el.appendChild(text);

  let detail = document.createElement("div");
  detail.className = "proto-blocker-banner-detail";
  detail.textContent = config.detail;
  el.appendChild(detail);

  let actions = document.createElement("div");
  actions.className = "proto-blocker-banner-actions";

  let primaryBtn = document.createElement("button");
  primaryBtn.type = "button";
  primaryBtn.className = "proto-blocker-banner-btn is-primary";
  primaryBtn.textContent = config.primaryLabel;
  primaryBtn.addEventListener("click", config.onPrimary);

  let dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "proto-blocker-banner-btn";
  dismissBtn.textContent = config.dismissLabel;
  dismissBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_DISMISS_BLOCKER_DETECTION", target: config.dismissTarget });
    el.hidden = true;
  });

  actions.appendChild(primaryBtn);
  actions.appendChild(dismissBtn);
  el.appendChild(actions);
}
