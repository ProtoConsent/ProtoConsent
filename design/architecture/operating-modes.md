# Operating modes

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

ProtoConsent supports two operating modes that share the same consent engine but differ in enforcement strategy.

## Mode definition

| Mode | Behaviour |
|---|---|
| **Blocking** (default) | ProtoConsent blocks requests directly using its own static and dynamic DNR rulesets |
| **Monitoring** | ProtoConsent delegates network blocking to an external blocker (e.g. uBlock Origin) and focuses on purpose attribution, signaling, and consent automation |

The mode is stored locally and persisted across sessions. The popup reads it synchronously so all UI components reflect the active mode immediately.

## What changes between modes

A capabilities model gates all mode-dependent behavior. Each feature is either active or skipped depending on the mode:

| Feature | Blocking | Monitoring | Notes |
|---|---|---|---|
| Static rulesets (per-purpose blocking) | Yes | No | Disabled entirely in Monitoring |
| Per-site overrides | Yes | No | |
| Whitelist allow rules | Yes | No | No own blocks to override |
| Enhanced Protection DNR rules | Yes | No | |
| Attribution indexes | Yes | Yes | Lists serve as classification dictionaries in both modes |
| GPC signaling | Yes | Yes | Subject to its own toggle in settings |
| Client Hints stripping | Yes | Yes | Subject to its own toggle in settings |
| CMP auto-response | Yes | Yes | Subject to signatures being loaded |
| Cosmetic filtering | Yes | Yes | Subject to list being enabled |

The key insight: Monitoring mode disables all network-level enforcement but keeps signaling, consent automation, and purpose attribution active. This makes it useful alongside a dedicated ad blocker.

## Mode transitions

Switching mode triggers an immediate full rebuild of all DNR rules. The transition is atomic from the user's perspective.

**Blocking to Monitoring**: all static rulesets are disabled, dynamic block rules and whitelist overrides are cleared. The badge counter persists; new block events reflect the external blocker's activity.

**Monitoring to Blocking**: full rebuild reconstructs all DNR rules. If an external blocker is still present during rebuild, it covers the gap.

## Coverage metrics

Two per-tab counters track attribution quality:

- **Observed**: total blocked requests detected (via `ERR_BLOCKED_BY_CLIENT`)
- **Attributed**: blocked requests successfully classified to at least one purpose

The coverage ratio (attributed / observed) is displayed in the Overview tab as a visual bar. Hostnames that could not be classified are collected in a buffer for diagnostic use. Both counters are persisted across service worker restarts and cleaned up on tab close or navigation.

Coverage is most useful in Monitoring mode, where blocks come from an external blocker and attribution depends entirely on the reverse hostname index.

## Overview tab

The Overview tab provides a mode-aware dashboard, visible in both modes. It auto-refreshes while the popup is open.

Layout (top to bottom):

1. **Status banner**: mode indicator with color coding (red for Blocking, teal for Monitoring)
2. **Coverage bar**: attributed / observed ratio
3. **Signal status**: GPC domain/request counts, cosmetic rule count
4. **CMP Detection**: detected banner name and state (present/showing)
5. **Purpose cards**: per-purpose blocked domain counts with Consent Commons icons, expandable with top domains
6. **CMP Auto-response**: template count and matched domain
7. **Param Stripping**: stripped parameter names per domain (only visible when strips detected)
8. **Unattributed hostnames**: collapsible diagnostic list

## UI gating

- **Mode indicator**: a semaphore pill in the popup header shows the active mode. Clicking it navigates to the Overview tab.
- **Whitelist**: hidden in Monitoring mode (no own blocks to override), with an explanatory message.
- **Settings toggle**: the Purpose Settings page includes an Operating Mode toggle. The mode choice is included in export/import.
