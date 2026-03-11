# Icons and information layers

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

ProtoConsent uses the Consent Commons icon system as a visual language to explain what each purpose means.

## 1. Central purposes (icons used for enforcement)

Each ProtoConsent purpose is mapped to one or more central Consent Commons icons (see [Consent Commons website](https://consentcommons.com/el-sistema/)):

- `functional` → icons for service management (and other data when needed).
- `analytics` → icon for profiling and analytics.
- `ads` → icons for marketing purposes (plus profiling and analytics when targeting is involved).
- `personalization` → icon for profiling and analytics.
- `third_parties` → icons for access to third-party data and sharing with third parties.
- `advanced_tracking` → combination of profiling and analytics plus other data, or a specific textual warning.

In the ProtoConsent popup, each purpose is shown as:

- a short label (e.g. “Analytics”),
- an allow/deny toggle controlled by the user,
- (future) central icon(s) from Consent Commons.

## 2. Legal basis (informational layer, future)

Consent Commons also provides icons for legal basis (consent, legitimate interest, contractual, etc.).

ProtoConsent does not decide the legal basis. Instead, in future versions it may:

- display the legal basis declared by the site (e.g. via a cooperating CMP or protocol),
- use the corresponding Consent Commons icon (“Consent”, “Legitimate interest”, “Contractual”, etc.),
- without changing how purposes are enforced technically.

For the early versions, legal basis is documented here but not implemented in the UI or in enforcement.

## 3. Data sharing, transfers and storage (informational layer, future)

Consent Commons includes icons for:

- whether data is shared with third parties and for which reasons,
- whether data is stored inside or outside the user's region or country,
- whether international transfers take place.

In the early versions, data sharing and transfers are not enforced as separate purposes. Over time, ProtoConsent may:

- use `third_parties` as a technical purpose (allow/deny sharing and enrichment where detectable),
- show additional Consent Commons icons about:
  - “no third-party sharing” vs “sharing within group” vs “sharing with third parties for ads/advertising”,
  - storage within your region or country,
  - international transfers.

These elements are purely informational in the current early design: they help the user understand a site, but they do not automatically create or change blocking rules.

## 4. Data subject rights (informational layer, future)

Consent Commons also defines icons for data subject rights (withdraw consent, access/rectification/erasure, portability, complaint to a data protection authority, etc.).

ProtoConsent may later include a small “rights” block in the site panel:

- a compact set of icons reminding users of their data protection and privacy rights (access, rectification, erasure, etc.) under applicable law,
- possibly linking to the site's privacy policy or to a help page.

Again, this is an informational layer: it does not change browser-level enforcement.
