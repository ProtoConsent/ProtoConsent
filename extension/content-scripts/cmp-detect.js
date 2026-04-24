// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// CMP detection content script (ISOLATED world, document_idle, top frame only).
// Detects CMP presence via CSS selectors (from _cmpDetectors),
// detects CMP cookies by name (from _cmpSignatures),
// and applies site-specific hiding (from _cmpSiteSignatures).
// Reports PROTOCONSENT_CMP_DETECTED to background.

(async () => {
  "use strict";

  // Top frame only
  if (window !== window.top) return;

  // Only http/https
  const protocol = window.location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return;

  // Read detection data from storage
  const stored = await chrome.storage.local.get(["_cmpDetectors", "_cmpSignatures", "_cmpSiteSignatures", "cmpDetectionEnabled"]);

  // Respect the detection toggle (default: enabled)
  if (stored.cmpDetectionEnabled === false) return;

  const detectors = stored._cmpDetectors || {};
  const signatures = stored._cmpSignatures || {};
  const siteSignatures = stored._cmpSiteSignatures || {};

  // Registrable domain for domain matching
  const hostname = window.location.hostname;
  const domain = hostname.replace(/^www\./, "");

  // Check if entry domains match current page
  function domainMatches(entry) {
    if (!Array.isArray(entry.domains) || entry.domains.length === 0) return true;
    return entry.domains.some(d => domain === d || domain.endsWith("." + d));
  }

  // --- CSS detection ---
  function runCssDetection() {
    const results = [];
    for (const [cmpId, rule] of Object.entries(detectors)) {
      if (!domainMatches(rule)) continue;
      let present = false;
      let showing = false;
      if (Array.isArray(rule.present)) {
        for (const sel of rule.present) {
          try { if (document.querySelector(sel)) { present = true; break; } } catch (_) {}
        }
      }
      if (Array.isArray(rule.showing)) {
        for (const sel of rule.showing) {
          try { if (document.querySelector(sel)) { showing = true; break; } } catch (_) {}
        }
      }
      if (present || showing) {
        results.push({ cmpId, present, showing });
      }
    }
    return results;
  }

  const detected = runCssDetection();

  // Many CMPs load asynchronously (e.g. Usercentrics via GTM).
  // Recheck after 4s to catch late-injected elements.
  let detectSent = detected.length > 0;
  if (!detectSent) {
    setTimeout(() => {
      if (detectSent) return;
      const late = runCssDetection();
      const lateSiteHidden = applySiteHiding(late);
      if (late.length === 0 && lateSiteHidden.length === 0) return;
      detectSent = true;
      chrome.runtime.sendMessage({
        type: "PROTOCONSENT_CMP_DETECTED",
        domain,
        detected: late,
        cookies: [],
        siteHidden: lateSiteHidden,
      }, () => { void chrome.runtime.lastError; });
    }, 4000);
  }

  // --- Cookie observation (delayed: waits for cmp-inject.js to clean up its injected
  //     cookies, so only CMP-set cookies remain) ---
  // Must match CMP_CLEANUP_DELAY in cmp-inject.js (5000ms)
  const CMP_CLEANUP_DELAY = 5000;
  setTimeout(() => {
    const cookies = [];
    let cookieStr = "";
    try { cookieStr = document.cookie || ""; } catch (_) { return; }
    if (!cookieStr) return;
    const cookieNames = new Set();
    for (const pair of cookieStr.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) cookieNames.add(pair.slice(0, eq).trim());
    }
    for (const [cmpId, sig] of Object.entries(signatures)) {
      if (!Array.isArray(sig.cookie) || sig.cookie.length === 0) continue;
      for (const c of sig.cookie) {
        if (cookieNames.has(c.name)) {
          const match = cookieStr.match(new RegExp("(?:^|;\\s*)" + c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
          cookies.push({
            cmpId,
            cookieName: c.name,
            rawValue: match ? match[1].slice(0, 500) : "",
          });
        }
      }
    }
    if (cookies.length === 0) return;
    chrome.runtime.sendMessage({
      type: "PROTOCONSENT_CMP_DETECTED",
      domain,
      detected: [],
      cookies,
      siteHidden: [],
    }, () => { void chrome.runtime.lastError; });
  }, CMP_CLEANUP_DELAY + 1000);

  // --- Site-specific hiding ---
  function applySiteHiding(detectedList) {
    const hidden = [];
    const detectedCmpIds = new Set(detectedList.map(d => d.cmpId));
    for (const [cmpId, sig] of Object.entries(siteSignatures)) {
      if (!sig.selector) continue;
      if (!domainMatches(sig)) continue;
      // Skip if already applied
      if (document.querySelector(`style[data-pc-cmp-site="${CSS.escape(cmpId)}"]`)) continue;
      if (!detectedCmpIds.has(cmpId)) {
        if (sig.detectors) {
          let sitePresent = false;
          if (Array.isArray(sig.detectors.present)) {
            for (const sel of sig.detectors.present) {
              try { if (document.querySelector(sel)) { sitePresent = true; break; } } catch (_) {}
            }
          }
          if (Array.isArray(sig.detectors.showing) && !sitePresent) {
            for (const sel of sig.detectors.showing) {
              try { if (document.querySelector(sel)) { sitePresent = true; break; } } catch (_) {}
            }
          }
          if (!sitePresent) continue;
        } else {
          continue;
        }
      }
      const style = document.createElement("style");
      style.setAttribute("data-pc-cmp-site", cmpId);
      style.textContent = sig.selector.split(",").map(s => s.trim()).filter(Boolean)
        .map(s => s + "{display:none!important}").join("");
      document.head.appendChild(style);
      hidden.push({ cmpId, selectorCount: sig.selector.split(",").length });
    }
    return hidden;
  }

  const siteHidden = applySiteHiding(detected);

  // Skip reporting if nothing found (detect + site-specific)
  if (detected.length === 0 && siteHidden.length === 0) return;

  chrome.runtime.sendMessage({
    type: "PROTOCONSENT_CMP_DETECTED",
    domain,
    detected,
    cookies: [],
    siteHidden,
  }, () => { void chrome.runtime.lastError; });
})();
