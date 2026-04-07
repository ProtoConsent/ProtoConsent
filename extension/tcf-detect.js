// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Detects IAB TCF __tcfapi on the page (MAIN world content script).
// Sends detected CMP info back to the extension via window.postMessage,
// picked up by content-script.js and forwarded to background.

(() => {
  "use strict";

  // Only run in top frame
  if (window !== window.top) return;

  let sent = false;

  function probe() {
    if (sent) return;
    if (typeof window.__tcfapi !== "function") return;

    sent = true;
    window.__tcfapi("getTCData", 2, (tcData, success) => {
      if (!success || !tcData) {
        // CMP exists but getTCData failed - still report presence
        window.postMessage({
          type: "PROTOCONSENT_TCF_DETECTED",
          cmpId: null,
          cmpVersion: null,
          tcfPolicyVersion: null,
          purposeConsents: null,
        }, window.location.origin);
        return;
      }

      window.postMessage({
        type: "PROTOCONSENT_TCF_DETECTED",
        cmpId: tcData.cmpId || null,
        cmpVersion: tcData.cmpVersion || null,
        tcfPolicyVersion: tcData.tcfPolicyVersion || null,
        purposeConsents: tcData.purpose && tcData.purpose.consents
          ? Object.fromEntries(
              Object.entries(tcData.purpose.consents).filter(([, v]) => typeof v === "boolean")
            )
          : null,
      }, window.location.origin);
    });
  }

  // Probe immediately (CMP may already be loaded)
  probe();

  // Retry a few times - CMPs often load async
  const timers = [200, 600, 1500, 3000, 5000];
  for (const ms of timers) {
    setTimeout(probe, ms);
  }
})();
