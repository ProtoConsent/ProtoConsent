# ProtoConsent: Technical architecture

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent is a client‑side system that adds purpose‑based privacy controls to the browser. It is implemented as a browser extension that stores all user rules locally and uses standard browser capabilities to enforce them. There is no central server: everything happens on the user’s device.

The extension provides a popup interface to manage profiles and purposes per site, and a background component that translates those choices into declarative network rules. A JavaScript SDK and a content script bridge allow websites to read the user’s choices and adapt accordingly.

## Contents

- [ProtoConsent: Technical architecture](#protoconsent-technical-architecture)
  - [1. Overview](#1-overview)
  - [Contents](#contents)
  - [2. Components](#2-components)
  - [3. Data model](#3-data-model)
  - [4. Main flows](#4-main-flows)
  - [5. Security and privacy by design](#5-security-and-privacy-by-design)
  - [6. Permissions rationale](#6-permissions-rationale)
  - [7. Chrome declarativeNetRequest: priority and limits](#7-chrome-declarativenetrequest-priority-and-limits)
    - [Priority resolution](#priority-resolution)
    - [`requestDomains` matching](#requestdomains-matching)
    - [`initiatorDomains` matching](#initiatordomains-matching)
    - [Resource limits](#resource-limits)
  - [8. Design decisions](#8-design-decisions)
    - [Advanced tracking is always blocked](#advanced-tracking-is-always-blocked)
    - [Iframe initiator behaviour](#iframe-initiator-behaviour)
    - [Override grouping for scalability](#override-grouping-for-scalability)
    - [`main_frame` exclusion](#main_frame-exclusion)
    - [Path‑domain filtering in block overrides](#pathdomain-filtering-in-block-overrides)
  - [9. Extensibility](#9-extensibility)
  - [10. Global Privacy Control (GPC)](#10-global-privacy-control-gpc)
    - [Relation to the GPC specification](#relation-to-the-gpc-specification)

## 2. Components

**Popup UI** – The main user‑facing element. When opened on a site, it shows the active profile and purpose states for that domain, and lets the user switch profiles or toggle purposes. Purpose categories are shown with [Consent Commons](https://consentcommons.com/) icons for visual clarity. When a site publishes a `.well-known/protoconsent.json` declaration, the popup displays it in a collapsible side panel with icons for legal basis, sharing and international transfers. A mode rail organises the interface into three views. The Consent view shows purpose toggles and per‑purpose blocked stats. The Enhanced view manages optional third‑party blocklists with preset selection and per‑list controls. The Log view provides real‑time request monitoring, blocked domains grouped by purpose, and GPC signal tracking per domain. The popup does not enforce anything directly; it sends messages to the background component when settings change.

**Background script (service worker)** – Maintains per‑site rules, computes defaults for new domains, and translates user choices into declarative network rules. Also handles `.well-known/protoconsent.json` fetches on behalf of the popup: when the user opens the side panel, the popup sends a message to the background, which fetches the declaration from the site's origin and returns it for rendering.

**Local storage** – All configuration lives in the browser’s extension storage: the mapping from domains to site rules (profile plus purpose overrides), predefined profiles, the domain whitelist, and Enhanced Protection state (list metadata in `enhancedLists`, heavy domain/path data in `enhancedData_{listId}` keys, active preset in `enhancedPreset`).

**Enforcement (declarativeNetRequest + GPC)** – The background component uses a two‑tier rule model to balance scalability with flexibility:

*Static rulesets* handle global blocking. Each of the five blocking purposes (analytics, ads, personalization, third\_parties, advanced\_tracking) has two static rulesets declared in the manifest: one for domain‑based rules (`block_ads.json`) and one for path‑based rules (`block_ads_paths.json`). All start disabled; the background script enables or disables each ruleset based on the user's global profile. Because static rulesets draw from a separate Chrome‑managed pool (up to 30,000 rules), they leave the dynamic rule budget available for per‑site customisation.

```text
Static rulesets (30,000 rule pool)
┌──────────────────────┐  ┌──────────────────────────┐
│ block_ads            │  │ block_ads_paths          │
│ 1 rule, 12904 domains│  │ 529 rules, urlFilter each│
│ requestDomains       │  │ e.g. ||google.com/adsense│
│ priority 1           │  │ priority 1               │
└──────────────────────┘  └──────────────────────────┘
     × 5 categories              × 5 categories

Dynamic rules (5,000 rule pool)
┌──────────────────────────────────────────────┐
│ Per-site overrides: max 10 rules (priority 2)│
│ Enhanced lists:     N rules     (priority 2) │
│ Whitelist allow:    1+ rules    (priority 3) │
│ GPC global: 1 rule              (priority 1) │
│ GPC per-site: max 2 rules       (priority 2) │
│ CH strip global: 1 rule         (priority 1) │
│ CH strip per-site: max 1 rule   (priority 2) │
└──────────────────────────────────────────────┘
```

*Domain‑based rules* use a single rule per category with a `requestDomains` array listing all tracker domains for that purpose. Chrome matches subdomains automatically, so listing `doubleclick.net` also blocks `static.doubleclick.net`.

*Path‑based rules* complement domain rules for high‑value domains that cannot be blocked entirely: `google.com`, `facebook.com`, or `linkedin.com`. These rules use `urlFilter` patterns (e.g. `||google.com/pagead/`, `||facebook.com/tr/`) to block specific tracking endpoints while allowing the rest of the domain. See [blocklists.md](blocklists.md) §6 for details.

*Dynamic rules* handle per‑site customisation and Enhanced Protection. When a user configures a site differently from the global profile, the background script creates override rules at priority 2 that take precedence over the static rules at priority 1. Overrides are grouped by (category, action) rather than by site: one "allow ads" rule covers all permissive sites via `initiatorDomains`, keeping the dynamic rule count constant regardless of how many custom sites exist. Enhanced Protection lists also produce dynamic block rules at priority 2 - one domain rule and optional path rules per enabled list. Sites where all purposes are allowed are excluded from enhanced blocking via `excludedInitiatorDomains`. This design supports hundreds of custom sites and multiple enhanced lists within Chrome's 5,000 dynamic rule limit.

*Whitelist allow rules* let users unblock specific domains that were caught by the static rulesets. These rules use priority 3, so they always win over both static blocks (priority 1) and per‑site overrides (priority 2). Each entry can be scoped per site (using `initiatorDomains`) or global (no initiator filter). Global entries are batched into a single rule; per‑site entries are grouped by site, one rule per unique site. Domain validation prevents invalid hostnames from entering storage or DNR rules, and storage writes are serialized to avoid concurrent conflicts.

*Global Privacy Control (GPC)* is managed by ProtoConsent. When privacy‑relevant purposes (marked with `triggers_gpc` in `config/purposes.json`) are denied, the extension injects a conditional `Sec-GPC: 1` header via `modifyHeaders` rules and sets `navigator.globalPrivacyControl` via a MAIN‑world content script, signalling the user's opt‑out to the receiving server. Per‑site overrides ensure that GPC is only sent where the user's preferences call for it. Users can also disable GPC entirely via a global toggle in Purpose Settings (`gpcEnabled` in storage, default `true`); when off, no GPC headers or content scripts are generated regardless of purpose state.

Per‑site GPC overrides use `requestDomains` (the destination URL), not `initiatorDomains` (the page making the request). This means that trusting a site, for example allowing all purposes on elpais.com, removes the GPC signal from requests *to* elpais.com, but third‑party requests *from* elpais.com to domains like google‑analytics.com still carry the global GPC signal. The same applies to cross‑origin iframes: an iframe from youtube.com embedded on a trusted elpais.com page still receives GPC from the global rule.

*Client Hint headers* are handled automatically when the `advanced_tracking` purpose is denied. In that case, the extension strips high‑entropy Client Hints headers (`Sec-CH-UA-Full-Version-List`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Bitness`, `Sec-CH-UA-Model`, `Sec-CH-UA-WoW64`, `Sec-CH-UA-Form-Factors`) via `modifyHeaders` remove rules. These headers expose enough device information (~33 bits of entropy) to uniquely fingerprint a user. Low‑entropy hints (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`) are kept intact as they are needed for basic content negotiation and have minimal fingerprinting value. Firefox and Safari do not send Client Hints at all, so removing them causes no site breakage. Like GPC, Client Hints stripping has a global toggle in Purpose Settings (`chStrippingEnabled` in storage, default `true`); when off, no stripping rules are generated regardless of purpose state. Per‑site exceptions use `excludedRequestDomains` on the global rule rather than a separate override, because a native browser header cannot be "un-removed" by a higher‑priority rule.

**Content script bridge** – A content script (`content-script.js`) declared in the manifest runs in the ISOLATED world on every page. It acts as a message bridge between the page‑level SDK and the extension’s background: it listens for `PROTOCONSENT_QUERY` messages from the page, forwards them to the background via `chrome.runtime.sendMessage`, and relays the response back. It also forwards `PROTOCONSENT_TCF_DETECTED` messages from the TCF detection script to the background. It does not access or modify page content.

**TCF detection script** – A MAIN‑world content script (`tcf-detect.js`) that probes for the IAB TCF `__tcfapi` function on the page. When a consent management platform (CMP) is found, the script calls `getTCData` to retrieve the CMP’s identity and purpose consent state, then sends a `PROTOCONSENT_TCF_DETECTED` message via `window.postMessage` (using `window.location.origin` as the target origin). The content script bridge picks it up and forwards it to the background, which validates and stores the data per tab in memory and `chrome.storage.session`. The popup displays the CMP info in a pill indicator and expandable side panel, so users can compare the site banner’s consent state with ProtoConsent’s enforcement. Probing retries at 200, 600, 1500, 3000 and 5000 ms to handle asynchronously loaded CMPs.

**protoconsent.js SDK** – A small, optional JavaScript library for web pages to read the user’s ProtoConsent preferences (e.g. whether analytics is allowed) via the content script bridge. The extension works without it; the SDK is for sites that want to adapt their behaviour to the user’s choices. TypeScript type declarations are also provided (`sdk/protoconsent.d.ts`).

**Onboarding and purpose settings pages** – Two additional extension pages complement the popup. The onboarding page (`pages/onboarding.html`) opens on first install and guides new users through selecting a default privacy profile. The purpose settings page (`pages/purposes-settings.html`) lets users customise the global default profile by toggling individual purposes, and shows the active Enhanced Protection preset alongside the consent presets. Accessible from the popup or `chrome://extensions`.

![ProtoConsent technical diagram](assets/diagrams/protoconsent-technical-diagram.png)

## 3. Data model

For each domain, the extension stores a rule that combines a profile with purpose‑level overrides:

`rules[domain] = { profile, purposes: { functional, analytics, ads, personalization, third_parties, advanced_tracking } }`

where each purpose resolves to “allowed” or “denied”. By default, all purpose values are inherited from the active profile (preset). When the user overrides a specific purpose for a domain, only that override is stored; the rest continue to inherit from the profile. In storage, purpose values are booleans (`true` = allowed, `false` = denied). All data is stored locally in the browser’s extension storage in a compact format.

The domain whitelist is stored separately under a `whitelist` key:

`whitelist[domain] = { site: purpose, ... }`

where each key is either a hostname (per‑site scope) or `”*”` (global scope), and the value is the purpose category that was originally blocked. This structure allows the same domain to be whitelisted globally on one scope and per‑site on another, though the UI prevents conflicting entries.

Three predefined profiles (“Strict”, “Balanced”, “Permissive”) map directly to purpose states and act as templates. When the user selects a profile, its values fill in the purposes; any per‑purpose change after that is tracked as an explicit override.

## 4. Main flows

**User updates settings for a site** – The user opens the popup, changes the profile or individual purposes. The popup sends an update to the background, which saves the new rule and rebuilds the declarative network rules. Changes take effect immediately for new requests, usually without a page reload.

**Page loads and makes network requests** – As the user navigates, third‑party requests are evaluated against the active rules for the current site. Requests tied to disabled purposes are blocked by the browser’s declarative rules; allowed purposes proceed normally.

**Page reads preferences via SDK** – On sites that integrate the optional SDK, page code can query the user’s preferences (e.g. `get("analytics")`) and decide whether to load scripts or simplify consent prompts. This complements browser‑level enforcement; it does not replace it. A live test is available on [protoconsent.org](https://protoconsent.org/) and [demo.protoconsent.org](https://demo.protoconsent.org).

**Extension reads site declaration** – When the user opens the side panel in the popup, the popup sends a `PROTOCONSENT_FETCH_WELL_KNOWN` message to the background script, which fetches `<protocol>://<host>/.well-known/protoconsent.json` from the current site’s origin. If a valid declaration is found, the popup renders it in a collapsible side panel with Consent Commons icons for purposes, legal basis, sharing scope, and data handling. The declaration is cached (24 hours on success, 6 hours on failure) to avoid repeated fetches. The fetch uses the page’s actual protocol and host (including port), so it works on both production sites and local development servers.

**Real‑time log monitoring** – When the user switches to the Log tab, the popup opens a persistent `chrome.runtime.connect` port (named `"log"`) to the background script. The background pushes `block` and `gpc` events through this port as they happen, and the popup appends timestamped entries to the Requests panel. Historical data (blocked domains by purpose and GPC signals) is replayed from the background’s in‑memory state when the panel first renders. The Domains panel shows a flat table of blocked domains grouped by purpose with Consent Commons icons, and the GPC panel lists domains that received `Sec‑GPC: 1` with request counts and first/last‑seen timestamps. All panels include a copy‑to‑clipboard button that formats content appropriately (plain text for console panels, tab‑separated text for tables).

The background detects blocked requests via `webRequest.onErrorOccurred` (filtering for `ERR_BLOCKED_BY_CLIENT`) and GPC signals via `webRequest.onSendHeaders` (checking for `Sec-GPC: 1` in final headers). Purpose attribution uses a reverse hostname index (~40K entries) built from the static blocklists, with subdomain walk‑up matching. A GPC configuration snapshot (global active flag, per‑site add/remove sets) filters out native browser GPC to avoid double‑counting. In developer mode (unpacked extension), a more precise API (`onRuleMatchedDebug`) is available that provides exact rule‑to‑request attribution; the extension uses it automatically when present, falling back to the `webRequest` path otherwise. Both paths feed into the same data structures and message format, so the popup and log UI show the same data regardless of build type.

The badge counter on the extension icon shows the per‑tab blocked request count, derived from the same data used by the popup and log. Because Chrome‑persisted rule match counts (`getMatchedRules`) and the real‑time listener (in‑memory) may diverge when the service worker sleeps through events, the log UI uses `getMatchedRules` as the authoritative total and transparently notes any gap (e.g. "42 blocked requests across 3 categories (2 not captured)").

**First‑time onboarding** – On first install (when no default profile exists in storage), the background script opens the onboarding page. The user selects a profile (Strict, Balanced, or Permissive), which is saved as the global default. All sites then inherit this profile until the user creates per‑site overrides.

**Cookie banner detection (TCF)** – When a page loads, the MAIN‑world `tcf-detect.js` script probes for the IAB TCF `__tcfapi` function. If found, it reads the CMP's identity and purpose consent state via `getTCData` and posts a message to the content script bridge, which forwards it to the background. The background validates the data (numeric ranges, boolean values, entry count limits) and stores it per tab in `tabTcfData` (in‑memory Map) and `chrome.storage.session` (keyed as `tcf_{tabId}`) for service worker restart resilience. When the popup opens, it queries the background for TCF data: if present, a pill indicator appears next to the site declaration area, and clicking it reveals a side panel showing the CMP provider, purpose consent details, and a note that ProtoConsent enforces preferences independently. TCF data is cleared on navigation (both full page loads and SPA pushState changes detected via `tabs.onUpdated` URL comparison) and on tab close. Orphan session keys are pruned during service worker restore.

## 5. Security and privacy by design

All configuration is stored locally. The extension requests only the permissions it needs (see §6 for the full rationale) and keeps a clear separation between UI and enforcement logic.

Enforcement is based on built‑in browser APIs (declarativeNetRequest), so ProtoConsent benefits from the browser’s own sandboxing and update mechanisms. The data model is intentionally small, which makes edge cases easier to audit.

## 6. Permissions rationale

| Permission | Why it is needed |
| --- | --- |
| `tabs` | Read the active tab's URL so the popup can identify which domain the user is managing and apply per‑site rules. |
| `storage` | Persist user rules, profiles, and preferences locally in the browser's extension storage. No remote storage is used. |
| `scripting` | Register the GPC content script (`gpc-signal.js`) into the MAIN world at runtime via `chrome.scripting.registerContentScripts`, so that `navigator.globalPrivacyControl` is set only on pages where the user's preferences require it. |
| `declarativeNetRequest` | Create and manage dynamic blocking rules that enforce the user's purpose choices by blocking third‑party requests associated with denied purposes. Also used for conditional `Sec-GPC: 1` header injection and high‑entropy Client Hints stripping via `modifyHeaders` rules. |
| `declarativeNetRequestFeedback` | Query which DNR rules matched on the current tab (`getMatchedRules`) so the popup can display how many requests were blocked and how many received the GPC signal. |
| `webRequest` | Observe network events (`onErrorOccurred`, `onSendHeaders`) to attribute blocked requests to purposes and detect GPC header presence. This is the default data source in all builds; an optional DNR debug mode can be activated for rule‑level diagnostics during development (see `USE_DNR_DEBUG` in `config.js`). |
| `unlimitedStorage` | Store downloaded Enhanced Protection blocklist data locally. Enhanced lists can be large (hundreds of thousands of domains), so the default 10 MB quota may not suffice. |
| `host_permissions: <all_urls>` | Required by `declarativeNetRequest` to apply blocking and header rules across all domains, by `scripting` to inject the GPC content script on any site, and by `webRequest` to observe network events on all origins. Without broad host access, per‑site enforcement would not work. |

## 7. Chrome declarativeNetRequest: priority and limits

ProtoConsent's enforcement relies on Chrome's `declarativeNetRequest` API. Its priority model determines how rules interact.

### Priority resolution

When multiple rules match the same request, Chrome applies the following precedence:

1. Higher priority number wins (priority 2 beats priority 1).
2. At the same priority, dynamic rules beat static rules.
3. At the same priority and source, `allow` beats `block`.

ProtoConsent uses this model deliberately: static rulesets block at priority 1, per‑site overrides at priority 2, and whitelist allow rules at priority 3. A user who allows ads on a specific site gets a dynamic allow rule that cleanly overrides the global static block without modifying it. A whitelisted domain gets a priority‑3 allow rule that wins over both static blocks and per‑site overrides.

### `requestDomains` matching

The `requestDomains` condition matches the domain of the **request URL** (the destination), including all subdomains. Listing `doubleclick.net` matches `static.doubleclick.net`, `googleads.g.doubleclick.net`, and any other subdomain.

### `initiatorDomains` matching

The `initiatorDomains` condition matches the **origin that initiated the request**. For subresources loaded by the main page, this is the page's domain. For subresources loaded by an iframe, this is the **iframe's origin**, not the top‑level page. This distinction matters: see §8 (iframe initiator behaviour).

### Resource limits

| Limit | Value | ProtoConsent usage |
| --- | --- | --- |
| Static rulesets (max declared) | 100 | 10 (5 domain + 5 path) |
| Static rulesets (max enabled) | 50 | Up to 10 |
| Static rules (total) | 30,000 | ~41,435 (40,233 domains + 1,202 path rules) |
| Dynamic + session rules | 5,000 | ~15 base (10 overrides + 3 GPC + 2 CH strip) + enhanced list rules + whitelist rules |
| `getMatchedRules` calls | 20 per 10 min | 1 per popup open |

By moving global blocking to static rulesets, the full dynamic budget is available for per‑site overrides, Enhanced Protection lists, and whitelist entries. The base cost is ~13 dynamic rules regardless of how many custom sites exist, plus one rule per enabled enhanced list (and optional path rules), plus one whitelist rule per unique site scope.

## 8. Design decisions

### Advanced tracking is always blocked

All three presets (Strict, Balanced, Permissive) set `advanced_tracking: false`. This is a deliberate design choice: fingerprinting, canvas tracking, and similar techniques are considered fundamentally at odds with user privacy. Even the most permissive profile does not allow them. Users who want to allow advanced tracking can create a custom per‑site override or define a custom global profile.

### Iframe initiator behaviour

When a page embeds a third‑party iframe (e.g. an ad iframe from `googlesyndication.com`), requests made by that iframe have the **iframe's origin** as their initiator, not the top‑level page. This means that a per‑site allow override for `elpais.com` does not automatically allow requests made by ad iframes embedded on elpais.com - the override's `initiatorDomains: ["elpais.com"]` does not match requests initiated by `googlesyndication.com`.

This is intentional: trusting a site means trusting *its own* requests, not the third‑party code it embeds.

### Override grouping for scalability

Per‑site overrides are grouped by (category, action) rather than by individual site. All sites that need an "allow ads" override share a single dynamic rule with multiple entries in `initiatorDomains`. This keeps the dynamic rule count proportional to the number of categories (max 10), not the number of custom sites. The tradeoff is that override rules carry larger `requestDomains` arrays, but Chrome handles these efficiently.

### `main_frame` exclusion

All blocking rules exclude `main_frame` from `resourceTypes`. This ensures that users can always navigate to any URL directly - only third‑party subresources are blocked. A user typing `doubleclick.net` in the address bar will reach the site; only background requests to it from other pages are affected.

### Path‑domain filtering in block overrides

When building per‑site "block" override rules (for sites more restrictive than the global profile), the background script filters out `requestDomains` entries that overlap with the site's own `initiatorDomains`. Without this filter, a site like `google.com` that appears both as a tracker domain (in path‑based rules) and as the initiator would block its own first‑party requests. The filtering ensures that block overrides only target third‑party traffic, never the site's own resources.

## 9. Extensibility

New purposes can be added as fields in the site rule without breaking existing preferences. The `.well-known/protoconsent.json` schema is versioned and designed to accommodate new fields while remaining backward‑compatible.

Firefox support is planned as the next browser target. The extension architecture (popup, background, local storage, enforcement) maps directly to Firefox's WebExtensions API, with adaptations mainly in `declarativeNetRequest` availability and manifest format. The same popup UI, data model, and SDK work across browsers.

The optional SDK and purpose‑signalling protocol are documented layers on top of the extension, not hard dependencies. Websites can adopt them at their own pace while the extension continues to work on its own. This lets others adopt parts of ProtoConsent independently.

## 10. Global Privacy Control (GPC)

ProtoConsent sends the [GPC signal](https://globalprivacycontrol.org/) conditionally, based on the user's resolved purpose state for each site. GPC is not a global toggle: it is derived from purpose‑level decisions.

Each purpose in `config/purposes.json` has a `triggers_gpc` boolean field. When any purpose with `triggers_gpc: true` is denied for a given site, the extension activates GPC for that site:

| Purpose | `triggers_gpc` | Rationale |
| --- | --- | --- |
| `functional` | `false` | Core site functionality; denying it does not imply a privacy opt‑out. |
| `analytics` | `false` | Site‑internal measurement; typically first‑party and not covered by GPC's opt‑out scope. |
| `ads` | `true` | Advertising and remarketing involve cross‑site data sharing that GPC was designed to signal against. |
| `personalization` | `false` | User‑facing content adaptation; does not inherently involve cross‑site tracking. |
| `third_parties` | `true` | Data sharing with third parties is a core opt‑out scenario for GPC. |
| `advanced_tracking` | `true` | Cross‑site fingerprinting and device tracking; GPC directly applies. |

When GPC is active for a site, two signals are sent:

1. **`Sec-GPC: 1` HTTP header** - injected via `declarativeNetRequest` `modifyHeaders` rules on outgoing requests to the site's domain.
2. **`navigator.globalPrivacyControl = true`** - set via a MAIN‑world content script (`gpc-signal.js`), registered at runtime through `chrome.scripting.registerContentScripts`.

When GPC is not active, neither signal is sent. There is no `Sec-GPC: 0`: absence of the header means no preference expressed.

The extension maintains up to three dynamic DNR rules for GPC:

- **Global GPC rule** (priority 1): sends `Sec-GPC: 1` to all sites when the default profile triggers it.
- **Per‑site add rule** (priority 2): adds GPC for specific sites whose custom profile triggers it, when the global rule does not apply.
- **Per‑site remove rule** (priority 2): suppresses GPC for specific sites whose custom profile allows all GPC‑triggering purposes, overriding the global rule.

Per‑site GPC overrides use `requestDomains` (the destination URL), not `initiatorDomains` (the page making the request). This means that trusting a site - for example allowing all purposes on elpais.com - removes the GPC signal from requests *to* elpais.com, but third‑party requests *from* elpais.com to domains like google‑analytics.com still carry the global GPC signal. The same applies to cross‑origin iframes: an iframe from youtube.com embedded on a trusted elpais.com page still receives GPC from the global rule.

Users can disable GPC entirely via a global toggle in Purpose Settings (`gpcEnabled` in storage, default `true`); when off, no GPC headers or content scripts are generated regardless of purpose state.

### Relation to the GPC specification

The [GPC specification](https://privacycg.github.io/gpc-spec/) defines GPC as a binary signal: the user either expresses a preference to opt out of sale/sharing, or does not. ProtoConsent respects this: it sends `Sec-GPC: 1` or nothing.

The difference is in *when* the signal is sent. Most implementations treat GPC as a global preference (always on or always off). ProtoConsent derives the signal from the user's purpose‑level decisions, making it conditional per site. This is compatible with the spec - the spec does not require the signal to be global - but it extends the practical semantics: the GPC signal reflects a structured privacy position, not a blanket opt‑out.
