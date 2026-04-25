# ProtoConsent - `.well-known/protoconsent.json` specification

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

## 1. Overview

Websites can declare their data-processing purposes by serving a static JSON file at:

```
http(s)://<host>/.well-known/protoconsent.json
```

Only `http:` and `https:` are supported. The extension uses the page's actual protocol and host when fetching the file.

This is a **voluntary, self-asserted declaration**. It does not change how the ProtoConsent extension enforces user preferences. The extension always enforces the user's own profile and toggles. Publishing a `protoconsent.json` file does not prove actual technical behavior. Consumers should treat the document as a transparency signal, not as enforcement evidence. Implementations may compare declared practices with observed traffic and surface possible mismatches.

The format follows the pattern of other `.well-known` resources ([RFC 8615](https://www.rfc-editor.org/rfc/rfc8615)), such as `security.txt` and `change-password`.

## Contents

1. [Overview](#1-overview)
2. [Schema](#2-schema)
3. [Relationship to other specifications](#3-relationship-to-other-specifications)
4. [Examples (non-normative)](#4-examples-non-normative)
5. [Implementation notes (non-normative)](#5-implementation-notes-non-normative)

## 2. Schema

### 2.1 Top-level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protoconsent` | string | yes | Protocol version. Currently `"0.2"`. |
| `purposes` | object | yes | Purpose declarations. At least one purpose must be present. |
| `data_handling` | object | no | Data storage and transfer information. |
| `links` | object | no | Related URLs. |
| `last_updated` | string (date) | no | ISO 8601 date, date only without time component (e.g. `"2026-04-13"`). When this declaration was last reviewed or updated. |

### 2.2 Purpose entry (`purposes.<key>`)

Each key must match a canonical ProtoConsent purpose (`functional`, `analytics`, `ads`, `personalization`, `third_parties`, `advanced_tracking`). Unknown keys are ignored.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `used` | boolean | yes | Whether this purpose is active on the site. |
| `legal_basis` | string | no | Legal basis invoked. See &sect;2.5. |
| `providers` | string[] | no | Names of the service providers used for this purpose (e.g. `["Plausible"]`, `["Google Ads", "Meta Pixel"]`). |
| `sharing` | string | no | Data sharing scope: `"none"`, `"within_group"`, or `"third_parties"`. |
| `retention` | object | no | Data retention period for this purpose. See &sect;2.6. |

**Three-state model:** purposes not included in the object are treated as **not declared**: the site makes no claim about them. This is distinct from `"used": false` (the site explicitly states it does not use that purpose).

The fields `legal_basis`, `providers`, `sharing`, and `retention` are only meaningful when `used` is `true`. When `used` is `false`, these fields should be omitted. Validators may warn if they are present on a `"used": false` entry.

### 2.3 Data handling (`data_handling`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storage_region` | string | no | Where user data is primarily stored. Values: ISO 3166-1 alpha-2 country code, or `"eu"`, `"eea"`, `"international"`. |
| `international_transfers` | boolean | no | Whether data is transferred outside the storage region. |

### 2.4 Links (`links`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `policy` | string (URL) | no | General privacy policy. |
| `rights` | string (URL) | no | Data subject rights section of the privacy policy. |

### 2.5 Legal basis values

Valid values for the `legal_basis` field, aligned with GDPR Article 6(1):

| Value | GDPR basis |
|-------|------------|
| `consent` | Art. 6(1)(a): Consent |
| `contractual` | Art. 6(1)(b): Performance of a contract |
| `legal_obligation` | Art. 6(1)(c): Legal obligation |
| `vital_interest` | Art. 6(1)(d): Protection of vital interests |
| `public_interest` | Art. 6(1)(e): Public interest or official authority |
| `legitimate_interest` | Art. 6(1)(f): Legitimate interests |

### 2.6 Retention

The `retention` field declares the data retention period for a purpose. It is always an object with a `type` discriminator.

| Type | Fields | Description |
|------|--------|-------------|
| `"session"` | `type` only | Data is retained only for the duration of the session. |
| `"fixed"` | `type`, `value`, `unit` | Data is retained for a specific period. |
| `"until_withdrawal"` | `type` only | Data is retained until the user withdraws consent. |

**Fixed retention fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"fixed"`. |
| `value` | integer | yes | Duration amount. Must be greater than 0. |
| `unit` | string | yes | `"days"`, `"months"`, or `"years"`. |

Examples:

```json
{ "type": "session" }
{ "type": "fixed", "value": 30, "unit": "days" }
{ "type": "fixed", "value": 2, "unit": "years" }
{ "type": "until_withdrawal" }
```

A `fixed` retention with `value: 0` is invalid. Use `"session"` instead. Both `{ "value": 365, "unit": "days" }` and `{ "value": 1, "unit": "years" }` are valid; generators should recommend the most natural unit.

### 2.7 Forward compatibility

Unknown top-level fields and unknown fields within purpose entries are silently ignored. This allows future versions to add fields without breaking existing consumers.

Consumers encountering a `protoconsent` version they do not fully support should parse the fields they recognize and ignore the rest.

## 3. Relationship to other specifications

- **`security.txt` (RFC 9116):** similar pattern: a `.well-known` file for machine-readable site metadata. ProtoConsent follows the same convention.
- **Consent Commons:** the purpose categories and legal basis values align with the [Consent Commons](https://consentcommons.com/) taxonomy. See [icons-and-layers.md](../architecture/icons-and-layers.md) for the visual mapping.
- **ProtoConsent SDK:** the SDK enables dynamic interaction (page queries extension). The `.well-known` file enables static declaration (extension reads site). Both are complementary: a site can use one, both, or neither.
- **GPC (`Sec-GPC`):** GPC signals user preference (browser to site). `.well-known/protoconsent.json` signals site practices (site to browser). They are complementary directions.

## 4. Examples (non-normative)

### 4.1 Minimal (blog with analytics)

```json
{
  "protoconsent": "0.2",
  "purposes": {
    "functional": { "used": true, "legal_basis": "legitimate_interest" },
    "analytics": {
      "used": true,
      "legal_basis": "consent",
      "providers": ["Plausible"],
      "retention": { "type": "fixed", "value": 30, "unit": "days" }
    }
  }
}
```

Only `functional` and `analytics` are declared. The remaining four purposes are **not declared**: the site makes no claim about them.

### 4.2 E-commerce with ads and third-party sharing

```json
{
  "protoconsent": "0.2",
  "last_updated": "2026-04-13",
  "purposes": {
    "functional": {
      "used": true,
      "legal_basis": "contractual",
      "retention": { "type": "session" }
    },
    "analytics": {
      "used": true,
      "legal_basis": "consent",
      "providers": ["Google Analytics"],
      "retention": { "type": "fixed", "value": 2, "unit": "years" }
    },
    "ads": {
      "used": true,
      "legal_basis": "consent",
      "providers": ["Google Ads", "Meta Pixel"],
      "sharing": "third_parties",
      "retention": { "type": "fixed", "value": 6, "unit": "months" }
    },
    "personalization": {
      "used": true,
      "legal_basis": "consent",
      "retention": { "type": "until_withdrawal" }
    },
    "third_parties": {
      "used": true,
      "legal_basis": "consent",
      "sharing": "third_parties",
      "retention": { "type": "fixed", "value": 2, "unit": "years" }
    },
    "advanced_tracking": { "used": false }
  },
  "data_handling": {
    "storage_region": "eu",
    "international_transfers": true
  },
  "links": {
    "policy": "https://shop.example.com/privacy",
    "rights": "https://shop.example.com/privacy#your-rights"
  }
}
```

### 4.3 Privacy-first site (no tracking)

```json
{
  "protoconsent": "0.2",
  "last_updated": "2026-04-13",
  "purposes": {
    "functional": {
      "used": true,
      "legal_basis": "legitimate_interest",
      "retention": { "type": "session" }
    },
    "analytics": { "used": false },
    "ads": { "used": false },
    "personalization": { "used": false },
    "third_parties": { "used": false },
    "advanced_tracking": { "used": false }
  },
  "data_handling": {
    "storage_region": "eu",
    "international_transfers": false
  },
  "links": {
    "policy": "https://privacy-first.example.com/privacy"
  }
}
```

## 5. Implementation notes (non-normative)

### 5.1 Extension behaviour

For details on how the ProtoConsent extension fetches, validates, caches, and displays `.well-known/protoconsent.json` files, see [architecture.md &sect;11](../architecture.md#11-site-declaration-behaviour).

### 5.2 Static sites / GitHub Pages

GitHub Pages uses Jekyll by default, which ignores directories whose names start with a dot, such as `.well-known`. To serve the `.well-known` directory, add a `.nojekyll` file to the publication root (e.g. `docs/.nojekyll`). This disables Jekyll processing entirely.

Then place the file at `docs/.well-known/protoconsent.json` (or root, depending on publishing source). See the [protoconsent.org source](https://github.com/ProtoConsent/ProtoConsent/tree/main/docs) and [demo.protoconsent.org source](https://github.com/ProtoConsent/demo) for working examples.

### 5.3 Content-Type

The file should be served with `Content-Type: application/json`. Most web servers handle `.json` files correctly by default.

### 5.4 Validation tooling

As a non-normative convenience, an online validator is available at [protoconsent.org/validate.html](https://protoconsent.org/validate.html) to check whether a `.well-known/protoconsent.json` file is valid and reachable. A GitHub Action ([validate-action](https://github.com/ProtoConsent/validate-action)) is also available for CI/CD validation.

## Changes from v0.1

- Added `last_updated` (top-level, optional): ISO 8601 date for declaration freshness.
- Added `links` object (top-level, optional) with `policy` and `rights` fields. Replaces `rights_url`.
- Removed `rights_url`.
- Added `providers` array (per-purpose, optional). Replaces `provider` string.
- Removed `provider`.
- Added `retention` object (per-purpose, optional): discriminated union with types `session`, `fixed`, and `until_withdrawal`.
- Added self-asserted declaration note in Overview.
- Added forward compatibility section (&sect;2.7).
- Added guidance that `legal_basis`, `providers`, `sharing`, and `retention` are only meaningful when `used` is `true`.
