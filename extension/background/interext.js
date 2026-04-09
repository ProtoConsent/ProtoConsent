// ProtoConsent background inter-extension API
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.runtime.onMessageExternal listener: TOFU authorization,
// rate limiting, capabilities discovery and consent query for other extensions.

import { INTEREXT_PROTOCOL_VERSION } from "./config-bridge.js";
import { logPorts, _extEventLog, EXT_EVENT_LOG_CAP } from "./state.js";
import { scheduleSessionPersist } from "./session.js";
import { handleBridgeQuery } from "./handlers.js";
import { isValidHostname } from "./storage.js";

// --- Rate limiting ---
const _extRateLimit = new Map();
const EXT_RATE_LIMIT = 10;
const EXT_RATE_WINDOW = 60000;
const EXT_PENDING_CAP = 10;
const EXT_UNKNOWN_LIMIT = 3;

let _unknownIds = new Set();
let _unknownWindowStart = 0;

export function pushExtEvent(evt) {
  evt.ts = Date.now();
  _extEventLog.push(evt);
  if (_extEventLog.length > EXT_EVENT_LOG_CAP) _extEventLog.shift();
  for (const port of logPorts) {
    try { port.postMessage(Object.assign({ type: "ext" }, evt)); } catch (_) {}
  }
  scheduleSessionPersist();
}

// Clean stale rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - EXT_RATE_WINDOW;
  for (const [id, entry] of _extRateLimit) {
    if (entry.windowStart < cutoff) _extRateLimit.delete(id);
  }
}, 300000);

function checkExtRateLimit(senderId) {
  const now = Date.now();
  let entry = _extRateLimit.get(senderId);
  if (!entry || now - entry.windowStart > EXT_RATE_WINDOW) {
    entry = { count: 0, windowStart: now };
    _extRateLimit.set(senderId, entry);
  }
  entry.count++;
  return entry.count <= EXT_RATE_LIMIT;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || typeof message.type !== "string"
      || message.type.length > 64 || !message.type.startsWith("protoconsent:")) {
    return;
  }

  chrome.storage.local.get(["interExtEnabled", "interExtAllowlist", "interExtDenylist"], (r) => {
    if (r.interExtEnabled !== true) {
      sendResponse({ type: "protoconsent:error", error: "disabled", message: "Inter-extension API is disabled by user" });
      const sid = sender.id || "?";
      pushExtEvent({ sender: sid, action: message.type, result: "disabled" });
      return;
    }

    const senderId = sender.id;
    if (!senderId) return;

    const denylist = r.interExtDenylist || [];
    if (denylist.includes(senderId)) return;

    const allowlist = r.interExtAllowlist || [];

    if (!allowlist.includes(senderId)) {
      const now = Date.now();
      if (now - _unknownWindowStart > EXT_RATE_WINDOW) {
        _unknownIds = new Set();
        _unknownWindowStart = now;
      }
      const isNewId = !_unknownIds.has(senderId);
      if (isNewId) _unknownIds.add(senderId);
      if (isNewId && _unknownIds.size > EXT_UNKNOWN_LIMIT) return;

      chrome.storage.local.get(["interExtPending"], (p) => {
        const pending = p.interExtPending || [];
        if (!pending.some(e => e.id === senderId) && pending.length < EXT_PENDING_CAP) {
          pending.push({ id: senderId, firstSeen: Date.now() });
          chrome.storage.local.set({ interExtPending: pending });
        }
      });
      sendResponse({ type: "protoconsent:error", error: "need_authorization",
        message: "Extension not authorized. The user must approve this extension in ProtoConsent settings." });
      pushExtEvent({ sender: senderId, action: message.type, result: "need_authorization" });
      return;
    }

    if (!checkExtRateLimit(senderId)) {
      sendResponse({ type: "protoconsent:error", error: "rate_limited", message: "Too many requests" });
      pushExtEvent({ sender: senderId, action: message.type, result: "rate_limited" });
      return;
    }

    // Capabilities discovery
    if (message.type === "protoconsent:capabilities") {
      const manifest = chrome.runtime.getManifest();
      sendResponse({
        type: "protoconsent:capabilities_response",
        name: "ProtoConsent",
        version: manifest.version,
        protocol_version: INTEREXT_PROTOCOL_VERSION,
        supported_types: ["protoconsent:query", "protoconsent:capabilities"],
        purposes: ["functional", "analytics", "ads", "personalization", "third_parties", "advanced_tracking"]
      });
      pushExtEvent({ sender: senderId, action: "capabilities", result: "ok" });
      return;
    }

    // Consent query
    if (message.type === "protoconsent:query") {
      const domain = message.domain;
      if (!domain || typeof domain !== "string" || domain.length > 253 || !isValidHostname(domain)) {
        sendResponse({ type: "protoconsent:error", error: "invalid_domain", message: "A valid hostname is required" });
        pushExtEvent({ sender: senderId, action: "query", domain: String(message.domain || ""), result: "invalid_domain" });
        return;
      }

      Promise.all([
        handleBridgeQuery({ domain, action: "getAll" }),
        handleBridgeQuery({ domain, action: "getProfile" })
      ]).then(([purposes, profile]) => {
        sendResponse({
          type: "protoconsent:response",
          domain,
          purposes: purposes || {},
          profile: profile || "balanced",
          version: chrome.runtime.getManifest().version
        });
        pushExtEvent({ sender: senderId, action: "query", domain, result: "ok", profile: profile || "balanced" });
      }).catch(() => {
        sendResponse({ type: "protoconsent:error", error: "internal", message: "Failed to resolve purposes" });
        pushExtEvent({ sender: senderId, action: "query", domain, result: "internal" });
      });
      return;
    }

    sendResponse({ type: "protoconsent:error", error: "unknown_type", message: "Unsupported message type" });
    pushExtEvent({ sender: senderId, action: message.type, result: "unknown_type" });
  });
  return true;
});
