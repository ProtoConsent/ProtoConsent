# URL parameter stripping

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

ProtoConsent strips tracking parameters (e.g. `utm_source`, `fbclid`, `gclid`) from URLs using Chrome's declarativeNetRequest redirect rules. Two static rulesets handle this: one for global parameters and one for site-specific parameters. See [list-catalog.md](list-catalog.md) for the parameter lists and sources.

## Detection

DNR redirect rules are invisible to `webRequest` because Chrome processes them before any request events fire. The extension detects strips using the `webNavigation` API instead:

1. `onBeforeNavigate` captures the original URL (with tracking params)
2. `onCommitted` provides the final URL after DNR has stripped params
3. The extension compares the two: same origin and path, different query means params were stripped

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
