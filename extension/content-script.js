// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// content-script.js — Bridge between the page-side SDK and the extension.
// Listens for PROTOCONSENT_QUERY messages from the SDK (via window.postMessage),
// forwards them to the background service worker, and relays the response back.

(() => {
  'use strict';

  // Only run on http/https pages (skip extension pages, chrome://, about:, etc.)
  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return;

  const VALID_ACTIONS = ['get', 'getAll', 'getProfile'];

  // Timeout for background service worker response (ms).
  // Must be shorter than the SDK timeout (500ms) so the content script
  // can reply before the SDK gives up.
  const BACKGROUND_TIMEOUT_MS = 400;

  /**
   * Normalize hostname by removing leading "www.".
   * Matches the normalization in popup.js.
   */
  function normalizeDomain(hostname) {
    return hostname.replace(/^www\./, '');
  }

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window (page context, not iframes)
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || msg.type !== 'PROTOCONSENT_QUERY') return;

    // Validate message structure
    if (typeof msg.id !== 'string' || !msg.id) return;
    if (!VALID_ACTIONS.includes(msg.action)) return;

  // Runs in all frames (manifest all_frames: true).  In iframes, the
  // query uses the iframe's own hostname, not the top-level page's.
  // This is intentional: an iframe from ads.example.com queries consent
  // for ads.example.com, not for the parent page.
  const domain = normalizeDomain(window.location.hostname);

    // Set up a timeout in case the background doesn't respond
    let responded = false;
    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      window.postMessage({
        type: 'PROTOCONSENT_RESPONSE',
        id: msg.id,
        data: null
      }, window.location.origin);
    }, BACKGROUND_TIMEOUT_MS);

    // Forward to the background service worker
    chrome.runtime.sendMessage({
      type: 'PROTOCONSENT_BRIDGE_QUERY',
      domain: domain,
      action: msg.action,
      purpose: msg.purpose || null
    }, (response) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeoutId);

      // Handle runtime errors (background unavailable, extension context invalidated)
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'PROTOCONSENT_RESPONSE',
          id: msg.id,
          data: null
        }, window.location.origin);
        return;
      }

      window.postMessage({
        type: 'PROTOCONSENT_RESPONSE',
        id: msg.id,
        data: (response && response.data !== undefined) ? response.data : null
      }, window.location.origin);
    });
  });
})();
