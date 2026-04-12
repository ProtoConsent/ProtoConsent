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
  - [11. Site declaration behaviour](#11-site-declaration-behaviour)
    - [11.1 Fetching](#111-fetching)
    - [11.2 Validation](#112-validation)
    - [11.3 Display](#113-display)
    - [11.4 No enforcement change](#114-no-enforcement-change)
  - [12. Inter-extension provider API](#12-inter-extension-provider-api)
    - [12.1 Mechanism](#121-mechanism)
    - [12.2 Resolution logic](#122-resolution-logic)
    - [12.3 Security](#123-security)
    - [12.4 Management UI](#124-management-ui)
    - [12.5 Observability](#125-observability)
    - [12.6 Supported message types](#126-supported-message-types)
  - [13. CMP auto-response](#13-cmp-auto-response)
    - [13.1 Pipeline](#131-pipeline)
    - [13.2 Three-layer response](#132-three-layer-response)
    - [13.3 TC String generation](#133-tc-string-generation)
    - [13.4 Limitations](#134-limitations)
    - [12.5 Observability](#125-observability)
    - [12.6 Supported message types](#126-supported-message-types)

## 2. Components

**Popup UI** – The main user-facing element. When opened on a site, it shows the active profile and purpose states for that domain, and lets the user switch profiles or toggle purposes. Purpose categories are shown with [Consent Commons](https://consentcommons.com/) icons. The popup does not enforce anything directly; it sends messages to the background component when settings change.

- **Consent view**: purpose toggles and per-purpose blocked stats
- **Enhanced view**: optional third-party blocklists with preset selection and per-list controls
- **Log view**: real-time request monitoring, blocked domains grouped by purpose, and GPC signal tracking per domain
- **Site declaration panel**: when a site publishes a `.well-known/protoconsent.json`, a collapsible side panel shows its declared purposes, legal basis, sharing and international transfers

**Background script (service worker)** – Central coordination point. Does not render UI; receives messages from popup and content scripts and translates them into enforcement actions.

- **Rule management**: maintains per-site rules, computes defaults for new domains, rebuilds DNR rules (static rulesets + dynamic overrides) on every settings change
- **GPC signal**: manages conditional `Sec-GPC: 1` header rules and registers the MAIN-world content script for `navigator.globalPrivacyControl`
- **Client Hints stripping**: adds/removes `modifyHeaders` rules for high-entropy `Sec-CH-UA-*` headers based on `advanced_tracking` state
- **Enhanced Protection**: downloads lists on demand, builds dynamic block rules, handles consent-enhanced link overlay, compiles cosmetic CSS and registers the injection content script
- **Inter-extension API**: responds to `chrome.runtime.onMessageExternal` queries from approved extensions (§12)
- **Observability**: tracks blocked requests and GPC signals via `webRequest` listeners, maintains per-tab counters, updates badge, pushes real-time events to the Log tab via persistent port
- **Site declarations**: fetches `.well-known/protoconsent.json` on behalf of the popup and caches results (24h success, 6h failure)
- **TCF detection**: receives CMP data from the content script bridge, validates and stores it per tab
- **Onboarding**: opens the welcome page on first install when no default profile exists

**Local storage** – All configuration lives in the browser’s extension storage. No remote server is used.

- **Site rules**: mapping from domains to rules (profile plus purpose overrides) and predefined profiles
- **Domain whitelist**: per-site and global allow entries
- **Enhanced Protection**: list metadata in `enhancedLists`, domain/path data in `enhancedData_{listId}` keys, active preset in `enhancedPreset`. 19 lists: 5 ProtoConsent Core (one per blocking purpose, maintained by the project) and 14 third-party from open-source projects. Core lists are bundled for first-install availability and updated weekly via CDN from the [data repository](https://github.com/ProtoConsent/data), where a GitHub Actions workflow refreshes all sources every Tuesday.
- **Cosmetic filtering**: compiled CSS in `_cosmeticCSS` (generic selectors) and `_cosmeticDomains` (per-domain selectors)
- **Opt-in flags**: `dynamicListsConsent` (remote sync) and `consentEnhancedLink` (consent-enhanced link)

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

*Dynamic rules* handle per-site customisation and Enhanced Protection.

- **Per-site overrides**: when a user configures a site differently from the global profile, the background creates override rules at priority 2. Overrides are grouped by (category, action) rather than by site: one "allow ads" rule covers all permissive sites via `initiatorDomains`, keeping the dynamic rule count constant regardless of how many custom sites exist.
- **Enhanced Protection**: each enabled list produces dynamic block rules at priority 2 - one domain rule and optional path rules. Sites where all purposes are allowed are excluded via `excludedInitiatorDomains`.
- **Consent-enhanced link**: when active (`consentEnhancedLink` in storage), lists whose category matches a denied consent purpose are included in the rebuild even if the user has not manually enabled them. This is a runtime overlay computed fresh on each rebuild, not a persistent storage change.

This design supports hundreds of custom sites and multiple enhanced lists within Chrome's 5,000 dynamic rule limit.

*Whitelist allow rules* let users unblock specific domains that were caught by the static rulesets. These rules use priority 3, so they always win over both static blocks (priority 1) and per‑site overrides (priority 2). Each entry can be scoped per site (using `initiatorDomains`) or global (no initiator filter). Global entries are batched into a single rule; per‑site entries are grouped by site, one rule per unique site. Domain validation prevents invalid hostnames from entering storage or DNR rules, and storage writes are serialized to avoid concurrent conflicts.

*Global Privacy Control (GPC)* is managed by ProtoConsent. When privacy‑relevant purposes (marked with `triggers_gpc` in `config/purposes.json`) are denied, the extension injects a conditional `Sec-GPC: 1` header via `modifyHeaders` rules and sets `navigator.globalPrivacyControl` via a MAIN‑world content script, signalling the user's opt‑out to the receiving server. Per‑site overrides ensure that GPC is only sent where the user's preferences call for it. Users can also disable GPC entirely via a global toggle in Purpose Settings (`gpcEnabled` in storage, default `true`); when off, no GPC headers or content scripts are generated regardless of purpose state.

Per‑site GPC overrides use `requestDomains` (the destination URL), not `initiatorDomains` (the page making the request). This means that trusting a site, for example allowing all purposes on elpais.com, removes the GPC signal from requests *to* elpais.com, but third‑party requests *from* elpais.com to domains like google‑analytics.com still carry the global GPC signal. The same applies to cross‑origin iframes: an iframe from youtube.com embedded on a trusted elpais.com page still receives GPC from the global rule.

*Client Hint headers* are handled automatically when the `advanced_tracking` purpose is denied. The extension strips seven high-entropy headers via `modifyHeaders` remove rules:

- Stripped: `Sec-CH-UA-Full-Version-List`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Bitness`, `Sec-CH-UA-Model`, `Sec-CH-UA-WoW64`, `Sec-CH-UA-Form-Factors` (~33 bits of entropy, enough to uniquely fingerprint)
- Kept: `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` (low-entropy, needed for content negotiation)
- Global toggle in Purpose Settings (`chStrippingEnabled`, default `true`); when off, no stripping rules are generated
- Per-site exceptions use `excludedRequestDomains` on the global rule rather than a separate override, because a native browser header cannot be "un-removed" by a higher-priority rule
- Firefox and Safari do not send Client Hints at all, so stripping is Chromium-specific

**Content script bridge** – A content script (`content-script.js`) declared in the manifest runs in the ISOLATED world on every page. It acts as a message bridge between the page‑level SDK and the extension’s background: it listens for `PROTOCONSENT_QUERY` messages from the page, forwards them to the background via `chrome.runtime.sendMessage`, and relays the response back. It also forwards `PROTOCONSENT_TCF_DETECTED` messages from the TCF detection script to the background. It does not access or modify page content.

**TCF detection script** – A MAIN-world content script (`tcf-detect.js`) that detects IAB TCF consent management platforms on the page.

- Probes for the `__tcfapi` function, retrying at 200, 600, 1500, 3000 and 5000 ms to handle async-loaded CMPs
- When found, reads CMP identity and purpose consent state via `getTCData`
- Sends data to the background via the content script bridge (`PROTOCONSENT_TCF_DETECTED` message)
- Background validates (numeric ranges, boolean values, entry count limits) and stores per tab in memory and `chrome.storage.session`
- Popup shows a pill indicator; clicking it reveals CMP provider, purpose consent details, and a note that ProtoConsent enforces independently
- Data is cleared on navigation (full loads and SPA pushState changes) and on tab close; orphan session keys are pruned during service worker restore

**protoconsent.js SDK** – A small, optional JavaScript library for web pages to read the user’s ProtoConsent preferences (e.g. whether analytics is allowed) via the content script bridge. The extension works without it; the SDK is for sites that want to adapt their behaviour to the user’s choices. TypeScript type declarations are also provided (`sdk/protoconsent.d.ts`).

**Inter-extension provider** – The background script also acts as a consent provider for other browser extensions. Extensions like Consent‑O‑Matic or uBlock Origin can query ProtoConsent’s resolved purpose state for any domain via `chrome.runtime.sendMessage`. The API is disabled by default and gated by a per-extension allowlist (Trust on First Use): the user must enable the feature and individually approve each consumer extension. Consumers can query but never modify preferences. The Purpose Settings page provides the management UI (master switch, pending/allow/deny lists), and all API events appear in the Log tab’s Requests stream for observability. See §12 for details.

**Onboarding and purpose settings pages** – Two additional extension pages complement the popup. The onboarding page (`pages/onboarding.html`) opens on first install and guides new users through four screens: (1) default profile selection, (2) feature overview, (3) Enhanced lists opt-ins (remote sync and consent-enhanced link), and (4) confirmation with next steps. The purpose settings page (`pages/purposes-settings.html`) lets users customise the global default profile by toggling individual purposes, manage Enhanced lists (sync toggle and consent-enhanced link toggle in a two-column grid), and shows the active Enhanced Protection preset alongside the consent presets. Accessible from the popup or `chrome://extensions`.

**Cosmetic filtering** – Hides ad containers and empty banners left after network-level blocking. Purely visual cleanup - does not block requests or affect privacy. Part of the Balanced preset, can be disabled independently.

- **Source**: `convert-cosmetic.js` (data repo) extracts `##` element-hiding rules from EasyList into generic and domain-specific CSS selectors
- **Distribution**: bundled in `extension/rules/easylist_cosmetic.json` for first-install; also hosted on CDN for updates
- **Rebuild**: background compiles selectors into CSS strings in `chrome.storage.local` (`_cosmeticCSS` generic, `_cosmeticDomains` per-domain)
- **Injection**: `cosmetic-inject.js` content script reads compiled CSS at `document_start` and injects a `<style>` element
- **Validation** (3 levels): converter rejects selectors containing `{`/`}`, background re-filters at compile time, content script re-filters at runtime

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

**Extension reads site declaration** – When the user opens the side panel, the popup asks the background to fetch `<protocol>://<host>/.well-known/protoconsent.json`.

- If valid, the popup renders purposes, legal basis, sharing scope, and data handling with Consent Commons icons
- Cached per domain: 24h on success, 6h on failure
- Uses the page’s actual protocol and host (including port), so it works on production sites and local dev servers

**Real-time log monitoring** – The popup opens a persistent `chrome.runtime.connect` port to the background, which pushes events as they happen.

- **Requests panel**: timestamped `block` and `gpc` events streamed in real time; historical data replayed on first render
- **Domains panel**: blocked domains grouped by purpose with Consent Commons icons
- **GPC panel**: domains that received `Sec-GPC: 1` with request counts and first/last-seen timestamps
- **Badge counter**: per-tab blocked count on the extension icon; uses `getMatchedRules` as authoritative total, noting any gap with the real-time listener

Detection sources:

- Blocked requests: `webRequest.onErrorOccurred` filtering for `ERR_BLOCKED_BY_CLIENT`
- GPC signals: `webRequest.onSendHeaders` checking for `Sec-GPC: 1`
- Purpose attribution: reverse hostname index (~40K entries) with subdomain walk-up matching
- Developer mode: `onRuleMatchedDebug` provides exact rule-to-request attribution when available; falls back to `webRequest` automatically
- Both paths feed into the same data structures, so the UI shows the same data regardless of build type

**First-time onboarding** – On first install (no default profile in storage), the background opens the onboarding page. Four screens:

1. Default profile selection (Strict, Balanced, Permissive)
2. Feature overview
3. Enhanced lists opt-ins (remote sync and consent-enhanced link)
4. Confirmation with next steps

The selected profile becomes the global default; opt-in choices are stored as `dynamicListsConsent` and `consentEnhancedLink` booleans.

**Cookie banner detection (TCF)** – The MAIN-world `tcf-detect.js` script detects IAB TCF consent management platforms.

- Probes `__tcfapi`, reads CMP identity and consent state via `getTCData`
- Background validates and stores per tab in memory + `chrome.storage.session` (keyed as `tcf_{tabId}`)
- Popup shows a pill indicator; side panel reveals CMP provider, purpose consents, and a note that ProtoConsent enforces independently
- Data cleared on navigation (full loads + SPA pushState) and tab close; orphan session keys pruned during service worker restore

## 5. Security and privacy by design

All configuration is stored locally. The extension requests only the permissions it needs (see §6 for the full rationale) and keeps a clear separation between UI and enforcement logic.

Enforcement is based on built‑in browser APIs (declarativeNetRequest), so ProtoConsent benefits from the browser’s own sandboxing and update mechanisms. The data model is intentionally small, which makes edge cases easier to audit.

## 6. Permissions rationale

| Permission | Why it is needed |
| --- | --- |
| `tabs` | Read the active tab's URL so the popup can identify which domain the user is managing and apply per‑site rules. |
| `storage` | Persist user rules, profiles, and preferences locally in the browser's extension storage. No remote storage is used. |
| `scripting` | Register the GPC content script (`gpc-signal.js`) into the MAIN world and the cosmetic filtering content script (`cosmetic-inject.js`) into the ISOLATED world at runtime via `chrome.scripting.registerContentScripts`. GPC sets `navigator.globalPrivacyControl` only on pages where the user's preferences require it; the cosmetic script injects element-hiding CSS on pages where cosmetic filtering is active. |
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

New purposes can be added as fields in the site rule without breaking existing preferences. The `.well-known/protoconsent.json` schema is versioned and designed to accommodate new fields while remaining backward-compatible.

The inter-extension provider API (§12) is a concrete example: other extensions can query ProtoConsent's consent state without any coupling to its internal data model.

Firefox support is planned as the next browser target. The extension architecture (popup, background, local storage, enforcement) maps directly to Firefox's WebExtensions API, with adaptations mainly in `declarativeNetRequest` availability and manifest format. The same popup UI, data model, and SDK work across browsers.

The optional SDK and purpose-signalling protocol are documented layers on top of the extension, not hard dependencies. Websites can adopt them at their own pace while the extension continues to work on its own. This lets others adopt parts of ProtoConsent independently.

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

## 11. Site declaration behaviour

This section describes how the extension handles `.well-known/protoconsent.json` files. For the file format specification, see [protoconsent-well-known.md](spec/protoconsent-well-known.md).

### 11.1 Fetching

When the user opens the side panel in the popup, the popup sends a `PROTOCONSENT_FETCH_WELL_KNOWN` message to the background script with the current site's protocol and host. The background script fetches `<protocol>://<host>/.well-known/protoconsent.json` directly from its service worker context (using the extension's `host_permissions`). Results are cached locally with a 24‑hour TTL per domain.

- If the file is not found (404), unreachable, or invalid JSON, no site declaration is shown. The negative result is cached for 6 hours to avoid repeated fetch attempts. No error is surfaced to the user.
- The extension does **not** fetch the file on every navigation: only when the user opens the side panel and the cache is expired.
- Works on both HTTP and HTTPS sites, including local development servers with non‑default ports.

### 11.2 Validation

The extension performs minimal validation:

1. `purposes` must be an object with at least one key matching a known purpose.
2. Each purpose entry must have a `used` boolean.
3. Unknown purpose keys are ignored (forward compatibility).
4. Unknown top-level fields are ignored (forward compatibility).
5. The `protoconsent` version field is accepted but not enforced (forward compatibility).

Invalid files are silently discarded.

### 11.3 Display

When a valid declaration exists, the popup shows a "Site declaration" side panel:

- Each declared purpose: label + used/not used + legal basis, provider, and sharing scope (if present), illustrated with [Consent Commons](https://consentcommons.com/) icons.
- Data handling details (storage region, international transfers) shown with corresponding Consent Commons icons when declared.
- Purposes not declared by the site are shown as "—" (not declared) in a muted style.
- If `rights_url` is present and uses `https://` or `http://`, a "Your rights" link is displayed.
- The section is purely informational. The user's toggles remain the sole control for enforcement.

### 11.4 No enforcement change

The `.well-known` file **never** modifies user preferences, DNR rules, or GPC headers. It is read-only information displayed alongside the user's own choices.

## 12. Inter-extension provider API

The background script exposes a read-only API that allows other browser extensions to query the user's resolved consent state for any domain. This enables inter-extension collaboration: a banner-handling extension can read ProtoConsent's purposes to fill consent dialogs coherently, or a content blocker can check whether the user has explicitly allowed a domain.

### 12.1 Mechanism

Communication uses `chrome.runtime.onMessageExternal`. The consumer extension calls `chrome.runtime.sendMessage(PROTOCONSENT_ID, message)` and receives a response via the callback or returned Promise. No `externally_connectable` manifest key is declared: the default behaviour (all extensions can send) applies on Chrome, and Firefox ignores the key entirely, so both browsers behave identically.

### 12.2 Resolution logic

Query responses reuse the same `handleBridgeQuery` function that serves the page-side SDK. Given a domain, it reads the user's stored rules, resolves purpose inheritance from the active profile, and returns the final boolean state for all six purposes. The consumer sees the same resolved values that the SDK and popup see.

### 12.3 Security

- The API is disabled by default (`interExtEnabled` in storage). The user must explicitly opt in. When disabled, a `disabled` error is returned (not a silent drop) so developers can diagnose. Toggling the switch preserves all lists.
- Each consumer extension must be individually approved via a TOFU (Trust on First Use) allowlist. Unknown extensions receive a `need_authorization` error and are recorded as pending for the user to review in settings. Approved IDs are stored in `interExtAllowlist`.
- Extensions explicitly denied by the user are moved to `interExtDenylist`. Their messages are silently dropped with no response, giving attackers no signal.
- The pending authorization queue is capped at 10 entries. When full, new entries are silently rejected (not queued) to prevent eviction of legitimate requests. A global cooldown allows at most 3 new unknown extension IDs per minute; beyond that, messages are silently dropped to prevent flooding.
- All queries are read-only. There is no code path from external messages to storage writes or rule rebuilds.
- Messages are validated: the `type` field must start with `protoconsent:`, the `domain` field must pass `isValidHostname()`.
- Requests are rate-limited to 10 per minute per sender extension, keyed by the browser-verified `sender.id`.
- One domain per query. There is no bulk endpoint to retrieve all stored rules.

### 12.4 Management UI

The Purpose Settings page (`pages/purposes-settings.html`) provides a dedicated "Inter-extension API" section with:

- **Master switch**: enables or disables the API. When disabled, the section collapses to the toggle alone.
- **Pending requests**: an auto-expanding accordion showing extension IDs that have contacted ProtoConsent but have not yet been approved. Each entry has Allow and Block buttons. The badge shows the pending count.
- **Authorized extensions**: accordion listing approved IDs with Revoke and Block buttons.
- **Blocked extensions**: accordion listing denied IDs with an Unblock button.

Extension IDs are displayed as links to the Chrome Web Store for verification. A note warns users that IDs not found on the store indicate unpublished (locally loaded) extensions.

All lists update in real time via `chrome.storage.onChanged`, so changes from the background (e.g. a new pending entry from an incoming query) appear without page reload. The inter-extension storage keys (`interExtEnabled`, `interExtAllowlist`, `interExtDenylist`, `interExtPending`) are included in the export/import configuration.

### 12.5 Observability

Inter-extension events appear in the Log tab's Requests stream alongside blocked request and GPC entries. Each event shows a truncated sender ID, the action (`capabilities`, `query`), the queried domain (if applicable), and the result (`✓` for success, `✗` followed by the error code for failures). Events are colour-coded blue to distinguish them from block (amber) and GPC (green) entries.

Events are buffered in memory (up to 50 entries) and persisted to `chrome.storage.session`, so they survive service worker restarts and appear when the user opens the Log tab after the queries have already occurred. Silent drops (denylist, global cooldown) are not logged, consistent with the security model's silent-drop design.

### 12.6 Supported message types

| Type | Direction | Description |
|------|-----------|-------------|
| `protoconsent:capabilities` | consumer → provider | Discovery: returns supported types, purpose keys, and protocol version. |
| `protoconsent:query` | consumer → provider | Returns resolved purpose booleans and profile for a domain. |
| `protoconsent:error` | provider → consumer | Returned for disabled API, unauthorized, invalid, or rate-limited queries. Codes: `disabled`, `need_authorization`, `invalid_domain`, `rate_limited`, `unknown_type`, `internal`. |

For message format details, see [inter-extension-protocol.md](spec/inter-extension-protocol.md).

## 13. CMP auto-response

ProtoConsent can automatically respond to consent banners by injecting the consent cookies that CMPs expect to find on page load. This prevents the banner from appearing without simulating clicks or interacting with the banner DOM.

For the full design, signature format, TC String specification, and list of supported CMPs, see [cmp-auto-response.md](cmp-auto-response.md).

### 13.1 Pipeline

The background module (`background/cmp-injection.js`) pre-computes injection data whenever global purposes change: it loads CMP signatures from `config/cmp-signatures.json`, generates an IAB TCF v2.2 TC String, and writes everything to `chrome.storage.local`. The content script (`content-scripts/cmp-inject.js`) runs at `document_start` in ISOLATED world, reads the pre-computed data, and executes the three-layer response.

### 13.2 Three-layer response

1. **Cookie injection**: For each applicable CMP signature, the content script resolves template placeholders with user purpose values and writes the resulting cookies. A cleanup timer deletes the injected cookies after 5 seconds to reduce HTTP overhead on subsequent requests.
2. **Cosmetic CSS**: Banner and overlay selectors from all applicable signatures are combined into a single `<style>` element as a safety net.
3. **Scroll unlock**: CSS class removal + inline style overrides for scroll lock patterns, with a `MutationObserver` watching for CMP re-locking attempts.

### 13.3 TC String generation

For CMPs that read the `euconsent-v2` cookie, ProtoConsent generates a valid IAB TCF v2.2 Transparency and Consent String. The generator maps ProtoConsent's purpose model to TCF's 24-purpose bitfield, respects the v2.2 legitimate interest restrictions (purposes 3-6 cannot use LI), and encodes the result as base64url with no external dependencies.

### 13.4 Limitations

- The content script currently runs in ISOLATED world. `window.__tcfapi` and `localStorage` are not accessible from this context; MAIN world injection is the known resolution (see [cmp-auto-response.md](cmp-auto-response.md#92-known-solutions)).
- No click simulation (by design -- ProtoConsent declares consent via data, not interaction).
- Proprietary consent systems (custom cookies, protobuf-encoded tokens) are not covered unless a known signature exists.
- The TC String uses empty vendor sections; CMPs that require specific vendor consent may not fully accept it.

