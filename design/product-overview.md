# ProtoConsent – Product overview

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Problem

Today, people are asked to make privacy and tracking decisions on almost every website they visit, but they rarely have meaningful control over how their data is actually used. Consent dialogs are fragmented per site, use inconsistent language, and are often designed with dark patterns that nudge users towards “accept all”. This produces consent fatigue: people click through banners just to access content, while regulators still expect consent to be specific, informed, and freely given. At the same time, existing tools sit at two unhelpful extremes: content blockers operate at the level of domains and filter lists, while consent management platforms (CMPs) operate at the level of each website and its vendors. There is no simple, browser‑level place where a user can say “on this site I only allow functional and analytics, never ads or advanced tracking” and have that preference enforced in a consistent way. ProtoConsent fills this missing layer: purpose‑based control at the browser level, usable by non‑experts and aligned with the legal requirement to respect user choices.

## 2. Solution: ProtoConsent in one paragraph

ProtoConsent is a purpose‑based privacy control that lives in the browser and works consistently across websites. Instead of deciding vendor by vendor in each cookie banner, the user defines high‑level profiles (for example, “Strict”, “Balanced”, “Permissive”) and purpose toggles (functional, analytics, ads/advertising, personalization, third‑party services, advanced tracking) directly in ProtoConsent’s interface. For each site, ProtoConsent stores a local rule that combines a profile with explicit overrides for specific purposes, and then applies technical enforcement via the browser’s native blocking capabilities (for instance, by using declarative network rules to prevent analytics or ads requests when those purposes are disabled). The long‑term goal is to complement the extension with an open, documented purpose‑signalling protocol and a small JavaScript SDK, so that websites and CMPs can read the user’s browser‑level preferences and adapt, without forcing people through yet another dark‑patterned banner.

## 3. Key features (MVP, today)

**Per‑site profiles:** ProtoConsent lets users assign simple profiles such as “Strict”, “Balanced”, or “Permissive” to each website, so they can quickly express their general level of trust without dealing with dozens of granular switches.

**Purpose‑based toggles:** Within each site, users can toggle individual purposes (such as functional, analytics, ads, personalisation, third‑party services, or advanced tracking) on or off, refining the profile when they care about specific data uses.

**Local‑only storage:** All rules are stored locally in the browser, without any remote server or central account, which simplifies deployment and avoids creating another privacy‑sensitive backend.

**Minimal technical enforcement:** The current design uses the browser’s declarativeNetRequest API to block network requests that correspond to disallowed purposes (for example, common analytics and ads domains), providing users with real, observable effects instead of purely symbolic settings. When privacy‑relevant purposes are denied, the extension also sends a conditional [Global Privacy Control](https://globalprivacycontrol.org/) (Sec‑GPC) header to signal the user’s opt‑out to the receiving server.

**Lightweight user interface:** A compact popup UI lets users see the active profile and purposes for the current site at a glance, and change them with a few clicks instead of reconfiguring each consent banner from scratch. A real‑time counter shows how many tracking requests have been blocked and how many outgoing requests carry the GPC privacy signal, giving users immediate, observable feedback on what ProtoConsent is doing for them.

## 4. High-level architecture

ProtoConsent is implemented as a browser extension that runs entirely on the client side, with no backend services. The extension has two main parts: a popup user interface that lets people inspect and change their settings for the current site, and a background script that stores rules, updates browser configuration, and applies enforcement through built‑in blocking APIs. A lightweight SDK (*protoconsent.js*) and a content script bridge allow websites and consent tools to read the user’s browser‑level choices directly from the page context.

At its core, ProtoConsent maintains a small data structure mapping each domain to a rule object, roughly of the shape `rules[domain] = { profile, purposes: { functional, analytics, ads, personalization, third_parties, advanced_tracking } }`. Rules are stored locally by the extension, so that the browser can apply them even when the user is offline and without contacting any external service. When a user changes the profile or toggles a purpose in the popup, the background script updates the stored rule and regenerates the corresponding browser configuration (for example, a set of declarativeNetRequest rules that match known analytics or ads endpoints). As a result, subsequent network requests from that site that match a disabled purpose are blocked by the browser before reaching the remote server, while allowed purposes continue to work as usual.

From a request‑flow perspective, ProtoConsent works in a few simple steps. First, the user opens a website and, if needed, adjusts the profile or individual purposes for that site in the ProtoConsent popup. The extension’s background script updates the local rule for that domain and refreshes the browser’s internal configuration so that it reflects the new choices. When the page (or its embedded third‑party scripts) later tries to contact external services, those network requests are checked against the active rules: requests associated with disabled purposes are blocked by the browser, while requests associated with allowed purposes continue as normal. This keeps the enforcement logic close to the user, using only standard browser capabilities, and avoids introducing new remote points of control or failure.

## 5. Roadmap

**Short‑term:** Improve the existing Chromium extension with more robust purpose handling, refine the user interface, and publish a “how to test ProtoConsent” guide for early adopters.

**Medium‑term:** Specify a small, open protocol for purpose signalling between the browser and websites, expand the extension into a reference implementation with better enforcement and multi‑browser support, and release a lightweight JavaScript SDK and demo sites that consume the user’s browser‑level preferences.

**Long‑term:** Strengthen ProtoConsent’s security posture (risk assessment, hardening, security processes) and work with regulators, browser vendors, and civil‑society organisations so that purpose‑based controls can become part of mainstream web practice.

**Internationalisation:** the extension’s user interface is structured so that all user‑facing strings can be translated. The initial focus will be on English and Spanish, with additional languages welcomed as community contributions.

## 6. Openness and licensing

ProtoConsent is developed as a free and open project from the start. The browser extension and main code are licensed under the GNU General Public License, version 3 or (at your option) any later version. The JavaScript SDK and protocol examples are licensed under the MIT License, so that websites, CMPs, and other tools can integrate ProtoConsent’s purpose‑based model without licensing friction. Project documentation, specifications, and explanatory material are licensed under the Creative Commons Attribution‑ShareAlike 4.0 International (CC BY‑SA 4.0) license, making it easy to translate, adapt, and reference in policy and technical work. All development happens in public repositories within the ProtoConsent organisation on GitHub, to support transparency, community review, and long‑term sustainability.
