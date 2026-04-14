// ProtoConsent background config bridge
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SYNC: values must match config.js - background cannot importScripts in module mode.
// config.js remains the source of truth for popup/pages (loaded as classic <script>).
// This file re-declares only the symbols background modules need.

// Debug panel in popup + verbose logging in background.
// Activate at runtime: chrome.storage.local.set({ debug: true })
// Deactivate:          chrome.storage.local.remove("debug")
export let DEBUG_RULES = false;

// Prefer onRuleMatchedDebug (declarativeNetRequest debug API) when available.
export const USE_DNR_DEBUG = false;

// Inter-extension protocol version (independent of extension version).
export const INTEREXT_PROTOCOL_VERSION = "0.1";

// High-entropy Client Hints headers stripped when advanced_tracking is denied.
export const HIGH_ENTROPY_CH = [
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64",
  "sec-ch-ua-form-factors",
];

export async function loadDebugFlag() {
  try {
    const { debug } = await chrome.storage.local.get("debug");
    DEBUG_RULES = debug === true;
  } catch (_) { /* keep default */ }
}

export function getChStrippingEnabled(callback) {
  chrome.storage.local.get(["chStrippingEnabled"], (r) => {
    callback(r.chStrippingEnabled !== false);
  });
}

// SYNC: must match config.js CAPABILITIES
export const CAPABILITIES = {
  standalone:   { ownBlocking: true,  observeExternalBlocks: true, whitelistOverrides: true,  enhancedDnr: true  },
  protoconsent: { ownBlocking: false, observeExternalBlocks: true, whitelistOverrides: false, enhancedDnr: false },
};
