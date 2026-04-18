# ProtoConsent - Blocklists management

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent includes a curated subset of domains from public blocklists, organized by purpose. These are stored as static DNR rulesets in `extension/rules/protoconsent_*.json` - one file per blocking purpose.

This is **not** a full ad/tracking blocker. The lists are drawn from public blocklists, curated with cross-source validation and quality filters, and organized by purpose to provide meaningful default protection.

## Contents

- [ProtoConsent - Blocklists management](#protoconsent---blocklists-management)
  - [1. Overview](#1-overview)
  - [Contents](#contents)
  - [2. Current state](#2-current-state)
  - [3. Sources](#3-sources)
  - [4. Curation process](#4-curation-process)
    - [Inclusion criteria](#inclusion-criteria)
    - [Quality review](#quality-review)
  - [5. DNR format](#5-dnr-format)
  - [6. Path-based rules](#6-path-based-rules)
    - [Current path rule counts](#current-path-rule-counts)
    - [Selection criteria for path rules](#selection-criteria-for-path-rules)
    - [Interaction with per-site overrides](#interaction-with-per-site-overrides)
  - [7. Enhanced protection lists (third-party)](#7-enhanced-protection-lists-third-party)
    - [Current lists (v0.5)](#current-lists-v05)
    - [Distribution model](#distribution-model)
    - [Presets](#presets)
    - [Consent-enhanced link](#consent-enhanced-link)
    - [Domain deduplication](#domain-deduplication)
    - [ABP format parsing](#abp-format-parsing)
    - [Cosmetic filtering](#cosmetic-filtering)
    - [CMP auto-response signatures](#cmp-auto-response-signatures)
  - [8. ProtoConsent Core lists](#8-protoconsent-core-lists)
  - [9. Adding a new Enhanced list](#9-adding-a-new-enhanced-list)
  - [10. Automated refresh](#10-automated-refresh)
  - [11. CNAME cloaking detection (informational)](#11-cname-cloaking-detection-informational)
    - [How it works](#how-it-works)
    - [Always active with Enhanced](#always-active-with-enhanced)
    - [Data format](#data-format)
    - [Source](#source)
  - [12. URL tracking parameter stripping](#12-url-tracking-parameter-stripping)
    - [Global parameters](#global-parameters)
    - [Per-site parameters](#per-site-parameters)
    - [DNR implementation](#dnr-implementation)
    - [Observability](#observability)
  - [13. Regional lists](#13-regional-lists)
    - [Sources](#sources)
    - [Distribution model](#distribution-model-1)
    - [FETCH handler](#fetch-handler)
    - [Language selection](#language-selection)
    - [Preset integration](#preset-integration)
    - [UI presentation](#ui-presentation)
    - [Constants](#constants)

## 2. Current state

| File | Purpose | Domains |
| --- | --- | --- |
| `protoconsent_ads.json` | Advertising networks | ~27,561 |
| `protoconsent_analytics.json` | Analytics and measurement | ~14,395 |
| `protoconsent_personalization.json` | DMPs, identity sync, personalization engines | ~75 |
| `protoconsent_third_parties.json` | Social widgets, marketing platforms, push services | ~187 |
| `protoconsent_advanced_tracking.json` | Fingerprinting, verification, cryptominers | ~15,876 |
| **Total** | | **~58,094** |

## 3. Sources

The curation draws from 6 public blocklists:

| Source | Type | Category hint | License |
| --- | --- | --- | --- |
| [EasyList](https://easylist.to/) | Adblock filter list | Ads | GPL-3.0+ / CC BY-SA 3.0+ |
| [EasyPrivacy](https://easylist.to/) | Adblock filter list | Analytics | GPL-3.0+ / CC BY-SA 3.0+ |
| [Peter Lowe's list](https://pgl.yoyo.org/adservers/) | Domain list | Ads | No formal license¹ |
| [OISD small](https://oisd.nl/) | Composite domain list | (mixed) | GPL-3.0 |
| [OISD big](https://oisd.nl/) | Composite domain list | (mixed) | GPL-3.0 |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | DNS blocklist | (mixed) | GPL-3.0 |

¹ Peter Lowe's list has no formal license; the author grants informal permission: "Feel free to combine this list with yours or lists from other sites and put it up on the web."

## 4. Curation process

### Inclusion criteria

- A domain must appear in **at least 2 independent sources** to be considered.
- Each domain is classified into one of the 5 blocking purposes based on source metadata.
- Domains that cannot be classified are discarded.

### Quality review

After cross-referencing, a quality pass removes:

- **False positives**: legitimate services that should never be blocked.
- **Junk domains**: hex-hash throwaway domains, random-word cloaking domains, date-based campaign domains, and other ephemeral entries that go stale immediately.
- **Redundant subdomains**: DNR `requestDomains` matches a domain and all its subdomains, so `marketo.com` already covers `app-ab01.marketo.com`. Listing both wastes rule slots.
- **Miscategorized entries**: domains moved to their correct purpose (e.g. cryptominers from analytics to advanced tracking).

A safelist ensures critical services are never blocked, even if public lists flag them.

## 5. DNR format

Each `protoconsent_*.json` contains a single declarative net request rule:

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "block" },
    "condition": {
      "resourceTypes": ["script", "xmlhttprequest", "image", "sub_frame", "ping", "other"],
      "requestDomains": ["domain1.com", "domain2.com"]
    }
  }
]
```

- Priority 1 for static rulesets; `background.js` uses priority 2 for dynamic per-site overrides.
- All rulesets are `enabled: false` in the manifest; the background script enables them based on user preferences.
- `main_frame` is excluded from `resourceTypes`, so users can still navigate to any domain directly.

## 6. Path-based rules

Some high-value domains cannot be blocked entirely because they serve both legitimate content and tracking endpoints. For example, `google.com` hosts search results, authentication flows, and advertising scripts on the same domain. Blocking `google.com` via `requestDomains` would break core functionality.

For these domains, ProtoConsent uses **path-based rules** with `urlFilter` patterns that target specific tracking endpoints:

```json
{
  "id": 1,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||google.com/pagead/",
    "resourceTypes": ["script", "xmlhttprequest", "image", "ping", "other"]
  }
}
```

Path rules are stored in `protoconsent_*_paths.json` files (one per category) alongside the domain rules. Each file contains multiple rules, one per tracking endpoint.

### Current path rule counts

| File | Category | Rules | Example endpoints |
| --- | --- | --- | --- |
| `protoconsent_analytics_paths.json` | Analytics | 559 | `google.com/pagead/`, `googletagmanager.com/gtag/js`, `facebook.com/tr/` |
| `protoconsent_ads_paths.json` | Ads | 529 | `google.com/adsense/`, `fundingchoicesmessages.google.com/` |
| `protoconsent_personalization_paths.json` | Personalization | 13 | `logx.optimizely.com/`, `crwdcntrl.net/5/c=` |
| `protoconsent_third_parties_paths.json` | Third parties | 73 | `facebook.com/plugins/`, `linkedin.com/embed/` |
| `protoconsent_advanced_tracking_paths.json` | Advanced tracking | 28 | `privacymanager.io/`, `consent.cookiebot.com/` |
| **Total** | | **1,202** | |

### Selection criteria for path rules

A path rule is added only when:

1. The domain hosts both tracking and legitimate content (cannot be fully blocked).
2. The tracking endpoint has a stable, well-known URL pattern.
3. The domain is **not** already in the corresponding domain blocklist (no redundancy).

### Interaction with per-site overrides

Per-site override rules use `requestDomains` to match both domain-blocked and path-blocked domains. When building overrides, the background script extracts the unique domains from path rules (e.g. `google.com` from `||google.com/pagead/`) and merges them into the override's `requestDomains`. This ensures that a Permissive site gets path-based requests unblocked alongside domain-based ones.

For **block overrides**, path-extracted domains that overlap with the initiator domains are filtered out. This prevents self-referential blocking: without the filter, a Strict override on `elpais.com` would block all first-party subdomains (`static.elpais.com`, `imagenes.elpais.com`, etc.) because DNR's `requestDomains` matching is subdomain-inclusive. The tradeoff is that first-party tracking pixels (e.g. `elpais.com/t.gif`) are not blocked by dynamic overrides - they are handled by the static path ruleset when the global profile blocks that category.

## 7. Enhanced protection lists (third-party)

Beyond the core static rulesets shipped with the extension, ProtoConsent supports **enhanced protection** via third-party blocklists converted to DNR-compatible JSON. These lists are optional - the user opts in from the Protection tab in the popup.

### Current lists (v0.5)

7 blocking lists plus 2 non-blocking lists (cosmetic filtering and CMP auto-response), 2 URL parameter stripping lists, 2 CMP detection lists, and 2 regional catalog entries (covering 13 regions x 2 types), organized in two presets. Regional lists are managed separately (see [section 13](#13-regional-lists)).

**Balanced preset** (5 lists + regional if languages selected):

| List | License | Domains | Path rules | Category |
| --- | --- | --- | --- | --- |
| [EasyPrivacy](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~46K | ~4K | `analytics` |
| [EasyList](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~58K | ~1.6K | `ads` |
| [AdGuard DNS Filter](https://github.com/AdguardTeam/AdGuardSDNSFilter) | GPL-3.0 | ~165K | - | - |
| [EasyList Cosmetic](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | - | - | `ads` |
| [ProtoConsent Banners](https://github.com/ProtoConsent/data) | GPL-3.0+ | - | - | - |
| Regional Cosmetic* | GPL-3.0+ | - | - | - |
| Regional Blocking* | GPL-3.0+ | varies | varies | - |

*Regional lists are only enabled when the user has selected at least one language in Purpose Settings (see [section 13](#13-regional-lists)).

**Full preset** (adds 4 lists):

| List | License | Domains | Path rules | Category |
| --- | --- | --- | --- | --- |
| [OISD Small](https://oisd.nl/) | GPL-3.0 | ~56K | - | - |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | GPL-3.0 | ~190K | - | - |
| [Blocklist Project - Crypto](https://github.com/blocklistproject/Lists) | Unlicense | ~24K | - | `advanced_tracking` |
| [Blocklist Project - Phishing](https://github.com/blocklistproject/Lists) | Unlicense | ~87K | - | `security` |

Domain counts are approximate and change with each upstream update.

Lists with a **category** display the corresponding Consent Commons icon in the UI. The `security` category is ProtoConsent-specific (not part of Consent Commons). Cosmetic lists display a dedicated pill instead of a category icon. CMP lists display a dedicated pill ("Banners") and show template counts instead of domain/rule counts.

### Distribution model

Enhanced lists are **not** shipped inside the extension package. Instead:

1. A converter script (`scripts/convert.js`) in the [ProtoConsent/data](https://github.com/ProtoConsent/data) repo fetches upstream lists, parses them (ABP, hosts, and plain domain formats), deduplicates, and outputs DNR-compatible JSON.
2. The JSON files are hosted on GitHub and served via **jsDelivr CDN** (primary) with **raw.githubusercontent.com** as fallback.
3. The extension fetches the JSON when the user downloads a list from the Protection tab. Lists are stored in `chrome.storage.local` with a split architecture: metadata in `enhancedLists`, heavy data in `enhancedData_{listId}`.

Remote fetching is gated behind a consent flag (`dynamicListsConsent` in storage). The user opts in during onboarding or from Purpose Settings. When disabled, the extension only uses bundled list data shipped with the package and does not contact any CDN. The cosmetic list (`easylist_cosmetic.json`) and the CMP signatures list (`protoconsent_cmp_signatures.json`) are bundled in `extension/rules/` and loaded into storage on first install, ensuring cosmetic filtering and CMP auto-response work out of the box without remote fetching.

This keeps the extension package small, avoids bundling third-party list content directly (except the cosmetic and CMP baselines), and allows list updates without publishing a new extension version.

### Presets

| Preset | Behavior |
| --- | --- |
| Off | No enhanced lists active (core ProtoConsent only) |
| Balanced | Enables the 5 Balanced lists on download; also enables regional lists if languages are selected |
| Full | Enables all 9 lists on download; also enables regional lists if languages are selected |
| Custom | User has toggled individual lists manually |

When a user downloads lists with the preset set to Off, the extension auto-switches to Balanced. Regional lists have `preset: "basic"` and are included in Balanced/Full presets, but only enabled when the user has selected at least one language in Purpose Settings (see [section 13](#13-regional-lists)).

### Consent-enhanced link

When the user enables the consent-enhanced link (`consentEnhancedLink` in storage), denied purposes in the **default profile** automatically activate Enhanced lists whose `category` matches. For example, if the default profile denies Ads, EasyList and EasyList Cosmetic are activated; denying Analytics activates EasyPrivacy. Lists with `category: null` or `category: "security"` are never auto-activated.

The link uses the default profile only, not per-site overrides. Enhanced lists are global (they block across all sites), so tying them to the user's general privacy posture prevents unexpected cross-site effects. The Settings page links the consent-link description to the default profile selector so the connection is clear.

This is a runtime overlay: the background script computes the linked list set on each `rebuildAllDynamicRules()` call based on the default profile's resolved purposes and the catalog's category mapping. It does not modify the stored `enabled` state of any list. Consent-linked lists are included in the rule build alongside manually enabled lists, and appear in the Protection tab with a ProtoConsent icon indicator and a disabled (checked) toggle. The link takes priority over the Enhanced "Off" preset - even with Off selected, consent-linked lists are enforced when the feature is active.

Only downloaded lists participate in DNR rule generation. When the Enhanced tab is open and the popup detects consent-linked lists that are not yet downloaded, it triggers an automatic download via the same mechanism as "Download all", provided Sync (`dynamicListsConsent`) is enabled. Without Sync, the consent link still activates already-downloaded lists but will not fetch new ones. Lists without a `fetch_url` in the catalog are skipped.

### Domain deduplication

DNR `requestDomains` matches a domain **and all its subdomains**. The converter removes dominated subdomains so the final JSON contains only the minimal set of root domains needed. This reduces rule size significantly - HaGeZi Pro drops from over 200K raw entries to ~190K after dedup.

### ABP format parsing

EasyList and EasyPrivacy are distributed in Adblock Plus (ABP) filter syntax. The converter extracts both **`||domain^` patterns** (domain-level blocks) and **`||domain/path^` patterns** (path-based URL blocks). Exception rules are discarded. Path rules are stored alongside domain rules in the same JSON and create separate dynamic DNR rules with `urlFilter` conditions.

### Cosmetic filtering

EasyList also contains **element-hiding rules** (CSS selectors prefixed with `##`) that hide ad containers and empty banners left after network-level blocking. A dedicated converter (`convert-cosmetic.js`) parses these rules into two categories: generic selectors (apply to all pages) and domain-specific selectors (scoped to particular sites).

The cosmetic list is a separate enhanced list (`type: "cosmetic"` in `enhanced-lists.json`) with its own storage and lifecycle:

1. A converter script (`scripts/convert-cosmetic.js`) in the [ProtoConsent/data](https://github.com/ProtoConsent/data) repo fetches EasyList, extracts `##` element-hiding rules, and outputs JSON with `generic` (array) and `domains` (object) fields.
2. The compiled JSON is bundled in `extension/rules/easylist_cosmetic.json` for first-install availability and also hosted on CDN for updates.
3. At build time (`rebuild.js`), the background script compiles active cosmetic selectors into a CSS string stored in `chrome.storage.local` (`_cosmeticCSS` for generic, `_cosmeticDomains` for per-domain).
4. A programmatically registered content script (`cosmetic-inject.js`) reads the compiled CSS at `document_start` and injects a `<style>` element.
5. Selectors are validated at three levels: the converter rejects selectors containing `{` or `}` (to prevent CSS injection), the background re-filters at compile time, and the content script re-filters at runtime.
6. Procedural selectors (`:has(`, `:-abp-`, `:contains(` etc.) are discarded by the converter as they cannot be expressed in plain CSS.

Cosmetic filtering is purely visual cleanup - it does not block network requests or affect privacy. It is active by default (Balanced preset) and can be disabled independently in the Protection tab.

### CMP auto-response signatures

ProtoConsent ships CMP auto-response signatures as an enhanced list (`type: "cmp"` in `enhanced-lists.json`). The list contains templates that describe how each consent management platform stores consent, including cookie patterns, banner selectors, and scroll lock behavior.

Unlike blocking or cosmetic lists, CMP signatures do not produce DNR rules or CSS. Instead, a statically registered content script (`cmp-inject.js`) reads the signatures from storage at `document_start` and injects consent cookies before any CMP script loads.

The CMP list follows the same distribution model as cosmetic:

1. A bundled copy in `extension/rules/protoconsent_cmp_signatures.json` is loaded into storage on first install via `initBundledCmpData()` in `lifecycle.js`.
2. When sync is enabled, the extension fetches `enhanced/protoconsent/protoconsent_cmp_signatures.json` from CDN and writes the signatures to storage, clearing the in-memory cache so the next page load picks up the update.
3. The bridge key `_cmpSignatures` in `chrome.storage.local` is the interface between the Enhanced system and the content script. Both bundled init and CDN fetch write to it.

Key differences from cosmetic:

- **No rebuild step**: Writing to `_cmpSignatures` is sufficient. The content script reads it directly on every page load.
- **Statically registered**: `cmp-inject.js` is declared in `manifest.json`, not dynamically registered like `cosmetic-inject.js`.
- **No `category`**: CMP signatures are not purpose-specific. The consent-enhanced link does not auto-activate this list.

For the full signature format, supported CMPs, and three-layer response architecture, see [cmp-auto-response.md](cmp-auto-response.md).

| List | License | Templates | Scope |
| --- | --- | --- | --- |
| [ProtoConsent Banners](https://github.com/ProtoConsent/data) | GPL-3.0+ | 31 | Global (most), domain-scoped (Bing) |

**CMP detection lists** complement the auto-response signatures by identifying consent banners on the page:

| List | Source | License | Entries | Scope |
| --- | --- | --- | --- | --- |
| `protoconsent_cmp_detectors.json` | [Autoconsent](https://github.com/duckduckgo/autoconsent) | MPL-2.0 | ~284 CMPs | Global (some domain-scoped) |
| `protoconsent_cmp_signatures_site.json` | [Autoconsent](https://github.com/duckduckgo/autoconsent) | MPL-2.0 | ~235 entries | Site-specific (via `domains` field) |

CMP detectors contain CSS selectors for `present` (CMP loaded) and `showing` (banner visible) states, used by the extension's CMP detection content script (`cmp-detect.js`) at `document_idle`. Site-specific signatures contain hiding selectors that are too generic to apply globally but safe when limited to their target domains. Both are filtered through `config/cmp-safelist.json` in the data repo. A bundled snapshot is included in the extension package; updated copies are fetched from CDN. UI shows these as part of "ProtoConsent Banners".

## 8. ProtoConsent Core lists

The extension ships static rulesets (`protoconsent_*.json`) for day-1 blocking with 58,094 curated domains and 1,202 path rules. The [ProtoConsent/data](https://github.com/ProtoConsent/data) repo publishes 6 Enhanced-format JSON files (one per purpose) containing delta domains not already in the bundle, curated from 18 upstream sources via the [classifier pipeline](https://github.com/ProtoConsent/ProtoConsent-classifier). Combined, bundle and delta provide 185,763 domain rules and 2,451 path rules. A sixth purpose (`security`) has no corresponding static ruleset and is available only via CDN.

| List ID | Category | Bundle | Delta | Total | Path rules |
| --- | --- | ---: | ---: | ---: | ---: |
| `protoconsent_ads` | `ads` | 27,561 | 78,532 | 106,093 | 1,062 |
| `protoconsent_analytics` | `analytics` | 14,395 | 24,481 | 38,876 | 1,121 |
| `protoconsent_personalization` | `personalization` | 75 | 212 | 287 | 27 |
| `protoconsent_third_parties` | `third_parties` | 187 | 486 | 673 | 183 |
| `protoconsent_advanced_tracking` | `advanced_tracking` | 15,876 | 1,576 | 17,452 | 58 |
| `protoconsent_security` | `security` | - | 22,382 | 22,382 | - |
| **Total** | | **58,094** | **127,669** | **185,763** | **2,451** |

Domain counts are exact as of 2026-04-18.

Each list has its own `category` so the reverse hostname index maps domains to the correct purpose icon. In the UI, the first 5 lists appear as a single grouped card ("ProtoConsent Core") in the Protection tab. Download, toggle and remove operate on all 5 as a group. The security list appears as an independent card with `is-own` styling.

The first 5 are preset `Balanced`. They extend static ruleset coverage with weekly CDN updates independently of extension version releases. The security list is preset `Full`.

## 9. Adding a new Enhanced list

Adding a third-party list requires entries in 3 files:

1. **`scripts/convert.js`** in the data repo - add the list to the `LISTS` object with `name`, `url`, and `format` (`abp`, `hosts`, or `domains`). This tells the refresh workflow how to fetch and parse the source.

2. **`scripts/generate-manifest.js`** in the data repo - add the list to the `LIST_CATALOG` object with `name`, `description`, `source`, `license`, `category`, and `preset`. This controls the metadata in `lists.json`.

3. **`extension/config/enhanced-lists.json`** in the extension repo - add the same metadata plus `fetch_url`. This is the local catalog fallback used when the remote `lists.json` is unavailable.

After adding the entries, run the workflow manually (`workflow_dispatch`) to generate the JSON and update `lists.json`. The UI renders whatever the catalog contains - no UI code changes needed.

For ProtoConsent Core lists, step 1 does not apply because they are generated from the static rulesets, not from external sources.

## 10. Automated refresh

A GitHub Actions workflow in the data repo refreshes all Enhanced lists weekly:

- **Schedule:** Tuesdays at 04:42 UTC (cron: `42 4 * * 2`)
- **Manual trigger:** `workflow_dispatch` with optional `list` parameter for single-list refresh
- **Steps:** `convert.js` (blocklists) → `convert-cname.js` (CNAME trackers) → `convert-cosmetic.js` (cosmetic rules) → `convert-regional.js` (regional lists) → `generate-manifest.js` (rebuild `config/enhanced-lists.json`) → commit and push if changes detected
- **Workflow file:** `.github/workflows/refresh-lists.yml`

The extension picks up updated lists on the next sync check (controlled by `dynamicListsConsent`). jsDelivr CDN caching may delay propagation by a few minutes after the commit.

## 11. CNAME cloaking detection (informational)

CNAME cloaking is a tracking technique where trackers disguise themselves as first-party subdomains via DNS CNAME records. For example, `metrics.example.com` might CNAME to `tracker.adjust.com`. Because the browser sees the request as first-party, traditional domain blocklists cannot catch it.

Chromium extensions have no DNS API, so runtime CNAME resolution is not possible. ProtoConsent uses a static lookup map compiled from [AdGuard CNAME Trackers](https://github.com/AdguardTeam/cname-trackers) (MIT license) to detect known CNAME-cloaked domains.

### How it works

- The list contains ~229K disguised domains mapped to ~244 tracker destinations across 5 categories: trackers, ads, clickthroughs, mail_trackers, and microsites.
- This is an **informational** list (`type: "informational"` in `enhanced-lists.json`). It does not generate DNR blocking rules.
- When enabled, the Log tab shows a `⇉` icon next to domains that appear in the CNAME map, with a tooltip showing the tracker destination.
- The icon appears in both the blocked domains table and the streaming request log.
- A `www.` prefix fallback ensures matches even when the listed domain omits or includes the prefix.

### Always active with Enhanced

CNAME detection is part of the Balanced preset and activates automatically when Enhanced Protection is enabled. CName trackers lists can be enabled/disabled independently.

### Data format

The lookup map uses an indexed format to reduce file size (from ~10.7 MB to ~7.9 MB):

```json
{
  "version": "2026-04-06",
  "trackers": ["adjust.com", "adobe.com", "..."],
  "map": { "disguised.example.com": 0, "...": 1 }
}
```

The `trackers` array stores destination names once. The `map` values are numeric indices into `trackers`.

### Source

| List | License | Disguised domains | Tracker destinations |
| --- | --- | --- | --- |
| [AdGuard CNAME Trackers](https://github.com/AdguardTeam/cname-trackers) | MIT | ~229K | ~244 |

The converter script (`convert-cname.js`) in the [ProtoConsent/data](https://github.com/ProtoConsent/data) repo fetches, merges, and outputs the indexed JSON.

## 12. URL tracking parameter stripping

ProtoConsent strips tracking parameters from navigation URLs using DNR redirect rules with `queryTransform.removeParams`. Unlike domain blocking, this does not prevent the request - it removes tracking parameters from the URL before the server receives them.

### Global parameters

The global list is compiled from [AdGuard TrackParamFilter](https://github.com/AdguardTeam/AdguardFilters) (GPL-3.0). It contains ~304 literal `$removeparam` parameter names that apply to all sites.

| List | Source | License | Parameters |
| --- | --- | --- | --- |
| `adguard_tracking_params.json` | [AdGuard TrackParamFilter](https://github.com/AdguardTeam/AdguardFilters) | GPL-3.0 | ~304 |

Examples: `utm_source`, `utm_medium`, `utm_campaign`, `fbclid`, `gclid`, `msclkid`, `mc_cid`, `mc_eid`, `yclid`, `_openstat`.

### Per-site parameters

The per-site list is compiled from [AdGuard TrackParamFilter](https://github.com/AdguardTeam/AdguardFilters) (GPL-3.0) and [Dandelion Sprout's Legitimate URL Shortener Tool](https://github.com/DandelionSprout/adfilt) (Dandelicence v1.4). It contains site-specific parameters that are only relevant on certain domains.

| List | Source | License | Parameters | Domains |
| --- | --- | --- | --- | --- |
| `dandelion_tracking_params.json` | AdGuard + Dandelion Sprout | GPL-3.0 / Dandelicence | ~1,814 | ~879 |

Parameters that already appear in the global list are excluded from the per-site list to avoid redundancy.

### DNR implementation

The extension builds two static DNR rulesets from these lists:

- **`strip_tracking_params`**: a single rule with `removeParams` containing all global parameters. Applies to all navigation URLs.
- **`strip_tracking_params_sites`**: one rule per domain group, each with `removeParams` scoped by `requestDomains`.

Both use `action.type: "redirect"` with `redirect.transform.queryTransform.removeParams`. Stripping is gated by the `advanced_tracking` purpose: it is active when advanced tracking is denied (all presets block it by default).

Dynamic CDN rules can supplement these static rulesets when Enhanced data includes updated parameter lists. The background script tracks dynamic param strip rule IDs in `dynamicParamStripIds` (state.js) for classification in the popup.

### Observability

Stripped parameters are detected via the `webNavigation` API (§15 in [architecture.md](architecture.md)) and shown in the Overview tab (accordion with parameter names) and Log tab (purple `[param-strip]` lines). The badge counter and blocked request count are not affected.

The converter script (`convert-tracking-params.js`) in the [ProtoConsent/data](https://github.com/ProtoConsent/data) repo fetches upstream lists, extracts literal `$removeparam` names (skipping regex patterns), separates global vs. per-site, and outputs the two JSON files.

## 13. Regional lists

Regional filter lists provide language/region-specific blocking and cosmetic rules compiled from EasyList regional supplements and AdGuard language-specific filters. Each region produces two files: `regional_<code>_cosmetic.json` (element hiding) and `regional_<code>_blocking.json` (domain and path blocking). 13 regions are supported, managed through 2 catalog entries.

### Sources

| Region | Code | Sources |
| --- | --- | --- |
| Chinese | `cn` | EasyList China + AdGuard Chinese |
| German | `de` | EasyList Germany + AdGuard German |
| Dutch | `nl` | EasyList Dutch + AdGuard Dutch |
| Spanish/Portuguese | `es` | EasyList Spanish + EasyList Portuguese + AdGuard Spanish/Portuguese |
| French | `fr` | AdGuard French |
| Hebrew | `he` | EasyList Hebrew |
| Italian | `it` | EasyList Italy |
| Japanese | `ja` | AdGuard Japanese |
| Lithuanian | `lt` | EasyList Lithuania |
| Polish | `pl` | EasyList Polish |
| Russian | `ru` | AdGuard Russian |
| Turkish | `tr` | AdGuard Turkish |
| Ukrainian | `uk` | AdGuard Ukrainian |

Regions with both EasyList and AdGuard sources (CN, DE, NL, ES) merge rules from all sources per type, deduplicating domains and selectors. The converter script (`convert-regional.js`) reuses the same ABP blocking parser as `convert.js` and the same cosmetic parser as `convert-cosmetic.js`.

### Distribution model

The extension's bundled catalog (`extension/config/enhanced-lists.json`) contains exactly **2 regional entries**:

| Catalog ID | Type field | Description |
| --- | --- | --- |
| `regional_cosmetic` | `regional_cosmetic` | Element-hiding rules for selected regions |
| `regional_blocking` | `regional_blocking` | Domain and path blocking rules for selected regions |

Each entry has a `fetch_base` field (CDN path prefix, e.g. `enhanced/regional/`) and a `regions` array listing all 13 region codes. There is no individual `fetch_url` per region. Both entries have `preset: "basic"`, so they are included in the Balanced and Full presets when the user has at least one language selected.

CDN path for individual region files: `{fetch_base}regional_{code}_{suffix}.json` (e.g. `enhanced/regional/regional_de_cosmetic.json`).

**CDN backward compatibility**: The data repo's `generate-manifest.js` **skips regional entries** from CDN output. Old extension versions (<=v0.5.0) have no regional code and would show phantom cards and break preset resolution if they encountered unknown regional entries in the CDN catalog. The extension's bundled copy provides the correct regional definitions; since the CDN merge cannot overwrite entries it does not contain, the bundled values survive intact. This skip should be removed once the minimum supported extension version includes regional support. 

### FETCH handler

When the user triggers a download for a regional catalog entry, the FETCH handler:

1. Reads `regionalLanguages` (a string array of region codes) from `chrome.storage.local`.
2. For each selected region, fetches `{fetch_base}regional_{code}_{suffix}.json` from CDN.
3. Merges all fetched files into a single `enhancedData_{id}` storage entry.

Regional cosmetic data is stored with `type: "cosmetic"`, so the cosmetic compile step in `rebuild.js` processes it alongside EasyList cosmetic selectors. Regional blocking data is stored without a `type` field, so `rebuild.js` processes it as standard DNR blocking rules (domains and path rules).

### Language selection

Region selection is managed in Purpose Settings (`purposes-settings-regional.js`) via `initRegionalSection()`:

- Per-region checkboxes allow the user to select which regions to activate. Each checkbox shows the region's flag icon (SVG from bundled `icons/flags/`) followed by the label.
- Selections are written to `regionalLanguages` in `chrome.storage.local` as a string array of region codes. Writes are serialized via a promise chain to prevent read-modify-write race conditions when toggling checkboxes rapidly.
- The default selection is derived from `chrome.i18n.getUILanguage()` via the language-to-region mappings in `config/regional-languages.json`. Multi-language mappings are supported (e.g. `pt` maps to `es` since Spanish/Portuguese are combined). The `flag` field in `regional-languages.json` supports strings (`"DE"`) or arrays (`["ES", "PT"]`) for dual-flag display.
- The storage change listener in `handlers-regional.js` detects changes to `regionalLanguages` and auto-re-fetches regional lists, so the user does not need to manually re-download after changing language selections. The listener is debounced (100ms) and automatically disables regional lists when all languages are removed.

Language detection only happens in Purpose Settings defaults. There is no `suggestedRegion` field in `GET_STATE` responses.

### Preset integration

Regional lists have `preset: "basic"` and participate in the Balanced/Full preset logic, gated by language selection:

- `resolveEnhancedPreset()` in `handlers.js` filters out `REGIONAL_IDS` when computing preset state, so regional lists being enabled/disabled does not affect preset detection.
- The `SET_PRESET` handler reads `regionalLanguages` from storage. If languages are selected, regional lists follow the preset (enabled for Balanced if `preset === "basic"`, always enabled for Full). If no languages are selected, regional lists are skipped. The Off preset always disables regional lists regardless of language selection.
- `setEnhancedPreset()` in the popup similarly checks `regionalLanguages` before including regionals in auto-download.

There is no `catalog[id].region` field. Identification relies entirely on the `REGIONAL_IDS` Set defined in `config.js`.

### UI presentation

Two cards in the Protection tab, rendered by `renderRegionalCard()` in `enhanced-regional.js`:

- **Regional Cosmetic**: Cosmetic pill, catalog description, expand/collapse with chevron.
- **Regional Blocking**: No category pill, catalog description, expand/collapse with chevron.

Card headers show flag icons (SVG images from bundled `icons/flags/`, max 2 flags with "+N" overflow) linking to Purpose Settings regional section, followed by a language count badge. Expanded state shows source, license, and last-updated date. Each card has standard download/toggle/remove buttons. There are no per-region controls in the Protection tab. Region selection is handled exclusively in Purpose Settings (see [Language selection](#language-selection) above).

Flag icons are from the [flag-icons](https://github.com/lipis/flag-icons) library (MIT license, Panayiotis Lipiridis). 14 SVGs are bundled in `extension/icons/flags/`. An `onerror` fallback renders a two-letter text abbreviation if the SVG fails to load (e.g. for new regions added via CDN before the extension bundles their flag).

### Constants

Regional constants are defined in `config.js`:

| Constant | Type | Description |
| --- | --- | --- |
| `REGIONAL_COSMETIC_ID` | `string` | Catalog ID for the regional cosmetic entry |
| `REGIONAL_BLOCKING_ID` | `string` | Catalog ID for the regional blocking entry |
| `REGIONAL_IDS` | `Set<string>` | Set containing both regional IDs, used for preset exclusion |

Region labels, flag codes, and language-to-region mappings are loaded at runtime from `config/regional-languages.json` (bundled, and synced via CDN catalog `regions` array for removal control).

