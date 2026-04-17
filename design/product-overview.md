# ProtoConsent: Product overview

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Problem

Today, people are asked to make privacy and tracking decisions on almost every website they visit, but they rarely have meaningful control over how their data is actually used. Consent dialogs are fragmented per site, use inconsistent language, and are often designed to encourage acceptance. This produces consent fatigue: people click through banners just to access content, while regulators still expect consent to be informed and specific.

Existing tools sit at two extremes: content blockers operate at the level of domains and filter lists, while consent management platforms (CMPs) operate at the level of each website and its vendors. There is no simple, browser‑level place where a user can say “on this site I only allow functional and analytics, never ads or advanced tracking” and have it enforced consistently.

ProtoConsent fills this missing layer: purpose‑based control at the browser level, usable by non‑experts.

## 2. Solution: ProtoConsent in one paragraph

ProtoConsent is a purpose‑based privacy control that lives in the browser and works consistently across websites. Instead of deciding vendor by vendor in each cookie banner, the user defines high‑level profiles (for example, “Strict”, “Balanced”, “Permissive”) and purpose toggles (functional, analytics, ads/advertising, personalization, third‑party services, advanced tracking) directly in ProtoConsent’s interface.

For each site, ProtoConsent stores a local rule that combines a profile with explicit overrides for specific purposes, and then blocks matching requests using the browser’s built‑in APIs. The extension includes an open, documented [purpose‑signalling protocol](spec/signalling-protocol.md) and a small [JavaScript SDK](../sdk/protoconsent.js) (MIT licensed), so that websites and CMPs can read the user’s browser‑level preferences and adapt, without requiring another banner. Websites can also publish a [`.well-known/protoconsent.json`](spec/protoconsent-well-known.md) file to declare their data practices without any code changes.

## 3. Key features

**Per‑site profiles:** ProtoConsent lets users assign simple profiles such as “Strict”, “Balanced”, or “Permissive” to each website, so they can quickly express their general level of trust without dealing with dozens of granular switches.

**Purpose‑based toggles:** Within each site, users can toggle individual purposes (such as functional, analytics, ads, personalisation, third‑party services, or advanced tracking) on or off, refining the profile when they care about specific data uses.

**Local‑only storage:** All rules are stored locally in the browser, without any remote server or central account.

**Network‑level enforcement:** The current design uses the browser’s declarativeNetRequest API to block network requests that correspond to disallowed purposes. Enforcement is based on curated blocklists organized by purpose in static rulesets (domain‑based and path‑based), with dynamic per‑site overrides that respect the user’s profile without touching the global rules. When privacy‑relevant purposes are denied, the extension also sends a conditional [Global Privacy Control](https://globalprivacycontrol.org/) (Sec‑GPC) header.

**Lightweight user interface:**

- A compact popup UI lets users see the active profile and purposes for the current site at a glance, and change them with a few clicks instead of reconfiguring each consent banner from scratch.
- The popup supports light and dark themes, configurable from Purpose Settings (Auto/Light/Dark). Auto mode follows the operating system preference.
- The popup provides four views accessible via a vertical tab rail: **Purposes** (purpose toggles and blocked stats), **Protection** (optional third-party blocklists), **Overview** (operating mode dashboard with signal status, purpose-attributed blocks, CMP detection, and cosmetic filtering), and **Log** (real-time request monitoring, blocked domains, GPC tracking, whitelist management, debug).
- A real-time counter and badge show how many tracking requests have been blocked and how many carry the GPC privacy signal, giving users immediate, visible feedback on enforcement activity.
- When advanced tracking is denied, high-entropy Client Hints headers (Sec-CH-UA-*) are stripped to reduce fingerprinting surface, with a global toggle in Purpose Settings.
- URL tracking parameters (`utm_source`, `fbclid`, `gclid`, etc.) are stripped from navigations via declarativeNetRequest redirect rules with `queryTransform.removeParams`. Stripped parameters are detected via `webNavigation` (comparing the original URL against the committed URL) and displayed in the Overview tab accordion and the Log tab request stream.
- When an IAB TCF consent management platform (CMP) is detected on the page, a pill indicator appears in the popup with the CMP's consent state, so users can compare what the site's banner is doing with what ProtoConsent enforces at the network level.
- A dedicated Log tab provides a real-time request log, blocked domains grouped by purpose, and GPC signal tracking per domain.
- Purpose categories and site declarations are illustrated with [Consent Commons](https://consentcommons.com/) icons, providing a consistent visual language across the interface.

**Domain whitelist:** Users can allow specific blocked domains directly from the Domains panel in the Log tab. Each whitelist entry can be scoped per site (only takes effect on the current website) or globally (all sites), with a one-click scope toggle. The Whitelist tab provides a central view of all allowed domains with active-domain highlighting when a whitelisted domain loads on the current page.

**Enhanced protection:** Users can optionally activate curated enhanced blocklists for broader coverage beyond the core static rulesets. 19 non-regional lists are available - 5 ProtoConsent Core lists that update weekly via CDN and 14 third-party lists from trusted open-source projects - plus 2 regional catalog entries covering 13 regions with language-specific blocking and cosmetic rules. Lists are organized in three presets (Off, Balanced, Full) or with individual list control. Regional lists are included in Balanced and Full presets when the user has selected at least one language. Remote fetching requires explicit user consent, offered during onboarding and in Purpose Settings. Lists are stored locally after download. A consent-enhanced link bridges consent purposes with Enhanced lists: denying a purpose automatically activates Enhanced lists matching that category, even if the preset is Off. Cosmetic filtering hides ad containers left empty after network-level blocking via CSS injection. Enhanced blocks appear in the Log tab with a shield icon alongside category icons.

> Third-party list sources: EasyList, EasyPrivacy, AdGuard DNS, HaGeZi, Steven Black, OISD, 1Hosts, Blocklist Project, AdGuard CNAME Trackers. See [blocklists.md](blocklists.md) for the full catalog.

**Site declarations:** Websites can publish a [`.well-known/protoconsent.json`](spec/protoconsent-well-known.md) file to declare their data practices. The extension reads this file and displays the site's declared purposes, legal bases, providers, and data handling details in a side panel, using [Consent Commons](https://consentcommons.com/) icons. No SDK or code changes required - just a static JSON file, like `robots.txt` or `security.txt`.

**Operating modes:** ProtoConsent supports two operating modes, selectable in Purpose Settings. In *Standalone* mode (default), the extension blocks requests directly using its own static and dynamic rulesets. In *ProtoConsent Mode*, the extension delegates network blocking to an external blocker (such as uBlock Origin, AdGuard, or Brave Shields) and focuses on purpose attribution, GPC signaling, CMP auto-response, cosmetic filtering, and Client Hints stripping. A dedicated Proto tab in the popup shows the current mode, signal status (GPC, CMP detection, cosmetic filtering), purpose-attributed blocks with domain detail, and CMP auto-response state. A semaphore indicator in the popup header shows the active mode at a glance (green for ProtoConsent Mode, red for Standalone). The mode is stored locally and triggers an immediate rebuild on change.

The two modes share the same consent engine: attribution indexes, GPC policy, CMP cookie injection, Client Hints stripping, and cosmetic hiding work identically in both modes. Only the enforcement strategy changes - standalone generates DNR block rules, while ProtoConsent Mode disables its own blocking and observes `ERR_BLOCKED_BY_CLIENT` events from external sources. A capabilities table gates mode-dependent behaviour:

| Capability | Standalone | ProtoConsent Mode |
|---|---|---|
| Own blocking (static + dynamic rulesets) | Yes | No |
| Observe external blocks | Yes | Yes |
| Whitelist overrides | Yes | No |
| Enhanced DNR rules | Yes | No |
| GPC signaling | Yes | Yes |
| CMP auto-response | Yes | Yes |
| Client Hints stripping | Yes | Yes |
| Cosmetic filtering | Yes | Yes |

**Purpose‑signalling protocol and SDK:** An open [protocol](spec/signalling-protocol.md) and a lightweight [JavaScript SDK](../sdk/protoconsent.js) (MIT licensed) allow websites to query the user's consent preferences directly from the page. The SDK returns simple boolean values per purpose - no identity, no cross‑site tracking. Blocking works regardless of whether sites integrate the SDK.

**Onboarding:** A welcome page guides first-time users through four screens: (1) choosing a default privacy profile, (2) a feature overview, (3) opting into Enhanced lists sync and the consent-enhanced link, and (4) confirmation with next steps. The extension works out of the box without requiring manual configuration.

**CMP auto-response:** Consent banners from 23 CMP frameworks (including IAB TCF v2.2) are answered automatically based on the user's purpose preferences. ProtoConsent injects the consent cookies that each CMP expects, so banners never appear. A cosmetic CSS layer hides banners as a safety net, and a scroll-unlock mechanism restores normal page behaviour. For IAB TCF-compliant CMPs, the extension generates a valid TCF v2.2 Transparency and Consent String. See [cmp-auto-response.md](cmp-auto-response.md).

## 4. High-level architecture

ProtoConsent is implemented as a browser extension that runs entirely on the client side. The extension has two main parts: a popup user interface that lets people inspect and change their settings for the current site, and a background script that stores rules, updates browser configuration, and applies enforcement through built‑in blocking APIs. A lightweight SDK (*protoconsent.js*) and a content script bridge allow websites and consent tools to read the user’s browser‑level choices directly from the page context.

At its core, ProtoConsent maintains a small data structure mapping each domain to a rule object, roughly of the shape `rules[domain] = { profile, purposes: { functional, analytics, ads, personalization, third_parties, advanced_tracking } }`. Rules are stored locally by the extension, so that the browser can apply them even when the user is offline. When a user changes the profile or toggles a purpose in the popup, the background script updates the stored rule and rebuilds the blocking rules (for example, a set of declarativeNetRequest rules that match known analytics or ads endpoints). As a result, subsequent network requests from that site that match a disabled purpose are blocked by the browser before reaching the remote server.

The user opens a website and, if needed, adjusts the profile or individual purposes for that site in the ProtoConsent popup. The extension’s background script updates the local rule for that domain and refreshes the browser’s internal configuration so that it reflects the new choices. When the page (or its embedded third‑party scripts) later tries to contact external services, those network requests are checked against the active rules: requests associated with disabled purposes are blocked by the browser, while requests associated with allowed purposes continue as normal. This keeps the enforcement logic close to the user, using only standard browser capabilities.

## 5. Roadmap

**Current focus:** Import/export of user configuration, `.well-known` declaration generator, core blocklist refresh, and ecosystem outreach (pilot sites publishing declarations).

**Planned:** Firefox support, internationalisation, protocol formalisation (the protocol is currently a working draft; formal standardisation is a long-term goal pending real-world adoption).

**Long‑term:** Strengthen ProtoConsent’s security posture (risk assessment, hardening, security processes) and work with regulators, browser vendors, and civil‑society organisations so that purpose‑based controls can become part of mainstream web practice.

**Already delivered:**

| Version | Features |
|---------|----------|
| v0.1.0 | Purpose-based consent model, per-domain rules, DNR enforcement (global + per-site), popup UI with profile and purpose toggles, [JavaScript SDK](../sdk/protoconsent.js) with [TypeScript declarations](../sdk/protoconsent.d.ts) |
| v0.1.1 | Static rulesets with path-based blocking, blocked request counter, conditional [GPC signal](https://globalprivacycontrol.org/), [.well-known side panel](spec/protoconsent-well-known.md) with [Consent Commons](https://consentcommons.com/) icons, debug panel |
| v0.2.0 | 40 000+ curated tracker domains and 1 200+ path rules ([blocklists.md](blocklists.md)), onboarding page, purpose settings page, [demo site](https://demo.protoconsent.org) |
| v0.2.1 | Log monitoring tab (real-time request log, blocked domains by purpose, GPC tracking), session persistence |
| v0.2.2 | Domain whitelist with per-site and global scope |
| v0.3.0 | Enhanced Protection: 14 optional third-party lists with presets (Off/Balanced/Full/Custom), CDN fetch with consent gate, consent-enhanced link, cosmetic filtering (EasyList CSS injection), Client Hints stripping, CNAME cloaking detection, cookie banner detection |
| v0.4.0 | Inter-extension messaging API ([spec](spec/inter-extension-protocol.md)), ProtoConsent Core lists (5 purpose-based, weekly CDN updates via [GitHub Actions](https://github.com/ProtoConsent/data)) |
| v0.4.1 | Fixes: HTTP cache bypass for list fetch, Core download side-effects. Improved: GPC tooltip, accessibility |
| v0.4.2 | CMP auto-response: banner suppression for 22 CMP frameworks via cookie injection, IAB TCF v2.2 TC String, scroll unlock, CDN-based signature updates ([cmp-auto-response.md](cmp-auto-response.md)) |
| v0.4.3 | CMP banner detection (285 CSS detectors), localStorage consent observation, cookie consent decoders (OneTrust, Cookiebot, CookieYes, Complianz, Wix), MAIN world security hardening |
| v0.5.0 | Operating modes (Standalone/ProtoConsent Mode) with capabilities gating, Overview tab dashboard, URL parameter stripping (~300 global + ~1800 site-specific params), blocker detection, block provenance |
| v0.5.1 | Regional filter lists (13 language-specific blocking and cosmetic filters), popup UI refactor (tabs renamed to Purposes/Protection/Overview/Log, modular JS extraction), post-reload counter polling, bug fixes |
| v0.5.3 | Dark mode with user-controlled theme toggle (auto/light/dark), WCAG AA contrast compliance, signals bar summary improvements, side panel layout refinements |
| v0.5.4 | Fix: restore GPC signal priority cascade in summary, stop inverting consent-linked icon in dark mode |
| **Website** | [Online validator](https://protoconsent.org/validate.html) for .well-known declarations, live SDK demo on [protoconsent.org](https://protoconsent.org/), full-featured demo on [demo.protoconsent.org](https://demo.protoconsent.org) |
| **Documentation** | [Protocol spec](spec/signalling-protocol.md), [.well-known spec](spec/protoconsent-well-known.md), [inter-extension protocol](spec/inter-extension-protocol.md), [CMP auto-response](cmp-auto-response.md), [design-rationale.md](design-rationale.md), [architecture overview](architecture.md), [testing guide](testing-guide.md), [blocklist methodology](blocklists.md) |

## 6. Scope and non‑goals

ProtoConsent is designed to implement browser‑side, purpose‑based privacy controls. Its scope is bounded.

### In scope

- User‑side expression and enforcement of consent preferences, organised by purpose
- Purpose‑based abstractions that are accessible to non‑experts and aligned with major privacy framework categories
- Voluntary, informational declarations by websites (`.well-known/protoconsent.json`)
- Observable, auditable feedback on network‑level effects (blocked requests, GPC signals, Client Hints stripping, logs)
- Compliance signalling: purpose alignment, legal basis transparency, conditional GPC emission, anti‑fingerprinting (Client Hints)
- Optional enhanced protection via curated third‑party blocklists

### Out of scope

- Defining or enforcing legal compliance: ProtoConsent provides compliance signalling and enforcement mechanisms, but does not determine whether a site's declared legal basis is valid. That remains a contextual, external assessment.
- Acting as a consent management platform (CMP): ProtoConsent does not manage consent on behalf of sites or negotiate with vendors.
- Replacing site‑side consent mechanisms: the extension complements existing consent tools, it does not replace them.
- Guaranteeing control over all forms of data processing: browser‑level enforcement cannot prevent server‑side processing, first‑party abuse, or offline correlation.


### Research focus

ProtoConsent explores how legally defined concepts (purposes, legal bases, sharing, transfers) can be expressed and understood by end users through practical interfaces. It also investigates whether consent with **observable outcomes** changes user trust and engagement compared to traditional banner flows.

For the full design rationale, including premises, trade‑offs, and boundary definitions, see [design-rationale.md](design-rationale.md).

## 7. Openness and licensing

ProtoConsent is developed as a free and open project from the start. The browser extension and main code are licensed under the GNU General Public License, version 3 or (at your option) any later version. The JavaScript SDK and protocol examples are licensed under the MIT License, so that websites, CMPs, and other tools can integrate ProtoConsent’s purpose‑based model without license constraints. Project documentation, specifications, and explanatory material are licensed under the Creative Commons Attribution‑ShareAlike 4.0 International (CC BY‑SA 4.0) license, making it easy to translate, adapt, and reference in policy and technical work. All development happens in public repositories within the ProtoConsent organisation on GitHub.
