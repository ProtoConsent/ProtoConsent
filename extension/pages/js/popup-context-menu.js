// ProtoConsent popup custom context menu
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Replaces the native right-click menu inside the popup with a custom one.
// Reuses the same storage keys and actions as background/context-menu.js.

(function () {
  const SIGNAL_KEYS = ["gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled"];

  const ITEMS = [
    { id: "mode", type: "checkbox", key: "operatingMode",
      label: function (on) { return on ? "Blocking mode" : "Monitoring mode - not blocking"; },
      isOn: function (d) { return (d.operatingMode || "standalone") === "standalone"; },
      action: function (on) {
        const mode = on ? "standalone" : "protoconsent";
        chrome.storage.local.set({ operatingMode: mode });
        chrome.runtime.sendMessage({ type: "PROTOCONSENT_SET_OPERATING_MODE", mode: mode }, function () {
          void chrome.runtime.lastError;
          if (typeof operatingMode !== "undefined") operatingMode = mode;
          if (typeof updateModeIndicator === "function") updateModeIndicator(mode);
          if (typeof _renderLifetimeToggles === "function") _renderLifetimeToggles();
        });
      }
    },
    { type: "separator" },
    { id: "banners", type: "checkbox", key: "cmpAutoResponse",
      label: function (on) { return on ? "Cookie banner management (enabled)" : "Cookie banner management (paused)"; },
      isOn: function (d) { return d.cmpAutoResponse !== false; },
      action: function (on) {
        chrome.storage.local.set({ cmpAutoResponse: on }, function () {
          if (typeof _renderLifetimeToggles === "function") _renderLifetimeToggles();
        });
      }
    },
    { id: "cosmetic", type: "checkbox", key: "enhancedCosmeticEnabled",
      label: function (on) { return on ? "Cosmetic filters (hide ads, banners, annoyances)" : "Cosmetic filters (show ads, banners, annoyances)"; },
      isOn: function (d) { return d.enhancedCosmeticEnabled !== false; },
      action: function (on) {
        chrome.storage.local.set({ enhancedCosmeticEnabled: on }, function () {
          chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
          if (typeof _renderLifetimeToggles === "function") _renderLifetimeToggles();
        });
      }
    },
    { id: "signals", type: "checkbox", keys: SIGNAL_KEYS,
      label: function (on, count) {
        if (on) return "Privacy signals (GPC, Client Hints, URL params)";
        if (count > 0) return "Privacy signals (partial)";
        return "Privacy signals (disabled)";
      },
      isOn: function (d) {
        let on = 0;
        for (let i = 0; i < SIGNAL_KEYS.length; i++) { if (d[SIGNAL_KEYS[i]] !== false) on++; }
        return on === SIGNAL_KEYS.length;
      },
      onCount: function (d) {
        let on = 0;
        for (let i = 0; i < SIGNAL_KEYS.length; i++) { if (d[SIGNAL_KEYS[i]] !== false) on++; }
        return on;
      },
      action: function (on) {
        const update = {};
        for (let i = 0; i < SIGNAL_KEYS.length; i++) { update[SIGNAL_KEYS[i]] = on; }
        chrome.storage.local.set(update, function () {
          chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
          if (typeof _renderLifetimeToggles === "function") _renderLifetimeToggles();
        });
      }
    },
    { type: "separator" },
    { id: "whitelist", type: "normal", label: function () { return "Whitelist site"; },
      action: function () {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (!tabs || !tabs[0]) return;
          let url;
          try { url = new URL(tabs[0].url); } catch (e) { return; }
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
          const site = url.hostname.replace(/^www\./, "");
          chrome.runtime.sendMessage({ type: "PROTOCONSENT_WHITELIST_ALL_SITE", tabId: tabs[0].id, site: site });
        });
      }
    },
    { id: "settings", type: "normal", label: function () { return "ProtoConsent settings"; },
      action: function () { chrome.runtime.openOptionsPage(); }
    },
  ];

  let menu = null;

  function buildMenu(data) {
    if (menu) menu.remove();
    menu = document.createElement("div");
    menu.className = "pc-ctx-menu";
    menu.setAttribute("role", "menu");

    for (let i = 0; i < ITEMS.length; i++) {
      const item = ITEMS[i];

      if (item.type === "separator") {
        const sep = document.createElement("div");
        sep.className = "pc-ctx-sep";
        sep.setAttribute("role", "separator");
        menu.appendChild(sep);
        continue;
      }

      const row = document.createElement("div");
      row.className = "pc-ctx-item";
      row.dataset.idx = String(i);
      row.setAttribute("tabindex", "-1");

      if (item.type === "checkbox") {
        const on = item.isOn(data);
        const count = item.onCount ? item.onCount(data) : 0;
        row.setAttribute("role", "menuitemcheckbox");
        row.setAttribute("aria-checked", on ? "true" : "false");

        const check = document.createElement("span");
        check.className = "pc-ctx-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = on ? "\u2713" : "";
        row.appendChild(check);

        const lbl = document.createElement("span");
        lbl.textContent = item.label(on, count);
        row.appendChild(lbl);
      } else {
        row.setAttribute("role", "menuitem");

        const pad = document.createElement("span");
        pad.className = "pc-ctx-check";
        pad.setAttribute("aria-hidden", "true");
        row.appendChild(pad);

        const lbl2 = document.createElement("span");
        lbl2.textContent = item.label();
        row.appendChild(lbl2);
      }

      row.addEventListener("click", (function (idx) {
        return function () {
          const it = ITEMS[idx];
          if (it.type === "checkbox") {
            const keys = ["operatingMode", "cmpAutoResponse", "enhancedCosmeticEnabled"].concat(SIGNAL_KEYS);
            chrome.storage.local.get(keys, function (d) {
              const wasOn = it.isOn(d);
              it.action(!wasOn);
            });
          } else {
            it.action();
          }
          hideMenu();
        };
      })(i));

      row.addEventListener("keydown", (function (idx) {
        return function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.click(); }
          else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); focusAdjacentItem(1); }
          else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); focusAdjacentItem(-1); }
        };
      })(i));

      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    return menu;
  }

  function focusAdjacentItem(dir) {
    if (!menu) return;
    const items = menu.querySelectorAll(".pc-ctx-item");
    if (!items.length) return;
    const current = document.activeElement;
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i] === current) { idx = i; break; }
    }
    let next = idx + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next].focus();
  }

  function showMenu(x, y, viaKeyboard) {
    const keys = ["operatingMode", "cmpAutoResponse", "enhancedCosmeticEnabled"].concat(SIGNAL_KEYS);
    chrome.storage.local.get(keys, function (data) {
      buildMenu(data);
      const bw = document.documentElement.clientWidth;
      const bh = document.documentElement.clientHeight;
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      if (x + mw > bw) x = bw - mw - 2;
      if (y + mh > bh) y = bh - mh - 2;
      if (x < 0) x = 2;
      if (y < 0) y = 2;
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.style.visibility = "visible";
      if (viaKeyboard) {
        const first = menu.querySelector(".pc-ctx-item");
        if (first) first.focus();
      }
    });
  }

  function hideMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    hideMenu();
    const viaKeyboard = e.clientX === 0 && e.clientY === 0;
    showMenu(e.clientX, e.clientY, viaKeyboard);
  });

  document.addEventListener("click", function () { hideMenu(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { hideMenu(); return; }
    if (!menu) return;
    if (menu.contains(document.activeElement)) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); focusAdjacentItem(1); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); focusAdjacentItem(-1); }
  });
})();
