# ProtoConsent – Technical architecture

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent is a client‑side system that adds purpose‑based privacy controls to the browser. It is implemented as a browser extension that stores all user rules locally and uses standard browser capabilities to enforce them. There is no central server: everything happens on the user’s device.

The extension provides a popup interface to manage profiles and purposes per site, and a background component that translates those choices into declarative network rules. A JavaScript SDK and a content script bridge allow websites to read and react to the user’s choices via a local purpose‑signalling protocol.

## 2. Components

**Popup UI** – The main user‑facing element. When opened on a site, it shows the active profile and purpose states for that domain, and lets the user switch profiles or toggle purposes. Purpose categories are shown with [Consent Commons](https://consentcommons.com/) icons for visual clarity. When a site publishes a `.well-known/protoconsent.json` declaration, the popup displays it in a collapsible side panel with icons for legal basis, sharing and international transfers. The popup does not enforce anything directly; it sends messages to the background component when settings change.

**Background script (service worker)** – Maintains per‑site rules, computes defaults for new domains, and translates user choices into declarative network rules. Enforcement stays in the browser; policy and UI logic stay in the extension.

**Local storage** – All configuration lives in the browser’s extension storage: the mapping from domains to site rules (profile plus purpose overrides) and predefined profiles. No backend, no remote calls.

**Enforcement (declarativeNetRequest + GPC)** – The background component maintains rules that match requests associated with specific purposes (analytics, ads, etc.) and blocks them when the corresponding purpose is disabled. When privacy‑relevant purposes (marked with `triggers_gpc` in `config/purposes.json`) are denied, the extension also injects a conditional `Sec-GPC: 1` header via `modifyHeaders` rules and sets `navigator.globalPrivacyControl` via a MAIN‑world content script, signalling the user's opt‑out to the receiving server. Per‑site overrides ensure that GPC is only sent where the user's preferences call for it. The core idea: express user intent as purposes, let the browser enforce it.

Per‑site GPC overrides use `requestDomains` (the destination URL), not `initiatorDomains` (the page making the request). This means that trusting a site — for example, allowing all purposes on elpais.com — removes the GPC signal from requests *to* elpais.com, but third‑party requests *from* elpais.com to domains like google‑analytics.com still carry the global GPC signal. The same applies to cross‑origin iframes: an iframe from youtube.com embedded on a trusted elpais.com page still receives GPC from the global rule. Trusting a site does not imply trusting the third parties it loads.

**protoconsent.js SDK** – A small, optional JavaScript library for web pages to read the user’s ProtoConsent preferences (e.g. whether analytics is allowed) via the content script bridge. The extension works without it; the SDK is for sites that want to adapt their behaviour to the user’s choices. TypeScript type declarations are also provided (`sdk/protoconsent.d.ts`).

![ProtoConsent technical diagram](assets/diagrams/protoconsent-technical-diagram.png)

## 3. Data model

For each domain, the extension stores a rule that combines a profile with purpose‑level overrides:

`rules[domain] = { profile, purposes: { functional, analytics, ads, personalization, third_parties, advanced_tracking } }`

where each purpose resolves to “allowed” or “denied”. By default, all purpose values are inherited from the active profile (preset). When the user overrides a specific purpose for a domain, only that override is stored; the rest continue to inherit from the profile. In storage, purpose values are booleans (`true` = allowed, `false` = denied). All data is stored locally in the browser’s extension storage in a compact format that can evolve over time through straightforward migrations.

Three predefined profiles (“Strict”, “Balanced”, “Permissive”) map directly to purpose states and act as templates. When the user selects a profile, its values fill in the purposes; any per‑purpose change after that is tracked as an explicit override.

## 4. Main flows

**User updates settings for a site** – The user opens the popup, changes the profile or individual purposes. The popup sends an update to the background, which saves the new rule and rebuilds the declarative network rules. Changes take effect immediately for new requests, usually without a page reload.

**Page loads and makes network requests** – As the user navigates, third‑party requests are evaluated against the active rules for the current site. Requests tied to disabled purposes are blocked by the browser’s declarative rules; allowed purposes proceed normally.

**Page reads preferences via SDK** – On sites that integrate the optional SDK, page code can query the user’s preferences (e.g. `get("analytics")`) and decide whether to load scripts or simplify consent prompts. This complements browser‑level enforcement — it does not replace it. A live test is available on [protoconsent.org](https://protoconsent.org/).

## 5. Security and privacy by design (non-normative)

All configuration is stored locally; the extension does not rely on remote servers, which reduces the attack surface and avoids creating central points where preferences would accumulate. The extension requests only the permissions it needs (see §6 for the full rationale) and keeps a clear separation between UI and enforcement logic.

Enforcement is based on built‑in browser APIs (declarativeNetRequest), so ProtoConsent benefits from the browser’s own sandboxing and update mechanisms. The data model is intentionally small, which makes edge cases easier to reason about. Additional safeguards (input validation, automated tests, storage hardening) can be added over time without changing the core design.

## 6. Permissions rationale

The extension requests only the permissions it needs. Each one has a specific purpose:

| Permission | Why it is needed |
|---|---|
| `tabs` | Read the active tab's URL so the popup can identify which domain the user is managing and apply per‑site rules. |
| `storage` | Persist user rules, profiles, and preferences locally in the browser's extension storage. No remote storage is used. |
| `scripting` | Register the GPC content script (`gpc-signal.js`) into the MAIN world at runtime via `chrome.scripting.registerContentScripts`, so that `navigator.globalPrivacyControl` is set only on pages where the user's preferences require it. |
| `declarativeNetRequest` | Create and manage dynamic blocking rules that enforce the user's purpose choices by blocking third‑party requests associated with denied purposes. Also used for conditional `Sec-GPC: 1` header injection via `modifyHeaders` rules. |
| `declarativeNetRequestFeedback` | Query which DNR rules matched on the current tab (`getMatchedRules`) so the popup can display how many requests were blocked and how many received the GPC signal. This is a read‑only, diagnostic permission — it does not change enforcement behaviour. |
| `host_permissions: <all_urls>` | Required by `declarativeNetRequest` to apply blocking and header rules across all domains, and by `scripting` to inject the GPC content script on any site. Without broad host access, per‑site enforcement would not work. |

The content script declared in the manifest (`content-script.js`) runs in the ISOLATED world and acts as a message bridge between the page‑level SDK and the extension's background. It does not access or modify page content.

## 7. Extensibility

New purposes can be added as fields in the site rule without breaking existing preferences. Support for more browsers reuses the same concepts (popup, background, local storage, enforcement) and adapts only platform‑specific details.

The optional SDK and purpose‑signalling protocol are documented layers on top of the extension, not hard dependencies. Websites can adopt them at their own pace while the extension continues to work on its own. This lets ProtoConsent evolve as an open building block that others can adapt or embed without adopting the entire stack.
