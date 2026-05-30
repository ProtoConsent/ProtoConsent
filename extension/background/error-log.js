// ProtoConsent background error log
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Single internal sink for recoverable background errors. Fully local:
// kept in memory and mirrored to storage.local (like DNR/rulesets). Nothing
// is ever sent off-device. Surfaced only in the internal panels
// (Log > Debug and Settings > Support), never via public console unless the
// debug flag is on.
//
// Privacy: callers must NOT pass the URL of the page the user is visiting.
// For CMP decoder failures, pass the CMP name or a hostname, never cookie
// contents.

import { DEBUG_RULES } from "./config-bridge.js";

const MAX_ERRORS = 50;
const STORAGE_KEY = "errorLog";
const MSG_MAX_LEN = 200;
const PERSIST_DEBOUNCE_MS = 2000;

// Most recent last.
let _errors = [];
let _persistTimer = 0;

function normalizeMessage(err) {
  let msg;
  if (err instanceof Error) {
    msg = err.message || err.name || "Error";
  } else if (typeof err === "string") {
    msg = err;
  } else {
    try { msg = String(err); } catch (_) { msg = "unknown error"; }
  }
  if (msg.length > MSG_MAX_LEN) msg = msg.slice(0, MSG_MAX_LEN) + "...";
  return msg;
}

function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = 0;
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: _errors });
    } catch (_) {
      // Storage unavailable; keep the in-memory copy.
    }
  }, PERSIST_DEBOUNCE_MS);
}

// Record a recoverable error. `scope` is a short stable category
// (e.g. "list-fetch", "cmp-decode:onetrust"). `note` is optional extra context.
export function logError(scope, err, note) {
  const entry = {
    t: Date.now(),
    scope: String(scope || "unknown"),
    msg: normalizeMessage(err),
  };
  if (note) entry.msg += " (" + normalizeMessage(note) + ")";

  _errors.push(entry);
  if (_errors.length > MAX_ERRORS) {
    _errors = _errors.slice(_errors.length - MAX_ERRORS);
  }
  schedulePersist();

  if (DEBUG_RULES) {
    console.warn("ProtoConsent [" + entry.scope + "]:", entry.msg);
  }
}

// Copy for the debug payload, most recent first.
export function getErrorLog() {
  return _errors.slice().reverse();
}

export function clearErrorLog() {
  _errors = [];
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = 0;
  }
  try {
    chrome.storage.local.remove(STORAGE_KEY);
  } catch (_) {
    // ignore
  }
}

// Reload persisted errors on service-worker start so the log survives
// worker termination. Merges with anything logged during early startup
// (before this async read resolves) so those entries are not lost.
export async function restoreErrorLog() {
  try {
    const d = await new Promise(resolve =>
      chrome.storage.local.get(STORAGE_KEY, resolve)
    );
    const stored = d && Array.isArray(d[STORAGE_KEY]) ? d[STORAGE_KEY] : [];
    if (stored.length) {
      // Stored entries are older; keep them before anything just logged.
      _errors = [...stored, ..._errors].slice(-MAX_ERRORS);
    }
  } catch (_) {
    // First run or storage unavailable; start empty.
  }
}
