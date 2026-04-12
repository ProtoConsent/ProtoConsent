// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// content-script.js - Bridge between the page-side SDK and the extension.
// Listens for PROTOCONSENT_QUERY messages from the SDK (via window.postMessage),
// forwards them to the background service worker, and relays the response back.

(() => {
  'use strict';

  // Only run on http/https pages (skip extension pages, chrome://, about:, etc.)
  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return;

  const VALID_ACTIONS = ['get', 'getAll', 'getProfile'];

  // Rate limit: accept at most 1 TCF and 1 GPP message per page load
  let tcfRelayed = false;
  let gppRelayed = false;
  let storageRelayed = false;
  let queryCount = 0;

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
    if (!msg) return;

    // TCF detection relay - forward to background (sanitize MAIN world data)
    if (msg.type === 'PROTOCONSENT_TCF_DETECTED') {
      if (tcfRelayed) return;
      tcfRelayed = true;
      const cmpId = typeof msg.cmpId === 'number' ? msg.cmpId : null;
      const cmpVersion = typeof msg.cmpVersion === 'number' ? msg.cmpVersion : null;
      const tcfPolicyVersion = typeof msg.tcfPolicyVersion === 'number' ? msg.tcfPolicyVersion : null;
      let purposeConsents = null;
      if (msg.purposeConsents && typeof msg.purposeConsents === 'object') {
        purposeConsents = {};
        for (const [k, v] of Object.entries(msg.purposeConsents)) {
          if (/^\d+$/.test(k) && typeof v === 'boolean') purposeConsents[k] = v;
        }
      }
      chrome.runtime.sendMessage({
        type: 'PROTOCONSENT_TCF_DETECTED',
        cmpId, cmpVersion, tcfPolicyVersion, purposeConsents,
      }, () => { void chrome.runtime.lastError; });
      return;
    }

    // GPP detection relay - forward to background (sanitize MAIN world data)
    if (msg.type === 'PROTOCONSENT_GPP_DETECTED') {
      if (gppRelayed) return;
      gppRelayed = true;
      const gppVersion = typeof msg.gppVersion === 'string'
        ? msg.gppVersion.slice(0, 20).replace(/[^0-9.]/g, '') : null;
      let supportedAPIs = null;
      if (Array.isArray(msg.supportedAPIs)) {
        supportedAPIs = msg.supportedAPIs
          .filter(s => typeof s === 'string' && s.length <= 50)
          .slice(0, 20)
          .map(s => s.replace(/[^a-z0-9_:.]/gi, ''));
      }
      chrome.runtime.sendMessage({
        type: 'PROTOCONSENT_GPP_DETECTED',
        gppVersion, supportedAPIs,
      }, () => { void chrome.runtime.lastError; });
      return;
    }

    // CMP localStorage observation relay - forward to background (sanitize MAIN world data)
    if (msg.type === 'PROTOCONSENT_CMP_STORAGE_DETECTED') {
      if (storageRelayed) return;
      storageRelayed = true;
      let entries = [];
      if (Array.isArray(msg.entries)) {
        entries = msg.entries.slice(0, 10).map(e => {
          if (!e || typeof e !== 'object') return null;
          const cmpId = typeof e.cmpId === 'string' ? e.cmpId.slice(0, 50).replace(/[^a-z0-9_-]/gi, '') : null;
          const key = typeof e.key === 'string' ? e.key.slice(0, 100).replace(/[^a-z0-9_.-]/gi, '') : null;
          const raw = typeof e.raw === 'string' ? e.raw.slice(0, 20000) : null;
          if (!cmpId || !key || !raw) return null;
          const result = { cmpId, key, raw };
          // Pass sanitized meta if present (e.g. uc_user_interaction)
          if (e.meta && typeof e.meta === 'object') {
            result.meta = {};
            if (typeof e.meta.interaction === 'boolean') result.meta.interaction = e.meta.interaction;
          }
          return result;
        }).filter(Boolean);
      }
      if (entries.length === 0) return;
      chrome.runtime.sendMessage({
        type: 'PROTOCONSENT_CMP_STORAGE_DETECTED',
        entries,
      }, () => { void chrome.runtime.lastError; });
      return;
    }

    if (msg.type !== 'PROTOCONSENT_QUERY') return;

    // Rate limit: max 100 SDK queries per page load to prevent abuse
    if (++queryCount > 100) return;

    // Validate message structure
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 64) return;
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
