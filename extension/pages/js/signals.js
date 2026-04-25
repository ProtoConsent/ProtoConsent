// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Privacy signals: pill indicators, signal state computation, signals bar rendering.
// Loaded after popup.js - uses globals: _signalsBar, lastGpcSignalsSent, lastGpcDomains,
// lastChStripped, currentDomain, currentPurposesState, gpcGlobalEnabled, chStrippingEnabled,
// expectedGpcEnabled, navigateToLog, navigateToProtoTcf, toggleSidePanel, ensureBars, pluralize.

// --- Signals bar ---

function renderSignalsBar(observedGpc) {
  ensureBars();
  if (!_signalsBar) return;

  if (typeof observedGpc === "undefined") observedGpc = lastGpcSignalsSent;

  var summary = buildSignalSummary(observedGpc);
  _signalsBar.setCollapsed(summary, "Global Privacy Control (GPC), Client Hints stripping, .well-known declaration, TCF banner detection");

  var pillsDiv = document.createElement("div");
  pillsDiv.className = "pc-scope-indicators";
  pillsDiv.style.gap = "4px 6px";

  pillsDiv.appendChild(buildPill("GPC", computeGpcState(observedGpc), function () { navigateToLog("gpc"); }));
  pillsDiv.appendChild(buildPill("CH", computeChState()));
  var wkState = computeWkState();
  var wkClick;
  if (wkState.state === "active" && typeof toggleSidePanel === "function") {
    wkClick = function () { toggleSidePanel(); };
  } else if (currentDomain && typeof refreshWellKnown === "function") {
    wkClick = function () { refreshWellKnown(); };
  }
  pillsDiv.appendChild(buildPill("WK", wkState, wkClick));
  pillsDiv.appendChild(buildPill("TCF", { state: "disabled", title: "TCF CMP not detected" }));
  updateTcfPill(pillsDiv);

  var wrapper = document.createElement("div");
  wrapper.appendChild(pillsDiv);

  if (typeof _wkRecheckStatus === "string" && _wkRecheckStatus) {
    var statusEl = document.createElement("div");
    statusEl.className = "pc-wk-recheck-status";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.textContent = _wkRecheckStatus;
    wrapper.appendChild(statusEl);
  }

  _signalsBar.setExpanded(wrapper);
}

function buildSignalSummary(observedGpc) {
  var main;
  if (observedGpc > 0 && lastGpcDomains.length > 0) {
    main = "GPC to " + pluralize(lastGpcDomains.length, "domain");
  } else if (observedGpc > 0 && expectedGpcEnabled()) {
    main = "GPC active (" + pluralize(observedGpc, "request") + ")";
  } else if (expectedGpcEnabled()) {
    main = "GPC active";
  } else if (lastChStripped > 0) {
    main = "CH stripped (" + lastChStripped + ")";
  } else {
    main = "Privacy signals";
  }
  var wk = computeWkState();
  if (wk.state === "active") main += " \u00B7 Site declaration";
  return main;
}

// --- Signal state computation ---

function computeGpcState(observedGpc) {
  if (!currentDomain) return { state: "disabled", title: "GPC unavailable on this page" };
  if (!gpcGlobalEnabled) return { state: "disabled", title: "GPC globally disabled in Purpose Settings" };
  var on = expectedGpcEnabled();
  var tip = on ? "GPC: active - do-not-sell/share signal" : "GPC: inactive";
  if (observedGpc > 0 && lastGpcDomains.length > 0) {
    tip += "\nSent to " + pluralize(lastGpcDomains.length, "domain") + " (" + pluralize(observedGpc, "request") + ")";
  } else if (observedGpc > 0 && on) {
    tip += "\nSent to " + pluralize(observedGpc, "request") + " (domain names not captured)";
  } else if (on) {
    tip += "\nNo signals sent yet on this tab";
  }
  return { state: on ? "active" : "inactive", title: tip };
}

function computeChState() {
  if (!currentDomain) return { state: "disabled", title: "Client Hints stripping unavailable on this page" };
  if (!chStrippingEnabled) return { state: "disabled", title: "Client Hints stripping globally disabled in Purpose Settings" };
  var on = currentPurposesState.advanced_tracking === false;
  if (on) {
    var countStr = lastChStripped > 0 ? " (" + lastChStripped + " requests)" : "";
    return { state: "active", title: "Client Hints: stripping active" + countStr + "\nHigh-entropy fingerprinting headers removed" };
  }
  return { state: "inactive", title: "Client Hints: not stripped\nAdvanced tracking allowed for this site" };
}

function computeWkState() {
  var state = typeof _wkIndicatorState !== "undefined" ? _wkIndicatorState : "disabled";
  var title = typeof _wkIndicatorTitle !== "undefined" ? _wkIndicatorTitle : "WK status unavailable";
  if (state !== "active" && currentDomain) title += "\nClick to recheck";
  return { state: state, title: title };
}

function updateTcfPill(container) {
  if (!currentDomain) return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0]) return;
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_TCF", tabId: tabs[0].id }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.tcf) return;
      var tcf = resp.tcf;
      var pill = container.querySelector('[data-signal="TCF"]');
      if (pill) {
        pill.classList.remove("is-disabled");
        pill.classList.add("is-active");
        var tip = "Cookie banner detected";
        if (tcf.purposeConsents) {
          var total = Object.keys(tcf.purposeConsents).length;
          if (total > 0) {
            var accepted = Object.entries(tcf.purposeConsents).filter(function (e) { return e[1]; }).length;
            tip += " \u00b7 " + accepted + "/" + total + " purposes accepted";
          }
        }
        pill.title = tip;
        pill.style.cursor = "pointer";
        pill.addEventListener("click", navigateToProtoTcf);
      }
    });
  });
}

// --- Pill builder ---

function buildPill(label, info, clickHandler) {
  var pill = document.createElement("div");
  pill.className = "pc-pill-indicator pc-" + label.toLowerCase() + "-indicator";
  pill.setAttribute("data-signal", label);
  pill.setAttribute("role", "status");
  pill.setAttribute("aria-live", "polite");

  if (info.state === "active") pill.classList.add("is-active");
  else if (info.state === "inactive") pill.classList.add("is-inactive");
  else pill.classList.add("is-disabled");

  pill.title = info.title || "";

  var dot = document.createElement("span");
  dot.className = "pc-pill-dot pc-" + label.toLowerCase() + "-dot";
  dot.setAttribute("aria-hidden", "true");
  pill.appendChild(dot);
  pill.appendChild(document.createTextNode(label));

  if (clickHandler) {
    pill.style.cursor = "pointer";
    pill.setAttribute("role", "button");
    pill.removeAttribute("aria-live");
    pill.setAttribute("tabindex", "0");
    pill.addEventListener("click", clickHandler);
    pill.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clickHandler(); }
    });
  } else {
    pill.style.cursor = "help";
  }

  return pill;
}
