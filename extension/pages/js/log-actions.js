// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Log tab: event wiring, whitelist mutations, port connection, tab/copy controls.
// Sends messages to the service worker and re-invokes log-render.js functions.

// --- One-time setup + refresh ---
function initLogTab() {
  // Load CNAME map if not already loaded; re-render domains once loaded
  if (!cnameMap) loadCnameData((loaded) => {
    if (loaded) renderLogDomains();
  });
  // Show debug inner tab only when DEBUG_RULES is on
  const debugTab = document.querySelector('[data-log-tab="debug"]');
  if (debugTab) debugTab.hidden = !DEBUG_RULES;

  // Always reconnect port if disconnected (SW may have restarted)
  if (!logPort) connectLogPort();

  if (!logInitialized) {
    initLogInnerTabs();
    initLogCopyButton();
    // Regional flags: built once (they don't change with domain)
    const strip = document.getElementById("pc-log-dot-strip");
    if (strip && typeof buildRegionalFlags === "function") {
      const flagsLink = document.createElement("a");
      flagsLink.href = "purposes-settings.html#regional-filters";
      flagsLink.target = "_blank";
      flagsLink.className = "pc-log-dot-flags";
      flagsLink.hidden = true;
      buildRegionalFlags(flagsLink, { maxFlags: 2 });
      strip.appendChild(flagsLink);
    }
    logInitialized = true;
  }

  refreshLogView();
}

// --- Inner tab switching ---

function initLogInnerTabs() {
  const tabs = document.querySelectorAll(".pc-log-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.logTab;
      if (!target) return;
      setActiveLogTab(target);
    });
  });
  // Arrow key navigation within tablist (WAI-ARIA Tabs pattern)
  const tablist = document.querySelector(".pc-log-tabs");
  if (tablist) {
    tablist.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const visible = Array.from(tabs).filter(t => !t.hidden && !t.classList.contains("pc-log-copy"));
      const idx = visible.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const next = e.key === "ArrowRight"
        ? visible[(idx + 1) % visible.length]
        : visible[(idx - 1 + visible.length) % visible.length];
      next.focus();
      next.click();
    });
  }
}

function initLogCopyButton() {
  const btn = document.getElementById("pc-log-copy");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const activePanel = document.querySelector(".pc-log-panel.is-active");
    if (!activePanel) return;
    const text = formatPanelForCopy(activePanel);
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }).catch(() => {
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  });
}

function setActiveLogTab(name) {
  document.querySelectorAll(".pc-log-tab").forEach((tab) => {
    const isActive = tab.dataset.logTab === name;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.querySelectorAll(".pc-log-panel").forEach((panel) => {
    const isActive = panel.dataset.logPanel === name;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });
}

// --- Real-time request log via port ---

function connectLogPort() {
  if (logPort) return;

  try {
    logPort = chrome.runtime.connect({ name: "log" });
  } catch (err) {
    appendLogLine("[error] Could not connect to background: " + err.message);
    return;
  }

  logPort.onMessage.addListener((msg) => {
    if (msg.type === "block") {
      appendLogLine("[" + msg.purpose + "] " + msg.url, "block");
    } else if (msg.type === "gpc") {
      appendLogLine("[gpc] " + msg.domain, "gpc");
    } else if (msg.type === "cosmetic") {
      let detail = "[cosmetic] " + msg.domain;
      if (msg.siteRules > 0) detail += " +" + msg.siteRules + " site rules";
      appendLogLine(detail, "cosmetic");
    } else if (msg.type === "param_strip") {
      let detail = "[param-strip] " + msg.domain;
      if (msg.params && msg.params.length > 0) detail += " \u2212 " + msg.params.join(", ");
      appendLogLine(detail, "param-strip");
    } else if (msg.type === "ext") {
      const sid = msg.sender.length > 16 ? msg.sender.slice(0, 8) + "\u2026" + msg.sender.slice(-6) : msg.sender;
      const action = (msg.action || "").replace("protoconsent:", "");
      let detail = action;
      if (msg.domain) detail += " " + msg.domain;
      if (msg.result === "ok") {
        detail += msg.profile ? " \u2713 " + msg.profile : " \u2713";
      } else {
        detail += " \u2717 " + msg.result;
      }
      appendLogLine("[ext] " + sid + " \u2192 " + detail, "ext", msg.ts);
    } else if (msg.type === "cmp_detect") {
      renderCmpDetectLog(msg);
    }
  });

  logPort.onDisconnect.addListener(() => {
    logPort = null;
    // Service worker restarted - clear log and reconnect so port replay is clean
    setTimeout(() => {
      if (!logPort && activeMode === "log") {
        const pre = document.getElementById("pc-log-requests");
        if (pre) pre.innerHTML = "";
        _historicalReplayed = false;
        initLogTab();
      }
    }, 1000);
  });
}

// --- Whitelist handlers ---

// Focus restore helper: after DOM rebuild, find button with matching data-wl-domain.
function restoreWhitelistFocus(domain) {
  if (!domain) return;
  requestAnimationFrame(() => {
    const btn = document.querySelector('button[data-wl-domain="' + CSS.escape(domain) + '"]');
    if (btn) btn.focus();
  });
}

function renderAndRestoreFocus(domain) {
  // Preserve how many domain rows were visible before re-render
  const tbody = document.querySelector("#pc-log-domains tbody");
  const visibleRows = tbody ? tbody.children.length : 0;
  renderLogDomains(visibleRows);
  renderLogWhitelist();
  restoreWhitelistFocus(domain);
}

function handleWhitelistAdd(domain, purpose) {
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_WHITELIST_ADD", domain, purpose, site: currentDomain },
    (resp) => {
      void chrome.runtime.lastError;
      if (resp?.ok) {
        if (!lastWhitelist[domain]) lastWhitelist[domain] = {};
        lastWhitelist[domain][currentDomain] = purpose;
        renderAndRestoreFocus(domain);
      }
    }
  );
}

function handleWhitelistRemove(domain, site) {
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_WHITELIST_REMOVE", domain, site },
    (resp) => {
      void chrome.runtime.lastError;
      if (resp?.ok) {
        if (lastWhitelist[domain]) {
          delete lastWhitelist[domain][site];
          if (Object.keys(lastWhitelist[domain]).length === 0) delete lastWhitelist[domain];
        }
        renderAndRestoreFocus(domain);
      }
    }
  );
}

function handleWhitelistAllSite() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.runtime.sendMessage(
      { type: "PROTOCONSENT_WHITELIST_ALL_SITE", tabId: tabs[0].id, site: currentDomain },
      (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          const domains = lastBlockedDomains || {};
          for (const [purpose, purposeDomains] of Object.entries(domains)) {
            for (const domain of Object.keys(purposeDomains)) {
              if (!lastWhitelist[domain]) lastWhitelist[domain] = {};
              lastWhitelist[domain][currentDomain] = purpose;
            }
          }
          const tbody = document.querySelector("#pc-log-domains tbody");
          const visibleRows = tbody ? tbody.children.length : 0;
          renderLogDomains(visibleRows);
          renderLogWhitelist();
        }
      }
    );
  });
}

function handleWhitelistRemoveAll() {
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_WHITELIST_REMOVE_ALL_SITE", site: currentDomain },
    (resp) => {
      void chrome.runtime.lastError;
      if (resp?.ok) {
        for (const [domain, siteMap] of Object.entries(lastWhitelist)) {
          delete siteMap[currentDomain];
          if (Object.keys(siteMap).length === 0) delete lastWhitelist[domain];
        }
        const tbody = document.querySelector("#pc-log-domains tbody");
        const visibleRows = tbody ? tbody.children.length : 0;
        renderLogDomains(visibleRows);
        renderLogWhitelist();
      }
    }
  );
}

function handleWhitelistRemoveAllGlobal() {
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_WHITELIST_CLEAR" },
    function (resp) {
      void chrome.runtime.lastError;
      if (resp && resp.ok) {
        for (const domain in lastWhitelist) {
          const siteMap = lastWhitelist[domain];
          for (const key in siteMap) {
            if (key === "_hotfix") continue;
            delete siteMap[key];
          }
          if (Object.keys(siteMap).length === 0) delete lastWhitelist[domain];
        }
        const tbody = document.querySelector("#pc-log-domains tbody");
        const visibleRows = tbody ? tbody.children.length : 0;
        renderLogDomains(visibleRows);
        renderLogWhitelist();
      }
    }
  );
}

function handleWhitelistToggleScope(domain, site) {
  if (site === "*") {
    // Global → per-site: replace "*" entry with current site
    const purpose = lastWhitelist[domain]?.["*"];
    if (!purpose) return;
    chrome.runtime.sendMessage(
      { type: "PROTOCONSENT_WHITELIST_REMOVE", domain, site: "*" },
      (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          chrome.runtime.sendMessage(
            { type: "PROTOCONSENT_WHITELIST_ADD", domain, purpose, site: currentDomain },
            (resp2) => {
              void chrome.runtime.lastError;
              if (resp2?.ok) {
                if (lastWhitelist[domain]) delete lastWhitelist[domain]["*"];
                if (!lastWhitelist[domain]) lastWhitelist[domain] = {};
                lastWhitelist[domain][currentDomain] = purpose;
                renderAndRestoreFocus(domain);
              } else {
                // ADD failed after REMOVE succeeded - restore global entry locally
                // and re-add on background to avoid leaving the domain unwhitelisted.
                chrome.runtime.sendMessage(
                  { type: "PROTOCONSENT_WHITELIST_ADD", domain, purpose, site: "*" },
                  () => { void chrome.runtime.lastError; }
                );
                if (!lastWhitelist[domain]) lastWhitelist[domain] = {};
                lastWhitelist[domain]["*"] = purpose;
                renderAndRestoreFocus(domain);
              }
            }
          );
        }
      }
    );
  } else {
    // Per-site → global
    chrome.runtime.sendMessage(
      { type: "PROTOCONSENT_WHITELIST_TOGGLE_SCOPE", domain, site },
      (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          if (lastWhitelist[domain]) {
            const purpose = lastWhitelist[domain][site];
            delete lastWhitelist[domain][site];
            lastWhitelist[domain]["*"] = purpose;
          }
          renderAndRestoreFocus(domain);
        }
      }
    );
  }
}
