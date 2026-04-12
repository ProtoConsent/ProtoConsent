// ProtoConsent background CMP cookie decoder
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Decodes raw CMP cookie values into per-purpose consent booleans.
// Compares CMP consent vs user-configured purposes to detect conflicts.
// Also decodes localStorage-based CMP consent (Usercentrics, CCM19, etc.).

// Per-CMP decoders. Each returns { [purpose]: bool } or null on failure.
const DECODERS = {
  onetrust(raw) {
    // OptanonConsent: URL-encoded, contains groups=1:1,2:0,3:1,4:0
    const decoded = safeDecodeURI(raw);
    const match = decoded.match(/groups=([^&]*)/);
    if (!match) return null;
    const groups = {};
    for (const pair of match[1].split(",")) {
      const [id, val] = pair.split(":");
      if (id && val !== undefined) groups[id.trim()] = val.trim() === "1";
    }
    // Map: 2=analytics, 3=personalization, 4=ads (1=necessary, always true)
    return {
      analytics: groups["2"] ?? null,
      personalization: groups["3"] ?? null,
      ads: groups["4"] ?? null,
    };
  },

  cookiebot(raw) {
    // CookieConsent: {stamp:'...',necessary:true,preferences:false,statistics:true,marketing:false,...}
    const result = {};
    const prefMatch = raw.match(/preferences:(\w+)/);
    const statMatch = raw.match(/statistics:(\w+)/);
    const mktMatch = raw.match(/marketing:(\w+)/);
    if (prefMatch) result.personalization = prefMatch[1] === "true";
    if (statMatch) result.analytics = statMatch[1] === "true";
    if (mktMatch) result.ads = mktMatch[1] === "true";
    return Object.keys(result).length > 0 ? result : null;
  },

  cookieyes(raw) {
    // cookieyes-consent: {consentid:...,consent:yes,action:yes,...,functional:yes,analytics:no,...}
    // Also handles wt_consent with same format
    const result = {};
    const funcMatch = raw.match(/functional:(\w+)/);
    const anlMatch = raw.match(/analytics:(\w+)/);
    const advMatch = raw.match(/advertisement:(\w+)/);
    const perfMatch = raw.match(/performance:(\w+)/);
    if (funcMatch) result.personalization = funcMatch[1] === "yes";
    if (anlMatch) result.analytics = anlMatch[1] === "yes";
    else if (perfMatch) result.analytics = perfMatch[1] === "yes";
    if (advMatch) result.ads = advMatch[1] === "yes";
    return Object.keys(result).length > 0 ? result : null;
  },

  complianz(raw, cookieName) {
    // Individual cookies: cmplz_statistics=allow, cmplz_marketing=deny, cmplz_preferences=allow
    const allowed = raw === "allow";
    if (cookieName === "cmplz_statistics") return { analytics: allowed };
    if (cookieName === "cmplz_marketing") return { ads: allowed };
    if (cookieName === "cmplz_preferences") return { personalization: allowed };
    return null;
  },

  wix(raw) {
    // consent-policy: URL-encoded JSON {"ess":1,"func":1,"anl":0,"adv":0,"dt3":0,"ts":...}
    try {
      const decoded = safeDecodeURI(raw);
      const obj = JSON.parse(decoded);
      return {
        analytics: obj.anl === 1,
        personalization: obj.func === 1,
        ads: obj.adv === 1,
        third_parties: obj.dt3 === 1,
      };
    } catch (_) {
      return null;
    }
  },
};

function safeDecodeURI(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

// Map CMP IDs to decoder names (handles CMP ID aliases)
const CMP_DECODER_MAP = {
  onetrust: "onetrust",
  cookiebot: "cookiebot",
  cookieyes: "cookieyes",
  complianz: "complianz",
  wix: "wix",
};

// Cookie name to CMP decoder mapping (for cookies that clearly identify the CMP)
const COOKIE_DECODER_MAP = {
  OptanonConsent: "onetrust",
  CookieConsent: "cookiebot",
  "cookieyes-consent": "cookieyes",
  wt_consent: "cookieyes",
  cmplz_statistics: "complianz",
  cmplz_marketing: "complianz",
  cmplz_preferences: "complianz",
  "consent-policy": "wix",
};


// Decode detected CMP cookies and compare against user purposes.
// @param {Array} cookieDetected - [{cmpId, cookieName, rawValue}]
// @param {Object} userPurposes - {analytics: bool, ads: bool, ...}
// @returns {Array} [{cmpId, cookieName, decoded: {purpose: bool}, conflicts: [{purpose, cmpValue, userValue}]}]

export function decodeCmpCookies(cookieDetected, userPurposes) {
  const results = [];
  // Group complianz cookies together for aggregated result
  const complianzDecoded = {};

  for (const { cmpId, cookieName, rawValue } of cookieDetected) {
    const decoderName = COOKIE_DECODER_MAP[cookieName] || CMP_DECODER_MAP[cmpId];
    if (!decoderName || !DECODERS[decoderName]) continue;

    try {
      const decoded = DECODERS[decoderName](rawValue, cookieName);
      if (!decoded) continue;

      // Aggregate complianz individual cookies
      if (decoderName === "complianz") {
        Object.assign(complianzDecoded, decoded);
        continue;
      }

      const conflicts = findConflicts(decoded, userPurposes);
      results.push({ cmpId, cookieName, decoded, conflicts });
    } catch (_) {
      // Decoder threw - skip
    }
  }

  // Emit aggregated complianz result
  if (Object.keys(complianzDecoded).length > 0) {
    const conflicts = findConflicts(complianzDecoded, userPurposes);
    results.push({ cmpId: "complianz", cookieName: "cmplz_*", decoded: complianzDecoded, conflicts });
  }

  return results;
}

function findConflicts(decoded, userPurposes) {
  const conflicts = [];
  if (!userPurposes) return conflicts;
  for (const [purpose, cmpValue] of Object.entries(decoded)) {
    if (cmpValue === null || cmpValue === undefined) continue;
    const userValue = userPurposes[purpose];
    if (userValue === undefined) continue;
    if (cmpValue !== userValue) {
      conflicts.push({ purpose, cmpValue, userValue });
    }
  }
  return conflicts;
}

// --- localStorage decoders ---
// Each returns { [purpose]: bool } or null on failure.

const STORAGE_DECODERS = {
  usercentrics(raw, meta) {
    // uc_settings: JSON with services[] array.
    // Services have opaque IDs (no human-readable names in SDK v4 localStorage).
    // Key insight: the history[].action field reveals user intent:
    //   "onInitialPageLoad" (type:"implicit") = CMP defaults, no user choice yet
    //   "onDenyAllServices" (type:"explicit") = user denied all non-essential
    //   "onAcceptAllServices" (type:"explicit") = user accepted all
    // The status field does NOT flip on deny-all: essential services stay true.
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.services) || obj.services.length === 0) return null;

    // Find the latest user action (all services share the same global action)
    let lastAction = null;
    let lastType = null;
    for (const svc of obj.services) {
      if (!Array.isArray(svc.history) || svc.history.length === 0) continue;
      const latest = svc.history[svc.history.length - 1];
      if (latest && typeof latest.action === "string" && typeof latest.type === "string") {
        lastAction = latest.action;
        lastType = latest.type;
        break;
      }
    }

    // No explicit user action yet - banner pending
    if (!lastAction || lastType !== "explicit") {
      return { _summary: true, _noInteraction: true };
    }

    // Explicit deny-all
    if (lastAction === "onDenyAllServices") {
      return { analytics: false, ads: false, personalization: false };
    }

    // Explicit accept-all
    if (lastAction === "onAcceptAllServices") {
      return { analytics: true, ads: true, personalization: true };
    }

    // Custom selection or other action: count service statuses
    let allow = 0;
    let deny = 0;
    for (const svc of obj.services) {
      if (typeof svc.status !== "boolean") continue;
      if (svc.status) allow++; else deny++;
    }
    return { _summary: true, _allow: allow, _deny: deny };
  },

  ccm19(raw) {
    // ccm_consent: JSON with categories object.
    // Expected: { categories: { functional: true, analytics: false, marketing: false, ... }, ... }
    const obj = JSON.parse(raw);
    if (!obj) return null;

    // Direct category mapping if available
    const cats = obj.categories || obj;
    const result = {};
    if (typeof cats.analytics === "boolean") result.analytics = cats.analytics;
    else if (typeof cats.statistics === "boolean") result.analytics = cats.statistics;
    if (typeof cats.marketing === "boolean") result.ads = cats.marketing;
    else if (typeof cats.advertising === "boolean") result.ads = cats.advertising;
    if (typeof cats.functional === "boolean") result.personalization = cats.functional;
    else if (typeof cats.preferences === "boolean") result.personalization = cats.preferences;
    return Object.keys(result).length > 0 ? result : null;
  },
};


// Decode localStorage CMP entries and compare against user purposes.
// @param {Array} entries - [{cmpId, key, raw}]
// @param {Object} userPurposes - {analytics: bool, ads: bool, ...}
// @returns {Array} [{cmpId, key, decoded: {purpose: bool}, conflicts: [...]}]

export function decodeCmpStorage(entries, userPurposes) {
  const results = [];
  for (const { cmpId, key, raw, meta } of entries) {
    const decoder = STORAGE_DECODERS[cmpId];
    if (!decoder) continue;
    try {
      const decoded = decoder(raw, meta);
      if (!decoded) continue;

      // Summary results (e.g. Usercentrics without service names)
      if (decoded._summary) {
        results.push({ cmpId, key, decoded, conflicts: [], summary: true });
        continue;
      }

      const conflicts = findConflicts(decoded, userPurposes);
      results.push({ cmpId, key, decoded, conflicts });
    } catch (_) {
      // Decoder threw (malformed JSON, etc.) - skip
    }
  }
  return results;
}
