# ProtoConsent Data Model

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

## 1. Overview

This document defines the shared data model used across all ProtoConsent specifications: the purpose categories, profiles, per-domain rule structure, and core design principles. Other specification documents ([signalling-protocol.md](signalling-protocol.md), [protoconsent-well-known.md](protoconsent-well-known.md), [inter-extension-protocol.md](inter-extension-protocol.md)) reference this data model rather than redefining it.

**Status:** draft.

## Contents

- [ProtoConsent Data Model](#protoconsent-data-model)
  - [1. Overview](#1-overview)
  - [Contents](#contents)
  - [2. Purposes](#2-purposes)
  - [3. Profiles (presets)](#3-profiles-presets)
  - [4. Per-domain rules](#4-per-domain-rules)
  - [5. Design Principles](#5-design-principles)

## 2. Purposes

ProtoConsent defines six purpose categories, each mapped to the [Consent Commons](https://consentcommons.com/) taxonomy:

| Key | Label | Short | Consent Commons keys |
| --- | --- | --- | --- |
| `functional` | Functional (service) | F | `service_management`, `other_data` |
| `analytics` | Analytics | An | `profiling_analytics` |
| `ads` | Ads / Marketing | Ad | `marketing_purposes`, `profiling_analytics` |
| `personalization` | Personalization / Profiling | P | `profiling_analytics` |
| `third_parties` | Third-party sharing | 3P | `third_party_access`, `third_party_sharing_advertising` |
| `advanced_tracking` | Advanced tracking / fingerprinting | T | `profiling_analytics`, `other_data` |

## 3. Profiles (presets)

Three predefined profiles set default purpose states:

| Profile | functional | analytics | ads | personalization | third_parties | advanced_tracking |
| --- | --- | --- | --- | --- | --- | --- |
| **strict** | allowed | denied | denied | denied | denied | denied |
| **balanced** | allowed | allowed | denied | allowed | denied | denied |
| **permissive** | allowed | allowed | allowed | allowed | allowed | denied |

## 4. Per-domain rules

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

## 5. Design Principles

- **No central server:** all data stays local to the browser.
- **Privacy by default:** the SDK reveals only purpose-level allow/deny per domain, never user identity or cross-site state.
- **Minimal signalling:** the smallest possible API surface that is useful.
- **Consent Commons alignment:** purpose definitions map to established [Consent Commons](https://consentcommons.com/) keys.
- **Optional adoption:** the extension works without any site integration; the SDK is an optional enhancement for cooperating websites.
