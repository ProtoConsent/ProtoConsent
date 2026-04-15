# Credits

ProtoConsent uses third-party assets, data, and open-source projects.
We are grateful to their maintainers and contributors.

## Bundled assets

### Consent Commons

| Source | Authors | License | Usage |
|--------|---------|---------|-------|
| [Consent Commons](https://consentcommons.com) | Consent Commons | Free to use with attribution | Purpose icons, legal basis icons, sharing and transfer icons |

(c) Consent Commons 2019

Icons used as-is:

    extension/icons/purposes/functional.png
    extension/icons/purposes/analytics.png
    extension/icons/purposes/ads.png
    extension/icons/purposes/third_parties.png
    extension/icons/declaration/consent.png
    extension/icons/declaration/contractual.png
    extension/icons/declaration/legitimate_interest.png
    extension/icons/declaration/legal_obligation.png
    extension/icons/declaration/public_interest.png
    extension/icons/declaration/vital_interest.png
    extension/icons/declaration/sharing.png
    extension/icons/declaration/intl_transfers_yes.png
    extension/icons/declaration/intl_transfers_no.png

Modified icons:

    extension/icons/purposes/personalization.png
      Based on the Consent Commons "profiling & analytics" icon
      with a "P" letter overlay added to distinguish it from analytics.

Icons not from Consent Commons:

    extension/icons/purposes/advanced_tracking.png
      Custom eye icon designed for ProtoConsent (no Consent Commons equivalent).

    extension/icons/purposes/enhanced.png
    extension/icons/purposes/enhanced.svg
      Custom orange shield icon designed for ProtoConsent.
      Used for Enhanced Protection blocks in counter bar, Log and whitelist panels.

    extension/icons/purposes/security.png
    extension/icons/purposes/security.svg
      Custom shield with checkmark icon designed for ProtoConsent.
      Used for security-category lists (e.g. Blocklist Project Phishing).

### CMP banner handling (Autoconsent)

| Source | Authors | License | Files |
|--------|---------|---------|-------|
| [Autoconsent](https://github.com/duckduckgo/autoconsent) | DuckDuckGo, Inc. | MPL-2.0 | `protoconsent_cmp_detectors.json`, `protoconsent_cmp_signatures_site.json`, `protoconsent_cmp_signatures.json` (prehide selectors) |

CMP detection selectors (detectCmp/detectPopup) and site-specific hiding
selectors used in the bundled files below are derived from Autoconsent.
The extraction is performed by `convert-autoconsent.js` in the ProtoConsent
data repo (https://github.com/ProtoConsent/data).

Files containing Autoconsent-derived data:

    extension/rules/protoconsent_cmp_detectors.json
      CMP detection selectors (285 CMPs). Extracted from Autoconsent's
      detectCmp and detectPopup arrays, filtered through cmp-safelist.json.

    extension/rules/protoconsent_cmp_signatures_site.json
      Site-specific CMP hiding selectors. Extracted from Autoconsent's
      site-specific prehide rules.

    extension/rules/protoconsent_cmp_signatures.json
      Prehide selectors from Autoconsent are merged into the selector field
      of hand-maintained CMP signatures. The 23 hand-maintained signatures
      (with cookie injection templates, purpose maps, and format definitions)
      are original to ProtoConsent.

## CDN-served data

The extension fetches enhanced blocking lists and cosmetic rules at runtime
from the ProtoConsent data repo via jsDelivr CDN. These lists are not bundled
in the extension but are compiled from upstream open-source projects.

### Blocklists

| Source | Authors | License | Files |
|--------|---------|---------|-------|
| [EasyList](https://easylist.to/) | EasyList authors | GPL-3.0+ / CC BY-SA 3.0+ | `easylist.json`, `easylist_cosmetic.json` |
| [EasyPrivacy](https://easylist.to/) | EasyList authors | GPL-3.0+ / CC BY-SA 3.0+ | `easyprivacy.json` |
| [AdGuard DNS Filter](https://github.com/AdguardTeam/AdGuardSDNSFilter) | AdGuard Team | GPL-3.0 | `adguard_dns.json` |
| [Steven Black Unified Hosts](https://github.com/StevenBlack/hosts) | Steven Black | MIT | `steven_black.json` |
| [OISD](https://oisd.nl/) | Stephan van Ruth | GPL-3.0 | `oisd_small.json` |
| [HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists) | HaGeZi | GPL-3.0 | `hagezi_pro.json`, `hagezi_tif.json` |
| [1Hosts](https://github.com/badmojr/1Hosts) | badmojr | MPL-2.0 | `onehosts_lite.json` |
| [Blocklist Project](https://github.com/blocklistproject/Lists) | Blocklist Project | Unlicense | `blp_ads.json`, `blp_tracking.json`, `blp_crypto.json`, `blp_phishing.json` |

### CNAME tracker detection

| Source | Authors | License | Files |
|--------|---------|---------|-------|
| [AdGuard CNAME Trackers](https://github.com/AdguardTeam/cname-trackers) | Adguard Software Ltd | MIT | `cname_trackers.json` |

### URL tracking parameter stripping

| Source | Authors | License | Files |
|--------|---------|---------|-------|
| [AdGuard TrackParamFilter](https://github.com/AdguardTeam/AdguardFilters) | AdGuard Team | GPL-3.0 | `adguard_tracking_params.json`, `dandelion_tracking_params.json` (per-site entries) |
| [Legitimate URL Shortener Tool](https://github.com/DandelionSprout/adfilt) | Dandelion Sprout | Dandelicence v1.4 | `dandelion_tracking_params.json` (per-site entries) |

AdGuard's TrackParamFilter general section provides the global parameter list (~304 params).
Per-site parameters in `dandelion_tracking_params.json` are merged from AdGuard's specific
section and Dandelion Sprout's list (~1,814 params across ~879 domains), with global
parameters excluded to avoid duplication.

For full upstream source attribution, conversion scripts, and license details
for CDN-served data, see the data repo CREDITS.md:
https://github.com/ProtoConsent/data/blob/main/CREDITS.md

## License notices

### MPL-2.0 (Autoconsent)

Autoconsent is distributed under the Mozilla Public License, version 2.0.
The full license text is available at: https://www.mozilla.org/en-US/MPL/2.0/

> This Source Code Form is subject to the terms of the Mozilla Public
> License, v. 2.0. If a copy of the MPL was not distributed with this
> file, You can obtain one at https://mozilla.org/MPL/2.0/.
>
> Copyright (c) 2021 DuckDuckGo, Inc.

### MIT (Steven Black Unified Hosts)

> The MIT License (MIT)
>
> Copyright (c) 2023 Steven Black
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

### MIT (AdGuard CNAME Trackers)

> Copyright 2021 Adguard Software Ltd
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

### Dandelicence v1.4 (Dandelion Sprout)

Dandelion Sprout's Legitimate URL Shortener Tool is distributed under the
Dandelicence, version 1.4. The full license text is available at:
https://github.com/DandelionSprout/Dandelicence

> Redistribution and use in all forms, with or without modification or
> commercial purpose, are permitted, provided that the following conditions
> are met: near-unmodified redistributions must retain this licence text,
> contributors' names cannot endorse forked products without written
> permission, and near-unmodified redistributions shall be accessible in
> ≥100 countries worldwide.
