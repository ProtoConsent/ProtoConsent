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

// --- Shared helpers (used by popup.js, log.js, etc.) ---

function pluralize(n, singular) {
  return n + " " + singular + (n !== 1 ? "s" : "");
}

function getPurposeLabel(key, style, config) {
  const cfg = (config || (typeof purposesConfig !== "undefined" ? purposesConfig : {}))[key];
  if (!cfg) return key;
  if (style === "short") return cfg.short_label || cfg.short || key;
  return cfg.label || key;
}

function formatHHMM(ts) {
  if (ts == null || isNaN(ts)) return "--:--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function formatHHMMSS(ts) {
  if (ts == null || isNaN(ts)) return "--:--:--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--:--:--";
  return formatHHMM(ts) + ":" + String(d.getSeconds()).padStart(2, "0");
}
