// ProtoConsent whitelist message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { isValidHostname, withWhitelist } from "./storage.js";
import { rebuildCategories } from "./rebuild.js";
import { whitelistAllForSite, removeWhitelistAllForSite, clearWhitelistAll } from "./context-menu.js";

// Handle whitelist-related messages (add, remove, toggle scope, all-site, clear).
// @returns {boolean|undefined} true if handled (async response), undefined if not a whitelist message

export function handleWhitelistMessage(message, _sender, sendResponse) {

  // Whitelist: add domain
  if (message.type === "PROTOCONSENT_WHITELIST_ADD") {
    const { domain, purpose, site } = message;
    if (!domain || !purpose || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    const siteKey = (site && isValidHostname(site)) ? site : "*";
    withWhitelist(whitelist => {
      if (!whitelist[domain]) whitelist[domain] = {};
      if (siteKey === "*") {
        whitelist[domain] = {};
      } else {
        delete whitelist[domain]["*"];
      }
      whitelist[domain][siteKey] = purpose;
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildCategories(new Set(["whitelist"]));
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: remove domain
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE") {
    const { domain, site } = message;
    if (!domain) { sendResponse({ ok: false }); return true; }
    withWhitelist(whitelist => {
      if (whitelist[domain]) {
        if (site) {
          delete whitelist[domain][site];
          if (Object.keys(whitelist[domain]).length === 0) {
            delete whitelist[domain];
          }
        } else {
          delete whitelist[domain];
        }
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildCategories(new Set(["whitelist"]));
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: toggle scope
  if (message.type === "PROTOCONSENT_WHITELIST_TOGGLE_SCOPE") {
    const { domain, site } = message;
    if (!domain || !site) { sendResponse({ ok: false }); return true; }
    withWhitelist(whitelist => {
      if (!whitelist[domain]) { sendResponse({ ok: false }); return Promise.resolve(); }
      if (site === "*") {
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      const purpose = whitelist[domain][site];
      if (!purpose) {
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      whitelist[domain] = { "*": purpose };
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildCategories(new Set(["whitelist"]));
            sendResponse({ ok: true, whitelist });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: allow all blocked domains for a site
  if (message.type === "PROTOCONSENT_WHITELIST_ALL_SITE") {
    const { tabId, site } = message;
    if (!site || !isValidHostname(site)) { sendResponse({ ok: false }); return true; }
    whitelistAllForSite(tabId, site).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Whitelist: remove all per-site whitelist entries
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE_ALL_SITE") {
    const { site } = message;
    if (!site || !isValidHostname(site)) { sendResponse({ ok: false }); return true; }
    removeWhitelistAllForSite(site).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Whitelist: clear all entries (except hotfixes)
  if (message.type === "PROTOCONSENT_WHITELIST_CLEAR") {
    clearWhitelistAll().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
}
