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
- A real‑time counter shows how many tracking requests have been blocked and how many outgoing requests carry the GPC privacy signal, giving users immediate, visible feedback on enforcement activity.
- When advanced tracking is denied, high‑entropy Client Hints headers (Sec‑CH‑UA‑*) are stripped to reduce fingerprinting surface, with a global toggle in Purpose Settings.
- When an IAB TCF consent management platform (CMP) is detected on the page, a pill indicator appears in the popup with the CMP's consent state, so users can compare what the site's banner is doing with what ProtoConsent enforces at the network level.
- A badge on the extension icon provides a per‑tab at‑a‑glance count.
- A dedicated Log tab provides three views: a real‑time request log showing blocked and GPC events as they happen, a Domains panel listing every blocked domain grouped by purpose with Consent Commons icons, and a GPC panel tracking which domains received the Sec‑GPC header with request counts and timestamps.
- All counters and log panels work in both developer and production (store) builds.
- All log panels include a copy‑to‑clipboard button for easy sharing and debugging.
- Purpose categories and site declarations are illustrated with icons from the [Consent Commons](https://consentcommons.com/) visual system, providing a familiar and consistent visual language across the interface.

**Domain whitelist:** Users can allow specific blocked domains directly from the Domains panel in the Log tab. Each whitelist entry can be scoped per site (only takes effect on the current website) or globally (all sites), with a one‑click scope toggle. The Whitelist tab provides a central view of all allowed domains with active‑domain highlighting when a whitelisted domain loads on the current page.

**Enhanced protection:** Users can optionally activate curated third‑party blocklists for broader coverage beyond the core static rulesets. 13 lists from trusted open‑source projects (EasyList, EasyPrivacy, AdGuard, HaGeZi, Steven Black, OISD, 1Hosts, Blocklist Project) are available, organized in three presets (Off, Balanced, Full) or with individual list control. Lists are fetched on demand from public CDN sources and stored locally. The Enhanced tab in the popup provides preset selection, per‑list download/toggle/remove controls, and status indicators. Enhanced blocks appear in the Log tab with a shield icon alongside category icons where applicable.

**Site declarations:** Websites can publish a [`.well-known/protoconsent.json`](spec/protoconsent-well-known.md) file to declare their data practices. The extension reads this file and displays the site's declared purposes, legal bases, providers, and data handling details in a side panel, using [Consent Commons](https://consentcommons.com/) icons. No SDK or code changes required - just a static JSON file, like `robots.txt` or `security.txt`.

**Purpose‑signalling protocol and SDK:** An open [protocol](spec/signalling-protocol.md) and a lightweight [JavaScript SDK](../sdk/protoconsent.js) (MIT licensed) allow websites to query the user's consent preferences directly from the page. The SDK returns simple boolean values per purpose - no identity, no cross‑site tracking. Blocking works regardless of whether sites integrate the SDK.

**Onboarding:** A welcome page guides first‑time users through choosing a default privacy profile, so the extension works out of the box without requiring manual configuration.

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
| v0.1.0 | Purpose/preset data models, per-domain rules in storage, DNR enforcement (global + per-site), popup UI (profiles, toggles), [JavaScript SDK](../sdk/protoconsent.js) + [TypeScript declarations](../sdk/protoconsent.d.ts), content script bridge |
| v0.1.1 | Static rulesets + path-based blocking, blocked request counter (per-tab, per-purpose, domain detail), conditional [GPC signal](https://globalprivacycontrol.org/) (Sec-GPC + navigator.globalPrivacyControl), [.well-known side panel](spec/protoconsent-well-known.md) with [Consent Commons](https://consentcommons.com/) icons, debug panel |
| v0.2.0 | 40 000+ curated tracker domains + 1 200+ path rules ([blocklists.md](blocklists.md)), onboarding welcome page, purpose settings page, full-featured demo on [demo.protoconsent.org](https://demo.protoconsent.org) |
| v0.2.1 | Log monitoring tab (real-time request log, blocked domains by purpose, GPC tracking), session persistence, webRequest visibility for production builds |
| v0.2.2 | Domain whitelist (per-site + global scope, priority-3 DNR allow rules, budget guard) |
| v0.3.0 | Enhanced Protection: 13 optional third-party blocklists with presets (Off/Balanced/Full/Custom), on-demand CDN fetch, Enhanced tab UI, enhanced scope in consent view, purposes-settings enhanced presets, Client Hints stripping, CNAME cloaking detection, Cookie banner detection |
| **Website** | [Online validator](https://protoconsent.org/validate.html) for .well-known declarations, live SDK demo on [protoconsent.org](https://protoconsent.org/), full-featured demo on [demo.protoconsent.org](https://demo.protoconsent.org) |
| **Documentation** | [Protocol spec](spec/signalling-protocol.md), [.well-known spec](spec/protoconsent-well-known.md), [design-rationale.md](design-rationale.md), [architecture overview](architecture.md), [testing guide](testing-guide.md), [blocklist methodology](blocklists.md) |

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
