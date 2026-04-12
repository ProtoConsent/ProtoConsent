# CMP auto-response

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

CMP auto-response is ProtoConsent's mechanism for translating the user's purpose preferences into the consent cookies that consent management platforms (CMPs) read on page load. When a page loads, ProtoConsent injects the appropriate consent cookies *before* any CMP script runs, so the CMP reads those cookies and skips the consent banner entirely. The user's preferences are enforced without interacting with the banner.

This is a declarative approach: ProtoConsent writes the data that the CMP expects to find, and the CMP treats the user as already having responded. No DOM interaction, no click simulation, no waiting for the banner to render.

## 2. Architecture

The system has two components:

```
background/cmp-injection.js          content-scripts/cmp-inject.js
(ES module, service worker)          (content script, ISOLATED world, document_start)
                                      
  ┌──────────────────────┐              ┌──────────────────────────────────┐
  │ updateCmpInjection   │              │ 1. Read storage (signatures,     │
  │ Data()               │              │    purposes, TC String)          │
  │                      │  storage     │ 2. Cookie injection              │
  │ - Load signatures    │ ─────────>   │ 3. Cosmetic CSS (safety net)     │
  │ - Compute TC String  │              │ 4. Scroll unlock                 │
  │ - Write purposes     │              │ 5. Cleanup (delete cookies)      │
  └──────────────────────┘              └──────────────────────────────────┘
```

**Background** (`cmp-injection.js`): Loads `cmp-signatures.json`, computes the IAB TCF v2.2 TC String from the user's global purposes, and writes everything to `chrome.storage.local` so the content script can read it synchronously at `document_start`.

**Content script** (`cmp-inject.js`): Runs at `document_start` in ISOLATED world. Reads signatures and purposes from storage, then executes three layers of response:

1. **Cookie injection** - writes consent cookies using signature templates
2. **Cosmetic CSS** - injects `display:none!important` rules targeting known banner selectors
3. **Scroll unlock** - removes scroll lock (CSS classes or inline styles) that CMPs apply to prevent scrolling until consent is given

## 3. CMP signatures

Signatures are defined in `config/cmp-signatures.json`. Each entry describes how a specific CMP stores and displays consent:

```json
{
  "onetrust": {
    "cookie": [
      {
        "name": "OptanonConsent",
        "template": "...groups=1%3A1%2C2%3A{analytics}%2C3%3A{personalization}%2C4%3A{ads}..."
      },
      {
        "name": "OptanonAlertBoxClosed",
        "template": "{DATE_ISO}"
      }
    ],
    "purposeMap": {
      "analytics": "2",
      "personalization": "3",
      "ads": "4"
    },
    "format": { "allow": "1", "deny": "0" },
    "selector": "#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter",
    "lockClass": "ot-sdk-show-settings"
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cookie` | array | Yes | One or more cookies to inject. Each has `name` and `template`. |
| `cookie[].template` | string | Yes | Cookie value with placeholders: `{analytics}`, `{ads}`, `{personalization}`, `{third_parties}`, `{gpc}`, `{DATE_ISO}`, `{DATESTAMP_ENCODED}`, `{UUID}`, `{TIMESTAMP}`, `{STAMP}`, `{TC_STRING}`. |
| `cookie[].siteSpecific` | boolean | No | If true, cookie requires site-specific data that cannot be templated. Cosmetic-only fallback. |
| `purposeMap` | object | No | Maps ProtoConsent purpose keys to CMP-specific purpose identifiers. Informational. |
| `format` | object | No | `{ "allow": "...", "deny": "..." }` - the string values that replace purpose placeholders. Default: `{ "allow": "1", "deny": "0" }`. |
| `selector` | string\|null | No | CSS selector(s) for the CMP banner and overlay elements. Used by cosmetic CSS layer. |
| `lockClass` | string\|null | No | CSS class the CMP adds to `body` or `html` to prevent scrolling. |
| `domains` | string[] | No | If present, signature only applies to these domains/brands. Matched against the registrable domain and its brand (first label). Signatures without `domains` apply globally. |
| `note` | string | No | Internal documentation about the CMP's behaviour or limitations. |

### Supported CMPs (22)

| CMP | Cookie(s) | Format | Scope |
|-----|-----------|--------|-------|
| OneTrust | `OptanonConsent`, `OptanonAlertBoxClosed` | purpose groups 1-4, 1/0 | Global |
| Cookiebot | `CookieConsent` | necessary/preferences/statistics/marketing, true/false | Global |
| Sourcepoint | `consentUUID` | UUID only | Global |
| Didomi | `didomi_token` | Site-specific (cosmetic fallback) | Global |
| Quantcast | `addtl_consent` | Google AC String | Global |
| TrustArc | `notice_preferences`, `cmapi_cookie_privacy`, `notice_gdpr_pr498` | Minimal consent | Global |
| ConsentManager | `cmpvendorconsent`, `cmpconsent` | Presence-only | Global |
| IAB TCF v2.2 | `euconsent-v2` | Full TC String (generated) | Global |
| Iubenda | `_iub_cs-s` | Presence-only | Global |
| CookieYes | `cookieyes-consent`, `wt_consent`, `cookielawinfo-checkbox-*`, `viewed_cookie_policy` | Per-category yes/no | Global |
| Complianz | `cmplz_functional`, `cmplz_statistics`, `cmplz_marketing`, `cmplz_preferences`, `cmplz_banner-status` | allow/deny per purpose | Global |
| Borlabs | (cosmetic only) | - | Global |
| Termly | (cosmetic only) | - | Global |
| Axeptio | (cosmetic only) | - | Global |
| Osano | `osano_consentmanager` | Presence-only | Global |
| Sirdata | (cosmetic only) | - | Global |
| Civic | (cosmetic only) | - | Global |
| CCM19 | (cosmetic only) | localStorage-based | Global |
| Amasty | `amcookie_policy_restriction`, `amcookie_allowed` | allowed/-1 | Global |
| Wix | `consent-policy` | URL-encoded JSON with ess/func/anl/adv/dt3 | Global |
| Fides | `fides_consent` | URL-encoded JSON with consent/identity/meta | Global |
| Bing/Microsoft | `BCP` | `AD={ads}&AL={analytics}&SM={personalization}`, 1/0 | bing, microsoft, outlook, live, msn |

### Signature types

Based on cookie support, signatures fall into three categories:

- **Full cookie injection**: Template produces a valid cookie that the CMP reads and accepts (OneTrust, Cookiebot, CookieYes, Complianz, Wix, Fides, Bing). Banner suppressed at the source.
- **Presence/minimal injection**: Cookie signals "consent given" but lacks full purpose mapping (Sourcepoint, TrustArc, Quantcast, ConsentManager, Osano, Amasty). CMP may still initialize but skips the banner.
- **Cosmetic only**: No injectable cookie (localStorage-based, site-specific, or no known format). Banner is hidden via CSS. (Borlabs, Termly, Axeptio, Sirdata, Civic, CCM19, Didomi).

## 4. TC String (IAB TCF v2.2)

For CMPs that read the `euconsent-v2` cookie (the IAB Transparency and Consent Framework standard), ProtoConsent generates a valid TC String in `background/cmp-injection.js`.

### Purpose mapping

| ProtoConsent purpose | TCF purpose IDs | TCF purpose names |
|---------------------|-----------------|-------------------|
| functional | 1 | Store and/or access information on a device |
| ads | 2, 3, 4, 7 | Basic ads, Create ads profile, Show personalized ads, Measure ad performance |
| analytics | 8, 9 | Measure content performance, Apply market research |
| personalization | 5, 6 | Create content profile, Show personalized content |

TCF purpose 10 (Develop and improve products) is not mapped and defaults to denied (0).

### Legitimate Interest transparency

TCF v2.2 restricts purposes 3-6 from using legitimate interest as a legal basis. The TC String sets LI transparency bits only for purposes that:
- Are denied by the user, AND
- Are not in the LI-forbidden set (3, 4, 5, 6)

### Structure

The TC String consists of two segments separated by `.`:

1. **Core segment** (213+ bits): version, timestamps, CMP metadata, 24 purpose consent bits, 24 LI transparency bits, publisher country, vendor consent (empty), vendor LI (empty), publisher restrictions (none).
2. **Disclosed Vendors segment** (type 1): empty (no specific vendors disclosed).

Fixed values:
- `CmpId = 1` (placeholder - ProtoConsent has no registered IAB CMP ID)
- `CmpVersion = 1`
- `VendorListVersion = 1`
- `TcfPolicyVersion = 4` (TCF v2.2)
- `IsServiceSpecific = true`
- `ConsentLanguage = EN`

### Encoding

Bits are packed manually (no dependencies) and encoded to base64url using the TCF alphabet (`A-Za-z0-9-_`). No external libraries.

## 5. Three-layer response

### Layer 1: Cookie injection

For each applicable signature, the content script:
1. Resolves template placeholders with user purposes (`{analytics}` -> `"1"` or `"0"`)
2. Replaces utility placeholders (`{DATE_ISO}`, `{UUID}`, `{TIMESTAMP}`, `{TC_STRING}`)
3. Sanitizes the value (strips semicolons to prevent cookie attribute injection)
4. Writes the cookie with `path=/; domain=.{registrable}; SameSite=Lax; max-age={maxAge}`

A persistent UUID is maintained across page loads so CMPs see a consistent identity.

**Cookie cleanup**: Injected cookies are deleted after `CMP_CLEANUP_DELAY` (5 seconds). CMPs read their cookies synchronously during script initialization (first 1-2 seconds). Deleting the cookies afterwards reduces HTTP overhead on subsequent same-domain requests (images, XHR, lazy loads). Cookies are re-injected on the next navigation via `document_start`.

### Layer 2: Cosmetic CSS

All applicable `selector` values are joined and injected as a `<style data-pc-cmp>` element:

```css
#onetrust-banner-sdk, .qc-cmp2-container, ... { display: none !important }
```

This is a safety net for cases where cookie injection is late or incomplete.

### Layer 3: Scroll unlock

CMPs typically lock page scrolling while the banner is visible, using either:
- A CSS class on `body` or `html` (e.g., `ot-sdk-show-settings`, `fides-no-scroll`)
- Inline styles (`overflow: hidden`, `position: fixed`)

The content script:
1. Injects CSS rules targeting known lock classes
2. Applies inline `!important` overrides for `overflow` and `position` when lock patterns are detected
3. Watches for CMP re-locking attempts via `MutationObserver` for `CMP_ENFORCE_TIMEOUT` (10 seconds)

A `MutationObserver` detects dynamically injected banners (CMPs load after `document_start`) with a safety timeout of `CMP_OBSERVER_TIMEOUT` (15 seconds).

## 6. Domain scoping

Signatures can be scoped to specific domains via the `domains` field. The content script extracts the registrable domain and brand from `location.hostname`:

```
location.hostname = "www.bing.com"
registrable domain = "bing.com"
brand = "bing"
```

A signature matches if any entry in `domains` equals the registrable domain OR the brand. This allows `"domains": ["bing", "microsoft"]` to match `bing.com`, `bing.co.uk`, `microsoft.com`, etc.

Signatures without `domains` apply to all sites (standard CMPs like OneTrust, Cookiebot, etc.).

## 7. User controls

CMP auto-response is controlled from **Purpose Settings** (right-click extension icon → Options, or click **Purpose Settings** in the popup). The following storage keys back the UI:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cmpAutoResponse` | boolean | `true` | Master toggle. Set to `false` to disable all CMP injection. |
| `cmpEnabled` | object | `{}` | Per-CMP toggles. `{ "onetrust": false }` disables OneTrust specifically. |
| `cmpCookieMaxAge` | number | `7776000` (90 days) | Cookie expiration in seconds. |
| `cmpCustomUuid` | string | `null` | User-provided UUID override for consent cookies. |

For testing instructions, see [testing-guide.md, section 16](testing-guide.md#16-testing-cmp-auto-response).

## 8. Constants

Content script (`cmp-inject.js`):

| Constant | Value | Description |
|----------|-------|-------------|
| `CMP_DEFAULT_MAX_AGE` | `7776000` | Default cookie max-age: 90 days (seconds) |
| `CMP_CLEANUP_DELAY` | `5000` | Delay before deleting injected cookies (ms) |
| `CMP_ENFORCE_TIMEOUT` | `10000` | Duration of scroll re-lock enforcement (ms) |
| `CMP_OBSERVER_TIMEOUT` | `15000` | Safety limit for banner detection observer (ms) |

Background (`cmp-injection.js`):

| Constant | Value | Description |
|----------|-------|-------------|
| `TCF_CMP_ID` | `1` | Placeholder CMP ID (no registered IAB ID) |
| `TCF_CMP_VERSION` | `1` | CMP version |
| `TCF_VENDOR_LIST_VERSION` | `1` | Minimal vendor list version |
| `TCF_POLICY_VERSION` | `4` | TCF v2.2 policy version |

## 9. Limitations and known paths

### 9.1 Current limitations

- **ISOLATED world**: The content script currently runs in Chrome's ISOLATED world, which cannot access the page's JavaScript context. This means `window.__tcfapi`, `localStorage`, and `window.__cmp` are not reachable. CMPs that store consent exclusively in localStorage (like CCM19) fall back to cosmetic hiding, and third-party scripts that call `__tcfapi` instead of reading the cookie will not receive a response. MAIN world injection resolves this (see [9.2](#92-known-solutions)).
- **No click simulation**: ProtoConsent does not simulate clicks on banner buttons. This is a deliberate design choice -- the extension declares consent via data, not interaction.
- **CMP-specific cookies**: Some CMPs (like Didomi) use site-specific tokens that cannot be templated. These fall back to cosmetic hiding.
- **Proprietary consent systems**: Sites with fully custom consent systems (not using any standard CMP) are not covered. The signature approach targets widely-deployed CMP frameworks.
- **TC String vendor sections**: The generated TC String has empty vendor consent and disclosed vendor sections. CMPs that check for specific vendor IDs may not fully accept it, though in practice CMPs read the purpose bits.

### 9.2 Known solutions

**MAIN world injection**: Manifest V3 supports `"world": "MAIN"` for content scripts, which runs in the page's JavaScript context. This would allow:
- Injecting `window.__tcfapi` so third-party scripts receive proper TCF callbacks
- Writing to `localStorage` for CMPs that use it exclusively (CCM19, some Didomi configurations)
- Populating `window.__cmp` (legacy TCF v1.1 API) for older sites

MAIN world access is the known resolution for the ISOLATED world limitations. The current ISOLATED approach was chosen because it requires no page-context trust and avoids interference with page scripts. Adding a MAIN world script requires only a manifest entry and a new file -- the rest of the pipeline (signatures, storage, cookie injection) remains unchanged.

### 9.3 Notable exceptions

**Google (SOCS cookie)**: Google's consent cookie uses Protocol Buffers encoding with a GWS server version field (e.g., `gws_20260408-0_RC1`) that appears to be tied to server deployments and cannot be predicted or templated. The banner DOM uses Closure Compiler-minified class names that are also unstable across deploys. Neither the cookie nor the selectors can be reliably templated. This has been investigated and documented; it remains an open problem.

**Consent walls**: Some sites (e.g., Le Figaro) offer no "reject" option -- only "accept cookies" or "subscribe". These are pay-or-consent walls where the consent mechanism is deliberately tied to a paywall. Cookie injection cannot bypass a paywall, which is by design: ProtoConsent expresses user preferences, it does not circumvent access controls.

## 10. Comparison with other approaches

| | ProtoConsent | Click-based extensions | Content blockers (uBlock, etc.) |
|---|---|---|---|
| **Mechanism** | Cookie injection at `document_start` | DOM interaction (simulate clicks on banner buttons) | Block CMP script entirely |
| **Timing** | Before CMP loads (preventive) | After banner renders (reactive) | Before CMP loads (preventive) |
| **Banner appears** | No (cookie pre-empts it) | Briefly (until click fires) | No (script blocked) |
| **CMP reads preferences** | Yes (from injected cookie) | Yes (via its own UI flow) | No (CMP never loads) |
| **`__tcfapi` available** | Not yet (ISOLATED world) | Yes (CMP creates it) | No (CMP blocked) |
| **Purpose-level control** | Yes (per-purpose consent values) | Varies (most are all-or-nothing) | No (binary block/allow) |
| **Maintenance model** | Signature JSON per CMP | CSS selectors + click targets per CMP | Filter lists (domain-based) |
| **Breakage risk** | Low (CMP sees valid consent) | Medium (DOM changes break selectors) | High (consent wall, `__tcfapi` undefined) |
| **Dark pattern risk** | None (no interaction to misinterpret) | A failed or partial click can be treated by the CMP as implicit consent | None (CMP never loads) |

## 11. Interaction with TCF detection

CMP auto-response and TCF detection are independent systems. Auto-response injects cookies at `document_start` in ISOLATED world. TCF detection (`tcf-detect.js`) runs in MAIN world and reads the CMP's JavaScript API (`__tcfapi`). The cookie and the JavaScript API are separate interfaces maintained by the CMP.

The TCF pill in the popup shows the site's own consent status as reported by its CMP, not the state applied by ProtoConsent.

## 12. Files

| File | Role |
|------|------|
| `config/cmp-signatures.json` | CMP signature definitions (22 entries) |
| `background/cmp-injection.js` | TC String generator + storage writer |
| `content-scripts/cmp-inject.js` | Content script: cookie injection, cosmetic CSS, scroll unlock |
| `manifest.json` | Registers `cmp-inject.js` as content script at `document_start` |
