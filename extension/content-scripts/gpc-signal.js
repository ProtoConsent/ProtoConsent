// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Sets navigator.globalPrivacyControl for cooperating websites.
// This file is registered as a MAIN world content script by background.js
// only on domains where GPC-relevant purposes are denied.

try {
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value: true,
    configurable: false,
    writable: false
  });
} catch (_) {
  // Another extension or the browser may have already defined this property.
}
