# ProtoConsent – Blocklists management

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent includes a curated subset of domains from public blocklists, organized by purpose. These are stored as static DNR rulesets in `extension/rules/block_*.json` — one file per blocking purpose.

This is **not** a full ad/tracking blocker. The lists are drawn from public blocklists, curated with cross‑source validation and quality filters, and organized by purpose to provide meaningful default protection.

## 2. Current state

| File | Purpose | Domains |
|------|---------|---------|
| `block_ads.json` | Advertising networks | ~12,904 |
| `block_analytics.json` | Analytics and measurement | ~15,851 |
| `block_personalization.json` | DMPs, identity sync, personalization engines | ~73 |
| `block_third_parties.json` | Social widgets, marketing platforms, push services | ~171 |
| `block_advanced_tracking.json` | Fingerprinting, verification, cryptominers | ~11,234 |
| **Total** | | **~40,233** |

## 3. Sources

The curation draws from 7 public blocklists:

| Source | Type | Category hint | License |
|--------|------|---------------|---------|
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

## 6. Path‑based rules

Some high‑value domains cannot be blocked entirely because they serve both legitimate content and tracking endpoints. For example, `google.com` hosts search results, authentication flows, and advertising scripts on the same domain. Blocking `google.com` via `requestDomains` would break core functionality.

For these domains, ProtoConsent uses **path‑based rules** with `urlFilter` patterns that target specific tracking endpoints:

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
|------|----------|-------|-------------------|
| `block_analytics_paths.json` | Analytics | 559 | `google.com/pagead/`, `googletagmanager.com/gtag/js`, `facebook.com/tr/` |
| `block_ads_paths.json` | Ads | 529 | `google.com/adsense/`, `fundingchoicesmessages.google.com/` |
| `block_personalization_paths.json` | Personalization | 13 | `logx.optimizely.com/`, `crwdcntrl.net/5/c=` |
| `block_third_parties_paths.json` | Third parties | 73 | `facebook.com/plugins/`, `linkedin.com/embed/` |
| `block_advanced_tracking_paths.json` | Advanced tracking | 28 | `privacymanager.io/`, `consent.cookiebot.com/` |
| **Total** | | **1,202** | |

### Selection criteria for path rules

A path rule is added only when:

1. The domain hosts both tracking and legitimate content (cannot be fully blocked).
2. The tracking endpoint has a stable, well‑known URL pattern.
3. The domain is **not** already in the corresponding domain blocklist (no redundancy).

### Interaction with per‑site overrides

Per‑site override rules use `requestDomains` to match both domain‑blocked and path‑blocked domains. When building overrides, the background script extracts the unique domains from path rules (e.g. `google.com` from `||google.com/pagead/`) and merges them into the override's `requestDomains`. This ensures that a Permissive site gets path‑based requests unblocked alongside domain‑based ones.

For **block overrides**, path‑extracted domains that overlap with the initiator domains are filtered out. This prevents self‑referential blocking: without the filter, a Strict override on `elpais.com` would block all first‑party subdomains (`static.elpais.com`, `imagenes.elpais.com`, etc.) because DNR's `requestDomains` matching is subdomain‑inclusive. The tradeoff is that first‑party tracking pixels (e.g. `elpais.com/t.gif`) are not blocked by dynamic overrides — they are handled by the static path ruleset when the global profile blocks that category.
