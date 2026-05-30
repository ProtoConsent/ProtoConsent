// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Log tab: in-memory state (sort/filter state, port handle, replay flag, limits).
// Shared globals owned here; read by log-render.js, mutated by log-actions.js.

let logPort = null;
let logInitialized = false;

// Sort & filter state (persists across re-renders within session)
let domainSort = { col: "count", dir: "desc" };
let gpcSort = { col: "count", dir: "desc" };
let wlSort = { col: "domain", dir: "asc" };
let logDomainFilter = "";
let logGpcFilter = "";
let logWhitelistFilter = "";

// Track whether historical data has been replayed to prevent re-renders
let _historicalReplayed = false;

const LOG_MAX_LINES = 500;
const LOG_NODES_PER_LINE = 3; // tsSpan + lineSpan + "\n" textNode
