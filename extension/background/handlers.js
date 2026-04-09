// ProtoConsent background message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.runtime.onMessage listener: handles all popup, content-script
// and SDK bridge messages (rules, whitelist, enhanced, debug, .well-known).

import {
  PURPOSES_FOR_ENFORCEMENT,
  tabBlockedDomains, tabGpcDomains, tabTcfData,
  lastRebuildDebug, lastConsentLinkedListIds, lastCelPendingDownload,
  tabNavigating, logPorts,
  _catalogSource, _catalogLastFetched, _catalogError,
  _catalogLocalCount, _catalogRemoteCount, _catalogLastRemoteFetch,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage, isValidHostname,
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage,
  withEnhancedStorageLock, withWhitelist,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadEnhancedListsCatalog,
} from "./config-loader.js";
import { rebuildAllDynamicRules } from "./rebuild.js";

// Handle a bridge query from the content script.
export async function handleBridgeQuery(message) {
  const { domain, action, purpose } = message;

  const [rules, presets, defaultConfig] = await Promise.all([
    getAllRulesFromStorage(),
    loadPresetsConfig(),
    getDefaultProfileConfig(),
    loadPurposesConfig()
  ]);

  const siteConfig = rules[domain] || {};
  const resolved = resolvePurposes(siteConfig, presets, defaultConfig);

  switch (action) {
    case 'get':
      return (purpose in resolved) ? resolved[purpose] : null;
    case 'getAll':
      return resolved;
    case 'getProfile':
      return siteConfig.profile || (defaultConfig && defaultConfig.profile) || 'balanced';
    default:
      return null;
  }
}

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // Popup notifies that rules were changed by the user
  if (message.type === "PROTOCONSENT_RULES_UPDATED") {
    rebuildAllDynamicRules();
    sendResponse({ ok: true });
    return;
  }

  // Popup requests per-tab blocked domain detail + per-purpose counts
  if (message.type === "PROTOCONSENT_GET_BLOCKED_DOMAINS") {
    if (PURPOSES_FOR_ENFORCEMENT.length === 0) {
      rebuildAllDynamicRules();
    }
    Promise.all([loadBlocklistsConfig(), getWhitelistFromStorage()]).then(([bl, whitelist]) => {
      const purposeDomainCounts = {};
      const purposePathCounts = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const dLen = bl[key]?.domains?.length;
        const pLen = bl[key]?.pathDomains?.length;
        if (dLen) purposeDomainCounts[key] = dLen;
        if (pLen) purposePathCounts[key] = pLen;
      }
      const gpcDomains = tabGpcDomains.get(message.tabId);
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        purposeDomainCounts,
        purposePathCounts,
        gpcDomains: gpcDomains ? Object.keys(gpcDomains) : [],
        gpcDomainCounts: gpcDomains || {},
        whitelist,
      });
    });
    return true;
  }

  // Content script forwards an SDK query
  if (message.type === "PROTOCONSENT_BRIDGE_QUERY") {
    handleBridgeQuery(message)
      .then((data) => sendResponse({ data }))
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // TCF detection from tcf-detect.js
  if (message.type === "PROTOCONSENT_TCF_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId) {
      const rawCmpId = message.cmpId;
      const rawCmpVer = message.cmpVersion;
      const rawPolicyVer = message.tcfPolicyVersion;
      const rawConsents = message.purposeConsents;

      const cmpId = (typeof rawCmpId === "number" && rawCmpId > 0 && rawCmpId < 10000) ? rawCmpId : null;
      const cmpVersion = (typeof rawCmpVer === "number" && rawCmpVer > 0 && rawCmpVer < 100) ? rawCmpVer : null;
      const tcfPolicyVersion = (typeof rawPolicyVer === "number" && rawPolicyVer > 0 && rawPolicyVer < 100) ? rawPolicyVer : null;

      let purposeConsents = null;
      if (rawConsents && typeof rawConsents === "object" && !Array.isArray(rawConsents)) {
        purposeConsents = {};
        const entries = Object.entries(rawConsents);
        const maxEntries = Math.min(entries.length, 20);
        for (let i = 0; i < maxEntries; i++) {
          const [key, val] = entries[i];
          if (/^\d{1,2}$/.test(key) && typeof val === "boolean") {
            purposeConsents[key] = val;
          }
        }
      }

      const tcfInfo = { detected: true, cmpId, cmpVersion, tcfPolicyVersion, purposeConsents };
      tabTcfData.set(tabId, tcfInfo);
      if (chrome.storage.session) {
        chrome.storage.session.set({ ["tcf_" + tabId]: tcfInfo }).catch(() => {});
      }
    }
    return;
  }

  // Popup requests TCF data for a tab
  if (message.type === "PROTOCONSENT_GET_TCF") {
    const info = tabTcfData.get(message.tabId) || null;
    sendResponse({ tcf: info });
    return;
  }

  // Popup requests last rebuild debug snapshot
  if (message.type === "PROTOCONSENT_GET_DEBUG") {
    const respond = () => {
      const debugData = Object.assign({}, lastRebuildDebug, {
        navigatingTabs: tabNavigating.size,
        logPorts: logPorts.size,
        catalogSource: _catalogSource,
        catalogLastFetched: _catalogLastFetched,
        catalogError: _catalogError,
        catalogLocalCount: _catalogLocalCount,
        catalogRemoteCount: _catalogRemoteCount,
        catalogLastRemoteFetch: _catalogLastRemoteFetch,
      });
      const p1 = (chrome.storage.session && chrome.storage.session.get)
        ? chrome.storage.session.get(null).then(s => Object.keys(s).length).catch(() => -1)
        : Promise.resolve(-1);
      const p2 = new Promise(r => chrome.storage.local.get(
        ["interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending"],
        r
      ));
      const p3 = new Promise(r => chrome.storage.local.get(
        ["dynamicListsConsent", "consentEnhancedLink"], d => r({
          dynamicConsent: d.dynamicListsConsent === true,
          consentEnhancedLink: d.consentEnhancedLink === true,
        })
      ));
      Promise.all([p1, p2, p3]).then(([sessionKeys, ext, p3Result]) => {
        debugData.sessionKeys = sessionKeys;
        debugData.interExtEnabled = ext.interExtEnabled === true;
        debugData.interExtAllowlist = ext.interExtAllowlist || [];
        debugData.interExtDenylist = ext.interExtDenylist || [];
        debugData.interExtPending = ext.interExtPending || [];
        debugData.dynamicListsConsent = p3Result.dynamicConsent;
        debugData.consentEnhancedLink = p3Result.consentEnhancedLink;
        debugData.consentLinkedListIds = lastConsentLinkedListIds;
        debugData.celPendingDownload = lastCelPendingDownload;
        sendResponse(debugData);
      });
    };
    if (!lastRebuildDebug.enableIds) {
      rebuildAllDynamicRules().then(respond).catch(respond);
    } else {
      respond();
    }
    return true;
  }

  // Popup requests .well-known fetch
  if (message.type === "PROTOCONSENT_FETCH_WELL_KNOWN") {
    const domain = message.domain;
    if (!domain || typeof domain !== "string") {
      sendResponse({ data: null });
      return;
    }
    const host = (message.host && typeof message.host === "string") ? message.host : domain;
    const protocol = message.protocol === "http:" ? "http://" : "https://";
    const url = protocol + host + "/.well-known/protoconsent.json";
    fetch(url, { credentials: "omit", redirect: "follow" })
      .then(res => {
        if (!res.ok) return null;
        return res.text().then(text => {
          if (text.length > 5000) return null;
          try { return JSON.parse(text); } catch (_) { return null; }
        });
      })
      .then(data => sendResponse({ data: data || null }))
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // Whitelist: add domain
  if (message.type === "PROTOCONSENT_WHITELIST_ADD") {
    const { domain, purpose, site } = message;
    if (!domain || !purpose || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return;
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
            rebuildAllDynamicRules();
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
    if (!domain) { sendResponse({ ok: false }); return; }
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
            rebuildAllDynamicRules();
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
    if (!domain || !site) { sendResponse({ ok: false }); return; }
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
            rebuildAllDynamicRules();
            sendResponse({ ok: true, whitelist });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Enhanced: get current state
  if (message.type === "PROTOCONSENT_ENHANCED_GET_STATE") {
    const forceRefresh = message.forceRefresh === true;
    Promise.all([
      loadEnhancedListsCatalog(forceRefresh ? { forceRefresh: true } : undefined),
      getEnhancedListsFromStorage(),
      getEnhancedPresetFromStorage(),
      new Promise(r => chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))),
      new Promise(r => chrome.storage.local.get("consentEnhancedLink", d => r(d.consentEnhancedLink === true))),
    ]).then(([catalog, lists, preset, dynamicConsent, consentEnhancedLink]) => {
      sendResponse({ catalog, lists, preset, dynamicConsent, consentEnhancedLink,
        consentLinkedListIds: lastConsentLinkedListIds,
        celPendingDownload: lastCelPendingDownload });
    });
    return true;
  }

  // Enhanced: set preset
  if (message.type === "PROTOCONSENT_ENHANCED_SET_PRESET") {
    const preset = message.preset;
    if (!["off", "basic", "full", "custom"].includes(preset)) {
      sendResponse({ ok: false }); return;
    }
    loadEnhancedListsCatalog().then(catalog => {
      withEnhancedStorageLock(() => {
        return getEnhancedListsFromStorage().then(lists => {
          for (const [listId, listDef] of Object.entries(catalog)) {
            if (!lists[listId]) continue;
            if (preset === "off") {
              lists[listId].enabled = false;
            } else if (preset === "basic") {
              lists[listId].enabled = listDef.preset === "basic";
            } else if (preset === "full") {
              lists[listId].enabled = true;
            }
          }
          return new Promise(resolve => {
            chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: preset }, () => {
              if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                resolve();
                return;
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true;
  }

  // Enhanced: toggle a single list
  if (message.type === "PROTOCONSENT_ENHANCED_TOGGLE") {
    const { listId, enabled } = message;
    if (!listId || typeof enabled !== "boolean") {
      sendResponse({ ok: false }); return;
    }
    withEnhancedStorageLock(() => {
      return getEnhancedListsFromStorage().then(lists => {
        if (!lists[listId]) {
          sendResponse({ ok: false, error: "List not downloaded" }); return;
        }
        lists[listId].enabled = enabled;
        return new Promise(resolve => {
          chrome.storage.local.set({
            enhancedLists: lists,
            enhancedPreset: "custom",
          }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              resolve();
              return;
            }
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
            resolve();
          });
        });
      });
    });
    return true;
  }

  // Enhanced: fetch (download) a list
  if (message.type === "PROTOCONSENT_ENHANCED_FETCH") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    Promise.all([
      loadEnhancedListsCatalog(),
    ]).then(([catalog]) => {
      const listDef = catalog[listId];
      if (!listDef || !listDef.fetch_url) {
        sendResponse({ ok: false, error: "Unknown list or no fetch URL" }); return;
      }
      const fetchUrl = listDef.fetch_url.startsWith("http")
        ? listDef.fetch_url
        : chrome.runtime.getURL(listDef.fetch_url);
      const fallbackUrl = fetchUrl.includes("cdn.jsdelivr.net/gh/")
        ? fetchUrl.replace("https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/", "https://raw.githubusercontent.com/ProtoConsent/data/main/")
        : null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const fetchOpts = { credentials: "omit", signal: controller.signal };
      const tryFetch = (url) => fetch(url, fetchOpts).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
      (tryFetch(fetchUrl).catch(err => {
        if (fallbackUrl && err.name !== "AbortError") return tryFetch(fallbackUrl);
        throw err;
      }))
        .then(data => {
          clearTimeout(timeoutId);
          if (listDef.type === "informational") {
            if (!data.map || typeof data.map !== "object" || !Array.isArray(data.trackers)) {
              throw new Error("Invalid informational list format: missing map or trackers");
            }
            const domainCount = data.domain_count || Object.keys(data.map).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeInformational(lists, shouldEnable);
                  });
                }
                return storeInformational(lists, shouldEnable);
                function storeInformational(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    domainCount,
                    pathRuleCount: 0,
                    type: "informational",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { map: data.map, trackers: data.trackers },
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      sendResponse({ ok: true, domainCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (!data.rules || !Array.isArray(data.rules)) {
            throw new Error("Invalid list format: missing rules array");
          }
          const domains = [];
          const pathRules = [];
          for (const rule of data.rules) {
            if (rule.condition?.requestDomains) {
              for (const d of rule.condition.requestDomains) domains.push(d);
            }
            if (rule.condition?.urlFilter) {
              pathRules.push({ urlFilter: rule.condition.urlFilter });
            }
          }
          return withEnhancedStorageLock(() => {
            return Promise.all([
              getEnhancedListsFromStorage(),
              getEnhancedPresetFromStorage(),
            ]).then(([lists, preset]) => {
              const existing = lists[listId];
              if (existing && data.version && existing.version === data.version) {
                sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount, pathRuleCount: existing.pathRuleCount });
                return;
              }
              const existingEnabled = existing?.enabled;
              let shouldEnable;
              if (existingEnabled !== undefined) {
                shouldEnable = existingEnabled;
              } else {
                shouldEnable = true;
                if (preset === "off") shouldEnable = false;
                else if (preset === "basic") shouldEnable = listDef.preset === "basic";
              }
              lists[listId] = {
                enabled: shouldEnable,
                version: data.version || null,
                lastFetched: Date.now(),
                domainCount: domains.length,
                pathRuleCount: pathRules.length,
              };
              const storageUpdate = {
                enhancedLists: lists,
                ["enhancedData_" + listId]: {
                  domains,
                  pathRules: pathRules.length > 0 ? pathRules : undefined,
                },
              };
              return new Promise(resolve => {
                chrome.storage.local.set(storageUpdate, () => {
                  if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    resolve();
                    return;
                  }
                  rebuildAllDynamicRules();
                  sendResponse({ ok: true, domainCount: domains.length, pathRuleCount: pathRules.length });
                  resolve();
                });
              });
            });
          });
        })
        .catch(err => {
          clearTimeout(timeoutId);
          sendResponse({ ok: false, error: err.name === "AbortError" ? "Download timed out" : err.message });
        });
    });
    return true;
  }

  // Enhanced: remove downloaded list
  if (message.type === "PROTOCONSENT_ENHANCED_REMOVE") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    withEnhancedStorageLock(() => {
      return Promise.all([
        getEnhancedListsFromStorage(),
        loadEnhancedListsCatalog(),
        getEnhancedPresetFromStorage(),
      ]).then(([lists, catalog, preset]) => {
        if (!lists[listId]) {
          sendResponse({ ok: true }); return;
        }
        delete lists[listId];
        let newPreset = preset;
        if (preset === "full" || preset === "basic") {
          for (const [id, def] of Object.entries(catalog)) {
            const data = lists[id];
            if (!data) continue;
            const shouldBeEnabled = preset === "full" ? true : def.preset === "basic";
            const isEnabled = data ? !!data.enabled : false;
            if (shouldBeEnabled !== isEnabled) {
              newPreset = "custom";
              break;
            }
          }
        }
        return new Promise(resolve => {
          chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: newPreset }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              resolve();
              return;
            }
            chrome.storage.local.remove("enhancedData_" + listId, () => {
              if (chrome.runtime.lastError) {
                // Data key removal failed - log but still report success
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true;
  }
});
