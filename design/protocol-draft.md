# ProtoConsent Purpose-Signalling Protocol (Draft)

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

This document describes the ProtoConsent purpose-signalling protocol: the mechanism by which web pages can query the user's consent preferences from the ProtoConsent browser extension, and by which websites can declare their data-processing practices.

The protocol is entirely local: communication happens between a page-side SDK and the extension via browser messaging primitives. There is no central server. It defines three layers:

- **Data model**: six purpose categories with profiles and per-domain overrides (§2).
- **Communication model**: SDK ↔ extension messaging via a content script bridge (§3–4).
- **Site declaration**: a static `.well-known/protoconsent.json` file for voluntary purpose disclosure (§5).

**Status:** draft.

## Contents

- [ProtoConsent Purpose-Signalling Protocol (Draft)](#protoconsent-purpose-signalling-protocol-draft)
  - [1. Overview](#1-overview)
  - [Contents](#contents)
  - [2. Data Model](#2-data-model)
    - [2.1 Purposes](#21-purposes)
    - [2.2 Profiles (presets)](#22-profiles-presets)
    - [2.3 Per-domain rules](#23-per-domain-rules)
  - [3. Communication Model](#3-communication-model)
    - [3.1 Architecture](#31-architecture)
    - [3.2 Message format (informative, subject to change)](#32-message-format-informative-subject-to-change)
    - [3.3 No network communication](#33-no-network-communication)
  - [4. SDK API Surface](#4-sdk-api-surface)
    - [Quick example](#quick-example)
  - [5. Site Declaration (`.well-known/protoconsent.json`)](#5-site-declaration-well-knownprotoconsentjson)
    - [Minimal example](#minimal-example)
    - [Three-state model](#three-state-model)
    - [Complementary to the SDK](#complementary-to-the-sdk)
    - [Additional fields](#additional-fields)
  - [6. Design Principles](#6-design-principles)

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

### 2.2 Profiles (presets)

Three predefined profiles set default purpose states:

| Profile | functional | analytics | ads | personalization | third_parties | advanced_tracking |
| --- | --- | --- | --- | --- | --- | --- |
| **strict** | allowed | denied | denied | denied | denied | denied |
| **balanced** | allowed | allowed | denied | allowed | denied | denied |
| **permissive** | allowed | allowed | allowed | allowed | allowed | denied |

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
| `ProtoConsent.get(purpose)` | method | `Promise<boolean\|null>`: `true` = allowed, `false` = denied, `null` = extension not present |
| `ProtoConsent.getAll()` | method | `Promise<object\|null>`: all purpose states, or `null` |
| `ProtoConsent.getProfile()` | method | `Promise<string\|null>`: `"strict"`, `"balanced"`, `"permissive"`, or `null` |
| `ProtoConsent.version` | property | `string`: SDK version |
| `ProtoConsent.purposes` | property | `string[]`: the valid purpose keys |

### Quick example

```html
<script type="module">
  import ProtoConsent from 'protoconsent.js';

  // Check a single purpose: returns true, false, or null (no extension)
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

Every method returns a `Promise` that resolves to `null` when the extension is not installed: no errors, no retries, no side effects.

## 5. Site Declaration (`.well-known/protoconsent.json`)

Websites can optionally declare their data-processing purposes by serving a static JSON file at `/.well-known/protoconsent.json`. This is a **voluntary, informational declaration**: it does not change how the extension enforces user preferences.

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

- `"used": true`: the site declares it uses this purpose.
- `"used": false`: the site explicitly declares it does **not** use this purpose.
- **Key absent**: the site makes no claim (not declared).

### Complementary to the SDK

The SDK enables **dynamic interaction** (page queries extension via JavaScript). The `.well-known` file enables **static declaration** (extension reads site metadata). A site can use one, both, or neither.

### Additional fields

Beyond the minimal `used` and `legal_basis` fields, each purpose entry can include `provider` (service provider name) and `sharing` (`"none"`, `"within_group"`, or `"third_parties"`). A top‑level `data_handling` object supports `storage_region` and `international_transfers`. A `rights_url` field links to the site's data subject rights page. See the full specification for details.

Full specification: [`design/well-known-spec.md`](well-known-spec.md)

## 6. Design Principles

- **No central server:** all data stays local to the browser.
- **Privacy by default:** the SDK reveals only purpose-level allow/deny per domain, never user identity or cross-site state.
- **Minimal signalling:** the smallest possible API surface that is useful.
- **Consent Commons alignment:** purpose definitions map to established [Consent Commons](https://consentcommons.com/) keys.
- **Optional adoption:** the extension works without any site integration; the SDK is an optional enhancement for cooperating websites.
