// ProtoConsent cosmetic exception message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { tabCosmeticData } from "./state.js";
import { isValidHostname, withCosmeticExceptions, withCosmeticExcludedSites } from "./storage.js";
import { rebuildCategories } from "./rebuild.js";

// Handle cosmetic-related messages (get state, exceptions, exclude/restore).
// @returns {boolean|undefined} true if handled (async response), undefined if not a cosmetic message

export function handleCosmeticMessage(message, _sender, sendResponse) {

  // Popup requests cosmetic state for a tab
  if (message.type === "PROTOCONSENT_GET_COSMETIC") {
    const info = tabCosmeticData.get(message.tabId) || null;
    sendResponse({ cosmetic: info });
    return;
  }

  // Popup requests user-defined cosmetic exceptions
  if (message.type === "PROTOCONSENT_GET_COSMETIC_EXCEPTIONS") {
    chrome.storage.local.get(["cosmeticUserExceptions"], (r) => {
      sendResponse({ exceptions: r.cosmeticUserExceptions || {} });
    });
    return true;
  }

  // Cosmetic whitelist: exclude a selector for a domain
  if (message.type === "PROTOCONSENT_COSMETIC_EXCLUDE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    withCosmeticExceptions(exc => {
      if (!exc[domain]) exc[domain] = [];
      if (!exc[domain].includes(selector)) exc[domain].push(selector);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserExceptions: exc }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: restore a previously excluded selector
  if (message.type === "PROTOCONSENT_COSMETIC_RESTORE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    withCosmeticExceptions(exc => {
      if (exc[domain]) {
        exc[domain] = exc[domain].filter(s => s !== selector);
        if (exc[domain].length === 0) delete exc[domain];
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserExceptions: exc }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: exclude all cosmetic filtering for a site
  if (message.type === "PROTOCONSENT_COSMETIC_EXCLUDE_SITE") {
    const { domain } = message;
    if (!domain || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    withCosmeticExcludedSites(sites => {
      if (!sites.includes(domain)) sites.push(domain);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticExcludedSites: sites }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: restore cosmetic filtering for a site
  if (message.type === "PROTOCONSENT_COSMETIC_RESTORE_SITE") {
    const { domain } = message;
    if (!domain || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    withCosmeticExcludedSites(sites => {
      const filtered = sites.filter(s => s !== domain);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticExcludedSites: filtered }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }
}
