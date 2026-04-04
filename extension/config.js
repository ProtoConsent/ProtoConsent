// ProtoConsent shared configuration and constants
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Debug panel in popup + verbose logging in background.
// Activate at runtime: chrome.storage.local.set({ debug: true })
// Deactivate:          chrome.storage.local.remove("debug")
let DEBUG_RULES = false;

async function loadDebugFlag() {
  try {
    const { debug } = await chrome.storage.local.get("debug");
    DEBUG_RULES = debug === true;
  } catch (_) { /* keep default */ }
}
