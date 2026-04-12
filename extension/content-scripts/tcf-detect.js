// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Detects IAB TCF __tcfapi and GPP __gpp on the page (MAIN world content script).
// Sends detected CMP info back to the extension via window.postMessage,
// picked up by content-script.js and forwarded to background.

(() => {
  "use strict";

  // Only run in top frame
  if (window !== window.top) return;

  // Capture native references before page scripts can monkey-patch them
  const _postMessage = window.postMessage.bind(window);
  const _setTimeout = window.setTimeout.bind(window);
  const _origin = window.location.origin;
  const _freeze = Object.freeze;
  const _JSONparse = JSON.parse;
  const _JSONstringify = JSON.stringify;
  const _isArray = Array.isArray;

  let tcfSent = false;
  let gppSent = false;

  function safeSend(data) {
    _postMessage(_freeze(data), _origin);
  }

  function probeTcf() {
    if (tcfSent) return;
    if (typeof window.__tcfapi !== "function") return;

    tcfSent = true;
    try {
      window.__tcfapi("getTCData", 2, (tcData, success) => {
        if (!success || !tcData) {
          safeSend({
            type: "PROTOCONSENT_TCF_DETECTED",
            cmpId: null,
            cmpVersion: null,
            tcfPolicyVersion: null,
            purposeConsents: null,
          });
          return;
        }

        // Extract only expected fields with strict type checks
        const cmpId = typeof tcData.cmpId === "number" ? tcData.cmpId : null;
        const cmpVersion = typeof tcData.cmpVersion === "number" ? tcData.cmpVersion : null;
        const tcfPolicyVersion = typeof tcData.tcfPolicyVersion === "number" ? tcData.tcfPolicyVersion : null;
        let purposeConsents = null;
        const consentsObj = tcData.purpose && tcData.purpose.consents;
        if (consentsObj && typeof consentsObj === "object" && !_isArray(consentsObj)) {
          purposeConsents = {};
          const keys = Object.keys(consentsObj);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (/^\d{1,2}$/.test(k) && typeof consentsObj[k] === "boolean") purposeConsents[k] = consentsObj[k];
          }
        }
        safeSend({
          type: "PROTOCONSENT_TCF_DETECTED",
          cmpId, cmpVersion, tcfPolicyVersion, purposeConsents,
        });
      });
    } catch (_) {
      // __tcfapi threw - report presence without data
      safeSend({
        type: "PROTOCONSENT_TCF_DETECTED",
        cmpId: null, cmpVersion: null, tcfPolicyVersion: null, purposeConsents: null,
      });
    }
  }

  function probeGpp() {
    if (gppSent) return;
    if (typeof window.__gpp !== "function") return;

    gppSent = true;
    try {
      window.__gpp("ping", (pingData, success) => {
        if (!success || !pingData) {
          safeSend({
            type: "PROTOCONSENT_GPP_DETECTED",
            gppVersion: null,
            supportedAPIs: null,
          });
          return;
        }
        const gppVersion = typeof pingData.gppVersion === "string"
          ? pingData.gppVersion.slice(0, 20) : null;
        const supportedAPIs = _isArray(pingData.supportedAPIs)
          ? pingData.supportedAPIs.filter(s => typeof s === "string").slice(0, 20).map(s => s.slice(0, 50))
          : null;
        safeSend({
          type: "PROTOCONSENT_GPP_DETECTED",
          gppVersion, supportedAPIs,
        });
      });
    } catch (_) {
      safeSend({
        type: "PROTOCONSENT_GPP_DETECTED",
        gppVersion: null,
        supportedAPIs: null,
      });
    }
  }

  // --- localStorage observation ---
  // CMPs that store consent in localStorage instead of (or in addition to) cookies.
  // These can ONLY be read from MAIN world.
  // Known keys:
  //   Usercentrics: "uc_settings" (JSON with services[].status)
  //   CCM19: "ccm_consent" (JSON with categories)
  let storageSent = false;

  function probeStorage() {
    if (storageSent) return;
    let ls;
    try { ls = window.localStorage; } catch (_) { return; } // sandboxed/opaque origin
    if (!ls) return;

    const entries = [];

    // Usercentrics — uc_settings can be huge (many services with history arrays).
    // Parse in MAIN world and send only the fields the decoder needs, so the
    // message stays small and JSON.parse in the background never sees a truncated string.
    try {
      const uc = ls.getItem("uc_settings");
      if (uc && uc.length < 200000) {
        const obj = _JSONparse(uc);
        if (obj && _isArray(obj.services) && obj.services.length > 0) {
          const compact = { services: obj.services.slice(0, 60).map(function(s) {
            // Sanitize status: only pass known string values
            const status = typeof s.status === "string" ? s.status.slice(0, 30) : null;
            let lastEntry = null;
            if (_isArray(s.history) && s.history.length > 0) {
              const h = s.history[s.history.length - 1];
              // Extract only expected history fields with type checks
              if (h && typeof h === "object" && !_isArray(h)) {
                lastEntry = {};
                if (typeof h.action === "string") lastEntry.action = h.action.slice(0, 50);
                if (typeof h.type === "string") lastEntry.type = h.type.slice(0, 30);
                if (typeof h.language === "string") lastEntry.language = h.language.slice(0, 10);
              }
            }
            return { status, history: lastEntry ? [lastEntry] : [] };
          }) };
          const ucInteraction = ls.getItem("uc_user_interaction");
          entries.push({ cmpId: "usercentrics", key: "uc_settings", raw: _JSONstringify(compact),
            meta: { interaction: ucInteraction === "true" } });
        }
      }
    } catch (_) {}

    // CCM19 — ccm_consent can be large. Parse in MAIN world, send only category booleans.
    try {
      const ccm = ls.getItem("ccm_consent");
      if (ccm && ccm.length < 200000) {
        const ccmObj = _JSONparse(ccm);
        if (ccmObj && typeof ccmObj === "object" && !_isArray(ccmObj)) {
          const cats = ccmObj.categories && typeof ccmObj.categories === "object" && !_isArray(ccmObj.categories)
            ? ccmObj.categories : ccmObj;
          const compact = { categories: {} };
          const boolKeys = ["analytics", "statistics", "marketing", "advertising", "functional", "preferences"];
          for (let i = 0; i < boolKeys.length; i++) {
            if (typeof cats[boolKeys[i]] === "boolean") compact.categories[boolKeys[i]] = cats[boolKeys[i]];
          }
          if (Object.keys(compact.categories).length > 0) {
            entries.push({ cmpId: "ccm19", key: "ccm_consent", raw: _JSONstringify(compact) });
          }
        }
      }
    } catch (_) {}

    if (entries.length === 0) return;
    storageSent = true;
    safeSend({
      type: "PROTOCONSENT_CMP_STORAGE_DETECTED",
      entries,
    });
  }

  function probeAll() {
    probeTcf();
    probeGpp();
  }

  // Probe immediately (CMP may already be loaded)
  probeAll();

  // Retry a few times - CMPs often load async
  const timers = [200, 600, 1500, 3000, 5000];
  for (const ms of timers) {
    _setTimeout(probeAll, ms);
  }

  // Storage probe: delayed (CMPs write localStorage after init, not at document_start)
  _setTimeout(probeStorage, 3000);
  _setTimeout(probeStorage, 6000);
})();
