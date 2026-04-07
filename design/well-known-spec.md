# ProtoConsent – `.well-known/protoconsent.json` specification

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

Websites can declare their data-processing purposes by serving a static JSON file at:

```
http(s)://<host>/.well-known/protoconsent.json
```

Only `http:` and `https:` are supported. The extension uses the page's actual protocol and host when fetching the file.

This is a **voluntary, informational declaration**. It does not change how the ProtoConsent extension enforces user preferences. The extension always enforces the user's own profile and toggles. The `.well-known` file adds transparency by showing what the site claims alongside the user's choices.

The format follows the pattern of other `.well-known` resources ([RFC 8615](https://www.rfc-editor.org/rfc/rfc8615)), such as `security.txt` and `change-password`.

## Contents

1. [Overview](#1-overview)
2. [Schema](#2-schema)
3. [Examples](#3-examples)
4. [Extension behaviour](#4-extension-behaviour)
5. [Hosting notes](#5-hosting-notes)
6. [Relationship to other specifications](#6-relationship-to-other-specifications)
7. [Online validator](#7-online-validator)

## 2. Schema

### 2.1 Top-level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protoconsent` | string | yes | Protocol version. Currently `"0.1"`. |
| `purposes` | object | yes | Purpose declarations. At least one purpose must be present. |
| `data_handling` | object | no | Data storage and transfer information. |
| `rights_url` | string (URL) | no | Link to the data subject rights section of the privacy policy. |

### 2.2 Purpose entry (`purposes.<key>`)

Each key must match a canonical ProtoConsent purpose (`functional`, `analytics`, `ads`, `personalization`, `third_parties`, `advanced_tracking`). Unknown keys are ignored.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `used` | boolean | yes | Whether this purpose is active on the site. |
| `legal_basis` | string | no | Legal basis invoked. See §2.4. |
| `provider` | string | no | Name of the service provider (e.g. `"Plausible"`, `"Google Analytics"`). |
| `sharing` | string | no | Data sharing scope: `"none"`, `"within_group"`, or `"third_parties"`. |

**Three-state model:** purposes not included in the object are treated as **not declared**: the site makes no claim about them. This is distinct from `"used": false` (the site explicitly states it does not use that purpose).

### 2.3 Data handling (`data_handling`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storage_region` | string | no | Where user data is primarily stored. Values: ISO 3166-1 alpha-2 country code, or `"eu"`, `"eea"`, `"international"`. |
| `international_transfers` | boolean | no | Whether data is transferred outside the storage region. |

### 2.4 Legal basis values

Valid values for the `legal_basis` field, aligned with GDPR Article 6(1):

| Value | GDPR basis |
|-------|------------|
| `consent` | Art. 6(1)(a): Consent |
| `contractual` | Art. 6(1)(b): Performance of a contract |
| `legal_obligation` | Art. 6(1)(c): Legal obligation |
| `vital_interest` | Art. 6(1)(d): Protection of vital interests |
| `public_interest` | Art. 6(1)(e): Public interest or official authority |
| `legitimate_interest` | Art. 6(1)(f): Legitimate interests |

## 3. Examples

### 3.1 Minimal (blog with analytics)

```json
{
  "protoconsent": "0.1",
  "purposes": {
    "functional": { "used": true, "legal_basis": "legitimate_interest" },
    "analytics": { "used": true, "legal_basis": "consent", "provider": "Plausible" }
  }
}
```

Only `functional` and `analytics` are declared. The remaining four purposes are **not declared**: the site makes no claim about them.

### 3.2 E-commerce with ads and third-party sharing

```json
{
  "protoconsent": "0.1",
  "purposes": {
    "functional": { "used": true, "legal_basis": "contractual" },
    "analytics": { "used": true, "legal_basis": "legitimate_interest", "provider": "Google Analytics" },
    "ads": { "used": true, "legal_basis": "consent", "provider": "Google Ads", "sharing": "third_parties" },
    "personalization": { "used": true, "legal_basis": "consent" },
    "third_parties": { "used": true, "legal_basis": "consent", "sharing": "third_parties" },
    "advanced_tracking": { "used": false }
  },
  "data_handling": {
    "storage_region": "eu",
    "international_transfers": true
  },
  "rights_url": "https://shop.example.com/privacy#your-rights"
}
```

### 3.3 Privacy-first site (no tracking)

```json
{
  "protoconsent": "0.1",
  "purposes": {
    "functional": { "used": true, "legal_basis": "legitimate_interest" },
    "analytics": { "used": false },
    "ads": { "used": false },
    "personalization": { "used": false },
    "third_parties": { "used": false },
    "advanced_tracking": { "used": false }
  },
  "data_handling": {
    "storage_region": "eu",
    "international_transfers": false
  }
}
```

### 3.4 Live example

A complete declaration covering all six purposes, multiple legal bases, sharing scopes, data handling, and a rights URL is published at [demo.protoconsent.org](https://demo.protoconsent.org). Install the extension and open the side panel to see it rendered with Consent Commons icons.

## 4. Extension behaviour

### 4.1 Fetching

When the user opens the side panel in the popup, the popup sends a `PROTOCONSENT_FETCH_WELL_KNOWN` message to the background script with the current site's protocol and host. The background script fetches `<protocol>://<host>/.well-known/protoconsent.json` directly from its service worker context (using the extension's `host_permissions`). Results are cached locally with a 24‑hour TTL per domain.

- If the file is not found (404), unreachable, or invalid JSON, no site declaration is shown. The negative result is cached for 6 hours to avoid repeated fetch attempts. No error is surfaced to the user.
- The extension does **not** fetch the file on every navigation: only when the user opens the side panel and the cache is expired.
- Works on both HTTP and HTTPS sites, including local development servers with non‑default ports.

### 4.2 Validation

The extension performs minimal validation:

1. `purposes` must be an object with at least one key matching a known purpose.
2. Each purpose entry must have a `used` boolean.
3. Unknown purpose keys are ignored (forward compatibility).
4. Unknown top-level fields are ignored (forward compatibility).
5. The `protoconsent` version field is accepted but not enforced (forward compatibility).

Invalid files are silently discarded.

### 4.3 Display

When a valid declaration exists, the popup shows a "Site declaration" side panel:

- Each declared purpose: label + used/not used + legal basis, provider, and sharing scope (if present), illustrated with [Consent Commons](https://consentcommons.com/) icons.
- Data handling details (storage region, international transfers) shown with corresponding Consent Commons icons when declared.
- Purposes not declared by the site are shown as "—" (not declared) in a muted style.
- If `rights_url` is present and uses `https://` or `http://`, a "Your rights" link is displayed.
- The section is purely informational. The user's toggles remain the sole control for enforcement.

### 4.4 No enforcement change

The `.well-known` file **never** modifies user preferences, DNR rules, or GPC headers. It is read-only information displayed alongside the user's own choices.

## 5. Hosting notes

### 5.1 Static sites / GitHub Pages

GitHub Pages uses Jekyll by default, which ignores directories starting with `.`. To serve the `.well-known` directory, add a `.nojekyll` file to the publication root (e.g. `docs/.nojekyll`). This disables Jekyll processing entirely.

Then place the file at `docs/.well-known/protoconsent.json` (or root, depending on publishing source). See the [protoconsent.org source](https://github.com/ProtoConsent/ProtoConsent/tree/main/docs) and [demo.protoconsent.org source](https://github.com/ProtoConsent/demo) for working examples.

### 5.2 Content-Type

The file should be served with `Content-Type: application/json`. Most web servers handle `.json` files correctly by default.

## 6. Relationship to other specifications

- **`security.txt` (RFC 9116):** similar pattern: a `.well-known` file for machine-readable site metadata. ProtoConsent follows the same convention.
- **Consent Commons:** the purpose categories and legal basis values align with the [Consent Commons](https://consentcommons.com/) taxonomy. See `icons-and-layers.md` for the visual mapping.
- **ProtoConsent SDK:** the SDK enables dynamic interaction (page queries extension). The `.well-known` file enables static declaration (extension reads site). Both are complementary: a site can use one, both, or neither.
- **GPC (`Sec-GPC`):** GPC signals user preference (browser → site). `.well-known/protoconsent.json` signals site practices (site → browser). They are complementary directions.

## 7. Online validator

An online validator is available at [protoconsent.org/validate.html](https://protoconsent.org/validate.html) to check whether a `.well-known/protoconsent.json` file is valid and reachable. It supports checking a live domain, pasting JSON, or loading a file from disk.
