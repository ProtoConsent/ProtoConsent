# ProtoConsent

<p align="center">
  <img src="design/assets/logo/protoconsent_logo.png" alt="ProtoConsent logo" width="160">
</p>

<p align="center"><em>User‑side, purpose‑based consent for the web.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/status-alpha-blue" alt="status: alpha">
</p>

ProtoConsent is a browser extension that lets you control how websites may use your data — expressed in terms of purposes (functional, analytics, ads, personalisation, third‑party services, advanced tracking) rather than specific trackers or domains.

No central server, no tracking, no sharing of personal data. Preferences are enforced at the network level, per site, entirely from your browser.

**Project website:** https://www.protoconsent.org

> Status: early alpha (v0.1.1), meant for exploration and feedback, not production use yet.

## What is ProtoConsent?

ProtoConsent is a browser extension (initially for Chromium-based browsers, with Firefox support planned) that:

- Stores the user’s data-use preferences per site and per purpose (for example: functional, analytics, ads, personalisation, third-party services, advanced tracking).
- Enforces those preferences by blocking or allowing network requests associated with each purpose.
- Keeps all decisions and identity local to the browser by default: no central server, no tracking, no sharing of personal data.

ProtoConsent is not a full ad blocker or a traditional consent management platform (CMP). It is a personal “consent control panel” that lives in the browser and can coexist with existing blockers and consent tools.

In later versions, websites that choose to respect ProtoConsent may be able to read a minimal, privacy-preserving signal from the browser (for example, “analytics allowed/denied for this site”), without learning any real-world identity or cross-site tracking identifier.

## Goals

- Give users a single, consistent place to manage their privacy and consent preferences.
- Express preferences in terms of purposes of data use, not just domains, cookies or vendors.
- Keep control and identity in the user’s browser by default, minimising or avoiding any server-side processing.
- Align with existing and emerging web privacy standards where possible (for example, Permissions API, Storage Access API, Global Privacy Control).
- Explore browser-level, purpose-based preference signals that other tools and standards discussions could build on.

## Project status

ProtoConsent is in early alpha (v0.1.1), meant for exploration and feedback, not production use yet. The current Chromium extension provides:

- Global default profile with per-site overrides via a browser action popup.
- Purpose toggles for six categories: functional, analytics, ads, personalisation, third-party services, and advanced tracking.
- Network-level enforcement using declarative net request rules (150 curated domains from public blocklists).
- Content script bridge and JavaScript SDK for web pages to query user preferences.
- TypeScript type declarations for SDK consumers.
- Live SDK test on [protoconsent.org](https://www.protoconsent.org).

For a more detailed roadmap and planned features, see [product-overview.md](design/product-overview.md). Expect the code and documentation to change quickly at this stage.

## Architecture overview

ProtoConsent is a browser extension with a popup UI, a background service worker, and local storage for site rules and purpose preferences. Enforcement relies on declarative network rules in the browser.

![ProtoConsent technical diagram](design/assets/diagrams/protoconsent-technical-diagram.png)

See [architecture.md](design/architecture.md) for more details.

## Screenshots

ProtoConsent popup with per-site profile and purpose toggles:

![ProtoConsent popup](docs/assets/screenshots/popup-profile.png)

Basic blocking of tracking resources for the Ads purpose on a news site.
Notice the missing ad slots in the page header and `ERR_BLOCKED_BY_CLIENT` entries in the console panel:

![Blocking analytics on elpais.com](design/assets/screenshots/test-elpais-blocked.png)

The project website ([protoconsent.org](https://protoconsent.org)) includes a live SDK test that shows your current preferences when the extension is installed:

![SDK live test on protoconsent.org](docs/assets/screenshots/sdk-demo-detected.png)

## Getting started (developer mode)

For now ProtoConsent is only available as an unpacked extension.

- Clone this repository locally.
- Load the folder as an unpacked extension in your Chromium-based browser   (Chrome, Edge, Brave) with Developer mode enabled.
- Open any site, click the ProtoConsent icon, pick a profile and adjust the per‑purpose toggles.

For step‑by‑step instructions and example test scenarios, see [testing-guide.md](design/testing-guide.md).

## Documentation

ProtoConsent comes with a small set of public documents that describe the project from different angles:

- **Product overview** – high-level description of the problem, solution, key features, roadmap, and openness: see [product-overview.md](design/product-overview.md).
- **Technical architecture** – components, data model, main flows, and design choices: see [architecture.md](design/architecture.md).
- **Icons and layers** – visual representation of profiles, purposes, and UI layers: see [icons-and-layers.md](design/icons-and-layers.md).
- **How to test the extension** – practical steps to install the extension in developer mode and try it on real sites: see [testing-guide.md](design/testing-guide.md).
- **Purpose-signalling protocol** – data model, communication mechanism, and SDK API surface: see [protocol-draft.md](design/protocol-draft.md).
- **SDK quick start** – import `sdk/protoconsent.js` (MIT) and call `get('analytics')`. Returns `true`, `false`, or `null` (no extension). See the [quick example](design/protocol-draft.md#quick-example).

## Use of Generative AI

This project occasionally uses generative AI tools for non-code tasks such as visuals, text translation, and spelling/grammar/orthography corrections. All project code and technical design are written and reviewed by human contributors, and the codebase is prepared as FLOS (GPL‑3.0‑or‑later) without “vibe-coding” or direct code generation from AI tools.

## License

ProtoConsent is free and open source software.

The browser extension and main code in this repository are licensed under the GNU General Public License, version 3 or (at your option) any later version (see [LICENSE](LICENSE)).

The JavaScript SDK (for example, files under `sdk/`) is licensed under the MIT License to make integration easier for third‑party services (see [sdk/LICENSE](sdk/LICENSE)).

Project documentation (for example, files under `design/` and `*.md` files in this repository) is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license (see [LICENSE-CC-BY-SA](LICENSE-CC-BY-SA)).
