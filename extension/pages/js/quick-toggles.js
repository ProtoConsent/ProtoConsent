// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Quick-toggle pills: expandable row under lifetime counter.
// Globals exposed: toggleLifetimePanel, setLifetimePanelState.

const GRID_ICONS_PATH = "../icons/grid/";

const LT_TOGGLES = [
  { id: "banners", icon: "banners.svg", key: "cmpAutoResponse", tooltip: "Cookie banner management", defaultOn: true },
  { id: "cosmetic", icon: "cosmetic.svg", key: "enhancedCosmeticEnabled", tooltip: "Cosmetic filters (hide ads, banners, annoyances)", defaultOn: true, needsRebuild: true },
  { id: "signals", icon: "gpc.svg", keys: ["gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled"], tooltip: "Privacy signals (GPC, Client Hints, URL params)", defaultOn: true },
  { id: "picker", icon: "picker.svg", tooltip: "Pick element to hide (manage in Log > Cosmetic)", isAction: true },
  { id: "api", icon: "api.svg", key: "interExtEnabled", tooltip: "Inter-extension API", defaultOn: false },
  { id: "theme", icon: "theme-auto.svg", key: "theme", tooltip: "Theme", isTheme: true },
];

function toggleLifetimePanel() {
  const ltEl = document.getElementById("pc-lifetime-counter");
  if (!ltEl || ltEl.hidden) return;
  const expanded = ltEl.classList.toggle("is-expanded");
  ltEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) _renderLifetimeToggles();
}

function setLifetimePanelState(expanded) {
  const ltEl = document.getElementById("pc-lifetime-counter");
  if (!ltEl || ltEl.hidden) return;
  if (ltEl.classList.contains("is-expanded") === expanded) return;
  ltEl.classList.toggle("is-expanded", expanded);
  ltEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) _renderLifetimeToggles();
}

function _renderLifetimeToggles() {
  const container = document.getElementById("pc-lifetime-toggles");
  if (!container) return;
  container.innerHTML = "";

  const allKeys = ["enhancedCosmeticEnabled"];
  for (let i = 0; i < LT_TOGGLES.length; i++) {
    const t = LT_TOGGLES[i];
    if (t.isAction) continue; // actions don't read storage
    if (t.keys) { for (let k = 0; k < t.keys.length; k++) allKeys.push(t.keys[k]); }
    else allKeys.push(t.key);
  }

  chrome.storage.local.get(allKeys, function (data) {
    for (let i = 0; i < LT_TOGGLES.length; i++) {
      container.appendChild(_buildLtPill(LT_TOGGLES[i], data));
    }
  });
}

function _buildLtPill(toggle, data) {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "pc-lt-pill";
  pill.setAttribute("data-toggle", toggle.id);
  pill.setAttribute("aria-label", toggle.tooltip);

  const img = document.createElement("img");
  img.src = GRID_ICONS_PATH + toggle.icon;
  img.alt = "";
  img.width = 18;
  img.height = 18;
  pill.appendChild(img);

  const dot = document.createElement("span");
  dot.className = "pc-lt-dot";
  dot.setAttribute("aria-hidden", "true");
  pill.appendChild(dot);

  if (toggle.isAction) {
    const cosmeticOn = data.enhancedCosmeticEnabled !== false;
    pill.disabled = !cosmeticOn;
    pill.classList.toggle("is-active", cosmeticOn);
    pill.title = cosmeticOn ? toggle.tooltip : "Enable cosmetic filters first";
    dot.style.backgroundColor = cosmeticOn ? "var(--pc-accent, #3b82f6)" : "";
    pill.addEventListener("click", function () { _triggerAction(toggle); });
  } else if (toggle.isTheme) {
    _applyThemeState(pill, data.theme || "auto");
    pill.addEventListener("click", function () { _cycleTheme(pill); });
  } else if (toggle.keys) {
    const state = _signalsGroupState(toggle.keys, data);
    _applyGroupState(pill, state);
    pill.addEventListener("click", function () { _toggleSignalsGroup(pill, toggle); });
  } else {
    const on = toggle.defaultOn ? data[toggle.key] !== false : data[toggle.key] === true;
    if (on) pill.classList.add("is-active");
    pill.title = toggle.tooltip + (on ? " (on)" : " (off)");
    pill.setAttribute("aria-pressed", on ? "true" : "false");
    pill.addEventListener("click", function () { _toggleSingleKey(pill, toggle); });
  }

  return pill;
}

function _signalsGroupState(keys, data) {
  let onCount = 0;
  for (let i = 0; i < keys.length; i++) {
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
  const toggle = LT_TOGGLES.find(function (t) { return t.id === pill.getAttribute("data-toggle"); });
  const label = toggle ? toggle.tooltip : "";
  if (state === "active") { pill.title = label + " (all on)"; pill.setAttribute("aria-pressed", "true"); }
  else if (state === "partial") { pill.title = label + " (mixed)"; pill.setAttribute("aria-pressed", "mixed"); }
  else { pill.title = label + " (all off)"; pill.setAttribute("aria-pressed", "false"); }
}

function _toggleSingleKey(pill, toggle) {
  const currentlyOn = pill.classList.contains("is-active");
  const newVal = !currentlyOn;
  const update = {};
  update[toggle.key] = newVal;
  chrome.storage.local.set(update);
  pill.classList.toggle("is-active", newVal);
  pill.title = toggle.tooltip + (newVal ? " (on)" : " (off)");
  pill.setAttribute("aria-pressed", newVal ? "true" : "false");
  if (toggle.needsRebuild) {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
  }
  // Cosmetic toggle affects picker pill
  if (toggle.key === "enhancedCosmeticEnabled") {
    var pp = document.querySelector('[data-toggle="picker"]');
    if (pp) {
      pp.disabled = !newVal;
      pp.classList.toggle("is-active", newVal);
      pp.title = newVal ? "Pick element to hide (manage in Log > Cosmetic)" : "Enable cosmetic filters first";
      var d = pp.querySelector(".pc-lt-dot");
      if (d) d.style.backgroundColor = newVal ? "var(--pc-accent, #3b82f6)" : "";
    }
  }
}

function _toggleSignalsGroup(pill, toggle) {
  const turnAllOn = !pill.classList.contains("is-active");
  const update = {};
  for (let i = 0; i < toggle.keys.length; i++) {
    update[toggle.keys[i]] = turnAllOn;
  }
  chrome.storage.local.set(update);
  _applyGroupState(pill, turnAllOn ? "active" : "inactive");
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
}

const THEME_CYCLE = ["auto", "light", "dark"];

function _applyThemeState(pill, theme) {
  pill.classList.remove("is-theme", "is-theme-light", "is-theme-dark", "is-active");
  if (theme === "light") pill.classList.add("is-theme-light");
  else if (theme === "dark") pill.classList.add("is-theme-dark");
  else pill.classList.add("is-theme");
  const iconFile = theme === "light" ? "theme-light.svg" : theme === "dark" ? "theme-dark.svg" : "theme-auto.svg";
  const img = pill.querySelector("img");
  if (img) img.src = GRID_ICONS_PATH + iconFile;
  pill.title = "Theme: " + theme.charAt(0).toUpperCase() + theme.slice(1);
}

function _cycleTheme(pill) {
  chrome.storage.local.get("theme", function (data) {
    const current = data.theme || "auto";
    const idx = THEME_CYCLE.indexOf(current);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    chrome.storage.local.set({ theme: next });
    _applyThemeState(pill, next);
  });
}

function _triggerAction(toggle) {
  if (toggle.id === "picker") {
    chrome.runtime.sendMessage({ type: "PROTOCONSENT_PICKER_START" }, function (resp) {
      void chrome.runtime.lastError;
    });
    // Close popup so the page is visible for picking
    window.close();
  }
}
