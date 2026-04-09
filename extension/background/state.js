// ProtoConsent background shared state
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// All mutable module-level variables live here so every background module
// reads/writes the same bindings. Use the set* functions to mutate - ES module
// bindings are live for reads but read-only for importers.

// --- Constants ---

// We assign IDs for dynamic rules starting from 1 upwards
export const BASE_RULE_ID = 1;

// Reserve dynamic rule slots for core enforcement (overrides + GPC + enhanced).
// Whitelist rules are trimmed if they would exceed the remaining budget.
export const DYNAMIC_RULE_RESERVE = 100;

// Resource types for blocking rules (not main_frame - that would block the page itself)
export const BLOCK_RESOURCE_TYPES = [
  "script", "xmlhttprequest", "image", "sub_frame", "ping", "other"
];

// Resource types for GPC header injection (includes main_frame for the server signal)
export const GPC_RESOURCE_TYPES = ["main_frame", ...BLOCK_RESOURCE_TYPES];

// --- Mutable state ---

// Purposes we currently enforce - derived at runtime from purposes.json keys.
export let PURPOSES_FOR_ENFORCEMENT = [];
export function setPurposesForEnforcement(v) { PURPOSES_FOR_ENFORCEMENT = v; }

// Purposes that trigger the Sec-GPC header when denied.
export let gpcPurposes = [];
export function setGpcPurposes(v) { gpcPurposes = v; }

// Cached domain and path-domain lists extracted from static rulesets.
export let blocklistsConfig = null;
export function setBlocklistsConfig(v) { blocklistsConfig = v; }

// Per-tab tracking of blocked domains for the popup detail view.
export const tabBlockedDomains = new Map();

// Per-tab TCF CMP detection data
export const tabTcfData = new Map();

// Maps dynamic block rule IDs to their purpose (rebuilt on each rule update).
export let dynamicBlockRuleMap = {};
export function setDynamicBlockRuleMap(v) { dynamicBlockRuleMap = v; }

// Set of dynamic rule IDs that inject Sec-GPC: 1
export let dynamicGpcSetIds = new Set();
export function setDynamicGpcSetIds(v) { dynamicGpcSetIds = v; }

// Set of dynamic rule IDs that strip high-entropy Client Hints
export let dynamicChRuleIds = new Set();
export function setDynamicChRuleIds(v) { dynamicChRuleIds = v; }

// Maps dynamic whitelist allow rule IDs to their requestDomains array
export let dynamicWhitelistMap = {};
export function setDynamicWhitelistMap(v) { dynamicWhitelistMap = v; }

// Maps dynamic enhanced block rule IDs to their list ID
export let dynamicEnhancedMap = {};
export function setDynamicEnhancedMap(v) { dynamicEnhancedMap = v; }

// Reverse index: hostname -> purpose key(s)
export let reverseHostIndex = null;
export function setReverseHostIndex(v) { reverseHostIndex = v; }

// Enhanced reverse index: hostname -> listId
export let enhancedReverseIndex = null;
export function setEnhancedReverseIndex(v) { enhancedReverseIndex = v; }

// Set of currently-enabled static blocking rulesets
export let enabledBlockRulesets = new Set();
export function setEnabledBlockRulesets(v) { enabledBlockRulesets = v; }

// GPC configuration snapshot - updated on each rebuild.
export let gpcGlobalActive = false;
export function setGpcGlobalActive(v) { gpcGlobalActive = v; }

export let gpcAddDomains = new Set();
export function setGpcAddDomains(v) { gpcAddDomains = v; }

export let gpcRemoveDomains = new Set();
export function setGpcRemoveDomains(v) { gpcRemoveDomains = v; }

// Per-tab tracking of unique domains that received GPC signals.
export const tabGpcDomains = new Map();

// Last rebuild debug snapshot (served to popup on request)
export let lastRebuildDebug = {};
export function setLastRebuildDebug(v) { lastRebuildDebug = v; }

export let lastConsentLinkedListIds = [];
export function setLastConsentLinkedListIds(v) { lastConsentLinkedListIds = v; }

export let lastCelPendingDownload = [];
export function setLastCelPendingDownload(v) { lastCelPendingDownload = v; }

// Cached in-memory copy of presets.json
export let presetsConfig = null;
export function setPresetsConfig(v) { presetsConfig = v; }

// Cached in-memory copy of purposes.json
export let purposesConfig = null;
export function setPurposesConfig(v) { purposesConfig = v; }

// Enhanced lists catalog
export let enhancedListsCatalog = null;
export function setEnhancedListsCatalog(v) { enhancedListsCatalog = v; }

export let _catalogPromise = null;
export function setCatalogPromise(v) { _catalogPromise = v; }

export let _catalogLastFetched = 0;
export function setCatalogLastFetched(v) { _catalogLastFetched = v; }

export let _catalogSource = "none";
export function setCatalogSource(v) { _catalogSource = v; }

export let _catalogError = null;
export function setCatalogError(v) { _catalogError = v; }

export let _catalogLocalCount = 0;
export function setCatalogLocalCount(v) { _catalogLocalCount = v; }

export let _catalogRemoteCount = 0;
export function setCatalogRemoteCount(v) { _catalogRemoteCount = v; }

export let _catalogLastRemoteFetch = 0;
export function setCatalogLastRemoteFetch(v) { _catalogLastRemoteFetch = v; }

export const CATALOG_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const CATALOG_REMOTE_URL = "https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/lists.json";
export const CATALOG_REMOTE_FALLBACK = "https://raw.githubusercontent.com/ProtoConsent/data/main/lists.json";
export const SUPPORTED_MANIFEST_VERSION = 1;

// Serialized whitelist write queue
export let _wlQueue = Promise.resolve();
export function setWlQueue(v) { _wlQueue = v; }

// Serialized enhanced storage lock
export let enhancedStorageChain = Promise.resolve();
export function setEnhancedStorageChain(v) { enhancedStorageChain = v; }

// Sequential rebuild guard
export let _rebuildRunning = false;
export function setRebuildRunning(v) { _rebuildRunning = v; }

export let _rebuildQueued = false;
export function setRebuildQueued(v) { _rebuildQueued = v; }

// Tab navigation tracking
export const tabNavigating = new Set();
export const tabLastUrl = new Map();

// GPC content script ID
export const GPC_SCRIPT_ID = "protoconsent-gpc";

// Log ports for real-time streaming to popup Log tab
export const logPorts = new Set();

// Inter-extension event log (capped buffer, replayed to new log ports)
export const _extEventLog = [];
export const EXT_EVENT_LOG_CAP = 50;

// Resolved once at startup
import { USE_DNR_DEBUG } from "./config-bridge.js";
export const useDnrDebug = USE_DNR_DEBUG && !!chrome.declarativeNetRequest.onRuleMatchedDebug;
