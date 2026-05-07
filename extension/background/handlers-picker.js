// ProtoConsent element picker message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { tabCosmeticData } from "./state.js";
import { isValidHostname, withCosmeticUserRules } from "./storage.js";
import { rebuildCategories } from "./rebuild.js";

// Handle picker-related messages.
// @returns {boolean|undefined} true if handled (async response), undefined if not a picker message

export function handlePickerMessage(message, _sender, sendResponse) {

  // Element picker: inject picker content script into the active tab
  if (message.type === "PROTOCONSENT_PICKER_START") {
    chrome.storage.local.get(["enhancedCosmeticEnabled"], (cfg) => {
      if (cfg.enhancedCosmeticEnabled === false) {
        sendResponse({ ok: false, error: "Cosmetic filters are disabled" }); return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) { sendResponse({ ok: false }); return; }
        const tab = tabs[0];
        const url = tab.url || "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          sendResponse({ ok: false, error: "Cannot pick on this page" }); return;
        }
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-scripts/element-picker.js"],
        }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true });
          }
        });
      });
    });
    return true;
  }

  // Element picker: save a user-picked selector
  if (message.type === "PROTOCONSENT_PICKER_SAVE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    if (selector.includes("{") || selector.includes("}") || selector.includes("<") || selector.includes("url(")) {
      sendResponse({ ok: false }); return true;
    }
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    withCosmeticUserRules(rules => {
      if (!rules[domain]) rules[domain] = [];
      if (!rules[domain].includes(selector)) rules[domain].push(selector);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserRules: rules }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          // Update tabCosmeticData so the log shows the new rule immediately
          if (tabId) {
            const existing = tabCosmeticData.get(tabId) || { domain, siteRules: 0, genericSelectors: [], domainSelectors: [], userSelectors: [], ts: Date.now() };
            if (!existing.userSelectors) existing.userSelectors = [];
            if (!existing.userSelectors.includes(selector)) existing.userSelectors.push(selector);
            existing.ts = Date.now();
            tabCosmeticData.set(tabId, existing);
          }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Element picker: delete a user-picked selector
  if (message.type === "PROTOCONSENT_PICKER_DELETE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return true;
    }
    withCosmeticUserRules(rules => {
      if (rules[domain]) {
        rules[domain] = rules[domain].filter(s => s !== selector);
        if (rules[domain].length === 0) delete rules[domain];
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserRules: rules }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          // Update tabCosmeticData for all tabs with this domain
          for (const [tabId, data] of tabCosmeticData) {
            if (data.domain === domain) {
              if (data.userSelectors) data.userSelectors = data.userSelectors.filter(s => s !== selector);
            }
          }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }
}
