# ProtoConsent

<p align="center">
  <img src="design/assets/logo/protoconsent_logo.png" alt="ProtoConsent logo" width="160">
</p>

<p align="center"><strong>Consent you can express, enforce and observe</strong></p>

<p align="center"><em>User‑side, purpose‑based consent for the web</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.1-blue" alt="version 0.5.1">
  <img src="https://img.shields.io/github/license/ProtoConsent/ProtoConsent" alt="GPL-3.0+">
  <img src="https://img.shields.io/badge/manifest-v3-green" alt="Manifest V3">
  <img src="https://img.shields.io/badge/chromium-supported-brightgreen?logo=googlechrome&logoColor=white" alt="Chromium">
  <img src="https://img.shields.io/badge/firefox-planned-lightgrey?logo=firefox&logoColor=white" alt="Firefox planned">
</p>

ProtoConsent is a browser extension that lets you control how websites may use your data, expressed in terms of purposes (functional, analytics, ads, personalisation, third‑party services, advanced tracking) rather than specific trackers or domains. Not a full ad blocker, not a CMP: a personal consent control panel that lives in the browser and can coexist with existing blockers and consent tools.

It works in two operating modes: **Standalone** (default) enforces purpose-based blocking directly via declarativeNetRequest. **ProtoConsent Mode** delegates blocking to an external ad blocker while ProtoConsent provides purpose attribution, coverage metrics, and signal observability - turning any blocker into a purpose-aware system.

No central server, no tracking, no sharing of personal data. Everything stays in your browser.

**Project website:** <https://protoconsent.org> · **Live demo:** <https://demo.protoconsent.org>

> Pending review in Chrome Web Store, Edge Add-ons, and Opera Addons. In the meantime, install locally in developer mode on any Chromium-based browser.

## Key features

- **Two operating modes:** Standalone (full blocking) or ProtoConsent Mode (monitoring and attribution with an external blocker). Switch from Purpose Settings. The Overview tab dashboard shows mode status, coverage metrics, signal indicators, purpose-attributed blocks, CMP detection, and parameter stripping - all in one view.
- **Per‑site profiles and purpose toggles:** assign a trust level (Strict, Balanced, Permissive) to each website and refine individual purposes (functional, analytics, ads, personalisation, third‑party services, advanced tracking).
- **Consent banner auto-response:** cookie consent popups from 31 CMP frameworks (including IAB TCF v2.2) are answered automatically based on your purpose preferences. No DOM interaction, no click simulation, no waiting for the banner to render. Signatures updated via CDN alongside Enhanced lists. See [cmp-auto-response.md](design/cmp-auto-response.md).
- **Conditional [Global Privacy Control](https://globalprivacycontrol.org/)** (Sec‑GPC), sent only when privacy‑relevant purposes are denied, per site, not globally.
- **Network‑level enforcement** of purpose‑based decisions via curated blocklists organised by purpose, with visible results (blocked counts, domain detail). See [blocklists.md](design/blocklists.md).
- **Optional enhanced protection** with 19 curated enhanced lists (5 ProtoConsent Core purpose-based lists plus EasyList, EasyPrivacy, AdGuard, HaGeZi, Steven Black, OISD, 1Hosts, Blocklist Project, AdGuard CNAME Trackers) plus regional filter lists for 13 languages, including cosmetic filtering (element-hiding CSS). Three presets (Off, Balanced, Full) or individual list selection. Remote fetch gated behind an explicit consent toggle. Consent-enhanced link optionally auto-activates lists matching denied purposes.
- **Inter-extension API:** other browser extensions can query the user's consent state via `chrome.runtime.sendMessage`, with TOFU trust model and rate limiting. See the [protocol spec](design/spec/inter-extension-protocol.md).
- **Banner detection and observation:** CSS-based detection of 290+ CMP banners (via Autoconsent data), site-specific hiding rules for 237+ sites, cookie consent state decoding and comparison against your preferences. CMP activity is visible in the Log tab as banner and consent lines.
- **URL parameter stripping:** removes tracking parameters (utm_source, fbclid, gclid, msclkid, and ~300 more) from URLs before they reach the server, plus ~1,800 site-specific parameters across ~880 domains. Stripped parameters are shown in the Overview tab and Log tab.
- **Visibility:** real‑time log monitoring, blocked domains grouped by purpose with [Consent Commons](https://consentcommons.com/) icons, GPC signal tracking, Client Hints status, cookie consent detection, CNAME trackers and domain whitelist management.
- **Light and dark themes:** the popup adapts to your system preference or can be set to light or dark manually from Purpose Settings.
- **Site declarations:** websites can publish a `.well-known/protoconsent.json` to declare their data practices. No SDK or code changes required.
- **JavaScript SDK** (MIT licensed) for web pages to query user preferences. TypeScript declarations included.

For a detailed feature breakdown, see [product-overview.md](design/product-overview.md).

## Getting started

ProtoConsent is pending review in extension stores. To try it now:

1. Clone this repository.
2. Open `chrome://extensions/` (or `edge://extensions/`) and enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Open any site and click the ProtoConsent icon in the toolbar.

On first install, a four-screen onboarding page will guide you through selecting a default privacy profile and opting into Enhanced lists features. You can then adjust per-site settings from the popup at any time.

To see the extension in action without configuring anything, visit [demo.protoconsent.org](https://demo.protoconsent.org). It includes a site declaration, an SDK live test, and a GPC signal check.

For step‑by‑step instructions and test scenarios, see [testing-guide.md](design/testing-guide.md).

## Screenshots

<table>
<tr>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-profile.png" alt="ProtoConsent popup" width="400" height="560"></td>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-profile-dark.png" alt="ProtoConsent popup (dark mode)" width="400" height="560"></td>
</tr>
<tr>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-protection-balanced.png" alt="Enhanced Protection tab" width="400" height="560"></td>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-protection-balanced-dark.png" alt="Enhanced Protection tab (dark mode)" width="400" height="560"></td>
</tr>
<tr>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-overview-monitoring.png" alt="Overview tab dashboard" width="400" height="560"></td>
<td align="center" width="50%"><img src="design/assets/screenshots/popup-log-domains-dark.png" alt="Log tab with blocked domains (dark mode)" width="400" height="560"></td>
</tr>
</table>

### Site declaration

Websites can publish a `.well-known/protoconsent.json` to declare their data practices. The extension displays it in a side panel with [Consent Commons](https://consentcommons.com/) icons alongside the user's own preferences.

<table>
<tr>
<td align="center"><img src="design/assets/screenshots/well-known-demo-detected-dark.png" alt="Site declaration side panel (dark mode)"></td>
</tr>
</table>

## For websites

ProtoConsent offers two ways for websites to participate, both optional:

- **Publish a site declaration:** serve a static `.well-known/protoconsent.json` file to declare your data practices (purposes, legal bases, providers, retention, sharing scope). No SDK, no code changes, just a JSON file. See the [spec](design/spec/protoconsent-well-known.md), the [JSON Schema](docs/schema/v0.2.json), the [demo site source](https://github.com/ProtoConsent/demo) for a complete example, or use the online tools: [generator](https://protoconsent.org/generate.html), [validator](https://protoconsent.org/validate.html), [CI action](https://github.com/ProtoConsent/validate-action).
- **Integrate the SDK:** import `sdk/protoconsent.js` (MIT) and call `get('analytics')` to read the user's preferences. Returns `true`, `false`, or `null` (extension not installed). See the [quick example](design/spec/signalling-protocol.md#quick-example) and [SDK source](sdk/protoconsent.js).
- **List your site in the directory:** if your site already serves a declaration, [add it to the public directory](https://github.com/ProtoConsent/ProtoConsent/issues/new?template=add-site.yml) — your file will be validated automatically. Browse the [directory](https://protoconsent.org/directory.html).

For a visual walkthrough of both paths, see [protoconsent.org/developers](https://protoconsent.org/developers.html).

## Architecture

![ProtoConsent technical diagram](design/assets/diagrams/protoconsent-technical-diagram.png)

See [architecture.md](design/architecture.md) for the full technical description.

## Documentation

**Concepts and design**
- [Design rationale](design/design-rationale.md) – premises, trade‑offs, boundaries, and non‑goals
- [Product overview](design/product-overview.md) – problem, solution, features, scope, and roadmap

**Specifications**
- [Purpose-signalling protocol](design/spec/signalling-protocol.md) - data model, communication mechanism, SDK API
- [Site declaration spec](design/spec/protoconsent-well-known.md) - `.well-known/protoconsent.json` format
- [JSON Schema](docs/schema/v0.2.json) - machine-readable schema for `protoconsent.json` (v0.2)
- [Blocklists methodology](design/blocklists.md) - sources, curation, DNR format, enhanced lists

**Implementation**
- [Technical architecture](design/architecture.md) – components, data model, flows, design decisions
- [CMP auto-response](design/cmp-auto-response.md) – consent banner suppression, CMP signatures, TC String generation
- [Testing guide](design/testing-guide.md) – installation, test scenarios
- [Icons and layers](design/icons-and-layers.md) – visual language and icon mapping

## What's next

- SDK `onchange` API for real-time site adaptation
- Firefox compatibility
- Ecosystem outreach and pilot sites

See [product-overview.md](design/product-overview.md) for the full roadmap.

## Use of Generative AI

This project occasionally uses generative AI tools for non-code tasks such as visuals, translation, and spelling corrections. All code and technical design are written and reviewed by human contributors, and the codebase is prepared as FLOS (GPL‑3.0‑or‑later) without "vibe-coding" or direct code generation from AI tools.

## License

ProtoConsent is free and open source software.

The browser extension and main code in this repository are licensed under the GNU General Public License, version 3 or (at your option) any later version (see [LICENSE](LICENSE)).

The JavaScript SDK (files under `sdk/`) is licensed under the MIT License to make integration easier for third‑party services (see [sdk/LICENSE](sdk/LICENSE)).

Project documentation (files under `design/` and `*.md` files in this repository) is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license (see [LICENSE-CC-BY-SA](LICENSE-CC-BY-SA)).
