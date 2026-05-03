// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Quick-toggle pills: expandable row under lifetime counter.
// Globals exposed: toggleLifetimePanel, setLifetimePanelState.

var GRID_ICONS_PATH = "../icons/grid/";

var LT_TOGGLES = [
  { id: "banners", icon: "banners.svg", key: "cmpAutoResponse", tooltip: "Cookie banner management", defaultOn: true },
  { id: "cosmetic", icon: "cosmetic.svg", key: "enhancedCosmeticEnabled", tooltip: "Cosmetic filters (hide ads, banners, annoyances)", defaultOn: true, needsRebuild: true },
  { id: "signals", icon: "gpc.svg", keys: ["gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled"], tooltip: "Privacy signals (GPC, Client Hints, URL params)", defaultOn: true },
  { id: "api", icon: "api.svg", key: "interExtEnabled", tooltip: "Inter-extension API", defaultOn: false },
  { id: "theme", icon: "theme-auto.svg", key: "theme", tooltip: "Theme", isTheme: true },
];

function toggleLifetimePanel() {
  var ltEl = document.getElementById("pc-lifetime-counter");
  if (!ltEl || ltEl.hidden) return;
  var expanded = ltEl.classList.toggle("is-expanded");
  ltEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) _renderLifetimeToggles();
}

function setLifetimePanelState(expanded) {
  var ltEl = document.getElementById("pc-lifetime-counter");
  if (!ltEl || ltEl.hidden) return;
  if (ltEl.classList.contains("is-expanded") === expanded) return;
  ltEl.classList.toggle("is-expanded", expanded);
  ltEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) _renderLifetimeToggles();
}

function _renderLifetimeToggles() {
  var container = document.getElementById("pc-lifetime-toggles");
  if (!container) return;
  container.innerHTML = "";

  var allKeys = [];
  for (var i = 0; i < LT_TOGGLES.length; i++) {
    var t = LT_TOGGLES[i];
    if (t.keys) { for (var k = 0; k < t.keys.length; k++) allKeys.push(t.keys[k]); }
    else allKeys.push(t.key);
  }

  chrome.storage.local.get(allKeys, function (data) {
    for (var i = 0; i < LT_TOGGLES.length; i++) {
      container.appendChild(_buildLtPill(LT_TOGGLES[i], data));
    }
  });
}

function _buildLtPill(toggle, data) {
  var pill = document.createElement("button");
  pill.type = "button";
  pill.className = "pc-lt-pill";
  pill.setAttribute("data-toggle", toggle.id);
  pill.setAttribute("aria-label", toggle.tooltip);

  var img = document.createElement("img");
  img.src = GRID_ICONS_PATH + toggle.icon;
  img.alt = "";
  img.width = 18;
  img.height = 18;
  pill.appendChild(img);

  var dot = document.createElement("span");
  dot.className = "pc-lt-dot";
  dot.setAttribute("aria-hidden", "true");
  pill.appendChild(dot);

  if (toggle.isTheme) {
    _applyThemeState(pill, data.theme || "auto");
    pill.addEventListener("click", function () { _cycleTheme(pill); });
  } else if (toggle.keys) {
    var state = _signalsGroupState(toggle.keys, data);
    _applyGroupState(pill, state);
    pill.addEventListener("click", function () { _toggleSignalsGroup(pill, toggle); });
  } else {
    var on = toggle.defaultOn ? data[toggle.key] !== false : data[toggle.key] === true;
    if (on) pill.classList.add("is-active");
    pill.title = toggle.tooltip + (on ? " (on)" : " (off)");
    pill.setAttribute("aria-pressed", on ? "true" : "false");
    pill.addEventListener("click", function () { _toggleSingleKey(pill, toggle); });
  }

  return pill;
}

function _signalsGroupState(keys, data) {
  var onCount = 0;
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]] !== false) onCount++;
  }
  if (onCount === keys.length) return "active";
  if (onCount === 0) return "inactive";
  return "partial";
}

function _applyGroupState(pill, state) {
  pill.classList.remove("is-active", "is-partial");
  if (state === "active") pill.classList.add("is-active");
  else if (state === "partial") pill.classList.add("is-partial");
  var toggle = LT_TOGGLES.find(function (t) { return t.id === pill.getAttribute("data-toggle"); });
  var label = toggle ? toggle.tooltip : "";
  if (state === "active") { pill.title = label + " (all on)"; pill.setAttribute("aria-pressed", "true"); }
  else if (state === "partial") { pill.title = label + " (mixed)"; pill.setAttribute("aria-pressed", "mixed"); }
  else { pill.title = label + " (all off)"; pill.setAttribute("aria-pressed", "false"); }
}

function _toggleSingleKey(pill, toggle) {
  var currentlyOn = pill.classList.contains("is-active");
  var newVal = !currentlyOn;
  var update = {};
  update[toggle.key] = newVal;
  chrome.storage.local.set(update);
  pill.classList.toggle("is-active", newVal);
  pill.title = toggle.tooltip + (newVal ? " (on)" : " (off)");
  pill.setAttribute("aria-pressed", newVal ? "true" : "false");
  if (toggle.needsRebuild) {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
  }
}

function _toggleSignalsGroup(pill, toggle) {
  var turnAllOn = !pill.classList.contains("is-active");
  var update = {};
  for (var i = 0; i < toggle.keys.length; i++) {
    update[toggle.keys[i]] = turnAllOn;
  }
  chrome.storage.local.set(update);
  _applyGroupState(pill, turnAllOn ? "active" : "inactive");
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
}

var THEME_CYCLE = ["auto", "light", "dark"];

function _applyThemeState(pill, theme) {
  pill.classList.remove("is-theme", "is-theme-light", "is-theme-dark");
  if (theme === "light") pill.classList.add("is-theme-light");
  else if (theme === "dark") pill.classList.add("is-theme-dark");
  else pill.classList.add("is-theme");
  pill.classList.add("is-active");
  var iconFile = theme === "light" ? "theme-light.svg" : theme === "dark" ? "theme-dark.svg" : "theme-auto.svg";
  var img = pill.querySelector("img");
  if (img) img.src = GRID_ICONS_PATH + iconFile;
  pill.title = "Theme: " + theme.charAt(0).toUpperCase() + theme.slice(1);
}

function _cycleTheme(pill) {
  chrome.storage.local.get("theme", function (data) {
    var current = data.theme || "auto";
    var idx = THEME_CYCLE.indexOf(current);
    var next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    chrome.storage.local.set({ theme: next });
    _applyThemeState(pill, next);
  });
}
