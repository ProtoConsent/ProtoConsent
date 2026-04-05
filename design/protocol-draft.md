# ProtoConsent Purpose-Signalling Protocol (Draft)

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent is a browser-side, purpose-based consent system. There is no central server: all user preferences are stored locally in the browser extension and enforced via `declarativeNetRequest`.

This document describes the protocol by which web pages can query the user's consent preferences from the ProtoConsent browser extension through an optional JavaScript SDK. The protocol is entirely local: communication happens between a page-side SDK and the extension via browser messaging primitives.

**Scope:** data model, communication model, and SDK API surface.

**Status:** draft. The communication mechanism is implemented via a content script bridge; this document defines the architecture.

## Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [Communication Model](#3-communication-model)
4. [SDK API Surface](#4-sdk-api-surface)
5. [Site Declaration (`.well-known/protoconsent.json`)](#5-site-declaration-well-knownprotocolconsentjson)
6. [Global Privacy Control (GPC) integration](#6-global-privacy-control-gpc-integration)
7. [JSON Schema Formalization (Planned)](#7-json-schema-formalization-planned)
8. [Implementation Status](#8-implementation-status)
9. [Design Principles](#9-design-principles)

## 2. Data Model

### 2.1 Purposes

ProtoConsent defines six purpose categories, each mapped to the [Consent Commons](https://consentcommons.com/) taxonomy:

| Key | Label | Short | Consent Commons keys |
| --- | --- | --- | --- |
| `functional` | Functional (service) | F | `service_management`, `other_data` |
| `analytics` | Analytics | An | `profiling_analytics` |
| `ads` | Ads / Marketing | Ad | `marketing_purposes`, `profiling_analytics` |
| `personalization` | Personalization / Profiling | P | `profiling_analytics` |
| `third_parties` | Third-party sharing | 3P | `third_party_access`, `third_party_sharing_advertising` |
| `advanced_tracking` | Advanced tracking / fingerprinting | T | `profiling_analytics`, `other_data` |

Canonical source: `extension/config/purposes.json`

### 2.2 Profiles (presets)

Three predefined profiles set default purpose states:

| Profile | functional | analytics | ads | personalization | third_parties | advanced_tracking |
| --- | --- | --- | --- | --- | --- | --- |
| **strict** | allowed | denied | denied | denied | denied | denied |
| **balanced** | allowed | allowed | denied | allowed | denied | denied |
| **permissive** | allowed | allowed | allowed | allowed | allowed | denied |

Canonical source: `extension/config/presets.json`

### 2.3 Per-domain rules

The core data structure stored in the browser's extension storage (`chrome.storage.local`). The `purposes` object contains only explicit overrides; purposes not listed inherit their value from the selected profile:

```json
{
  "example.com": {
    "profile": "balanced",
    "purposes": {
      "analytics": false
    }
  }
}
```

In this example, `analytics` is explicitly denied. The remaining five purposes (`functional`, `ads`, `personalization`, `third_parties`, `advanced_tracking`) inherit their values from the "balanced" profile. The resolved state is equivalent to:

```json
{
  "functional": true,
  "analytics": false,
  "ads": false,
  "personalization": true,
  "third_parties": false,
  "advanced_tracking": false
}
```

Each domain has exactly one rule entry. Purpose values are booleans: `true` = allowed, `false` = denied. When a domain has no explicit rule, all purpose values are inherited from the active profile (preset).

## 3. Communication Model

### 3.1 Architecture

```text
 Page context                Extension context
 ┌──────────┐  postMessage  ┌────────────────┐  chrome.runtime  ┌────────────┐  chrome.storage  ┌─────────┐
 │  SDK     │ ←──────────→  │ Content script │ ←──────────────→ │ Background │ ←──────────────→ │ Storage │
 │  (page)  │               │ (bridge)       │                  │ (service   │                  │ (local) │
 └──────────┘               └────────────────┘                  │  worker)   │                  └─────────┘
                                                                └────────────┘
```

- The **SDK** runs in the page's JavaScript context and cannot access extension APIs directly.
- A **content script** injected by the extension acts as the bridge. It receives `postMessage` queries from the page and forwards them to the **background script** via `chrome.runtime.sendMessage`.
- The **background script** resolves the query against stored rules and the active profile, and returns the result through the same chain.
- Communication uses `window.postMessage` with structured messages identified by type prefix.

### 3.2 Message format (informative, subject to change)

**Query** (page → extension):

```json
{
  "type": "PROTOCONSENT_QUERY",
  "id": "uuid-string",
  "action": "get | getAll | getProfile",
  "purpose": "analytics"
}
```

**Response** (extension → page):

```json
{
  "type": "PROTOCONSENT_RESPONSE",
  "id": "uuid-string",
  "data": true
}
```

The `id` field correlates requests with responses. The `purpose` field is only present for `get` actions. The `data` field contains: `boolean|null` for `get`, `object|null` for `getAll`, `string|null` for `getProfile`.

### 3.3 No network communication

The protocol is entirely local. No HTTP requests, no server endpoints, no remote API. All data stays within the browser.

## 4. SDK API Surface

The SDK exposes a minimal read-only API for web pages:

| Member | Type | Returns |
| --- | --- | --- |
| `ProtoConsent.get(purpose)` | method | `Promise<boolean\|null>` — `true` = allowed, `false` = denied, `null` = extension not present |
| `ProtoConsent.getAll()` | method | `Promise<object\|null>` — all purpose states, or `null` |
| `ProtoConsent.getProfile()` | method | `Promise<string\|null>` — `"strict"`, `"balanced"`, `"permissive"`, or `null` |
| `ProtoConsent.version` | property | `string` — SDK version |
| `ProtoConsent.purposes` | property | `string[]` — the valid purpose keys |

Reference implementation: `sdk/protoconsent.js` (MIT licensed)

### Quick example

```html
<script type="module">
  import ProtoConsent from 'protoconsent.js';

  // Check a single purpose — returns true, false, or null (no extension)
  const allowed = await ProtoConsent.get('analytics');
  if (allowed) {
    // user allows analytics on this site
  }

  // Read all purposes at once
  const all = await ProtoConsent.getAll();
  // → { functional: true, analytics: false, ads: false, personalization: false,
  //     third_parties: false, advanced_tracking: false }

  // Read the active profile
  const profile = await ProtoConsent.getProfile();
  // → "strict", "balanced", "permissive", or null
</script>
```

Every method returns a `Promise` that resolves to `null` when the extension is not installed — no errors, no retries, no side effects.

## 5. Site Declaration (`.well-known/protoconsent.json`)

Websites can optionally declare their data-processing purposes by serving a static JSON file at `/.well-known/protoconsent.json`. This is a **voluntary, informational declaration** — it does not change how the extension enforces user preferences.

The extension reads the file when the user opens the side panel in the popup, caches it locally (24‑hour TTL on success, 6‑hour TTL on failure), and displays the site's claims alongside the user's own choices.

### Minimal example

```json
{
  "protoconsent": "0.1",
  "purposes": {
    "functional": { "used": true, "legal_basis": "legitimate_interest" },
    "analytics": { "used": true, "legal_basis": "consent", "provider": "Plausible" }
  }
}
```

### Three-state model

- `"used": true` — the site declares it uses this purpose.
- `"used": false` — the site explicitly declares it does **not** use this purpose.
- **Key absent** — the site makes no claim (not declared).

### Complementary to the SDK

The SDK enables **dynamic interaction** (page queries extension via JavaScript). The `.well-known` file enables **static declaration** (extension reads site metadata). A site can use one, both, or neither.

### Additional fields

Beyond the minimal `used` and `legal_basis` fields, each purpose entry can include `provider` (service provider name) and `sharing` (`"none"`, `"within_group"`, or `"third_parties"`). A top‑level `data_handling` object supports `storage_region` and `international_transfers`. A `rights_url` field links to the site's data subject rights page. See the full specification for details.

Full specification: [`design/well-known-spec.md`](well-known-spec.md)

## 6. Global Privacy Control (GPC) integration

ProtoConsent sends the [Global Privacy Control](https://globalprivacycontrol.org/) signal conditionally, based on the user's resolved purpose state for each site. GPC is not a global toggle: it is derived from purpose decisions.

### 6.1 Which purposes trigger GPC

Each purpose in `config/purposes.json` has a `triggers_gpc` boolean field. When a purpose with `triggers_gpc: true` is denied for a given site, the extension activates GPC for that site.

Current mapping:

| Purpose | `triggers_gpc` | Rationale |
| --- | --- | --- |
| `functional` | `false` | Core site functionality; denying it does not imply a privacy opt-out. |
| `analytics` | `false` | Site-internal measurement; typically first-party and not covered by GPC's opt-out scope. |
| `ads` | `true` | Advertising and remarketing involve cross-site data sharing that GPC was designed to signal against. |
| `personalization` | `false` | User-facing content adaptation; does not inherently involve cross-site tracking. |
| `third_parties` | `true` | Data sharing with third parties is a core opt-out scenario for GPC. |
| `advanced_tracking` | `true` | Cross-site fingerprinting and device tracking; GPC directly applies. |

The rule: if **any** purpose with `triggers_gpc: true` is denied for a site, GPC is active for that site. If all such purposes are allowed (or the profile allows them), GPC is not sent.

### 6.2 Mechanism

When GPC is active for a site, two signals are sent:

1. **`Sec-GPC: 1` HTTP header** — injected via `declarativeNetRequest` `modifyHeaders` rules on outgoing requests to the site's domain.
2. **`navigator.globalPrivacyControl = true`** — set via a MAIN-world content script (`gpc-signal.js`), registered at runtime through `chrome.scripting.registerContentScripts`.

When GPC is not active, neither signal is sent. There is no `Sec-GPC: 0` — absence of the header means no preference expressed.

### 6.3 Per-site overrides

GPC follows the same per-site override model as blocking (§2.3). A site assigned the Permissive profile with all purposes allowed will not receive GPC, even if the global default profile would trigger it. Conversely, a site with a Strict profile will receive GPC even if the global default is Permissive.

The extension maintains up to three dynamic DNR rules for GPC:

- **Global GPC rule** (priority 1): sends `Sec-GPC: 1` to all sites when the default profile triggers it.
- **Per-site add rule** (priority 2): adds GPC for specific sites whose custom profile triggers it, when the global rule does not apply.
- **Per-site remove rule** (priority 2): suppresses GPC for specific sites whose custom profile allows all GPC-triggering purposes, overriding the global rule.

### 6.4 Relation to the GPC specification

The [GPC specification](https://privacycg.github.io/gpc-spec/) defines GPC as a binary signal: the user either expresses a preference to opt out of sale/sharing, or does not. ProtoConsent respects this: it sends `Sec-GPC: 1` or nothing.

The difference is in **when** the signal is sent. Most implementations treat GPC as a global preference (always on or always off). ProtoConsent derives the signal from the user's purpose-level decisions, making it conditional per site. This is compatible with the spec — the spec does not require the signal to be global — but it extends the practical semantics: the GPC signal reflects a structured privacy position, not a blanket opt-out.

Canonical source: `extension/config/purposes.json` (field `triggers_gpc`)

## 7. JSON Schema Formalization (Planned)

Formal JSON Schemas are planned for the configuration files:

- `purposes.schema.json` — validates the purposes definition structure
- `presets.schema.json` — validates the profiles/presets structure
- `rules.schema.json` — validates the per-domain rules object
- `message.schema.json` — validates the SDK ↔ extension message format

Status: planned for a future version. This is not a blocker for current functionality.

## 8. Implementation Status

| Component | Status |
| --- | --- |
| Purposes data model (`purposes.json`) | Implemented (v0.1.0) |
| Presets data model (`presets.json`) | Implemented (v0.1.0) |
| Per-domain rules in storage | Implemented (v0.1.0) |
| Extension enforcement (DNR) | Implemented (v0.1.0 — global + per-site; v0.1.1 — static rulesets, path-based blocking, override grouping; v0.2.0 — 40 000+ domains, 1 200+ path rules, blocklist audit; v0.2.1 — domain whitelist with priority-3 allow rules) |
| Extension popup UI | Implemented (v0.1.0 — profiles, toggles; v0.1.1 — blocked counter, per-purpose stats, .well-known side panel, debug panel; v0.2.0 — onboarding, purpose settings page; v0.2.1 — log monitoring tab, flood protection, domain whitelist) |
| Blocked request counter | Implemented (v0.1.1) — per-tab blocked count, per-purpose breakdown, domain detail |
| Domain whitelist | Implemented (v0.2.1) — per-site and global scope, priority-3 DNR allow rules, budget guard |
| Onboarding welcome page | Implemented (v0.2.0) |
| SDK skeleton (API surface defined) | Implemented (v0.1.0) |
| SDK messaging (actual communication) | Implemented (v0.1.0) |
| Content script bridge | Implemented (v0.1.0) |
| TypeScript type declarations | Implemented (v0.1.0) |
| Conditional GPC header (Sec-GPC) | Implemented (v0.1.1) — per-site, driven by `triggers_gpc` in purposes.json; also sets `navigator.globalPrivacyControl` via MAIN‑world content script |
| Site declaration (`.well-known`) | Implemented (v0.1.1) — fetch with 24h/6h cache, popup side panel with Consent Commons icons |
| JSON Schemas | Planned (protocol formalization) |
| Demo sites using SDK | [protoconsent.org](https://protoconsent.org/) live test (v0.1.0), [demo.protoconsent.org](https://demo.protoconsent.org) full-featured demo (v0.2.0); additional demos planned |

## 9. Design Principles

- **No central server:** all data stays local to the browser.
- **Privacy by default:** the SDK reveals only purpose-level allow/deny per domain, never user identity or cross-site state.
- **Minimal signalling:** the smallest possible API surface that is useful.
- **Consent Commons alignment:** purpose definitions map to established [Consent Commons](https://consentcommons.com/) keys.
- **Optional adoption:** the extension works without any site integration; the SDK is an optional enhancement for cooperating websites.

---

This draft is a starting point for the ProtoConsent purpose-signalling protocol. Feedback and contributions are welcome via the project's [GitHub repository](https://github.com/ProtoConsent/ProtoConsent).
