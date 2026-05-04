# URL parameter stripping

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

ProtoConsent strips tracking parameters (e.g. `utm_source`, `fbclid`, `gclid`) from URLs using declarativeNetRequest redirect rules. Two static rulesets handle this: one for global parameters and one for site-specific parameters. See [list-catalog.md](list-catalog.md) for the parameter lists and sources.

## Detection

DNR redirect rules are invisible to standard request events, so the extension uses browser-specific strategies to detect when parameters have been stripped.

### Chromium (Chrome, Edge, Brave)

DNR redirects do not fire `onBeforeRedirect`. The extension captures the original URL via `webRequest.onBeforeRequest` (which fires before DNR processes the request), then compares it with the committed URL in `webNavigation.onCommitted`. Same origin and path with different query string means parameters were stripped. A secondary check via `declarativeNetRequest.getMatchedRules` confirms the strip came from a param ruleset.

### Firefox

Firefox fires `webRequest.onBeforeRedirect` for DNR redirects, providing both the original URL and redirect target directly. The extension compares the two URLs in the listener, filtering out server-side redirects (status 300-399). No `webNavigation` or `getMatchedRules` fallback is needed.

Only main-frame navigations are tracked. Server-side redirects are filtered out to avoid false positives.

## What gets recorded

For each tab, the extension tracks which domains had parameters stripped, how many times, and which specific parameter names were removed. For example, visiting a link with `?utm_source=twitter&utm_medium=social&fbclid=abc` would record three stripped parameters for that domain.

Strip data is persisted across service worker restarts and cleaned up on tab close or navigation.

## Observability

Parameter stripping surfaces in three places in the popup:

- **Overview tab**: an accordion card showing total strip count and individual parameter names grouped by domain
- **Log tab**: real-time purple `[param-strip]` lines with domain and parameter names
- **Purposes tab**: strip count is tracked separately from the blocked request counter (strips are redirects, not blocks)

## Debug mode

In developer builds with DNR debug mode enabled, strip events are detected by both `onRuleMatchedDebug` and `webNavigation`. The two sources are deduplicated: debug mode counts the events, navigation detection adds the parameter names (which debug mode does not provide).
