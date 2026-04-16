# Icons and information layers

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

ProtoConsent uses the [Consent Commons](https://consentcommons.com/el-sistema/) icon system as a visual language to explain what each purpose means.

## 1. Purpose icons (popup badges)

Each ProtoConsent purpose is represented by a Consent Commons icon displayed as a badge next to the purpose name in the popup:

| Purpose | Icon | Consent Commons icon | File | Notes |
|---------|------|---------------------|------|-------|
| `functional` | ![](../extension/icons/purposes/functional.png) | Box (service management) | `icons/purposes/functional.png` | CC “gestión del servicio” |
| `analytics` | ![](../extension/icons/purposes/analytics.png) | Person + bar chart (profiling & analytics) | `icons/purposes/analytics.png` | CC “perfilado y analítica” |
| `ads` | ![](../extension/icons/purposes/ads.png) | Megaphone (marketing) | `icons/purposes/ads.png` | CC “marketing” |
| `personalization` | ![](../extension/icons/purposes/personalization.png) | Person + bar chart + “P” overlay | `icons/purposes/personalization.png` | Shares base icon with analytics; “P” overlay distinguishes it |
| `third_parties` | ![](../extension/icons/purposes/third_parties.png) | Person + nodes (third-party access) | `icons/purposes/third_parties.png` | CC “información a terceros” |
| `advanced_tracking` | ![](../extension/icons/purposes/advanced_tracking.png) | Eye (custom) | `icons/purposes/advanced_tracking.png` | No Consent Commons equivalent; custom SVG design (source: `advanced_tracking.svg`) |

Icons are PNG files at 125×125 pixels, rendered at 18×18 in the popup. When an icon is present, the letter badge (F, An, Ad, P, 3P, T) is replaced; if no icon file is found, the letter badge remains as fallback.

## 2. Legal basis icons (site declaration panel)

When a website publishes a `.well-known/protoconsent.json` declaration, the popup side panel shows an icon for each purpose's declared legal basis:

| `legal_basis` value | Icon | Consent Commons icon | File |
|---------------------|------|---------------------|------|
| `consent` | ![](../extension/icons/declaration/consent.png) | Check in circle | `icons/declaration/consent.png` |
| `contractual` | ![](../extension/icons/declaration/contractual.png) | Signed document | `icons/declaration/contractual.png` |
| `legitimate_interest` | ![](../extension/icons/declaration/legitimate_interest.png) | Empty circle | `icons/declaration/legitimate_interest.png` |
| `legal_obligation` | ![](../extension/icons/declaration/legal_obligation.png) | Temple / columns | `icons/declaration/legal_obligation.png` |
| `public_interest` | ![](../extension/icons/declaration/public_interest.png) | Public building | `icons/declaration/public_interest.png` |
| `vital_interest` | ![](../extension/icons/declaration/vital_interest.png) | Heart | `icons/declaration/vital_interest.png` |

Icons are rendered at 14×14 next to the legal basis text. The label “legitimate_interest” is abbreviated to “legit. interest” for space. The value `legal_obligation` uses the generic temple/columns icon (the Consent Commons section header for legal basis) as Consent Commons does not include one for this basis.

## 3. Data sharing icon (site declaration panel)

| Field | Icon | Consent Commons icon | File |
|-------|------|---------------------|------|
| `sharing` (any value) | ![](../extension/icons/declaration/sharing.png) | Arrow E→ (data shared) | `icons/declaration/sharing.png` |

## 4. International transfers icons (site declaration panel)

| `international_transfers` value | Icon | Consent Commons icon | File |
|---------------------------------|------|---------------------|------|
| `true` | ![](../extension/icons/declaration/intl_transfers_yes.png) | Bidirectional arrows ↔ | `icons/declaration/intl_transfers_yes.png` |
| `false` | ![](../extension/icons/declaration/intl_transfers_no.png) | Angle brackets < > | `icons/declaration/intl_transfers_no.png` |

## 5. Out of scope (v0.1)

The following Consent Commons icons are not used in the current version:

- **Data subject rights** (portability, complaint, withdraw consent, transparency): ProtoConsent uses a single `rights_url` link instead of individual right icons. These rights are legally mandated under GDPR, so sites don't differ much here.
- **Data retention modifiers** (3+, 3−, 3×, 3++): retention periods are not modeled in the current schema. Retention periods are the most likely future addition to the schema.
- **International transfers with safeguards**: the current schema uses a boolean (`international_transfers: true/false`). A future version could expand this to an enum (e.g. `”none”`, `”safeguarded”`, `”unrestricted”`) to capture whether Standard Contractual Clauses or adequacy decisions apply.
- **Other unused icons**: CV/recruitment, commercial communications (covered by ads), generic “other data”, data reception (reverse direction of sharing).

## 6. Enhanced Protection icons

Enhanced Protection uses two additional SVG icons that are not part of the Consent Commons system:

| Purpose | Icon | Consent Commons icon | File | Notes |
|---------|------|---------------------|------|-------|
| `enhanced` | <img src="../extension/icons/purposes/enhanced.png" width="60"> | Orange shield | `icons/purposes/enhanced.png` | Identifies Enhanced Protection blocks in counter bar, Log domains and whitelist panels |
| `security` | <img src="../extension/icons/purposes/security.png" width="60"> | B&W shield with checkmark | `icons/purposes/security.png` | ProtoConsent‑specific (not Consent Commons). Used for lists like Blocklist Project Phishing |

Icons are PNG files at 125×125 (matching purposes icons in §1) and SVG originals at 18×18. The `enhanced` shield appears as primary icon for all enhanced blocks; category icons (from §1 or `security`) appear next to it as a category marker.

## 7. Grid card icons (Overview and Protection tabs)

The Overview and Protection tabs use a shared set of SVG icons for their metric grid cards. All icons are 20×20 outline SVGs using `stroke="currentColor"`, stored in `icons/grid/`.

### Overview tab grid cards

| Card | Icon | Description | File | Metric shown |
|------|------|-------------|------|-------------|
| Coverage | <img src="../extension/icons/grid/coverage.svg" width="60"> | Pie chart (circle with filled quarter) | `icons/grid/coverage.svg` | Purpose coverage % |
| GPC | <img src="../extension/icons/grid/gpc.svg" width="60"> | Padlock | `icons/grid/gpc.svg` | Domains with GPC signal |
| Banners | <img src="../extension/icons/grid/banners.svg" width="60"> | Monitor with horizontal divider and stand | `icons/grid/banners.svg` | CMP banners detected |
| Cosmetic | <img src="../extension/icons/grid/cosmetic.svg" width="60"> | Sun (circle with 8 rays) | `icons/grid/cosmetic.svg` | Cosmetic filter rules active |
| Trackers | <img src="../extension/icons/grid/trackers.svg" width="60"> | Magnifying glass | `icons/grid/trackers.svg` | CNAME-cloaked trackers |
| Clean Links | <img src="../extension/icons/grid/cleanlinks.svg" width="60"> | Angle brackets with dashed line | `icons/grid/cleanlinks.svg` | URL parameters stripped |

### Protection tab grid cards

| Card | Icon | Description | File | Metric shown |
|------|------|-------------|------|-------------|
| Overview | <img src="../extension/icons/grid/overview.svg" width="60"> | Dashboard panel (rectangle with grid lines and highlighted cell) | `icons/grid/overview.svg` | Active lists and total rules |
| Blocking | <img src="../extension/icons/grid/blocking.svg" width="60"> | Shield | `icons/grid/blocking.svg` | Blocking lists summary |
| Cosmetic | <img src="../extension/icons/grid/cosmetic.svg" width="60"> | Sun (circle with 8 rays) | `icons/grid/cosmetic.svg` | Cosmetic lists summary |
| Banners | <img src="../extension/icons/grid/banners.svg" width="60"> | Monitor with horizontal divider and stand | `icons/grid/banners.svg` | Banner/CMP lists summary |
| Detection | <img src="../extension/icons/grid/detection.svg" width="60"> | Crosshair (concentric circles with dashed outer ring and cardinal ticks) | `icons/grid/detection.svg` | Detection lists summary |

Cosmetic and Banners icons are shared between both tabs. All icons inherit text color via `currentColor` and scale cleanly at 20×20 and smaller sizes.
