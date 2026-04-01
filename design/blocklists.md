# ProtoConsent – Blocklist curation

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent includes a curated subset of domains from public blocklists, organized by purpose. These are stored as static DNR rulesets in `extension/rules/block_*.json` — one file per blocking purpose.

This is **not** a full ad/tracking blocker. At this stage of development, the lists are intentionally focused: enough to provide meaningful default protection, few enough to audit and maintain manually.

## 2. Current state

| File | Purpose | Domains |
|------|---------|---------|
| `block_ads.json` | Advertising networks | ~1206 |
| `block_analytics.json` | Analytics and measurement | ~1776 |
| `block_personalization.json` | DMPs, identity sync, personalization engines | ~105 |
| `block_third_parties.json` | Social widgets, marketing platforms, push services | ~195 |
| `block_advanced_tracking.json` | Fingerprinting, verification, cryptominers | ~1255 |
| **Total** | | **~4537** |

## 3. Sources

The curation draws from 8 public blocklists:

| Source | Type | Category hint |
|--------|------|---------------|
| [EasyList](https://easylist.to/) | Adblock filter list | Ads |
| [EasyPrivacy](https://easylist.to/) | Adblock filter list | Analytics |
| [Peter Lowe's list](https://pgl.yoyo.org/adservers/) | Domain list | Ads |
| [OISD small](https://oisd.nl/) | Composite domain list | (mixed) |
| [OISD big](https://oisd.nl/) | Composite domain list | (mixed) |
| [HaGeZi Pro](https://github.com/hagezi/dns-blocklists) | DNS blocklist | (mixed) |
| [HaGeZi TIF](https://github.com/hagezi/dns-blocklists) | Threat intelligence | Advanced tracking |
| [Disconnect](https://github.com/nickspaargaren/disconnect-tracking-protection) | Categorized JSON | Multi-category |

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
