// ProtoConsent browser extension - service worker entry point
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ES module entry point. Each background/*.js module registers its own
// listeners as a side effect of being imported. This file orchestrates
// the import order and runs top-level initialization.

// 1. Shared state (must load first - other modules import from it)
import "./background/state.js";

// 2. Session restore (depends on state)
import { restoreTabDataFromSession } from "./background/session.js";

// 3. Config loaders (depends on state)
import { loadBlocklistsConfig } from "./background/config-loader.js";

// 4. DNR rebuild engine (depends on state, storage, config-loader)
import "./background/rebuild.js";

// 5. Message handlers - popup, content script, SDK bridge (depends on rebuild)
import "./background/handlers.js";

// 6. Inter-extension API (depends on handlers for handleBridgeQuery)
import "./background/interext.js";

// 7. Request tracking - webRequest listeners, log ports (depends on state, config-loader)
import "./background/tracking.js";

// 8. Lifecycle - tab events, onStartup, onInstalled (depends on rebuild)
import "./background/lifecycle.js";

// --- Top-level initialization ---
// Restore persisted tab data from session storage on every SW load.
restoreTabDataFromSession();

// Start loading blocklists early so the reverse hostname index is ready
// when the first onErrorOccurred event arrives.
loadBlocklistsConfig();

// Badge background color (gray)
chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
