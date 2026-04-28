// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hostname heuristic classification. Pure function, no state, no imports.
// Returns a best-guess purpose string or null for unattributed hostnames.
// Display only - never used for blocking decisions.

const HEURISTIC_PATTERNS = [
  { re: /^(ads?[.\-]|adserv|advert|adsystem|adnxs|adform|adtech|adroll|admob|admanag)/, purpose: "ads" },
  { re: /^(track(er|ing)?[.\-]|beacon|pixel|collect|log[.\-])/, purpose: "analytics" },
  { re: /^(analytics|stats?[.\-]|metrics?[.\-]|measure|insights|segment|telemetry)/, purpose: "analytics" },
  { re: /^(personali[sz]|recommend|suggest|targeting|retarget|remarket)/, purpose: "personalization" },
  { re: /^(fingerprint|device-?api|fp[.\-]|canvas[.\-])/, purpose: "advanced_tracking" },
  { re: /^(social|share|like[.\-]|comment|disqus|livefyre)/, purpose: "social" },
];


// Guess the purpose of an unattributed hostname based on subdomain patterns.
// @param {string} hostname - The full hostname (e.g., "ads.example.com")
// @returns {string|null} Purpose key or null if no match
export function guessHeuristicPurpose(hostname) {
  if (!hostname || typeof hostname !== "string") return null;
  const parts = hostname.toLowerCase().split(".");
  // Check the leftmost subdomain label
  const sub = parts[0];
  for (const { re, purpose } of HEURISTIC_PATTERNS) {
    if (re.test(sub)) return purpose;
  }
  return null;
}
