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

// Track which grid card was expanded to preserve state across refreshes
let _protoExpandedCard = null;
// Track which <details> inside grid cards are open
let _protoOpenDetails = new Set();
// Track which bars are expanded to preserve state across refreshes
let _protoExpandedBars = new Set();

function refreshProtoView() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    let tabId = tabs[0].id;
    chrome.runtime.sendMessage(
      { type: "PROTOCONSENT_GET_PROTO_DATA", tabId: tabId },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return;

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

          // --- Proto shared bars ---
          _renderProtoBars(resp, tcfData);

          // --- 6-card grid ---
          _renderProtoGrid(resp, wkData, tcfData);

          // --- Declarations (mismatch card, below grid) ---
          renderProtoDeclarations(wkData, resp.blocked);

          // --- Purpose accordion cards (below grid) ---
          renderProtoPurposes(resp.blocked, wkData);

          // --- Blocker detection banner ---
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

// --- Proto shared bars (stats + signals) ---

function _renderProtoBars(resp, tcfData) {
  var statsContainer = document.getElementById("proto-bar-stats");
  var signalsContainer = document.getElementById("proto-bar-signals");

  // Save expanded state before re-rendering
  _protoExpandedBars.forEach(function (id) {
    if (!document.getElementById(id)) _protoExpandedBars.delete(id);
  });

  // Stats bar
  if (statsContainer) {
    statsContainer.textContent = "";
    var bar = createCollapsibleBar("proto-stats-bar", { ariaLabel: "Blocking stats" });
    var prov = computeBlockProvenance(resp.coverage, resp.mode);
    var isMonitoring = resp.mode === "protoconsent";
    var collapsed;
    if (isMonitoring) {
      var otherText = prov.other < 0 ? "n/a" : prov.other;
      collapsed = "Blocked by external: " + otherText + " \u00b7 " +
        (resp.coverage ? Math.round((resp.coverage.attributed / Math.max(resp.coverage.observed, 1)) * 100) : 0) + "% purpose attributed";
    } else {
      collapsed = buildStatsCollapsed(lastBlocked || 0);
    }
    bar.setCollapsed(collapsed);

    // Expanded: provenance detail + link
    var expDiv = document.createElement("div");
    var d1 = document.createElement("div");
    var d1Label = document.createElement("strong"); d1Label.textContent = "Blocked by ProtoConsent: ";
    d1.appendChild(d1Label); d1.appendChild(document.createTextNode(prov.own)); expDiv.appendChild(d1);
    if (prov.other > 0) {
      var d2 = document.createElement("div");
      var d2Label = document.createElement("strong");
      d2Label.textContent = isMonitoring ? "Blocked by external: " : "Other: ";
      d2.appendChild(d2Label); d2.appendChild(document.createTextNode(prov.other)); expDiv.appendChild(d2);
    }
    if (resp.coverage) {
      var d3 = document.createElement("div");
      var d3Label = document.createElement("strong"); d3Label.textContent = "Purpose attribution: ";
      d3.appendChild(d3Label); d3.appendChild(document.createTextNode((resp.coverage.attributed || 0) + " / " + (resp.coverage.observed || 0) + " matched")); expDiv.appendChild(d3);
    }
    var link = document.createElement("button"); link.type = "button"; link.className = "pc-bar-link";
    link.textContent = "\u2192 View blocked domains";
    link.addEventListener("click", function () { navigateToLog("domains"); });
    expDiv.appendChild(link);
    bar.setExpanded(expDiv);
    _hookProtoBarToggle(bar);
    if (_protoExpandedBars.has("proto-stats-bar")) {
      bar.classList.add("is-expanded");
      bar.querySelector(".pc-bar-toggle").setAttribute("aria-expanded", "true");
      bar.querySelector(".pc-bar-body").hidden = false;
    }
    statsContainer.appendChild(bar);
  }

  // Signals bar (reuse consent signals bar pattern)
  if (signalsContainer) {
    signalsContainer.textContent = "";
    var sBar = createCollapsibleBar("proto-signals-bar", { ariaLabel: "Privacy signals", tint: "signals" });
    var summary = (typeof buildSignalSummary === "function") ? buildSignalSummary(lastGpcSignalsSent) : "Privacy signals";
    sBar.setCollapsed(summary, "Global Privacy Control (GPC), Client Hints stripping, .well-known declaration, TCF banner detection");

    var pillsDiv = document.createElement("div");
    pillsDiv.className = "pc-scope-indicators";
    pillsDiv.style.gap = "4px 6px";
    pillsDiv.appendChild(buildPill("GPC", computeGpcState(lastGpcSignalsSent), function () { navigateToLog("gpc"); }));
    pillsDiv.appendChild(buildPill("CH", computeChState()));
    pillsDiv.appendChild(buildPill("WK", computeWkState(), function () { if (typeof toggleSidePanel === "function" && computeWkState().state === "active") toggleSidePanel(); }));
    // TCF pill with async update
    var tcfState = tcfData && tcfData.detected
      ? { state: "active", title: "Cookie banner detected" }
      : { state: "disabled", title: "TCF CMP not detected" };
    pillsDiv.appendChild(buildPill("TCF", tcfState, navigateToProtoTcf));
    sBar.setExpanded(pillsDiv);
    _hookProtoBarToggle(sBar);
    if (_protoExpandedBars.has("proto-signals-bar")) {
      sBar.classList.add("is-expanded");
      sBar.querySelector(".pc-bar-toggle").setAttribute("aria-expanded", "true");
      sBar.querySelector(".pc-bar-body").hidden = false;
    }
    signalsContainer.appendChild(sBar);
  }
}

function _hookProtoBarToggle(bar) {
  var toggle = bar.querySelector(".pc-bar-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", function () {
    if (bar.classList.contains("is-expanded")) _protoExpandedBars.add(bar.id);
    else _protoExpandedBars.delete(bar.id);
  });
}

// --- 6-card grid ---

function _renderProtoGrid(resp, wkData, tcfData) {
  var grid = document.getElementById("proto-grid");
  if (!grid) return;

  // Preserve expanded card
  var prevExpanded = _protoExpandedCard;
  // Preserve open <details> inside grid cards
  grid.querySelectorAll("details[open]").forEach(function (d) {
    var card = d.closest(".pc-grid-card-body");
    var gc = card ? card.previousElementSibling : null;
    if (gc && gc.id) _protoOpenDetails.add(gc.id);
  });
  grid.textContent = "";

  // Compute metrics for card displays
  var coverage = resp.coverage || {};
  var coverageRatio = coverage.observed > 0 ? Math.round((coverage.attributed / coverage.observed) * 100) : 0;

  var gpcDomains = resp.gpcDomains ? Object.keys(resp.gpcDomains) : [];
  var popupGpcDomains = (typeof lastGpcDomains !== "undefined") ? lastGpcDomains : [];
  var gpcCount = gpcDomains.length > 0 ? gpcDomains.length : popupGpcDomains.length;
  var gpcRequests = (typeof lastGpcSignalsSent !== "undefined") ? lastGpcSignalsSent : 0;
  var gpcMetric = gpcCount > 0 ? gpcCount + " domains" : (gpcRequests > 0 ? gpcRequests + " requests" : "0 domains");

  var cmpDetected = !!(resp.cmpDetect && resp.cmpDetect.detected && resp.cmpDetect.detected.length > 0);
  var cmpCount = cmpDetected ? resp.cmpDetect.detected.length : 0;

  var cosmActive = !!(resp.cosmetic && resp.cosmetic.domain);
  var cosmRules = cosmActive ? (resp.cosmetic.siteRules || 0) : 0;

  var cnameCount = _countCname(resp.blocked);
  var paramStrips = resp.paramStrips || {};
  var paramDomains = Object.keys(paramStrips);
  var paramTotal = 0;
  for (var i = 0; i < paramDomains.length; i++) {
    var info = paramStrips[paramDomains[i]];
    paramTotal += (typeof info === "object" ? info.count : info) || 0;
  }
  if (typeof lastParamStrips === "number" && lastParamStrips > paramTotal) paramTotal = lastParamStrips;

  var GRID_ICONS = "../icons/grid/";
  var cards = [
    { id: "proto-card-coverage", iconSrc: GRID_ICONS + "coverage.svg", title: "Coverage", metric: coverageRatio + "%" },
    { id: "proto-card-gpc", iconSrc: GRID_ICONS + "gpc.svg", title: "GPC", metric: gpcMetric },
    { id: "proto-card-banners", iconSrc: GRID_ICONS + "banners.svg", title: "Banners", metric: cmpCount > 0 ? cmpCount + " detected" : "None" },
    { id: "proto-card-cosmetic", iconSrc: GRID_ICONS + "cosmetic.svg", title: "Cosmetic", metric: cosmRules + " rules" },
    { id: "proto-card-trackers", iconSrc: GRID_ICONS + "trackers.svg", title: "Trackers", metric: cnameCount + " cloaked" },
    { id: "proto-card-cleanlinks", iconSrc: GRID_ICONS + "cleanlinks.svg", title: "URL Cleanup", metric: paramTotal + " stripped" },
  ];

  for (var c = 0; c < cards.length; c++) {
    var def = cards[c];
    var gc = createGridCard(def);
    grid.appendChild(gc.card);
    grid.appendChild(gc.body);

    // Fill expand body content
    switch (c) {
      case 0: _fillCoverageBody(gc.body, resp, wkData); break;
      case 1: _fillGpcBody(gc.body, resp); break;
      case 2: _fillBannersBody(gc.body, resp, tcfData); break;
      case 3: _fillCosmeticBody(gc.body, resp); break;
      case 4: _fillTrackersBody(gc.body, resp); break;
      case 5: _fillCleanLinksBody(gc.body, resp); break;
    }

    // Restore expanded state
    if (prevExpanded === def.id) {
      gc.card.classList.add("is-expanded");
      gc.card.querySelector(".pc-grid-card-toggle").setAttribute("aria-expanded", "true");
      gc.body.hidden = false;
      // Restore open <details> inside this card
      if (_protoOpenDetails.has(def.id)) {
        var det = gc.body.querySelector("details");
        if (det) det.open = true;
      }
    }
  }

  // Track which card gets expanded
  grid.addEventListener("click", function (e) {
    var card = e.target.closest(".pc-grid-card");
    if (card) _protoExpandedCard = card.classList.contains("is-expanded") ? card.id : null;
  });
  // Track <details> open/close
  grid.addEventListener("toggle", function (e) {
    if (e.target.tagName !== "DETAILS") return;
    var body = e.target.closest(".pc-grid-card-body");
    var gc = body ? body.previousElementSibling : null;
    if (!gc || !gc.id) return;
    if (e.target.open) _protoOpenDetails.add(gc.id);
    else _protoOpenDetails.delete(gc.id);
  }, true);
}

// Count CNAME-cloaked domains
function _countCname(blocked) {
  if (!blocked || !cnameMap) return 0;
  var count = 0;
  var purposes = Object.keys(blocked);
  for (var i = 0; i < purposes.length; i++) {
    var domains = blocked[purposes[i]];
    if (!domains) continue;
    var hosts = Object.keys(domains);
    for (var j = 0; j < hosts.length; j++) {
      if (lookupCname(hosts[j])) count++;
    }
  }
  return count;
}

// --- Card body content builders ---

function _fillCoverageBody(body, resp, wkData) {
  var coverage = resp.coverage || {};
  if (!coverage.observed) {
    if (resp.isBrave && resp.mode === "protoconsent") {
      body.textContent = "Brave Shields blocks before ProtoConsent can monitor";
    } else {
      body.textContent = "No data yet";
    }
    return;
  }
  var prov = computeBlockProvenance(coverage, resp.mode);
  var ratio = coverage.observed > 0 ? Math.round((coverage.attributed / coverage.observed) * 100) : 0;

  // Attribution bar
  var barEl = document.createElement("div"); barEl.className = "proto-coverage-bar";
  barEl.setAttribute("role", "progressbar"); barEl.setAttribute("aria-valuenow", String(ratio));
  var fillEl = document.createElement("div"); fillEl.className = "proto-coverage-fill";
  fillEl.style.width = ratio + "%"; barEl.appendChild(fillEl); body.appendChild(barEl);

  var textEl = document.createElement("div"); textEl.className = "proto-coverage-text";
  textEl.innerHTML = "<span><strong>" + ratio + "%</strong> purposes attributed</span><span><strong>" + (coverage.observed - (coverage.attributed || 0)) + "</strong> unmatched</span>";
  body.appendChild(textEl);

  // Provenance + heuristic summary on one line
  var provEl = document.createElement("div"); provEl.style.marginTop = "4px";
  var otherLabel = resp.mode === "protoconsent" ? "External" : "Other";
  var provText = "<strong>Own:</strong> " + prov.own;
  if (prov.other >= 0) provText += " \u00b7 <strong>" + otherLabel + ":</strong> " + prov.other;
  if (resp.unattributed && resp.unattributed.length > 0) {
    var heuristicCounts = {};
    var heuristicTotal = 0;
    for (var h = 0; h < resp.unattributed.length; h++) {
      var hk = resp.unattributed[h].heuristic;
      if (hk) { heuristicTotal++; heuristicCounts[hk] = (heuristicCounts[hk] || 0) + 1; }
    }
    provText += " \u00b7 <strong>Guess:</strong> " + heuristicTotal + "/" + resp.unattributed.length;
    if (heuristicTotal > 0) {
      var parts = [];
      var sorted = Object.entries(heuristicCounts).sort(function(a,b){ return b[1]-a[1]; });
      for (var hi = 0; hi < sorted.length; hi++) parts.push(sorted[hi][1] + " " + sorted[hi][0]);
      provText += " (" + parts.join(", ") + ")";
    }
  }
  provEl.innerHTML = provText;
  body.appendChild(provEl);

  // Unattributed hostnames
  if (resp.unattributed && resp.unattributed.length > 0) {
    var toggle = document.createElement("div"); toggle.className = "ep-active-card"; toggle.style.marginTop = "4px";
    var sumHeader = document.createElement("div"); sumHeader.className = "ep-active-card-header";
    sumHeader.setAttribute("role", "button"); sumHeader.setAttribute("tabindex", "0");
    sumHeader.setAttribute("aria-expanded", "false");
    sumHeader.setAttribute("aria-label", "Unmatched hostnames, " + resp.unattributed.length + " entries");
    var sumChevron = document.createElement("span"); sumChevron.className = "ep-active-card-chevron pc-chevron"; sumChevron.setAttribute("aria-hidden", "true");
    var sumName = document.createElement("span"); sumName.className = "ep-active-card-name"; sumName.textContent = "Unmatched hostnames";
    var sumCount = document.createElement("span"); sumCount.className = "ep-active-card-count"; sumCount.textContent = resp.unattributed.length;
    sumHeader.appendChild(sumChevron); sumHeader.appendChild(sumName); sumHeader.appendChild(sumCount);
    var toggleBody = document.createElement("div"); toggleBody.className = "ep-active-card-body";
    for (var i = 0; i < Math.min(resp.unattributed.length, 10); i++) {
      var d = document.createElement("div"); d.className = "proto-unmatched-row";
      var hostSpan = document.createElement("span"); hostSpan.className = "proto-unmatched-host";
      hostSpan.textContent = resp.unattributed[i].hostname;
      d.appendChild(hostSpan);
      if (resp.unattributed[i].heuristic) {
        var badge = document.createElement("span");
        badge.className = "pc-heuristic-badge";
        badge.textContent = resp.unattributed[i].heuristic;
        badge.title = "Best-guess classification from hostname pattern";
        d.appendChild(badge);
      }
      toggleBody.appendChild(d);
    }
    if (resp.unattributed.length > 10) {
      var more = document.createElement("div"); more.className = "proto-card-more";
      more.textContent = "+" + (resp.unattributed.length - 10) + " more";
      toggleBody.appendChild(more);
    }
    var toggleFn = function() {
      var expanded = toggle.classList.toggle("is-expanded");
      sumHeader.setAttribute("aria-expanded", expanded ? "true" : "false");
    };
    sumHeader.addEventListener("click", toggleFn);
    sumHeader.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFn(); }
    });
    toggle.appendChild(sumHeader); toggle.appendChild(toggleBody);
    body.appendChild(toggle);
  }
}

function _fillGpcBody(body, resp) {
  var bgDomains = resp.gpcDomains ? Object.keys(resp.gpcDomains) : [];
  var popupDomains = (typeof lastGpcDomains !== "undefined") ? lastGpcDomains : [];
  var domains = bgDomains.length > 0 ? bgDomains : popupDomains;

  var gpcRequests = (typeof lastGpcSignalsSent !== "undefined") ? lastGpcSignalsSent : 0;

  if (domains.length === 0 && gpcRequests > 0) {
    body.textContent = "Sec-GPC: 1 sent to " + gpcRequests + " requests (domain names not captured)";
    return;
  }
  if (domains.length === 0) { body.textContent = "No GPC signals sent yet"; return; }
  var note = document.createElement("div");
  note.textContent = "GPC is sent on requests that reach the server. Blocked requests never leave your browser.";
  note.style.opacity = "0.7";
  note.style.marginBottom = "4px";
  body.appendChild(note);
  var header = document.createElement("div");
  header.innerHTML = "<strong>" + domains.length + " domains</strong> received GPC signal";
  header.style.marginBottom = "4px";
  body.appendChild(header);
  for (var i = 0; i < Math.min(domains.length, 10); i++) {
    var row = document.createElement("div"); row.className = "proto-purpose-domain";
    var name = document.createElement("span"); name.className = "proto-purpose-domain-name"; name.textContent = domains[i];
    row.appendChild(name); body.appendChild(row);
  }
  if (domains.length > 10) {
    var more = document.createElement("button"); more.type = "button"; more.className = "pc-bar-link proto-card-more";
    more.textContent = "+" + (domains.length - 10) + " more \u2192 Log";
    more.addEventListener("click", function () { navigateToLog("gpc"); });
    body.appendChild(more);
  }
}

function _fillBannersBody(body, resp, tcfData) {
  var cd = resp.cmpDetect;
  var hasCmpDetect = cd && cd.detected && cd.detected.length > 0;
  var hasActions = resp.cmp && (resp.cmp.selectorCount > 0 || resp.cmp.scrollUnlock || resp.cmp.cookieCount > 0);

  // Block 1: Blue info (CMP detection + auto-response actions)
  if (hasCmpDetect || hasActions) {
    var infoBlock = document.createElement("div");
    infoBlock.className = "pc-tcf-info";
    if (hasCmpDetect) {
      for (var i = 0; i < cd.detected.length; i++) {
        var line = document.createElement("div");
        line.style.fontWeight = "600";
        line.textContent = cd.detected[i].cmpId + " (" + (cd.detected[i].showing ? "showing" : "present") + ")";
        infoBlock.appendChild(line);
      }
    }
    if (hasActions) {
      var actions = [];
      if (resp.cmp.selectorCount > 0) actions.push("Cosmetic hiding: " + resp.cmp.selectorCount + " selectors");
      if (resp.cmp.scrollUnlock) actions.push("Scroll unlock: active");
      if (resp.cmp.cookieCount > 0) actions.push("Cookies injected: " + resp.cmp.cookieCount);
      var actLine = document.createElement("div");
      actLine.textContent = actions.join(", ");
      infoBlock.appendChild(actLine);
    }
    body.appendChild(infoBlock);
  }

  // Block 2: Yellow note (TCF provider + enforcement)
  if (tcfData) {
    var consents = tcfData.purposeConsents || {};
    var ids = Object.keys(consents).sort(function (a, b) { return Number(a) - Number(b); });
    var hasPurposes = ids.length > 0;

    var note = document.createElement("div");
    note.className = "pc-tcf-note";
    var provLine = document.createElement("div");
    provLine.style.fontWeight = "600";
    if (tcfData.cmpId && _protoCmpNames[tcfData.cmpId]) {
      provLine.textContent = "Managed by " + _protoCmpNames[tcfData.cmpId];
    } else {
      provLine.textContent = "Consent banner detected";
    }
    note.appendChild(provLine);
    var noteLine = document.createElement("div");
    noteLine.textContent = hasPurposes
      ? "ProtoConsent enforces your preferences at the network level regardless of CMP consent state."
      : "Banner not responded. ProtoConsent enforces your preferences at the network level regardless.";
    note.appendChild(noteLine);
    body.appendChild(note);

    // Block 3: Purpose grid
    var grid = document.createElement("div");
    grid.className = "pc-tcf-purposes";
    if (hasPurposes) {
      for (var j = 0; j < ids.length; j++) {
        var row = document.createElement("div"); row.className = "pc-tcf-purpose-row";
        var check = document.createElement("span");
        check.className = consents[ids[j]] ? "pc-tcf-accepted" : "pc-tcf-denied";
        check.textContent = consents[ids[j]] ? "\u2713" : "\u2717";
        var label = document.createElement("span");
        label.textContent = _iabPurposeNames[ids[j]] || ("Purpose " + ids[j]);
        row.appendChild(check); row.appendChild(label); grid.appendChild(row);
      }
    } else {
      for (var k = 1; k <= 11; k++) {
        var pRow = document.createElement("div"); pRow.className = "pc-tcf-purpose-row pc-tcf-pending-row";
        var pCheck = document.createElement("span");
        pCheck.className = "pc-tcf-pending";
        pCheck.textContent = "?";
        var pLabel = document.createElement("span");
        pLabel.textContent = _iabPurposeNames[k] || ("Purpose " + k);
        pRow.appendChild(pCheck); pRow.appendChild(pLabel); grid.appendChild(pRow);
      }
    }
    body.appendChild(grid);
  }

  if (!body.hasChildNodes()) body.textContent = "No banners detected";
}

function _fillCosmeticBody(body, resp) {
  if (!resp.cosmetic || !resp.cosmetic.domain) { body.textContent = "No cosmetic filters applied"; return; }
  var c = resp.cosmetic;
  var info = document.createElement("div");
  info.className = "pc-tcf-info";
  info.innerHTML = "<strong>" + (c.siteRules || 0) + " rules</strong> applied on " + c.domain;
  body.appendChild(info);
}

function _fillTrackersBody(body, resp) {
  if (!cnameMap) {
    var link = document.createElement("a");
    link.href = "#";
    link.textContent = "Enable CNAME list in Protection \u203A Detection";
    link.addEventListener("click", function (e) {
      e.preventDefault();
      if (typeof setActiveMode === "function") setActiveMode("enhanced");
      if (typeof initEnhancedTab === "function") initEnhancedTab();
      setTimeout(function () {
        var card = document.getElementById("ep-card-detection");
        if (card && !card.classList.contains("is-expanded")) {
          var toggle = card.querySelector(".pc-grid-card-toggle");
          if (toggle) toggle.click();
        }
      }, 100);
    });
    body.appendChild(link);
    return;
  }
  var blocked = resp.blocked || {};
  var found = [];
  var purposes = Object.keys(blocked);
  for (var i = 0; i < purposes.length; i++) {
    var domains = blocked[purposes[i]];
    if (!domains) continue;
    var hosts = Object.keys(domains);
    for (var j = 0; j < hosts.length; j++) {
      var cname = lookupCname(hosts[j]);
      if (cname) found.push({ host: hosts[j], tracker: cname });
    }
  }
  if (found.length === 0) {
    var empty = document.createElement("div"); empty.className = "pc-tcf-info";
    empty.textContent = "No CNAME-cloaked trackers detected"; body.appendChild(empty); return;
  }
  var info = document.createElement("div"); info.className = "pc-tcf-info";
  for (var k = 0; k < Math.min(found.length, 10); k++) {
    var row = document.createElement("div"); row.className = "proto-purpose-domain";
    var name = document.createElement("span"); name.className = "proto-purpose-domain-name";
    var cnameIcon = document.createElement("span");
    cnameIcon.className = "pc-log-cname-icon";
    cnameIcon.textContent = "\u21C9";
    cnameIcon.title = "CNAME cloaked\n" + found[k].host + " \u2192 " + found[k].tracker;
    cnameIcon.setAttribute("aria-label", "CNAME cloaked: " + found[k].tracker);
    name.appendChild(cnameIcon);
    name.appendChild(document.createTextNode(" " + found[k].host + " \u2192 " + found[k].tracker));
    row.appendChild(name); info.appendChild(row);
  }
  body.appendChild(info);
  if (found.length > 10) {
    var more = document.createElement("button"); more.type = "button"; more.className = "pc-bar-link proto-card-more";
    more.textContent = "+" + (found.length - 10) + " more \u2192 Log";
    more.addEventListener("click", function () { navigateToLog("domains"); });
    body.appendChild(more);
  }
}

function _fillCleanLinksBody(body, resp) {
  var strips = resp.paramStrips || {};
  var domains = Object.keys(strips);
  if (domains.length === 0) {
    var empty = document.createElement("div"); empty.className = "pc-tcf-info";
    if (typeof lastParamStrips === "number" && lastParamStrips > 0) {
      empty.textContent = lastParamStrips + " tracking parameter" + (lastParamStrips > 1 ? "s" : "") + " stripped";
    } else {
      empty.textContent = "No parameters stripped";
    }
    body.appendChild(empty);
    return;
  }
  var infoBlock = document.createElement("div"); infoBlock.className = "pc-tcf-info";
  for (var i = 0; i < Math.min(domains.length, 10); i++) {
    var info = strips[domains[i]];
    var params = (typeof info === "object" && info.params) ? info.params : [];
    if (params.length > 0) {
      for (var k = 0; k < params.length; k++) {
        var row = document.createElement("div"); row.className = "proto-purpose-domain";
        var name = document.createElement("span"); name.className = "proto-purpose-domain-name";
        name.textContent = domains[i];
        var paramSpan = document.createElement("span"); paramSpan.className = "proto-purpose-domain-count";
        paramSpan.textContent = params[k];
        row.appendChild(name); row.appendChild(paramSpan); infoBlock.appendChild(row);
      }
    } else {
      var row = document.createElement("div"); row.className = "proto-purpose-domain";
      var name = document.createElement("span"); name.className = "proto-purpose-domain-name";
      name.textContent = domains[i];
      var count = document.createElement("span"); count.className = "proto-purpose-domain-count";
      count.textContent = typeof info === "object" ? info.count : info;
      row.appendChild(name); row.appendChild(count); infoBlock.appendChild(row);
    }
  }
  body.appendChild(infoBlock);
  if (domains.length > 10) {
    var more = document.createElement("button"); more.type = "button"; more.className = "pc-bar-link proto-card-more";
    more.textContent = "+" + (domains.length - 10) + " more \u2192 Log";
    more.addEventListener("click", function () { navigateToLog("domains"); });
    body.appendChild(more);
  }
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


// Navigate to Proto tab and expand the Banners grid card.
// Called by both the Consent tab TCF pill and the Proto tab TCF pill.
function navigateToProtoTcf() {
  if (typeof setActiveMode === "function") setActiveMode("proto");
  if (typeof initProtoTab === "function") initProtoTab();
  setTimeout(function () {
    var card = document.getElementById("proto-card-banners");
    if (card && !card.classList.contains("is-expanded")) {
      var toggle = card.querySelector(".pc-grid-card-toggle");
      if (toggle) toggle.click();
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
  chevron.className = "proto-card-chevron pc-chevron";
  chevron.setAttribute("aria-hidden", "true");

  let dot = document.createElement("span");
  dot.className = "proto-signal-dot proto-mismatch-dot";
  dot.style.marginRight = "4px";

  let nameSpan = document.createElement("span");
  nameSpan.className = "proto-card-name";
  nameSpan.textContent = "Needs review";

  let detailSpan = document.createElement("span");
  detailSpan.className = "proto-card-count proto-mismatch-count";
  detailSpan.textContent = mismatches.length + " " + (mismatches.length === 1 ? "purpose" : "purposes");

  header.appendChild(chevron);
  header.appendChild(dot);
  header.appendChild(nameSpan);
  header.appendChild(detailSpan);

  let body = document.createElement("div");
  body.className = "proto-card-body";
  body.hidden = !wasExpanded.has("mismatch");

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
    body.hidden = !expanded;
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}



// --- Purpose cards (accordion) ---

function renderProtoPurposes(blocked, wkData) {
  const el = document.getElementById("proto-purposes");
  if (!el) return;

  // Preserve expanded state across refreshes (keyed by category)
  const wasExpanded = new Set();
  el.querySelectorAll(".proto-card.is-expanded").forEach((c) => {
    if (c.dataset.key) wasExpanded.add(c.dataset.key);
  });

  el.textContent = "";

  if (!blocked || Object.keys(blocked).length === 0) return;

  let wkPurposes = (wkData && wkData.purposes) ? wkData.purposes : null;
  const catalog = (typeof enhancedCatalogConfig !== "undefined") ? enhancedCatalogConfig : null;

  // Group blocked entries by category
  const categoryGroups = {};
  for (const [purpose, domains] of Object.entries(blocked)) {
    const total = Object.values(domains).reduce((s, c) => s + c, 0);
    if (total === 0) continue;
    let category, label;
    const isEnhanced = purpose.startsWith("enhanced:");
    if (isEnhanced) {
      const listId = purpose.split(":")[1];
      category = (catalog && catalog[listId] && catalog[listId].category) || "other";
      label = (catalog && catalog[listId] && catalog[listId].name) || listId;
    } else {
      category = purpose;
      label = (typeof getPurposeLabel === "function") ? getPurposeLabel(purpose) : purpose;
    }
    if (!categoryGroups[category]) categoryGroups[category] = [];
    categoryGroups[category].push({ key: purpose, label, domains, total, isEnhanced });
  }

  // Sort categories by total blocked desc; sources within each by total desc
  const sorted = Object.entries(categoryGroups).map(([cat, items]) => {
    items.sort((a, b) => b.total - a.total);
    return { category: cat, items, total: items.reduce((s, i) => s + i.total, 0) };
  }).sort((a, b) => b.total - a.total);

  // Resolve category display info
  function getCategoryDisplay(cat) {
    const pCfg = (typeof purposesConfig !== "undefined") ? purposesConfig[cat] : null;
    if (pCfg) return { icon: pCfg.icon, label: getPurposeLabel(cat) };
    const extra = ENHANCED_EXTRA_CATEGORIES[cat];
    if (extra) return { icon: extra.icon, label: extra.label };
    return { icon: "../icons/grid/blocking.svg", label: "General Protection" };
  }

  for (const { category, items, total } of sorted) {
    const display = getCategoryDisplay(category);

    const card = document.createElement("div");
    card.className = "proto-card";
    card.dataset.key = category;
    if (wasExpanded.has(category)) card.classList.add("is-expanded");

    // Header
    const header = document.createElement("div");
    header.className = "proto-card-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", wasExpanded.has(category) ? "true" : "false");

    const chevron = document.createElement("span");
    chevron.className = "proto-card-chevron pc-chevron";
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);

    if (display.icon) {
      const iconEl = document.createElement("img");
      iconEl.src = display.icon;
      iconEl.width = 20;
      iconEl.height = 20;
      iconEl.alt = "";
      iconEl.className = "proto-card-icon";
      header.appendChild(iconEl);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "proto-card-name";
    nameSpan.textContent = display.label;

    const countSpan = document.createElement("span");
    countSpan.className = "proto-card-count";
    countSpan.textContent = total + " blocked";

    header.appendChild(nameSpan);
    header.appendChild(countSpan);

    // Declaration badge - only for core purpose categories
    if (wkPurposes && typeof purposesConfig !== "undefined" && purposesConfig[category]) {
      const declBadge = document.createElement("span");
      declBadge.className = "proto-card-decl";
      const declEntry = wkPurposes[category];
      if (declEntry) {
        if (declEntry.used === true) {
          declBadge.textContent = "Declared: used";
          declBadge.classList.add("proto-decl-used");
          declBadge.title = "Site declares this purpose as used";
        } else if (declEntry.used === false) {
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

    // Body
    const body = document.createElement("div");
    body.className = "proto-card-body";
    body.hidden = !wasExpanded.has(category);

    if (items.length === 1) {
      // Single source: show domains directly
      renderDomainList(body, items[0].domains, 10);
    } else {
      // Multiple sources: sub-header per source
      for (const src of items) {
        const srcHeader = document.createElement("div");
        srcHeader.className = "proto-source-header";
        if (src.isEnhanced) {
          const shield = document.createElement("img");
          shield.src = ENHANCED_ICON;
          shield.width = 14;
          shield.height = 14;
          shield.alt = "EP";
          srcHeader.appendChild(shield);
        }
        const srcName = document.createElement("span");
        srcName.textContent = src.label;
        srcHeader.appendChild(srcName);
        const srcCount = document.createElement("span");
        srcCount.className = "proto-source-count";
        srcCount.textContent = src.total;
        srcHeader.appendChild(srcCount);
        body.appendChild(srcHeader);
        renderDomainList(body, src.domains, 5);
      }
    }

    // Toggle handler
    const toggle = () => {
      const expanded = card.classList.toggle("is-expanded");
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
      body.hidden = !expanded;
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

function renderDomainList(container, domains, limit) {
  const entries = Object.entries(domains).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit);
  for (const [domain, count] of shown) {
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
    container.appendChild(row);
  }
  if (entries.length > limit) {
    const moreEl = document.createElement("div");
    moreEl.className = "proto-card-more";
    moreEl.textContent = "+" + (entries.length - limit) + " more";
    container.appendChild(moreEl);
  }
}



// --- Show/Hide details integration ---
// Called from popup.js toggleDescBtn handler


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
  if (state.isBrave && mode === "protoconsent") {
    config = {
      title: "Brave Shields active",
      detail: "Brave blocks trackers before ProtoConsent can count them. Block counts will show 0, but privacy signals (GPC), banner management, cosmetic filtering, and URL cleaning remain active. Switch to Blocking mode for purpose-based protection on top of Shields.",
      primaryLabel: "Switch to Blocking",
      dismissLabel: "Dismiss",
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
