# ProtoConsent – `.well-known/protoconsent.json` specification

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

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
3. [Examples (non-normative)](#3-examples-non-normative)
4. [Extension behaviour (non-normative)](#4-extension-behaviour-non-normative)
5. [Relationship to other specifications](#5-relationship-to-other-specifications)
6. [Implementation notes (non-normative)](#6-implementation-notes-non-normative)

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

## 3. Examples (non-normative)

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

## 4. Extension behaviour (non-normative)

For details on how the ProtoConsent extension fetches, validates, caches, and displays `.well-known/protoconsent.json` files, see [architecture.md §11](../architecture.md#11-site-declaration-behaviour).

## 5. Relationship to other specifications

- **`security.txt` (RFC 9116):** similar pattern: a `.well-known` file for machine-readable site metadata. ProtoConsent follows the same convention.
- **Consent Commons:** the purpose categories and legal basis values align with the [Consent Commons](https://consentcommons.com/) taxonomy. See `icons-and-layers.md` for the visual mapping.
- **ProtoConsent SDK:** the SDK enables dynamic interaction (page queries extension). The `.well-known` file enables static declaration (extension reads site). Both are complementary: a site can use one, both, or neither.
- **GPC (`Sec-GPC`):** GPC signals user preference (browser → site). `.well-known/protoconsent.json` signals site practices (site → browser). They are complementary directions.

## 6. Implementation notes (non-normative)

### 6.1 Static sites / GitHub Pages

GitHub Pages uses Jekyll by default, which ignores directories whose names start with a dot, such as `.well-known`. To serve the `.well-known` directory, add a `.nojekyll` file to the publication root (e.g. `docs/.nojekyll`). This disables Jekyll processing entirely.

Then place the file at `docs/.well-known/protoconsent.json` (or root, depending on publishing source). See the [protoconsent.org source](https://github.com/ProtoConsent/ProtoConsent/tree/main/docs) and [demo.protoconsent.org source](https://github.com/ProtoConsent/demo) for working examples.

### 6.2 Content-Type

The file should be served with `Content-Type: application/json`. Most web servers handle `.json` files correctly by default.

### 6.3 Validation tooling

As a non-normative convenience, an online validator is available at [protoconsent.org/validate.html](https://protoconsent.org/validate.html) to check whether a `.well-known/protoconsent.json` file is valid and reachable.

