// ProtoConsent background CMP injection
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pre-computes CMP injection data (user purposes, TC String) and writes it
// to chrome.storage.local for cmp-inject.js content script to read at
// document_start.

import { gpcPurposes } from "./state.js";

// ---------------------------------------------------------------------------
// TC String generator (IAB TCF v2.2)
// Produces a valid euconsent-v2 cookie value from ProtoConsent purposes.
// No external dependencies — manual bitfield + base64url encoding.
// ---------------------------------------------------------------------------

// ProtoConsent purposes → TCF purpose IDs (1-indexed, 24 bits total)
// See design/cmp-auto-response.md mapping table
const TCF_PURPOSE_MAP = {
  functional:        [1],         // Store/access device
  ads:               [2, 3, 4, 7], // Basic ads, ads profile, personalized ads, measure ads
  analytics:         [8, 9],     // Measure content performance, market research
  personalization:   [5, 6],     // Content profile, personalized content
};

// TCF v2.2 core segment fixed values
const TCF_CMP_ID             = 1;  // Placeholder (no registered CMP ID yet)
const TCF_CMP_VERSION        = 1;
const TCF_VENDOR_LIST_VERSION = 1;  // Minimal
const TCF_POLICY_VERSION     = 4;  // TCF v2.2
// Purposes 10 (develop/improve products) and special purposes are not mapped —
// they follow the most restrictive denied purpose or stay 0.

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeTcString(globalPurposes) {
  const bits = [];

  function pushBits(value, count) {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >> i) & 1);
    }
  }

  function pushLetter(ch) {
    pushBits(ch.toLowerCase().charCodeAt(0) - 97, 6);
  }

  // Deciseconds since epoch (TCF timestamp format)
  const now = Math.round(Date.now() / 100);

  // --- Core segment fixed fields (213 bits) ---
  pushBits(2, 6);           // Version = 2
  pushBits(now, 36);        // Created
  pushBits(now, 36);        // LastUpdated
  pushBits(TCF_CMP_ID, 12);         // CmpId
  pushBits(TCF_CMP_VERSION, 12);    // CmpVersion
  pushBits(0, 6);           // ConsentScreen
  pushLetter("E");          // ConsentLanguage: EN
  pushLetter("N");
  pushBits(TCF_VENDOR_LIST_VERSION, 12);  // VendorListVersion
  pushBits(TCF_POLICY_VERSION, 6);        // TcfPolicyVersion
  pushBits(1, 1);           // IsServiceSpecific = true
  pushBits(0, 1);           // UseNonStandardTexts = false

  // SpecialFeatureOptIns: 12 bits, all 0
  pushBits(0, 12);

  // PurposesConsent: 24 bits (1 = consent given for that TCF purpose)
  const purposeConsent = new Array(24).fill(0);
  for (const [pcPurpose, tcfIds] of Object.entries(TCF_PURPOSE_MAP)) {
    if (globalPurposes[pcPurpose]) {
      for (const id of tcfIds) purposeConsent[id - 1] = 1;
    }
  }
  for (const bit of purposeConsent) pushBits(bit, 1);

  // PurposesLITransparency: 24 bits
  // When a purpose is denied, set LI objection bit (user objects to legitimate interest).
  // TCF v2.2: purposes 3-6 cannot use LI, so those bits must be 0.
  const LI_FORBIDDEN = new Set([3, 4, 5, 6]);
  const purposeLI = new Array(24).fill(0);
  for (const [pcPurpose, tcfIds] of Object.entries(TCF_PURPOSE_MAP)) {
    if (!globalPurposes[pcPurpose]) {
      for (const id of tcfIds) {
        if (!LI_FORBIDDEN.has(id)) purposeLI[id - 1] = 1;
      }
    }
  }
  for (const bit of purposeLI) pushBits(bit, 1);

  pushBits(0, 1);           // PurposeOneTreatment = false
  pushLetter("A");          // PublisherCC: AA (generic)
  pushLetter("A");

  // --- Core segment variable fields ---
  // Vendor Consent: MaxVendorId=0, BitField encoding (no vendors)
  pushBits(0, 16);          // MaxVendorId = 0
  pushBits(0, 1);           // IsRangeEncoding = 0 (bitfield, 0 bits follow)

  // Vendor Legitimate Interest: same — empty
  pushBits(0, 16);
  pushBits(0, 1);

  // Publisher Restrictions: none
  pushBits(0, 12);          // NumPubRestrictions = 0

  // Encode core segment to base64url
  const core = bitsToBase64url(bits);

  // --- Disclosed Vendors segment (type 1, mandatory) ---
  const dvBits = [];
  // SegmentType = 1
  dvBits.push(0, 0, 1);
  // MaxVendorId = 0, BitField encoding
  for (let i = 15; i >= 0; i--) dvBits.push(0);
  dvBits.push(0); // IsRangeEncoding = 0

  const disclosed = bitsToBase64url(dvBits);

  return core + "." + disclosed;
}

function bitsToBase64url(bits) {
  // Pad to multiple of 6
  while (bits.length % 6 !== 0) bits.push(0);
  let result = "";
  for (let i = 0; i < bits.length; i += 6) {
    const val = (bits[i] << 5) | (bits[i + 1] << 4) | (bits[i + 2] << 3) |
                (bits[i + 3] << 2) | (bits[i + 4] << 1) | bits[i + 5];
    result += B64URL[val];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Write CMP injection data to storage for cmp-inject.js content script.
// Loads cmp-signatures.json on first call, then writes resolved purposes
// (including GPC state and pre-computed TC String) so the content script
// can replace template placeholders.
// ---------------------------------------------------------------------------
let _cmpSignaturesCache = null;
export async function updateCmpInjectionData(globalPurposes, gpcEnabled) {
  try {
    if (!_cmpSignaturesCache) {
      const url = chrome.runtime.getURL("config/cmp-signatures.json");
      const res = await fetch(url);
      if (!res.ok) return;
      _cmpSignaturesCache = await res.json();
      await chrome.storage.local.set({ _cmpSignatures: _cmpSignaturesCache });
    }

    const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);
    const tcString = encodeTcString(globalPurposes);

    await chrome.storage.local.set({
      _userPurposes: {
        analytics: !!globalPurposes.analytics,
        ads: !!globalPurposes.ads,
        personalization: !!globalPurposes.personalization,
        third_parties: !!globalPurposes.third_parties,
        advanced_tracking: !!globalPurposes.advanced_tracking,
        gpc: globalNeedsGPC ? 1 : 0,
      },
      _tcString: tcString,
    });
  } catch (e) {
    console.error("ProtoConsent: failed to update CMP injection data:", e);
  }
}
