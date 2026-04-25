# ProtoConsent - Lists management

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

## Contents

- [ProtoConsent - Lists management](#protoconsent---lists-management)
  - [Contents](#contents)
  - [1. Overview](#1-overview)
  - [2. Core blocklists](#2-core-blocklists)
  - [3. DNR format](#3-dnr-format)
  - [4. Path-based rules](#4-path-based-rules)
    - [Path rule counts](#path-rule-counts)
  - [5. Enhanced protection lists](#5-enhanced-protection-lists)
    - [Presets](#presets)
    - [Balanced preset lists](#balanced-preset-lists)
    - [Full preset (adds 4 lists)](#full-preset-adds-4-lists)
  - [6. Distribution and updates](#6-distribution-and-updates)
    - [Automated refresh](#automated-refresh)
    - [Format conversion](#format-conversion)
  - [7. Consent-enhanced link](#7-consent-enhanced-link)
  - [8. Cosmetic filtering](#8-cosmetic-filtering)
  - [9. CMP auto-response signatures](#9-cmp-auto-response-signatures)
  - [10. CNAME cloaking detection](#10-cname-cloaking-detection)
  - [11. URL parameter stripping](#11-url-parameter-stripping)
  - [12. Regional lists](#12-regional-lists)
    - [Supported regions](#supported-regions)
    - [Distribution](#distribution)
    - [Language selection](#language-selection)
    - [Preset integration](#preset-integration)
    - [UI](#ui)
  - [13. Adding a new list](#13-adding-a-new-list)

## 1. Overview

ProtoConsent includes a curated subset of domains from public blocklists, organized by purpose. These are stored as static DNR rulesets in `extension/rules/protoconsent_*.json` - one file per blocking purpose.

This is **not** a full ad/tracking blocker. The lists are organized by purpose to provide meaningful default protection, complemented by optional third-party Enhanced lists for broader coverage.

## 2. Core blocklists

The extension ships static DNR rulesets organized by purpose for day-1 blocking without requiring any download. The [data repo](https://github.com/ProtoConsent/data) publishes Enhanced-format JSON with additional domains (delta) not in the bundle. All core lists are GPL-3.0+ licensed and maintained by the ProtoConsent project.

| Purpose | Bundle domains | Delta | Total domains | Total paths |
| --- | ---: | ---: | ---: | ---: |
| Advertising (`ads`) | 27,561 | 78,532 | 106,093 | 1,646 |
| Analytics (`analytics`) | 14,395 | 24,481 | 38,876 | 3,990 |
| Personalization (`personalization`) | 75 | 212 | 287 | 13 |
| Third parties (`third_parties`) | 187 | 486 | 673 | 196 |
| Advanced tracking (`advanced_tracking`) | 15,876 | 1,576 | 17,452 | 28 |
| Security (`security`) | - | 22,382 | 22,382 | - |
| **Total** | **58,094** | **127,669** | **185,763** | **5,873** |

Counts as of 2026-04-18. The first 5 purposes are Balanced preset; security is Full preset. In the UI, the first 5 appear as a grouped card ("ProtoConsent Core") in the Protection tab.

## 3. DNR format

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

- Priority 1 for static rulesets; dynamic per-site overrides use priority 2.
- All rulesets start disabled in the manifest; the background enables them based on user preferences.
- `main_frame` is excluded so users can always navigate to any domain directly.

## 4. Path-based rules

Some high-value domains cannot be blocked entirely because they serve both legitimate content and tracking endpoints. For example, `google.com` hosts search, authentication, and advertising on the same domain.

For these domains, ProtoConsent uses **path-based rules** with `urlFilter` patterns that target specific tracking endpoints (e.g. `||google.com/pagead/`). Path rules are stored in `protoconsent_*_paths.json` files alongside the domain rules.

### Path rule counts

| Category | Rules | Example endpoints |
| --- | --- | --- |
| Analytics | 559 | `google.com/pagead/`, `facebook.com/tr/` |
| Ads | 529 | `google.com/adsense/` |
| Personalization | 13 | `logx.optimizely.com/` |
| Third parties | 73 | `facebook.com/plugins/`, `linkedin.com/embed/` |
| Advanced tracking | 28 | `privacymanager.io/` |
| **Total** | **1,202** | |

A path rule is added only when the domain hosts both tracking and legitimate content, the endpoint has a stable URL pattern, and the domain is not already in the domain blocklist.

Per-site overrides include path-extracted domains so that allowing a purpose on a site also unblocks path-based rules. For block overrides, domains that overlap with the site's own domain are filtered out to prevent self-referential blocking.

## 5. Enhanced protection lists

Beyond the core rulesets, ProtoConsent supports optional third-party blocklists converted to DNR-compatible JSON. The user opts in from the Protection tab.

### Presets

| Preset | Behavior |
| --- | --- |
| Off | No enhanced lists active (core ProtoConsent only) |
| Balanced | Enables 5 blocking lists + cosmetic + CMP; also enables regional if languages selected |
| Full | Enables all 9 blocking lists + cosmetic + CMP; also enables regional if languages selected |
| Custom | User has toggled individual lists manually |

When downloading with preset Off, the extension auto-switches to Balanced.

### Balanced preset lists

| List | License | Domains | Path rules | Category |
| --- | --- | --- | --- | --- |
| [EasyPrivacy](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~46K | ~4K | `analytics` |
| [EasyList](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | ~58K | ~1.6K | `ads` |
| [AdGuard DNS Filter](https://github.com/AdguardTeam/AdGuardSDNSFilter) | GPL-3.0 | ~165K | - | - |
| [EasyList Cosmetic](https://easylist.to/) | GPL-3.0+ / CC BY-SA 3.0+ | - | - | `ads` |
| [ProtoConsent Banners](https://github.com/ProtoConsent/data) | GPL-3.0+ | - | - | - |
| Regional* | GPL-3.0+ | varies | varies | - |

*Regional lists only active when user has selected languages (see [section 12](#12-regional-lists)).

### Full preset (adds 4 lists)

| List | License | Domains | Category |
| --- | --- | --- | --- |
| [OISD Small](https://oisd.nl/) | GPL-3.0 | ~56K | - |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | GPL-3.0 | ~190K | - |
| [Blocklist Project - Crypto](https://github.com/blocklistproject/Lists) | Unlicense | ~24K | `advanced_tracking` |
| [Blocklist Project - Phishing](https://github.com/blocklistproject/Lists) | Unlicense | ~87K | `security` |

Domain counts are approximate and change with each upstream update.

## 6. Distribution and updates

Enhanced lists are **not** shipped inside the extension package:

1. A converter script in the [data repo](https://github.com/ProtoConsent/data) fetches upstream lists, parses them, deduplicates, and outputs DNR-compatible JSON.
2. JSON files are hosted on GitHub and served via **jsDelivr CDN** (primary) with raw.githubusercontent.com as fallback.
3. The extension fetches JSON when the user downloads a list. Lists are stored locally with metadata separated from heavy data.

Remote fetching requires user consent, set during onboarding or in Purpose Settings. When disabled, only bundled data is used. The cosmetic list and CMP signatures are bundled for out-of-the-box availability.

### Automated refresh

A GitHub Actions workflow in the data repo refreshes all Enhanced lists weekly (Tuesdays 04:42 UTC). It runs all converters, regenerates the catalog, and commits changes. Manual single-list refresh is available via `workflow_dispatch`.

The extension picks up updates on the next sync check. jsDelivr CDN caching may delay propagation by a few minutes.

### Format conversion

EasyList and EasyPrivacy use Adblock Plus syntax. The converter extracts `||domain^` patterns (domain blocks) and `||domain/path^` patterns (path blocks). Exception rules are discarded.

DNR matches a domain and all its subdomains. The converter removes dominated subdomains so the JSON contains only the minimal root domain set. HaGeZi Pro drops from 200K+ raw entries to ~190K after dedup.

## 7. Consent-enhanced link

When enabled, denied purposes in the default profile automatically activate Enhanced lists whose category matches. For example, denying Ads activates EasyList; denying Analytics activates EasyPrivacy. Lists without a category are never auto-activated.

The link uses the default profile only (not per-site overrides) because Enhanced lists are global. This is a runtime overlay computed on each rebuild - it does not modify stored list state. Consent-linked lists appear in the Protection tab with a special indicator and override the Off preset.

Only downloaded lists participate. When the popup detects consent-linked lists not yet downloaded, it triggers automatic download if sync is enabled.

## 8. Cosmetic filtering

EasyList element-hiding rules (`##` selectors) hide ad containers and empty banners left after network-level blocking. A dedicated converter extracts generic and domain-specific selectors, validated at three levels (converter, background compile, runtime injection) to prevent CSS injection.

Cosmetic filtering is purely visual cleanup - no network blocking. Active by default (Balanced preset), can be disabled independently.

## 9. CMP auto-response signatures

CMP signatures are an enhanced list containing templates for how consent platforms store consent. Unlike blocking lists, they produce no DNR rules. Instead, a content script reads signatures and injects consent cookies before CMP scripts load.

The signature list is bundled for first-install availability and updated via CDN when sync is enabled. For the full architecture, see [cmp-auto-response.md](cmp-auto-response.md).

| List | License | Templates | Scope |
| --- | --- | --- | --- |
| [ProtoConsent Banners](https://github.com/ProtoConsent/data) | GPL-3.0+ | 31 | Global (most), domain-scoped (some) |

**CMP detection lists** complement signatures by identifying banners on pages:

| List | Source | License | Entries |
| --- | --- | --- | --- |
| `protoconsent_cmp_detectors.json` | [Autoconsent](https://github.com/duckduckgo/autoconsent) | MPL-2.0 | ~284 CMPs |
| `protoconsent_cmp_signatures_site.json` | [Autoconsent](https://github.com/duckduckgo/autoconsent) | MPL-2.0 | ~235 entries |

Detectors contain CSS selectors for banner presence/visibility. Site-specific signatures contain hiding selectors scoped to specific domains. Both are filtered through a safelist and bundled with CDN updates.

## 10. CNAME cloaking detection

CNAME cloaking disguises trackers as first-party subdomains via DNS CNAME records (e.g. `metrics.example.com` CNAMEs to `tracker.adjust.com`). Chromium extensions have no DNS API, so ProtoConsent uses a static lookup map from [AdGuard CNAME Trackers](https://github.com/AdguardTeam/cname-trackers) (MIT license).

The map contains ~229K disguised domains mapped to ~244 tracker destinations. This is an **informational** list - it does not block requests. When enabled, the Log tab shows a CNAME indicator next to matched domains. Part of the Balanced preset.

## 11. URL parameter stripping

ProtoConsent strips tracking parameters from navigation URLs using DNR redirect rules. Unlike domain blocking, this removes parameters from the URL before the server receives them.

**Global parameters** (~304): compiled from [AdGuard TrackParamFilter](https://github.com/AdguardTeam/AdguardFilters) (GPL-3.0). Examples: `utm_source`, `fbclid`, `gclid`, `msclkid`.

**Per-site parameters** (~1,814 across ~879 domains): compiled from AdGuard + [Dandelion Sprout](https://github.com/DandelionSprout/adfilt) (GPL-3.0 / Dandelicence). Site-specific parameters excluded from the global list.

Stripping is gated by the `advanced_tracking` purpose (active when denied, which is the default for all presets). Detection and observability are documented in [param-stripping.md](param-stripping.md).

## 12. Regional lists

Regional filter lists provide language-specific blocking and cosmetic rules from EasyList regional supplements and AdGuard language-specific filters. Each region produces two files: cosmetic (element hiding) and blocking (domains + paths). 13 regions are supported.

### Supported regions

| Region | Code | Sources |
| --- | --- | --- |
| Chinese | `cn` | EasyList China + AdGuard Chinese |
| German | `de` | EasyList Germany + AdGuard German |
| Dutch | `nl` | EasyList Dutch + AdGuard Dutch |
| Spanish/Portuguese | `es` | EasyList Spanish + Portuguese + AdGuard Spanish/Portuguese |
| French | `fr` | AdGuard French |
| Hebrew | `he` | EasyList Hebrew |
| Italian | `it` | EasyList Italy |
| Japanese | `ja` | AdGuard Japanese |
| Lithuanian | `lt` | EasyList Lithuania |
| Polish | `pl` | EasyList Polish |
| Russian | `ru` | AdGuard Russian |
| Turkish | `tr` | AdGuard Turkish |
| Ukrainian | `uk` | AdGuard Ukrainian |

Regions with multiple sources merge and deduplicate rules from all sources.

### Distribution

The catalog contains 2 regional entries (cosmetic and blocking). Each covers all 13 regions. Individual region files are fetched from CDN when the user downloads. Both entries have Balanced preset, gated by language selection.

### Language selection

Users select regions in Purpose Settings. The default selection is auto-detected from the browser's UI language. Changing the selection automatically re-fetches regional lists. Regional lists are disabled when all languages are removed.

### Preset integration

Regional lists participate in Balanced/Full presets but are excluded from preset state calculation. This means enabling or disabling regional lists does not change the displayed preset. The Off preset always disables regional lists.

### UI

Two cards in the Protection tab (Regional Cosmetic and Regional Blocking) show flag icons for selected languages. Region selection is handled exclusively in Purpose Settings. Flag icons are from [flag-icons](https://github.com/lipis/flag-icons) (MIT license).

## 13. Adding a new list

Adding a third-party list requires entries in 3 files:

1. **`scripts/convert.js`** in the data repo - add to the `LISTS` object with name, URL, and format.
2. **`scripts/generate-manifest.js`** in the data repo - add to `LIST_CATALOG` with metadata (name, description, source, license, category, preset).
3. **`extension/config/enhanced-lists.json`** in the extension repo - same metadata plus `fetch_url` (local catalog fallback).

Run the workflow manually to generate JSON and update the catalog. The UI renders whatever the catalog contains.
