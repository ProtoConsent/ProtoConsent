// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// debug.js — Debug panel rendering for the Log > Debug tab.
// Renders directly into #pc-log-debug (only called when DEBUG_RULES = true).
// Loaded after popup.js; uses globals: currentDomain, currentProfile, currentPurposesState.

function renderDebugPanel({ blocked, gpc, gpcDomains, domainHitCount, rulesetHitCount, blockedDomains }) {
  const content = document.getElementById("pc-log-debug");
  if (!content) return;

  // Fetch background rebuild snapshot
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_DEBUG" }, (bg) => {
    const lines = [];

    // Extension version
    const manifest = chrome.runtime.getManifest();
    lines.push("— ProtoConsent v" + manifest.version + " —");
    lines.push("");

    // Site info
    lines.push("— site: " + (currentDomain || "?") + " (profile: " + currentProfile + ") —");
    if (currentPurposesState) {
      const siteStr = Object.entries(currentPurposesState)
        .map(([k, v]) => k + ":" + (v ? "\u2713" : "\u2717")).join("  ");
      lines.push("  " + siteStr);
    }
    lines.push("");

    // Global profile & purposes
    if (bg && bg.globalProfile) {
      lines.push("— global profile: " + bg.globalProfile + " —");
      if (bg.globalPurposes) {
        const purposeStr = Object.entries(bg.globalPurposes)
          .map(([k, v]) => k + ":" + (v ? "\u2713" : "\u2717")).join("  ");
        lines.push("  " + purposeStr);
      }
      lines.push("");
    }

    // Log port status
    const portStatus = (typeof logPort !== "undefined" && logPort) ? "connected" : "disconnected";
    lines.push("— log port: " + portStatus + " (bg ports: " + (bg?.logPorts || 0) + ") —");
    lines.push("");

    // Session persistence check
    if (bg && typeof bg.sessionKeys !== "undefined") {
      lines.push("— session storage: " + bg.sessionKeys + " keys —");
      lines.push("");
    }

    // Navigation guard status
    if (bg && typeof bg.navigatingTabs !== "undefined") {
      lines.push("— navigation guard: " + bg.navigatingTabs + " tabs navigating —");
      lines.push("");
    }

    // Category domain counts
    if (bg && bg.categoryDomains) {
      lines.push("— blocklist sizes —");
      for (const [cat, info] of Object.entries(bg.categoryDomains).sort()) {
        lines.push("  " + cat + ": " + info);
      }
      lines.push("");
    }

    // Static rulesets & dynamic rules
    if (bg && bg.enableIds) {
      lines.push("— rulesets —");
      lines.push("  enabled:  " + (bg.enableIds.join(", ") || "(none)"));
      lines.push("  disabled: " + (bg.disableIds.join(", ") || "(none)"));
      lines.push("  dynamic: " + bg.dynamicCount +
        " (" + bg.overrideCount + " overrides, " +
        bg.gpcGlobal + " GPC-g, " + bg.gpcPerSite + " GPC-s)");
      if (bg.error) lines.push("  \u26A0 ERROR: " + bg.error);
      if (bg.rulesetError) lines.push("  \u26A0 RULESET ERROR: " + bg.rulesetError);
      lines.push("");
    }

    // Override detail
    if (bg && bg.overrideDetails && Object.keys(bg.overrideDetails).length) {
      lines.push("— overrides —");
      for (const [id, detail] of Object.entries(bg.overrideDetails)) {
        lines.push("  rule " + id + ": " + detail);
      }
      lines.push("");
    }

    // Custom sites
    if (bg && bg.customSites && bg.customSites.length) {
      lines.push("— custom sites (" + bg.customSites.length + ") —");
      lines.push("  " + bg.customSites.join(", "));
      lines.push("");
    }

    // Tab match info
    lines.push("— tab matches —");
    lines.push("  blocked: " + blocked + "  gpc: " + gpc + " (" + (gpcDomains?.length || 0) + " domains)");
    lines.push("");

    // Ruleset breakdown (domain vs path)
    if (Object.keys(rulesetHitCount).length) {
      lines.push("— ruleset hits —");
      for (const [id, count] of Object.entries(rulesetHitCount).sort()) {
        const tag = id.endsWith("_paths") ? " (path)" : id === "_dynamic_block" ? " (dynamic)" : " (domain)";
        lines.push("  " + id + ": " + count + tag);
      }
      lines.push("");
    }

    // Purpose breakdown
    if (Object.keys(domainHitCount).length) {
      lines.push("— purpose hits —");
      for (const [purpose, count] of Object.entries(domainHitCount).sort()) {
        lines.push("  " + purpose + ": " + count);
      }
      lines.push("");
    }

    // Blocked domains detail
    if (Object.keys(blockedDomains).length) {
      lines.push("— blocked domains —");
      for (const [purpose, domains] of Object.entries(blockedDomains).sort()) {
        for (const [domain, count] of Object.entries(domains).sort()) {
          lines.push("  [" + purpose + "] " + domain + " \u00d7" + count);
        }
      }
    }

    content.textContent = lines.join("\n");
  });
}
