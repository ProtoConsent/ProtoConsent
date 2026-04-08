# ProtoConsent: Design Rationale

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## 0. Status and scope of this document

This document explains *why* ProtoConsent is designed the way it is: the premises, the trade‑offs, and the boundaries it assumes. It describes the reasoning behind the design, not the technical details. It does not repeat API surfaces, data models, or implementation details covered in other documents:

- **[product-overview.md](product-overview.md)**: what ProtoConsent is and what it does
- **[architecture.md](architecture.md)**: how it works technically
- **[signalling-protocol.md](spec/signalling-protocol.md)**: the SDK and purpose‑signalling protocol
- **[protoconsent-well-known.md](spec/protoconsent-well-known.md)**: site declaration format
- **[blocklists.md](blocklists.md)**: enforcement methodology and list curation

## 1. The problem ProtoConsent addresses

Consent on the web today is mostly UI‑driven: users make choices in per‑site banners, but rarely have a consistent way to enforce or verify those choices. Consent fatigue is the default experience, and the gap between "I clicked accept" and "what actually happened" is invisible.

Existing tools sit at two extremes. Content blockers operate on domains and filter lists, effective but blunt. Consent management platforms (CMPs) operate per site and per vendor, flexible for the site, opaque for the user. There is no browser‑level layer in between where a user can express intent by purpose and have it enforced consistently across sites.

## 2. Core design premise: meaningful consent

ProtoConsent starts from a single premise:

> Consent is only meaningful if the user can **express** it in understandable terms, **enforce** it technically, and **observe** its effects.

All design decisions derive from completing this triangle. If any of the three is missing, the system fails.

## 3. Why purpose‑based consent

ProtoConsent organises decisions around *purposes of data use* (functional, analytics, ads, personalisation, third‑party services, advanced tracking), not around vendors, cookies, or domains.

Purpose is the only abstraction that connects three things simultaneously:

1. **Regulation**: major privacy frameworks organise consent around purpose limitation: GDPR (EU), CCPA/CPRA (US-CA), LGPD (Brazil), PIPL (China), PIPA (South Korea), APPI (Japan). Consent Commons provides a visual vocabulary aligned with this structure.
2. **Human comprehension**: people think "I don't want ads tracking me", not "I don't want requests to doubleclick.net". Purpose maps to how users reason about their choices.
3. **Viable enforcement**: purposes can be mapped to domain categories and filter rules that browser APIs can enforce at the network level.

A vendor‑based model would fragment decisions across hundreds of entities. A cookie‑based model would ignore network‑level tracking.

## 4. Why user‑side, browser‑level control

ProtoConsent places enforcement in the browser, not in the site or in a backend:

- **No delegation to sites**: enforcement does not depend on each site honouring preferences. The browser blocks requests before they leave.
- **No backend**: no central server, no accounts, no cloud sync. All state is local. This eliminates a privacy‑sensitive backend and reduces the attack surface.
- **No CMP dependency**: the extension works without any site integration. Sites that integrate the optional SDK or publish a declaration add cooperation, not a requirement.
- **Consistency**: the same choice applies the same way across sites, rather than being re‑negotiated per banner.

The browser is the only place where you can block requests, emit privacy signals (GPC), and show the user what happened, all without introducing new remote points of control.

## 5. Enforcement as a means, not an end

ProtoConsent uses curated blocklists to enforce user choices, but blocking is not the goal: it is the mechanism that makes consent meaningful.

The current core set contains ~40,000 curated tracker domains and ~1,200 path‑based rules from public blocklists, organised by purpose. The architecture can scale significantly beyond this (Chrome's DNR API supports hundreds of thousands of rules), but the current size reflects a deliberate choice focused on **accuracy, explainability, and low false‑positive rates**. Cross‑source validation, an explicit safelist, and path‑based precision (blocking `google.com/pagead/` instead of all of `google.com`) prioritise correctness over exhaustiveness.

Optional Enhanced Protection (curated third‑party lists with millions of additional domains) extends coverage for users who want it, without changing the core model.

## 6. Observability as a first‑class requirement

Without visibility into what enforcement does, consent is symbolic. ProtoConsent treats observability as a design requirement, not a debug feature:

- **Per‑purpose blocked request counters**: the user sees how many requests were blocked and which purposes they belonged to.
- **Real‑time log**: blocked and GPC events stream to the Log tab as they happen, with timestamps and purpose attribution.
- **Blocked domains by purpose**: grouped with Consent Commons icons so the user can see exactly which domains were affected.
- **GPC signal tracking**: which domains received Sec‑GPC headers, with request counts and first/last timestamps.
- **Gap reporting**: when in‑memory and persistent counts diverge (e.g. after a service worker restart), the gap is transparently noted.

This creates a feedback loop: the user decides, the browser enforces, the user sees the result. Consent becomes a process, not a single click.

## 7. Voluntary cooperation with websites

ProtoConsent supports two optional cooperation channels, both designed to preserve user control:

**Site declarations** (`.well-known/protoconsent.json`): a website can publish a static JSON file declaring its purposes, legal bases, providers, and data handling. The extension reads this and displays it alongside the user's preferences. The declaration is informational and voluntary; it does not change how enforcement works. It is an act of public transparency, not a binding contract.

**SDK** (`protoconsent.js`): websites can query the user's consent state per purpose and adapt their behaviour accordingly. The SDK is read‑only, null‑safe (returns `null` if no extension is present), and transmits no identity. It complements enforcement but does not replace it.

## 8. Compliance signalling, not legal adjudication

ProtoConsent implements privacy compliance at the level of *technical signalling and enforcement*:

- **Purpose alignment**: the data model maps directly to purpose categories recognised across major privacy frameworks, using Consent Commons terminology.
- **Legal basis transparency**: site declarations can declare legal basis per purpose, displayed with standardised icons.
- **Sec‑GPC emission**: conditional, per‑site, purpose‑derived, with observable evidence (logs and timestamps). GPC already carries legal weight under CCPA/CPRA and is under discussion in the EU.
- **Auditability**: logs, counters, and GPC records provide technical evidence of what happened and when.

ProtoConsent provides the technical mechanisms; whether a site's declared legal basis holds under any given jurisdiction remains a contextual assessment.

## 9. Explicit non‑goals and boundaries

ProtoConsent has clear boundaries:

- **Not yet a web standard**: the protocol is a working draft; formal standardisation is a long‑term goal pending real‑world adoption.
- **Not a CMP**: it does not manage consent on behalf of sites, negotiate with vendors, or provide compliance certification.
- **Not a full ad blocker**: its core goal is purpose‑based consent enforcement, not exhaustive tracking coverage. Enhanced lists extend coverage optionally.
- **Not control over all data processing**: browser‑level enforcement cannot prevent server‑side processing, first‑party abuse, or offline correlation. ProtoConsent makes *network‑level* effects visible and controllable.
- **Not legal adjudication**: it does not validate legal bases, perform impact assessments, or certify compliance.

## 10. Design trade‑offs and conscious limitations

| Trade‑off | Choice | Rationale |
|-----------|--------|-----------|
| **Exhaustiveness vs explainability** | Curated lists over raw dumps | Users (and reviewers) should be able to understand what the system blocks and why. |
| **Coverage vs false positives** | Conservative blocking, path‑based precision | Blocking too broadly breaks sites and erodes trust. A wrong block is worse than a missed tracker. |
| **Observability vs cognitive load** | Layered UI (summary → log → debug) | Summary for most users, detail on demand. The risk of "consent as debugging" is real and must be managed. |
| **Whitelist as pragmatic escape** | Per‑site and global allow overrides | Necessary for real‑world use, but introduces a tension between the purpose model and domain‑level exceptions. |
| **Cooperation vs coercion** | All site integration is optional | Maximises adoption potential but means enforcement alone cannot cover sites that misrepresent their practices. |

## 11. Relationship to the rest of the documentation

| Question | Document |
|----------|----------|
| What is ProtoConsent and what does it do? | [product-overview.md](product-overview.md) |
| How is it implemented? | [architecture.md](architecture.md) |
| What is the SDK API surface? | [signalling-protocol.md](spec/signalling-protocol.md) |
| How do site declarations work? | [protoconsent-well-known.md](spec/protoconsent-well-known.md) |
| How are blocklists curated and applied? | [blocklists.md](blocklists.md) |
| How to test the extension? | [testing-guide.md](testing-guide.md) |
| What visual language does it use? | [icons-and-layers.md](icons-and-layers.md) |
