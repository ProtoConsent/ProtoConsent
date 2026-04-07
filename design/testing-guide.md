# ProtoConsent: How to test the extension

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## Contents

- [ProtoConsent: How to test the extension](#protoconsent-how-to-test-the-extension)
  - [Contents](#contents)
  - [1. Requirements](#1-requirements)
  - [2. Installing the Extension (Developer Mode)](#2-installing-the-extension-developer-mode)
  - [3. Basic Test: Per‑Site Profile](#3-basic-test-persite-profile)
  - [4. Purpose Toggles and Visible Effects](#4-purpose-toggles-and-visible-effects)
  - [5. Example: Blocking Ads on elpais.com (DoubleClick)](#5-example-blocking-ads-on-elpaiscom-doubleclick)
    - [5.1 Baseline: Ads Allowed](#51-baseline-ads-allowed)
    - [5.2 Ads Blocked with ProtoConsent](#52-ads-blocked-with-protoconsent)
  - [6. Trying different sites, profiles and purposes](#6-trying-different-sites-profiles-and-purposes)
    - [6.1 Functional (service)](#61-functional-service)
    - [6.2 Analytics](#62-analytics)
    - [6.3 Ads / Marketing](#63-ads--marketing)
    - [6.4 Personalization / Profiling](#64-personalization--profiling)
    - [6.5 Third-party sharing](#65-third-party-sharing)
    - [6.6 Advanced tracking / fingerprinting](#66-advanced-tracking--fingerprinting)
  - [7. Testing the SDK query flow (content script bridge)](#7-testing-the-sdk-query-flow-content-script-bridge)
    - [7.1 Setup](#71-setup)
    - [7.2 Querying from the browser console](#72-querying-from-the-browser-console)
    - [7.3 Expected results](#73-expected-results)
    - [7.4 Security validation](#74-security-validation)
  - [8. Testing Global Privacy Control (Sec-GPC header)](#8-testing-global-privacy-control-sec-gpc-header)
    - [8.1 GPC active (default with Balanced or Strict)](#81-gpc-active-default-with-balanced-or-strict)
    - [8.2 GPC inactive (all privacy purposes allowed)](#82-gpc-inactive-all-privacy-purposes-allowed)
    - [8.3 GPC globally disabled](#83-gpc-globally-disabled)
    - [8.4 Verifying rules from the service worker console](#84-verifying-rules-from-the-service-worker-console)
  - [9. Enabling the debug panel](#9-enabling-the-debug-panel)
    - [9.1 Activate debug mode](#91-activate-debug-mode)
    - [9.2 Deactivate debug mode](#92-deactivate-debug-mode)
  - [10. Testing site declarations (`.well-known/protoconsent.json`)](#10-testing-site-declarations-well-knownprotoconsentjson)
    - [10.1 Using demo.protoconsent.org](#101-using-demoprotoconsentorg)
    - [10.2 What to check](#102-what-to-check)
    - [10.3 Publishing your own declaration](#103-publishing-your-own-declaration)
  - [11. Switching to DNR debug mode](#11-switching-to-dnr-debug-mode)
    - [11.1 When to use it](#111-when-to-use-it)
    - [11.2 Activating DNR debug mode](#112-activating-dnr-debug-mode)
    - [11.3 What changes](#113-what-changes)
    - [11.4 Deactivating DNR debug mode](#114-deactivating-dnr-debug-mode)
  - [12. Testing the domain whitelist](#12-testing-the-domain-whitelist)
    - [12.1 Allowing a blocked domain](#121-allowing-a-blocked-domain)
    - [12.2 Removing a whitelisted domain](#122-removing-a-whitelisted-domain)
    - [12.3 Per‑site vs global scope](#123-persite-vs-global-scope)
    - [12.4 Verifying whitelist rules from the service worker console](#124-verifying-whitelist-rules-from-the-service-worker-console)
  - [13. Testing Enhanced Protection](#13-testing-enhanced-protection)
    - [13.1 Activating a preset](#131-activating-a-preset)
    - [13.2 Downloading and toggling lists](#132-downloading-and-toggling-lists)
    - [13.3 Verifying enhanced blocks in the Log tab](#133-verifying-enhanced-blocks-in-the-log-tab)
    - [13.4 Checking enhanced rules from the service worker console](#134-checking-enhanced-rules-from-the-service-worker-console)

## 1. Requirements

- **A Chromium‑based browser** (for example, Chrome, Edge or Brave)
- **Ability to load an unpacked extension** in developer mode
- **A few test sites** that use common analytics or ads/advertising services (for example, news sites)

## 2. Installing the Extension (Developer Mode)

2.1. **Clone the ProtoConsent repository locally:**

  ```bash
  git clone https://github.com/ProtoConsent/ProtoConsent.git
  cd ProtoConsent
  ```

  In this folder you should see the `extension/` directory, which contains the extension files (`manifest.json`, `background.js`, etc.), and the `sdk/` directory, which contains the SDK.

2.2. **Load the extension in your browser:**

- Open the extensions page (for example `chrome://extensions/` or `edge://extensions/`).
- Enable **Developer mode**.
- Click **Load unpacked** and select the `extension/` folder inside the cloned repository (the one that contains `manifest.json`).
- Confirm that an extension called **ProtoConsent** appears in the extensions list and that it is enabled. Pin it in the toolbar if your browser supports pinning.

## 3. Basic Test: Per‑Site Profile

Verify that site rules are stored per domain and correctly associated with each site.

1. Visit any news or blog site of your choice.
2. Open the ProtoConsent popup from the browser toolbar.
3. Use the **Profile** selector to assign a profile to the current site (for example, “Strict” or “Balanced”).
4. Reload the page.
5. Open the popup again and confirm that the selected profile is still applied to this site.
6. If you repeat the same steps on a different domain, each site should keep its own profile.

Example popup view with profile and per‑purpose summary:

![ProtoConsent popup with per-site profile](assets/screenshots/popup-profile.png)

Expanded view with purpose toggles visible:

![ProtoConsent popup with purpose toggles](assets/screenshots/popup-toggles.png)

## 4. Purpose Toggles and Visible Effects

Changing purposes in ProtoConsent has direct, observable effects on network traffic.

1. On a site that uses web analytics, open the ProtoConsent popup.
2. Choose a profile (for example “Balanced”).
3. In the popup, make sure that **Functional (service)** remains **Allowed** and set **Analytics** to **Blocked** for this site.
4. Open your browser’s developer tools and go to the **Network** tab. Optionally filter by a common analytics domain (for example `google-analytics.com` or `analytics`).
5. Reload the page and observe the network requests. You should see that analytics requests that would normally be sent are now missing or reported as blocked.
6. Switch to a more permissive profile or enable **Analytics** for this site in the popup.
7. Reload again and confirm that analytics requests are now visible in the network log.

The point is to see the cause and effect: toggle a purpose, watch requests appear or disappear.

## 5. Example: Blocking Ads on elpais.com (DoubleClick)

This example uses the Spanish news site <https://elpais.com/> to demonstrate how the **Ads / Marketing** purpose affects third‑party ad requests.

### 5.1 Baseline: Ads Allowed

1. Open <https://elpais.com/> in a new tab.
2. Open the ProtoConsent popup.
3. Ensure the **Profile** is set to a mode where **Ads / Marketing** is **Allowed** for elpais.com.
4. Open developer tools and go to the **Network** tab.
5. Use the filter box to search for `doubleclick` or `googlesyndication`.
6. Reload the page.
7. In the Network panel you should see requests to domains like `g.doubleclick.net`, `googleads.g.doubleclick.net` or `pagead2.googlesyndication.com` with status 200 (or similar).

### 5.2 Ads Blocked with ProtoConsent

1. With the same elpais.com tab open, switch back to the ProtoConsent popup.
2. Set **Ads / Marketing** to **Blocked** for elpais.com.
3. The extension updates its rules immediately.
4. Keep developer tools open on the Network tab, still filtered by `doubleclick`.
5. Reload the page.
6. Now you should see that some requests to `g.doubleclick.net`, `googleads.g.doubleclick.net` or `cm.g.doubleclick.net` fail with `net::ERR_BLOCKED_BY_CLIENT` or similar errors, indicating that the browser blocked them before they were completed.

Example screenshot with ads blocked:

![Ads / Marketing blocked on elpais.com](assets/screenshots/test-elpais-blocked.png)

Blocking of tracking resources for the **Ads** purpose on a news site. Notice the missing ad slots in the page header and the `ERR_BLOCKED_BY_CLIENT` entries in the Network panel.

## 6. Trying different sites, profiles and purposes

To explore the ProtoConsent extension, you can combine site profiles with purpose-level tests.

- Repeat the tests above on several sites (for example, other news sites, blogs, or services that embed third‑party widgets).
- Try different profiles (“Strict”, “Balanced”, “Permissive”) to see how they translate into purpose states for each site.
- Experiment with per‑site overrides: start from a profile and then enable or disable a specific purpose manually.

Below are example scenarios for each purpose.

### 6.1 Functional (service)

Functional is a reference-only purpose in this version.

- It represents everything strictly necessary to provide the service (login, navigation, basic UX, billing, support).
- In this early version, Functional does not generate any blocking rules, even if you turn it off, to avoid breaking sites.
- It serves to distinguish “core service” from optional analytics, ads or third‑party integrations.

### 6.2 Analytics

**Analytics controls measurement and usage tracking.**

- Reference domains (examples - full list in `extension/rules/block_*.json`): `google-analytics.com`, `scorecardresearch.com`, `chartbeat.com`, `fullstory.com`.

- Steps:
  1. Visit a site that uses Google Analytics or Segment.
  2. In the ProtoConsent popup, keep **Functional** allowed and set **Analytics** to *Blocked* for this site.
  3. Open DevTools → **Network**, filter by `google-analytics` or `segment`.
  4. Reload the page and verify that these requests are missing or reported as `ERR_BLOCKED_BY_CLIENT`.
  5. Switch **Analytics** back to *Allowed*, reload and confirm that the requests reappear with status 200.

### 6.3 Ads / Marketing

**Ads / Marketing controls advertising traffic.**

- Reference domains (examples - full list in `extension/rules/block_*.json`): `doubleclick.net`, `googlesyndication.com`, `adservice.google.com`, `criteo.com`, `taboola.com`.

- Steps:
  1. Use a site with visible ads (for example, a major news site).
  2. With **Ads / Marketing** set to *Allowed*, open **Network** and filter by `doubleclick` or `googlesyndication`. Confirm that requests return 200.
  3. Set **Ads / Marketing** to *Blocked* for this site.
  4. Reload and check that the same requests now disappear or are shown as blocked (for example `ERR_BLOCKED_BY_CLIENT`).

### 6.4 Personalization / Profiling

**Personalization separates basic ads from advanced profiling and retargeting.**

- Reference domains (examples - full list in `extension/rules/block_*.json`): `bluekai.com`, `crwdcntrl.net`, `acxiom.com`, `barilliance.com`, `audigent.com`.

- Steps:
  1. On a site with banners and personalised or retargeted ads, keep **Ads / Marketing** allowed but set **Personalization / Profiling** to *Blocked*.
  2. Filter in **Network** by `bluekai`, `crwdcntrl`, `audigent`.
  3. Reload and compare the results with the case where Personalization is also allowed.
  4. Results vary by site, but ProtoConsent treats personalization as a separate purpose from “basic ads”.

### 6.5 Third-party sharing

**Third-party sharing covers external data sharing and integrations.**

- Reference domains (examples - full list in `extension/rules/block_*.json`): `connect.facebook.net`, `addthis.com`, `addtoany.com`, `intercom.io`, `disqus.com`.

- Steps:
  1. Choose a site that embeds social widgets, Hotjar or Microsoft/Bing tracking.

  2. Allow **Functional** and **Analytics**, but set **Third‑party sharing** to *Blocked*.
  3. Filter by `facebook.net`, `addthis`, `intercom` or `disqus` in **Network**.
  4. Reload and compare the results with the case where Third‑party sharing is also allowed.

### 6.6 Advanced tracking / fingerprinting

**Advanced tracking targets monitoring, experimentation and fingerprinting tools.**

- Reference domains (examples - full list in `extension/rules/block_*.json`): `js-agent.newrelic.com`, `cdn.optimizely.com`, `fpnpmcdn.net`, `datadome.co`, `arkoselabs.com`.

- Steps:
  1. Visit a site that uses New Relic, Heap, Optimizely or similar tooling.
  2. Set **Advanced tracking / fingerprinting** to *Blocked* and keep the other purposes allowed.
  3. Filter in **Network** by `newrelic`, `nr-data`, `heapanalytics` or `optimizely`.
  4. Reload and check whether those requests are blocked; then switch Advanced tracking back to *Allowed* and confirm that they return to 200 responses.

These scenarios are not meant to be exhaustive.

## 7. Testing the SDK query flow (content script bridge)

The SDK lets web pages query consent preferences through a content script bridge. The extension injects a content script on every page that bridges SDK queries to the extension's storage.

### 7.1 Setup

1. Make sure the extension is loaded and reloaded after any code changes (see section 2).
2. Open any website (for example `wikipedia.org`).
3. Use the ProtoConsent popup to set a profile and adjust purposes for this site.

### 7.2 Querying from the browser console

Open DevTools (F12) and go to the **Console** tab. Paste the following helper function:

```js
function testQuery(action, purpose) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), 600);
    window.addEventListener('message', function handler(event) {
      if (event.data && event.data.type === 'PROTOCONSENT_RESPONSE' && event.data.id === id) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(event.data.data);
      }
    });
    window.postMessage({ type: 'PROTOCONSENT_QUERY', id, action, purpose }, window.location.origin);
  });
}
```

Then run these queries one at a time:

```js
await testQuery('get', 'analytics')
```

You can replace `'analytics'` with any valid purpose key: `functional`, `analytics`, `ads`, `personalization`, `third_parties`, `advanced_tracking`.

```js
await testQuery('getAll')
```

```js
await testQuery('getProfile')
```

### 7.3 Expected results

- `get('analytics')` returns `true` or `false` depending on the purpose state for this site.
- `getAll()` returns an object with a boolean property per purpose, resolved from the active profile plus any overrides.
- `getProfile()` returns the profile name (`"strict"`, `"balanced"` or `"permissive"`).

On a site with no explicit configuration, the results reflect the default profile (currently balanced).

### 7.4 Security validation

These queries should be rejected by the content script:

```js
await testQuery('delete', null)
```

Expected: `TIMEOUT` (invalid action, ignored by the content script).

```js
await testQuery('get', 'malware')
```

Expected: `null` (invalid purpose, the extension has no data for it).

## 8. Testing Global Privacy Control (Sec-GPC header)

ProtoConsent conditionally sends a `Sec-GPC: 1` HTTP request header when privacy-relevant purposes are denied for a site. The purposes that trigger GPC are marked with `triggers_gpc: true` in `extension/config/purposes.json` (currently: ads, third_parties, advanced_tracking).

### 8.1 GPC active (default with Balanced or Strict)

1. Open a site (for example `elpais.com`) with the default Balanced profile.
2. Open DevTools → **Network**, reload the page.
3. Click the first request (the HTML document).
4. In **Request Headers**, look for `Sec-GPC: 1`. It should be present because Balanced denies ads, third_parties and advanced_tracking.

GPC signal detected on a site with privacy purposes denied:

![GPC signal detected on ProtoConsent](assets/screenshots/popup-log-gpc.png)
![GPC signal detected on https://globalprivacycontrol.org](assets/screenshots/gpc-demo-detected.png)


### 8.2 GPC inactive (all privacy purposes allowed)

1. In the ProtoConsent popup, set the site to a custom profile with all purposes allowed.
2. Reload the page.
3. Check **Request Headers** again. `Sec-GPC` should **not** appear.

### 8.3 GPC globally disabled

1. Open Purpose Settings and uncheck the GPC toggle.
2. Reload a site that previously showed `Sec-GPC: 1` (e.g. Balanced profile on `elpais.com`).
3. Check **Request Headers**. `Sec-GPC` should **not** appear.
4. In the popup, the GPC pill should show "GPC off" (greyed out) with tooltip "GPC globally disabled in Purpose Settings".
5. Re-enable the toggle in Purpose Settings, reload the site, and verify `Sec-GPC: 1` returns.

### 8.4 Verifying rules from the service worker console

Open the service worker console for the extension and run:

```js
chrome.declarativeNetRequest.getDynamicRules().then(r => {
  const block = r.filter(x => x.action.type === 'block');
  const allow = r.filter(x => x.action.type === 'allow');
  const gpc = r.filter(x => x.action.type === 'modifyHeaders');
  console.log('Block:', block.length, '| Allow:', allow.length, '| GPC:', gpc.length);
  gpc.forEach(x => console.log(' ',
    x.action.requestHeaders[0].operation,
    x.condition.requestDomains || 'GLOBAL'));
})
```

With Balanced as the default and one site set to custom (all allowed), the expected output is:

- `Block: 0 | Allow: 3 | GPC: 2`
- The 3 allow rules are per-site overrides for the categories that Balanced blocks globally (ads, third_parties, advanced_tracking), allowing them on the custom site.
- `set GLOBAL` - the global GPC rule (privacy purposes denied by Balanced)
- `remove ["example.com"]` - the per-site override that suppresses GPC for the permissive site

## 9. Enabling the debug panel

The popup includes a hidden debug panel that shows internal state (dynamic rules, ruleset toggles, GPC mappings). It is off by default and controlled by a flag in local storage - no code changes needed.

### 9.1 Activate debug mode

1. Open the ProtoConsent popup, right-click it and choose **Inspect** to open its DevTools console.
2. Run:

   ```js
   chrome.storage.local.set({ debug: true })
   ```

3. Close and reopen the popup. A **Debug** section should appear at the bottom, and the **Debug** inner tab becomes visible in the Log view.

> **Tip:** You can also run this command from the service worker console, but make sure you use a **live** console: after reloading the extension from `chrome://extensions/`, the previous SW console is disconnected and commands typed there will silently fail. Click **Inspect** on the service worker entry again to open a fresh console.

### 9.2 Deactivate debug mode

1. In the same console (popup Inspect or a live SW console), run:

   ```js
   chrome.storage.local.remove("debug")
   ```

2. Close and reopen the popup. The debug panel and Log debug tab disappear.

The flag persists across browser restarts until explicitly removed.

## 10. Testing site declarations (`.well-known/protoconsent.json`)

ProtoConsent reads a `.well-known/protoconsent.json` file from any website to display the site's declared data practices in a side panel. The easiest way to test this is with the public demo site.

### 10.1 Using demo.protoconsent.org

1. Make sure the extension is loaded (see section 2).
2. Open <https://demo.protoconsent.org> in a new tab.
3. Open the ProtoConsent popup from the toolbar.
4. Click the **Site** tab (side panel toggle) in the popup header.
5. The side panel should show the site's declaration with [Consent Commons](https://consentcommons.com/) icons, including purposes, legal bases, providers, sharing scope, and data handling details.

Site declaration displayed with Consent Commons icons on demo.protoconsent.org:

![Site declaration side panel](assets/screenshots/well-known-demo-detected.png)

### 10.2 What to check

- Each declared purpose shows its legal basis, provider, and sharing scope (if declared).
- Purposes with `"used": false` are shown as not used.
- The `rights_url` field links to the site's data rights page.
- The declaration indicator (pill) in the popup header should be active (blue dot) when a valid declaration is found.

### 10.3 Publishing your own declaration

Any site can publish a `.well-known/protoconsent.json` file. See the [site declaration spec](well-known-spec.md) for the full format and the [demo site source](https://github.com/ProtoConsent/demo) for a complete example. You can also use the [online validator](https://protoconsent.org/validate.html) to check your file before deploying it.

## 11. Switching to DNR debug mode

By default, the extension uses `webRequest` events to track blocked requests and GPC signals. This is the same code path in both unpacked (developer) and store builds.

For rule-level debugging - for example, when developing or troubleshooting blocklist rules - you can switch to `onRuleMatchedDebug`, a Chrome API that reports the exact rule ID and ruleset for every matched request. This API is only available in unpacked extensions.

### 11.1 When to use it

- Developing or testing new blocklist rules and you need to see which exact rule matched.
- Investigating whether a request was blocked by a static ruleset, a dynamic override, or a GPC header rule.
- Comparing Chrome's rule matching against the webRequest-based hostname lookup.

For normal testing and day-to-day use, leave `USE_DNR_DEBUG` off.

### 11.2 Activating DNR debug mode

1. Open `extension/config.js`.
2. Change `USE_DNR_DEBUG` from `false` to `true`:

   ```js
   const USE_DNR_DEBUG = true;
   ```

3. Reload the extension from `chrome://extensions/`.
4. The debug panel (Log → Debug tab) will show `data source: onRuleMatchedDebug` to confirm the switch.

> **Note:** This only works in unpacked extensions. In store builds, `onRuleMatchedDebug` does not exist and the flag has no effect - the extension continues using `webRequest` automatically.

### 11.3 What changes

| Feature | webRequest (default) | onRuleMatchedDebug |
| --- | --- | --- |
| Purpose attribution | Hostname lookup against blocklists | Exact rulesetId → purpose |
| Rule-level detail | Not available | ruleId and rulesetId per match |
| GPC detection | Header presence in onSendHeaders | Exact GPC rule ID per match |
| Other extensions' blocks | Filtered by our blocklists (may miss edge cases) | Only our rules, guaranteed |
| Works in store builds | Yes | No |

The popup, log tab, badge counter, and debug panel all work in both modes - only the data source changes.

### 11.4 Deactivating DNR debug mode

1. Set `USE_DNR_DEBUG` back to `false` in `extension/config.js`.
2. Reload the extension.

## 12. Testing the domain whitelist

The whitelist lets you allow specific blocked domains directly from the Log tab, so you can fix false positives without changing your profile or purpose settings. Each whitelist entry can be scoped to a single site or applied globally.

### 12.1 Allowing a blocked domain

1. Visit a site with blocked domains (for example, a news site with the Balanced profile).
2. Open the ProtoConsent popup and go to the **Log** tab → **Domains** panel.
3. Find a blocked domain in the list. Each row has an **Allow** button on the right.
4. Click **Allow**. The button changes to **Allowed** (green).
5. Reload the page. The domain should no longer appear in the blocked count, and the corresponding requests should load normally.
6. The **Whitelist** tab becomes visible in the Log view, listing the newly allowed domain.

Log tab showing a whitelisted domain with scope toggle:

![Whitelist tab in Log view](assets/screenshots/popup-log-whitelist.png)

### 12.2 Removing a whitelisted domain

1. Go to **Log** → **Whitelist** tab.
2. Find the domain you allowed in the previous step. Click **Remove**.
3. The domain disappears from the Whitelist tab.
4. Reload the page. The domain should be blocked again and reappear in the blocked count.

### 12.3 Per‑site vs global scope

1. Allow a domain that appears on multiple sites (for example, `www.googletagmanager.com`).
2. By default, the entry is scoped to the current site. In the **Whitelist** tab, the Scope column shows **Site** and displays the hostname.
3. Click the scope toggle button (**→ All**) to switch the entry to **Global**. The scope changes to **Global**.
4. Navigate to a different site where the same domain is blocked. Reload - the domain should now be allowed there too.
5. To narrow the scope back, click **→ Site** in the Whitelist tab. The entry reverts to site-only, effective only on the current site.

### 12.4 Verifying whitelist rules from the service worker console

Open the service worker console for the extension and run:

```js
chrome.declarativeNetRequest.getDynamicRules().then(r => {
  const wl = r.filter(x => x.action.type === 'allow');
  console.log('Whitelist allow rules:', wl.length);
  wl.forEach(x => console.log(' ', x.priority, x.condition.requestDomains));
})
```

- Whitelisted domains appear as priority 3 `allow` rules.
- Adding a domain creates or updates the rule; removing all whitelisted domains removes the rule entirely.
- You can also check the raw storage with: `chrome.storage.local.get("whitelist", r => console.log(r))`.

## 13. Testing Enhanced Protection

Enhanced Protection adds optional third‑party blocklists that are fetched on demand. These lists are enforced via dynamic DNR rules, and the Enhanced tab in the popup manages presets and individual lists.

### 13.1 Activating a preset

1. Open the ProtoConsent popup and click the **Enhanced** tab in the mode rail.
2. The preset bar shows four options: **Off**, **Basic**, **Full**, and **Custom** (disabled until you toggle individual lists).
3. Select **Basic**. The extension will prompt you to download the four basic lists (EasyPrivacy, EasyList, AdGuard DNS, Steven Black).
4. Wait for all downloads to complete - each card shows a progress indicator, then switches to an enabled state with a domain count.
5. Select **Full** to enable all 12 lists. Lists not yet downloaded will start downloading automatically.

Enhanced Protection tab with the Basic preset active:

![Enhanced Protection tab](assets/screenshots/popup-enhanced-basic.png)

### 13.2 Downloading and toggling lists

1. With the **Basic** preset active, find a Full‑only list (for example, HaGeZi Pro) and click its **Download** button.
2. Once downloaded, the list appears with a toggle switch. Toggle it on - the preset switches to **Custom** automatically.
3. Toggle it off again. The preset remains **Custom** because the state no longer matches Basic or Full exactly.
4. To remove a downloaded list entirely, click its **Remove** (×) button. The list reverts to the not‑downloaded state.

### 13.3 Verifying enhanced blocks in the Log tab

1. With Enhanced lists enabled, visit a site with significant third‑party traffic (for example, a news site).
2. Open the ProtoConsent popup → **Log** tab → **Domains** panel.
3. Enhanced blocks appear with a shield icon (🛡) alongside the domain name, distinct from core purpose icons.
4. Lists with a category mapping (for example, EasyPrivacy → analytics, Blocklist Project Phishing → security) also show the corresponding category icon next to the shield.
5. The blocked count in the Consent tab header includes an enhanced count indicator (shield + number) when enhanced blocks are present.

### 13.4 Checking enhanced rules from the service worker console

Open the service worker console for the extension and run:

```js
chrome.declarativeNetRequest.getDynamicRules().then(r => {
  const enhanced = r.filter(x => x.action.type === 'block' && x.priority === 2 && !x.condition.initiatorDomains);
  console.log('Enhanced block rules:', enhanced.length);
  enhanced.slice(0, 5).forEach(x => console.log(' ', x.id, x.condition.requestDomains?.length || 0, 'domains'));
})
```

You can also check Enhanced state in storage:

```js
chrome.storage.local.get(["enhancedLists", "enhancedPreset"], r => console.log(r))
```

