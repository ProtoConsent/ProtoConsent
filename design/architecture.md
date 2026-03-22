# ProtoConsent – Technical architecture

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 1. Overview

ProtoConsent is a client‑side system that adds purpose‑based privacy controls to the browser. It is implemented as a browser extension that stores all user rules locally and uses only standard browser capabilities to enforce them. There is no central server: configuration and enforcement happen on the user’s device, under the user’s control. The extension exposes a simple popup interface for people to manage profiles and purposes per site, and a background component that translates those choices into concrete browser behaviour (for example, by installing or updating declarative network rules). Over time, ProtoConsent is designed to be complemented by a small JavaScript SDK and an open purpose‑signalling protocol, so that websites and consent tools can read and react to the user’s browser‑level choices.

## 2. Components

**Browser extension (popup UI)** – The popup is the main user‑facing element of ProtoConsent. When the user opens it on a given site, it shows the active profile and the state of each purpose for that domain, and lets people switch profiles or toggle purposes on or off. The popup does not apply enforcement directly; instead, it sends messages to the background component whenever the user updates a setting.

**Browser extension (background script / service worker)** – The background part of the extension maintains the internal state of ProtoConsent: it stores the per‑site rules, computes defaults for new domains, and translates user choices into browser configuration. In particular, it derives and updates declarative network rules so that requests associated with disabled purposes can be blocked or modified by the browser itself. This keeps enforcement close to the browser, while policy and UI logic stay in the extension.

**Local storage** – ProtoConsent keeps its configuration as a compact data structure in the browser’s extension storage. This includes the mapping from domains to site rules (profile plus purpose toggles) and any global defaults or predefined profiles. Storing everything locally avoids introducing a separate backend, reduces latency, and makes it easier for users to reason about where their choices live.

**Enforcement mechanism** – On platforms that support it, ProtoConsent relies on the browser’s declarative network APIs to implement enforcement. The background component maintains a set of rules that match requests typically associated with specific purposes (for example, analytics or ads/advertising), and instructs the browser to block those requests when the corresponding purpose is disabled. Other enforcement mechanisms can be added over time, but the core idea is simple: express user intent in terms of purposes and let the browser apply it.

**Future protoconsent.js SDK** – A small, optional JavaScript SDK is planned to run inside web pages. Its goal is to offer a simple API for websites and consent tools to read the user’s ProtoConsent preferences (for example, whether analytics is allowed for a site) and adapt their behaviour accordingly. The SDK is meant to be lightweight and optional: ProtoConsent remains usable as a pure browser‑side tool even on sites that never integrate the SDK.

![ProtoConsent technical diagram](assets/diagrams/protoconsent-technical-diagram.png)

## 3. Data model

ProtoConsent keeps a simple, explicit data model centered around site rules. For each domain, the extension stores a rule object that combines a high‑level profile with a set of purpose‑level overrides. Conceptually, this can be represented as:

`rules[domain] = { profile, purposes: { functional, analytics, ads, personalization, third_parties, advanced_tracking } }`

where each purpose can be in a state such as “allowed”, “denied”, or “inherit from profile”. All of this information is stored locally in the browser’s extension storage in a compact, serialisable format that can evolve over time. When the data model changes between versions (for example, adding a new purpose or a new field), ProtoConsent applies straightforward migrations so that existing users keep their choices.

In addition to per‑site rules, ProtoConsent defines a small set of predefined profiles (for instance, “Strict”, “Balanced”, “Permissive”) that map directly to purpose states. Profiles act as reusable templates: when a user selects a profile for a site, ProtoConsent fills in purpose values from that template and then tracks any explicit overrides the user applies. This separation between profiles and concrete purpose states makes it easier to offer a simple UI while still keeping the underlying data model precise and extensible. This also prepares future interoperability, where profiles and purpose states can be exposed through a documented protocol and used by other tools.

## 4. Main flows

**User updates settings for a site** – When a user opens the ProtoConsent popup on a given website and changes the profile or individual purposes, the popup sends an update message to the background component. The background script updates the corresponding site rule in local storage and recomputes any browser‑level configuration needed to reflect the new choices (for example, updating the set of declarative network rules). The change takes effect immediately for new requests from that site, often without needing a page reload.

**Page loads and makes network requests** – As the user navigates, the browser loads pages that may include first‑party resources and third‑party scripts or iframes. When those resources try to contact external services, their network requests are evaluated against the active ProtoConsent rules for the current site. Requests associated with purposes that are disabled in the site rule are blocked (or otherwise handled) by the browser according to the installed declarative rules, while requests associated with allowed purposes proceed as normal. This turns high‑level purpose choices into concrete effects on which trackers and services can run.

**(Future) Page reads preferences via SDK** – On sites that choose to integrate it, the optional protoconsent.js SDK can expose a small API that lets page code query the user’s purpose preferences as seen by ProtoConsent (for example, `get("analytics")`). The page or its consent tool can then decide whether to load certain scripts, display a simplified consent dialog, or skip some prompts altogether when a clear browser‑level decision already exists. This flow is designed to complement, not replace, enforcement at the browser level, and to reduce the need for users to repeat the same decisions on every site.

## 5. Security and privacy by design (non-normative)

ProtoConsent is built around a few simple security and privacy choices. All configuration is stored locally in the browser’s extension storage, and the extension does not rely on remote servers for core functionality, which reduces the attack surface and avoids creating new central points where sensitive data or preferences would accumulate. The extension is designed to request only the permissions it needs to operate (such as access to the active tab and the ability to install declarative network rules), and to keep a clear separation between the user interface and the enforcement logic.

By basing enforcement on built‑in browser capabilities rather than custom network code, ProtoConsent benefits from the browser’s existing sandboxing and update mechanisms. The internal data model is intentionally small and explicit, which makes it easier to understand edge cases and review changes. Over time, additional safeguards can be added (for example, more systematic input validation, automated tests, or hardening of storage and rule updates), but the core design already aims to minimise the amount of data handled and to keep control as close to the user’s device as possible.

## 6. Extensibility

ProtoConsent’s architecture is intentionally modular so that it can grow without forcing breaking changes on existing users. New purposes can be added to the data model and user interface as additional fields in the site rule, while preserving existing preferences and profiles through simple migration steps. Support for more browsers can be developed by reusing the same core concepts (popup, background script, local storage, enforcement layer) and adapting only the platform‑specific details of permissions and blocking APIs.

On the integration side, the optional protoconsent.js SDK and any future purpose‑signalling protocol are designed to be small, documented layers on top of the extension, not hard dependencies. Websites and consent tools remain free to adopt them at their own pace, while the extension continues to provide value on its own through browser‑level enforcement. This separation lets ProtoConsent evolve as an open building block that others can adapt, extend, or embed in larger privacy solutions without adopting the entire stack.
