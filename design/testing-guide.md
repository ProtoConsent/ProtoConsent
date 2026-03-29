# ProtoConsent – How to test the extension

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

This document explains how to try the current version of ProtoConsent in a browser using an unpacked extension, and how to observe its effects on real websites.

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

  In this folder you should see files like `manifest.json`, `background.js`, `popup.html`, `popup.js`, `popup.css` and the `config/` and `icons/` directories.

2.2. **Load the extension in your browser:**

- Open the extensions page (for example `chrome://extensions/` or `edge://extensions/`).
- Enable **Developer mode**.
- Click **Load unpacked** and select the folder that contains `manifest.json` (the project root you just cloned).
- Confirm that an extension called **ProtoConsent** appears in the extensions list and that it is enabled. Pin it in the toolbar if your browser supports pinning.

## 3. Basic Test: Per‑Site Profile

This first test checks that site rules are stored locally and correctly associated with each domain.

1. Visit any news or blog site of your choice.
2. Open the ProtoConsent popup from the browser toolbar.
3. Use the **Profile** selector to assign a profile to the current site (for example, “Strict” or “Balanced”).
4. Reload the page.
5. Open the popup again and confirm that the selected profile is still applied to this site.
6. If you repeat the same steps on a different domain, each site should keep its own profile.

Example popup view with profile and per‑purpose summary:

![ProtoConsent popup with per-site profile](../docs/assets/screenshots/popup-profile.png)

Expanded view with purpose toggles visible:

![ProtoConsent popup with purpose toggles](../docs/assets/screenshots/popup-toggles.png)

## 4. Purpose Toggles and Visible Effects

This test shows how changing purposes in ProtoConsent has direct, observable effects on network traffic.

1. On a site that uses web analytics, open the ProtoConsent popup.
2. Choose a profile (for example “Balanced”).
3. In the popup, make sure that **Functional (service)** remains **Allowed** and set **Analytics** to **Blocked** for this site.
4. Open your browser’s developer tools and go to the **Network** tab. Optionally filter by a common analytics domain (for example `google-analytics.com` or `analytics`).
5. Reload the page and observe the network requests. You should see that analytics requests that would normally be sent are now missing or reported as blocked.
6. Switch to a more permissive profile or enable **Analytics** for this site in the popup.
7. Reload again and confirm that analytics requests are now visible in the network log.

The goal is not to exhaustively test every tracker, but to see the cause‑and‑effect relationship between purpose toggles and network traffic.

## 5. Example: Blocking Ads on elpais.com (DoubleClick)

This example uses the Spanish news site <https://elpais.com/> to show how the **Ads / Marketing** purpose affects third‑party ad requests.

### 5.1 Baseline: Ads Allowed

1. Open <https://elpais.com/> in a new tab.
2. Open the ProtoConsent popup.
3. Ensure the **Profile** is set to a mode where **Ads / Marketing** is **Allowed** for elpais.com.
4. Open developer tools and go to the **Network** tab.
5. Use the filter box to search for `doubleclick` or `googlesyndication`.
6. Reload the page.
7. In the Network panel you should see requests to domains like `g.doubleclick.net`, `googleads.g.doubleclick.net` or `pagead2.googlesyndication.com` with status 200 (or similar).

Example screenshot with ads allowed:

![Ads / Marketing allowed on elpais.com](assets/screenshots/test-elpais-allowed.png)

Basic ad slots are visible in the page header & footer and the Network panel shows `doubleclick` requests with successful responses.

### 5.2 Ads Blocked with ProtoConsent

1. With the same elpais.com tab open, switch back to the ProtoConsent popup.
2. Set **Ads / Marketing** to **Blocked** for elpais.com.
3. The extension updates its rules immediately.
4. Keep developer tools open on the Network tab, still filtered by `doubleclick`.
5. Reload the page.
6. Now you should see that some requests to `g.doubleclick.net`, `googleads.g.doubleclick.net` or `cm.g.doubleclick.net` fail with `net::ERR_BLOCKED_BY_CLIENT` or similar errors, indicating that the browser blocked them before they were completed.

Example screenshot with ads blocked:

![Ads / Marketing blocked on elpais.com](assets/screenshots/test-elpais-blocked.png)

Basic blocking of tracking resources for the **Ads** purpose on a news site: notice missing ad slots in the page header and `ERR_BLOCKED_BY_CLIENT` entries in the Network panel.

## 6. Trying different sites, profiles and purposes

To get a broader feeling for the ProtoConsent extension, you can combine site profiles with purpose-level tests.

- Repeat the tests above on several sites (for example, other news sites, blogs, or services that embed third‑party widgets).
- Try different profiles (“Strict”, “Balanced”, “Permissive”) to see how they translate into purpose states for each site.
- Experiment with per‑site overrides: start from a profile and then enable or disable a specific purpose manually.

Below are example scenarios for each purpose.

### 6.1 Functional (service)

**Goal:** Understand the role of the Functional purpose.

- Functional represents everything strictly necessary to provide the service (login, navigation, basic UX, billing, support).
- In this early version, Functional does not generate any blocking rules, even if you turn it off, to avoid breaking sites by accident.
- You can still use it as a reference to distinguish “core service” from optional analytics, ads or third‑party integrations.

### 6.2 Analytics

**Goal:** See how Analytics controls measurement and usage tracking.

- Reference domains: `google-analytics.com`, `www.google-analytics.com`, `analytics.google.com`, `stats.g.doubleclick.net`, `cdn.segment.com`.

- Steps:
  1. Visit a site that uses Google Analytics or Segment.
  2. In the ProtoConsent popup, keep **Functional** allowed and set **Analytics** to *Blocked* for this site.
  3. Open DevTools → **Network**, filter by `google-analytics` or `segment`.
  4. Reload the page and verify that these requests are missing or reported as `ERR_BLOCKED_BY_CLIENT`.
  5. Switch **Analytics** back to *Allowed*, reload and confirm that the requests reappear with status 200.

### 6.3 Ads / Marketing

**Goal:** Observe the impact on advertising traffic.

- Reference domains: `doubleclick.net`, `pagead2.googlesyndication.com`, `securepubads.g.doubleclick.net`, `adservice.google.com`, `ads.yahoo.com`.

- Steps:
  1. Use a site with visible ads (for example, a major news site).
  2. With **Ads / Marketing** set to *Allowed*, open **Network** and filter by `doubleclick` or `googlesyndication`. Confirm that requests return 200.
  3. Set **Ads / Marketing** to *Blocked* for this site.
  4. Reload and check that the same requests now disappear or are shown as blocked (for example `ERR_BLOCKED_BY_CLIENT`).

### 6.4 Personalization / Profiling

**Goal:** Separate basic ads from more advanced personalization or retargeting.

- Reference domains: `ad.doubleclick.net`, `cm.g.doubleclick.net`, `secure.adnxs.com`, `idsync.rlcdn.com`, `match.adsrvr.org`.

- Steps:
  1. On a site with banners and personalised or retargeted ads, keep **Ads / Marketing** allowed but set **Personalization / Profiling** to *Blocked*.
  2. Filter in **Network** by `adnxs`, `adsrvr`, `doubleclick`.
  3. Reload and compare the results with the case where Personalization is also allowed.
  4. This will not be perfect on every site, but it shows that ProtoConsent treats personalization as a separate purpose from “basic ads”.

### 6.5 Third-party sharing

**Goal:** Highlight third‑party data sharing and integrations.

- Reference domains: `connect.facebook.net`, `static.hotjar.com`, `script.hotjar.com`, `analytics.twitter.com`, `bat.bing.com`.

- Steps:
  1. Choose a site that embeds social widgets, Hotjar or Microsoft/Bing tracking.

  2. Allow **Functional** and **Analytics**, but set **Third‑party sharing** to *Blocked*.
  3. Filter by `facebook.net`, `hotjar`, `analytics.twitter.com` or `bat.bing.com` in **Network**.
  4. Reload and compare the results with the case where Third‑party sharing is also allowed.

### 6.6 Advanced tracking / fingerprinting

**Goal:** Target more advanced monitoring or experimentation tools.

- Reference domains: `js-agent.newrelic.com`, `bam.nr-data.net`, `cdn.perfdrive.com`, `cdn.heapanalytics.com`, `cdn.optimizely.com`.

- Steps:
  1. Visit a site that uses New Relic, Heap, Optimizely or similar tooling.
  2. Set **Advanced tracking / fingerprinting** to *Blocked* and keep the other purposes allowed.
  3. Filter in **Network** by `newrelic`, `nr-data`, `heapanalytics` or `optimizely`.
  4. Reload and check whether those requests are blocked; then switch Advanced tracking back to *Allowed* and confirm that they return to 200 responses.

These scenarios are not meant to be exhaustive, but to show that ProtoConsent already offers a consistent, browser‑level way to express and enforce purpose‑based preferences across real websites.

## 7. Testing the SDK query flow (content script bridge)

This test verifies that a web page can query the user's consent preferences through the ProtoConsent SDK protocol. The extension injects a content script on every page that bridges SDK queries to the extension's storage.

### 7.1 Setup

1. Make sure the extension is loaded and reloaded after any code changes (see section 2).
2. Open any website (for example `wikipedia.org`).
3. Use the ProtoConsent popup to set a profile and adjust purposes for this site.

### 7.2 Querying from the browser console

Open DevTools (F12) and go to the **Console** tab. Paste the following helper function:

```
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

```
await testQuery('get', 'analytics')
```

You can replace `'analytics'` with any valid purpose key: `functional`, `analytics`, `ads`, `personalization`, `third_parties`, `advanced_tracking`.

```
await testQuery('getAll')
```

```
await testQuery('getProfile')
```

### 7.3 Expected results

- `get('analytics')` returns `true` or `false` depending on the purpose state for this site.
- `getAll()` returns an object with a boolean property per purpose, resolved from the active profile plus any overrides.
- `getProfile()` returns the profile name (`"strict"`, `"balanced"` or `"permissive"`).

On a site with no explicit configuration, the results reflect the default profile (currently balanced).

### 7.4 Security validation

These queries should be rejected by the content script:

```
await testQuery('delete', null)
```

Expected: `TIMEOUT` (invalid action, ignored by the content script).

```
await testQuery('get', 'malware')
```

Expected: `null` (invalid purpose, the extension has no data for it).

