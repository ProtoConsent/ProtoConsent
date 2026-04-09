# ProtoConsent - Blocklists management

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent includes a curated subset of domains from public blocklists, organized by purpose. These are stored as static DNR rulesets in `extension/rules/block_*.json` - one file per blocking purpose.

This is **not** a full ad/tracking blocker. The lists are drawn from public blocklists, curated with cross-source validation and quality filters, and organized by purpose to provide meaningful default protection.

## Contents

1. [Overview](#1-overview)
2. [Current state](#2-current-state)
3. [Sources](#3-sources)
4. [Curation process](#4-curation-process)
5. [DNR format](#5-dnr-format)
6. [Path-based rules](#6-pathbased-rules)
7. [Enhanced protection lists (third-party)](#7-enhanced-protection-lists-third-party)
8. [CNAME cloaking detection (informational)](#8-cname-cloaking-detection-informational)

## 2. Current state

| File | Purpose | Domains |
| --- | --- | --- |
| `block_ads.json` | Advertising networks | ~12,904 |
| `block_analytics.json` | Analytics and measurement | ~15,851 |
| `block_personalization.json` | DMPs, identity sync, personalization engines | ~73 |
| `block_third_parties.json` | Social widgets, marketing platforms, push services | ~171 |
| `block_advanced_tracking.json` | Fingerprinting, verification, cryptominers | ~11,234 |
| **Total** | | **~40,233** |

## 3. Sources

The curation draws from 7 public blocklists:

| Source | Type | Category hint | License |
| --- | --- | --- | --- |
| [EasyList](https://easylist.to/) | Adblock filter list | Ads | GPL-3.0+ / CC BY-SA 3.0+ |
| [EasyPrivacy](https://easylist.to/) | Adblock filter list | Analytics | GPL-3.0+ / CC BY-SA 3.0+ |
| [Peter Lowe's list](https://pgl.yoyo.org/adservers/) | Domain list | Ads | No formal license¹ |
| [OISD small](https://oisd.nl/) | Composite domain list | (mixed) | GPL-3.0 |
| [OISD big](https://oisd.nl/) | Composite domain list | (mixed) | GPL-3.0 |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | DNS blocklist | (mixed) | GPL-3.0 |
| [HaGeZi TIF](https://github.com/hagezi/dns-blocklists) | Threat intelligence | Advanced tracking | GPL-3.0 |

¹ Peter Lowe's list has no formal license; the author grants informal permission: "Feel free to combine this list with yours or lists from other sites and put it up on the web."

## 4. Curation process

The current process is manual and will be replaced by an automated pipeline in the future.

### Inclusion criteria

- A domain must appear in **at least 2 independent sources** to be considered.
- Each domain is classified into one of the 5 blocking purposes based on source metadata, known seed mappings, and domain name heuristics.
- Domains that cannot be classified are discarded.
- Each category is capped at ~2000 candidates before quality review.

### Quality review

After cross-referencing, a quality pass removes:

- **False positives**: legitimate services that should never be blocked (payment processors, search engines, CDNs, auth providers, CAPTCHA services).
- **Junk domains**: hex-hash throwaway domains, random-word cloaking domains, date-based campaign domains, and other ephemeral entries that go stale immediately.
- **Scam/malware**: phishing sites and malware infrastructure that don't belong in a purpose-based blocklist.
- **Redundant subdomains**: DNR `requestDomains` matches a domain and all its subdomains, so `marketo.com` already covers `app-ab01.marketo.com`. Listing both wastes rule slots.
- **Miscategorized entries**: domains moved to their correct purpose (e.g. cryptominers from analytics to advanced tracking).

### Safelist

A safelist of ~120 domains ensures critical services are never blocked, even if public lists flag them. This includes payment processors (Stripe, PayPal), CDNs (Cloudflare, jsDelivr), auth providers (Auth0, Okta), CAPTCHA services, and main domains of social platforms.

## 5. DNR format

Each `block_*.json` contains a single declarative net request rule:

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

Path rules are stored in `block_*_paths.json` files (one per category) alongside the domain rules. Each file contains multiple rules, one per tracking endpoint.

### Current path rule counts

| File | Category | Rules | Example endpoints |
| --- | --- | --- | --- |
| `block_analytics_paths.json` | Analytics | 559 | `google.com/pagead/`, `googletagmanager.com/gtag/js`, `facebook.com/tr/` |
| `block_ads_paths.json` | Ads | 529 | `google.com/adsense/`, `fundingchoicesmessages.google.com/` |
| `block_personalization_paths.json` | Personalization | 13 | `logx.optimizely.com/`, `crwdcntrl.net/5/c=` |
| `block_third_parties_paths.json` | Third parties | 73 | `facebook.com/plugins/`, `linkedin.com/embed/` |
| `block_advanced_tracking_paths.json` | Advanced tracking | 28 | `privacymanager.io/`, `consent.cookiebot.com/` |
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

Beyond the core static rulesets shipped with the extension, ProtoConsent supports **enhanced protection** via third-party blocklists converted to DNR-compatible JSON. These lists are optional - the user opts in from the Enhanced tab in the popup.

### Current lists (v0.3)

13 lists organized in two presets.

**Balanced preset** (5 lists - enabled by default when user selects Balanced):

| List | License | Domains | Path rules | Category |
| --- | --- | --- | --- | --- |
| [EasyPrivacy](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~46K | ~4K | `analytics` |
| [EasyList](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~58K | ~1.6K | `ads` |
| [AdGuard DNS Filter](https://github.com/AdguardTeam/AdGuardSDNSFilter) | GPL-3.0 | ~165K | - | - |
| [Steven Black Unified](https://github.com/StevenBlack/hosts) | MIT | ~49K | - | - |
| [EasyList Cosmetic](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | - | - | `ads` |

**Full preset** (adds 8 lists):

| List | License | Domains | Path rules | Category |
| --- | --- | --- | --- | --- |
| [OISD Small](https://oisd.nl/) | GPL-3.0 | ~56K | - | - |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | GPL-3.0 | ~190K | - | - |
| [HaGeZi TIF](https://github.com/hagezi/dns-blocklists) | GPL-3.0 | ~966K | - | `advanced_tracking` |
| [1Hosts Lite](https://github.com/badmojr/1Hosts) | MPL-2.0 | ~195K | - | - |
| [Blocklist Project - Ads](https://github.com/blocklistproject/Lists) | Unlicense | ~155K | - | `ads` |
| [Blocklist Project - Tracking](https://github.com/blocklistproject/Lists) | Unlicense | ~15K | - | `analytics` |
| [Blocklist Project - Crypto](https://github.com/blocklistproject/Lists) | Unlicense | ~24K | - | `advanced_tracking` |
| [Blocklist Project - Phishing](https://github.com/blocklistproject/Lists) | Unlicense | ~87K | - | `security` |

Domain counts are approximate and change with each upstream update.

Lists with a **category** display the corresponding Consent Commons icon in the UI. The `security` category is ProtoConsent-specific (not part of Consent Commons). Cosmetic lists display a dedicated pill instead of a category icon.

### Removed from earlier candidates

| List | Reason |
| --- | --- |
| Peter Lowe's list | License incompatible with GPL-3.0 (McRae GPL, non-commercial). Only 3,519 domains. |
| OISD Big | ~418K domains but heavy overlap with HaGeZi Pro (OISD aggregates HaGeZi). Redundant. |

### Distribution model

Enhanced lists are **not** shipped inside the extension package. Instead:

1. A converter script (`scripts/convert.js`) in the [ProtoConsent/data](https://github.com/ProtoConsent/data) repo fetches upstream lists, parses them (ABP, hosts, and plain domain formats), deduplicates, and outputs DNR-compatible JSON.
2. The JSON files are hosted on GitHub and served via **jsDelivr CDN** (primary) with **raw.githubusercontent.com** as fallback.
3. The extension fetches the JSON when the user downloads a list from the Enhanced tab. Lists are stored in `chrome.storage.local` with a split architecture: metadata in `enhancedLists`, heavy data in `enhancedData_{listId}`.

Remote fetching is gated behind a consent flag (`dynamicListsConsent` in storage). The user opts in during onboarding or from Purpose Settings. When disabled, the extension only uses bundled list data shipped with the package and does not contact any CDN. The cosmetic list (`easylist_cosmetic.json`) is bundled in `extension/rules/` and loaded into storage on first install, ensuring cosmetic filtering works out of the box without remote fetching.

This keeps the extension package small, avoids bundling third-party list content directly (except the cosmetic baseline), and allows list updates without publishing a new extension version.

### Presets

| Preset | Behavior |
| --- | --- |
| Off | No enhanced lists active (core ProtoConsent only) |
| Balanced | Enables the 5 Balanced lists on download |
| Full | Enables all 13 lists on download |
| Custom | User has toggled individual lists manually |

When a user downloads lists with the preset set to Off, the extension auto-switches to Balanced.

### Consent-enhanced link

When the user enables the consent-enhanced link (`consentEnhancedLink` in storage), denied purposes in the **default profile** automatically activate Enhanced lists whose `category` matches. For example, if the default profile denies Ads, EasyList, EasyList Cosmetic and Blocklist Project - Ads are activated; denying Analytics activates EasyPrivacy and Blocklist Project - Tracking. Lists with `category: null` or `category: "security"` are never auto-activated.

The link uses the default profile only, not per-site overrides. Enhanced lists are global (they block across all sites), so tying them to the user's general privacy posture prevents unexpected cross-site effects. The Settings page links the consent-link description to the default profile selector so the connection is clear.

This is a runtime overlay: the background script computes the linked list set on each `rebuildAllDynamicRules()` call based on the default profile's resolved purposes and the catalog's category mapping. It does not modify the stored `enabled` state of any list. Consent-linked lists are included in the rule build alongside manually enabled lists, and appear in the Enhanced tab with a ProtoConsent icon indicator and a disabled (checked) toggle. The link takes priority over the Enhanced "Off" preset - even with Off selected, consent-linked lists are enforced when the feature is active.

Only downloaded lists participate in DNR rule generation. When the Enhanced tab is open and the popup detects consent-linked lists that are not yet downloaded, it triggers an automatic download via the same mechanism as "Download all", provided Sync (`dynamicListsConsent`) is enabled. Without Sync, the consent link still activates already-downloaded lists but will not fetch new ones. Lists without a `fetch_url` in the catalog are skipped.

### Domain deduplication

DNR `requestDomains` matches a domain **and all its subdomains**. The converter removes dominated subdomains so the final JSON contains only the minimal set of root domains needed. This reduces rule size significantly - HaGeZi TIF drops from over 1M raw entries to ~966K after dedup.

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

Cosmetic filtering is purely visual cleanup - it does not block network requests or affect privacy. It is active by default (Balanced preset) and can be disabled independently in the Enhanced tab.

## 8. CNAME cloaking detection (informational)

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
