// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Cosmetic filter injection - reads pre-compiled CSS from storage
// and injects a <style> element to hide ad/tracker elements.
// Registered programmatically by rebuild.js via chrome.scripting.registerContentScripts.

(() => {
  "use strict";
  const p = location.protocol;
  if (p !== "http:" && p !== "https:") return;

  const host = location.hostname.replace(/^www\./, "");

  chrome.storage.local.get(["_cosmeticCSS", "_cosmeticDomains"], (r) => {
    if (chrome.runtime.lastError) return;
    if (!r._cosmeticCSS && !r._cosmeticDomains) return;

    let text = r._cosmeticCSS || "";
    let siteRuleCount = 0;

    // Domain-specific: walk up hostname (sub.example.com -> example.com)
    if (r._cosmeticDomains) {
      const sels = [];
      let h = host;
      while (h.includes(".")) {
        if (r._cosmeticDomains[h]) {
          for (const s of r._cosmeticDomains[h]) {
            if (!s.includes("{") && !s.includes("}")) sels.push(s);
          }
        }
        h = h.slice(h.indexOf(".") + 1);
      }
      if (sels.length) {
        text += "\n" + sels.join(",") + "{display:none!important}";
        siteRuleCount = sels.length;
      }
    }

    if (!text) return;
    const s = document.createElement("style");
    s.textContent = text;
    (document.head || document.documentElement).appendChild(s);

    // Report to background for Log tab streaming
    // Only report from the top frame to avoid duplicate messages from iframes
    if (window === window.top) {
      chrome.runtime.sendMessage({
        type: "PROTOCONSENT_COSMETIC_APPLIED",
        domain: host,
        siteRules: siteRuleCount,
      }, () => { void chrome.runtime.lastError; });
    }
  });
})();
