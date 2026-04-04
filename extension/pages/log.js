// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Log tab: real-time request log, domain summary, GPC activity.
// Loaded after popup.js — shares globals: currentDomain, currentProfile,
// currentPurposesState, purposesConfig, lastBlockedDomains, lastBlocked,
// lastGpcDomains, lastGpcDomainCounts, lastGpcSignalsSent, lastPurposeStats,
// PURPOSES_TO_SHOW, DEBUG_RULES.
// Shared helpers from config.js: pluralize, getPurposeLabel, formatHHMM, formatHHMMSS.

let logPort = null;
let logInitialized = false;

// --- Single entry point: refresh all Log panels -----------
function refreshLogView() {
  renderLogHeader();
  refreshLogRequests();
  renderLogDomains();
  renderLogGpc();
}

// --- One-time setup + refresh ----------------------------
function initLogTab() {
  // Show debug inner tab only when DEBUG_RULES is on
  const debugTab = document.querySelector('[data-log-tab="debug"]');
  if (debugTab) debugTab.hidden = !DEBUG_RULES;

  // Always reconnect port if disconnected (SW may have restarted)
  if (!logPort) connectLogPort();

  if (!logInitialized) {
    initLogInnerTabs();
    initLogCopyButton();
    logInitialized = true;
  }

  refreshLogView();
}

// --- Inner tab switching ---------------------------------

function initLogInnerTabs() {
  const tabs = document.querySelectorAll(".pc-log-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.logTab;
      if (!target) return;
      setActiveLogTab(target);
    });
  });
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

function formatPanelForCopy(panel) {
  // For pre-based panels (requests, debug), textContent is fine
  const pre = panel.querySelector("pre");
  if (pre) return pre.textContent;

  // For table-based panels (domains, gpc), format with tabs
  const lines = [];
  const header = panel.querySelector(".pc-log-purpose-label");
  if (header) lines.push(header.textContent);

  const table = panel.querySelector("table");
  if (table) {
    const rows = table.querySelectorAll("tr");
    for (const row of rows) {
      const cells = row.querySelectorAll("th, td");
      const vals = [];
      for (const cell of cells) {
        const img = cell.querySelector("img");
        vals.push(img ? (img.title || img.alt || "") : cell.textContent.trim());
      }
      lines.push(vals.join("\t"));
    }
  }

  // Fallback: any remaining text not in header/table
  if (!header && !table) return panel.textContent;
  return lines.join("\n");
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

// --- Header: site + profile + purposes --------------------

function renderLogHeader() {
  const siteEl = document.getElementById("pc-log-site");
  const siteProfileEl = document.getElementById("pc-log-profile-site");
  const globalProfileEl = document.getElementById("pc-log-profile-global");
  const purposesEl = document.getElementById("pc-log-purposes");

  if (siteEl) siteEl.textContent = currentDomain || "unknown";

  const siteProfile = currentProfile || "balanced";
  const globalProfile = defaultProfile || "balanced";
  const hasSiteOverride = (siteProfile !== globalProfile);

  if (siteProfileEl) {
    siteProfileEl.textContent = (hasSiteOverride ? "Site: " : "") + siteProfile;
    siteProfileEl.title = hasSiteOverride ? "Profile applied to this site" : "Active profile";
  }
  if (globalProfileEl) {
    if (hasSiteOverride) {
      globalProfileEl.textContent = "Default: " + globalProfile;
      globalProfileEl.title = "Default profile for all sites";
      globalProfileEl.hidden = false;
    } else {
      globalProfileEl.hidden = true;
    }
  }

  if (purposesEl && currentPurposesState) {
    purposesEl.innerHTML = "";
    for (const [key, val] of Object.entries(currentPurposesState)) {
      const label = getPurposeLabel(key, "short");
      const cell = document.createElement("span");
      cell.className = "pc-log-purpose-cell";
      cell.textContent = label + ": ";
      const icon = document.createElement("span");
      icon.className = val ? "pc-log-purpose-on" : "pc-log-purpose-off";
      icon.textContent = val ? "\u2713" : "\u2717";
      cell.appendChild(icon);
      purposesEl.appendChild(cell);
    }
  }
}

// --- Domains panel ---------------------------------------

function renderLogDomains() {
  const container = document.getElementById("pc-log-domains");
  if (!container) return;
  container.innerHTML = "";

  const domains = lastBlockedDomains || {};
  const orderedPurposes = getActivePurposes();

  if (orderedPurposes.length === 0) {
    container.innerHTML = '<div class="pc-log-empty">No blocked domains captured yet.</div>';
    return;
  }

  // Flatten all purposes into sorted rows: purpose order, then count desc
  const rows = [];
  for (const purpose of orderedPurposes) {
    const cfg = purposesConfig[purpose];
    const purposeDomains = domains[purpose] || {};
    const entries = Object.entries(purposeDomains).sort((a, b) => b[1] - a[1]);
    const total = lastPurposeStats[purpose] || entries.reduce((sum, [, c]) => sum + c, 0);

    if (entries.length > 0) {
      for (const [domain, count] of entries) {
        rows.push({ purpose, cfg, domain, count });
      }
    } else if (total > 0) {
      rows.push({ purpose, cfg, domain: null, count: total });
    }
  }

  // Summary header — use pre-computed total from popup.js
  const totalBlocked = lastBlocked || rows.reduce((sum, r) => sum + r.count, 0);
  const header = document.createElement("div");
  header.className = "pc-log-purpose-label";
  header.textContent = pluralize(totalBlocked, "blocked request") +
    " across " + orderedPurposes.length + (orderedPurposes.length !== 1 ? " categories" : " category");
  container.appendChild(header);

  const table = document.createElement("table");
  table.className = "pc-log-table";

  const colgroup = document.createElement("colgroup");
  colgroup.innerHTML = '<col style="width:24px"><col style="width:auto"><col style="width:50px">';
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  thead.innerHTML = '<tr><th></th><th>Domain</th><th style="text-align:right">Blocked</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");

    const tdIcon = document.createElement("td");
    tdIcon.className = "pc-log-domains-icon";
    if (row.cfg && row.cfg.icon) {
      const img = document.createElement("img");
      img.src = row.cfg.icon;
      img.width = 14;
      img.height = 14;
      img.alt = row.cfg.short || "";
      img.title = getPurposeLabel(row.purpose);
      tdIcon.appendChild(img);
    } else {
      tdIcon.textContent = row.cfg?.short || row.purpose.charAt(0).toUpperCase();
      tdIcon.title = getPurposeLabel(row.purpose);
    }

    const tdDomain = document.createElement("td");
    if (row.domain) {
      tdDomain.textContent = row.domain;
    } else {
      tdDomain.textContent = "(domain names not captured)";
      tdDomain.className = "pc-log-empty";
    }

    const tdCount = document.createElement("td");
    tdCount.textContent = row.count;
    tdCount.className = "pc-log-table-count";

    tr.appendChild(tdIcon);
    tr.appendChild(tdDomain);
    tr.appendChild(tdCount);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// --- GPC panel -------------------------------------------

function renderLogGpc() {
  const container = document.getElementById("pc-log-gpc");
  if (!container) return;
  container.innerHTML = "";

  const domains = lastGpcDomains || [];
  const counts = lastGpcDomainCounts || {};

  if (domains.length === 0) {
    container.innerHTML = '<div class="pc-log-empty">No GPC signals sent for this tab.</div>';
    return;
  }

  // counts may be {domain: {count, firstSeen, lastSeen}} or legacy {domain: number}
  function getCount(d) {
    const v = counts[d];
    return (v && typeof v === "object") ? v.count : (v || 1);
  }
  function getTime(d) {
    const v = counts[d];
    if (!v || typeof v !== "object") return null;
    return { firstSeen: v.firstSeen, lastSeen: v.lastSeen };
  }

  const totalSignals = lastGpcSignalsSent || domains.reduce((sum, d) => sum + getCount(d), 0);
  const today = new Date();
  const dateStr = today.getFullYear() + "-" +
    String(today.getMonth() + 1).padStart(2, "0") + "-" +
    String(today.getDate()).padStart(2, "0");

  const header = document.createElement("div");
  header.className = "pc-log-purpose-label";
  header.textContent = dateStr + " \u002D Sec-GPC: 1 sent to " + pluralize(domains.length, "domain") +
    " (" + pluralize(totalSignals, "request") + ")";
  container.appendChild(header);

  const table = document.createElement("table");
  table.className = "pc-log-table";

  const colgroup = document.createElement("colgroup");
  colgroup.innerHTML = '<col style="width:auto"><col style="width:40px"><col style="width:80px">';
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  thead.innerHTML = '<tr><th>Domain</th><th style="text-align:right">Reqs</th><th style="text-align:right" title="First -- last seen">Time</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  // Sort by count descending
  const sorted = domains.map(d => [d, getCount(d), getTime(d)]).sort((a, b) => b[1] - a[1]);
  for (const [domain, count, time] of sorted) {
    const tr = document.createElement("tr");
    const tdDomain = document.createElement("td");
    tdDomain.textContent = domain;
    const tdCount = document.createElement("td");
    tdCount.textContent = count;
    tdCount.className = "pc-log-table-count";
    const tdTime = document.createElement("td");
    tdTime.className = "pc-log-table-time";
    tdTime.textContent = formatGpcTime(time);
    tr.appendChild(tdDomain);
    tr.appendChild(tdCount);
    tr.appendChild(tdTime);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function formatGpcTime(time) {
  if (!time) return "\u002D";
  const first = formatHHMM(time.firstSeen);
  const last = time.lastSeen ? formatHHMM(time.lastSeen) : null;
  if (!last || first === last) return first;
  return first + " \u002D " + last;
}

// --- Real-time request log via port -----------------------

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
    }
  });

  logPort.onDisconnect.addListener(() => {
    logPort = null;
  });
}

function refreshLogRequests() {
  const pre = document.getElementById("pc-log-requests");
  if (!pre) return;
  pre.innerHTML = "";
  replayHistoricalLog();
}

function replayHistoricalLog() {
  const pre = document.getElementById("pc-log-requests");
  if (!pre || pre.childNodes.length > 0) return;

  const domains = lastBlockedDomains || {};
  const gpcDomains = lastGpcDomains || [];
  let hasData = false;

  // Replay blocked domains
  for (const [purpose, domainMap] of Object.entries(domains)) {
    for (const [domain, count] of Object.entries(domainMap)) {
      for (let i = 0; i < count; i++) {
        appendLogLine("[" + purpose + "] " + domain, "block");
        hasData = true;
      }
    }
  }

  // Replay GPC domains
  for (const domain of gpcDomains) {
    appendLogLine("[gpc] " + domain, "gpc");
    hasData = true;
  }

  if (!hasData) {
    const placeholder = document.createElement("span");
    placeholder.className = "pc-log-line-ts";
    placeholder.id = "pc-log-requests-placeholder";
    placeholder.textContent = "Listening... Reload page to capture events.";
    pre.appendChild(placeholder);
  }
}

function appendLogLine(text, type) {
  const pre = document.getElementById("pc-log-requests");
  if (!pre) return;

  // Remove placeholder and add spacing before first real entry
  const placeholder = document.getElementById("pc-log-requests-placeholder");
  if (placeholder) {
    placeholder.after(document.createTextNode("\n\n"));
    placeholder.remove();
  }

  const line = document.createElement("span");
  if (type === "block") line.className = "pc-log-line-block";
  else if (type === "gpc") line.className = "pc-log-line-gpc";

  const tsSpan = document.createElement("span");
  tsSpan.className = "pc-log-line-ts";
  tsSpan.textContent = formatHHMMSS(Date.now()) + " ";

  pre.appendChild(tsSpan);
  pre.appendChild(line);
  line.textContent = text;
  pre.appendChild(document.createTextNode("\n"));

  // Auto-scroll to bottom
  pre.scrollTop = pre.scrollHeight;
}
