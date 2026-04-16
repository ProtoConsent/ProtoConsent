// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// well-known.js - .well-known/protoconsent.json fetch, validation, and rendering.
// Loaded after popup.js; uses globals: currentDomain, purposesConfig, PURPOSES_TO_SHOW.

// Consent Commons icons for legal_basis values in site declaration
const LEGAL_BASIS_ICONS = {
  consent: "../icons/declaration/consent.png",
  contractual: "../icons/declaration/contractual.png",
  legitimate_interest: "../icons/declaration/legitimate_interest.png",
  legal_obligation: "../icons/declaration/legal_obligation.png",
  public_interest: "../icons/declaration/public_interest.png",
  vital_interest: "../icons/declaration/vital_interest.png",
};

// Display labels for legal_basis values
const LEGAL_BASIS_LABELS = {
  legitimate_interest: "legit. interest",
};

// Cache TTL for .well-known declarations
const WELL_KNOWN_CACHE_TTL = 24 * 60 * 60 * 1000;
// Shorter TTL for negative results (site has no .well-known or invalid file)
const WELL_KNOWN_NEGATIVE_TTL = 6 * 60 * 60 * 1000;
// Maximum cached .well-known entries before evicting oldest
const WELL_KNOWN_MAX_ENTRIES = 200;
// Known legal_basis values (GDPR Article 6)
const KNOWN_LEGAL_BASIS = ["consent", "contractual", "legitimate_interest", "legal_obligation", "public_interest", "vital_interest"];
// Maximum string length for declaration text fields
const WELL_KNOWN_MAX_STRING_LEN = 100;

// Strip unrecognized fields and cap string lengths before caching
function sanitizeDeclaration(raw) {
  if (!raw || typeof raw !== "object") return null;
  const clean = {};
  if (typeof raw.protoconsent === "string") clean.protoconsent = raw.protoconsent.slice(0, 10);
  if (raw.purposes && typeof raw.purposes === "object") {
    clean.purposes = {};
    for (const [key, entry] of Object.entries(raw.purposes)) {
      if (typeof key !== "string" || key.length > 50) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (!entry || typeof entry !== "object") continue;
      const p = { used: entry.used === true };
      if (typeof entry.legal_basis === "string" && KNOWN_LEGAL_BASIS.includes(entry.legal_basis)) {
        p.legal_basis = entry.legal_basis;
      }
      if (typeof entry.sharing === "string") p.sharing = entry.sharing.slice(0, WELL_KNOWN_MAX_STRING_LEN);
      // v0.2: providers array (replaces provider string)
      if (Array.isArray(entry.providers)) {
        const prov = entry.providers
          .filter(function(s) { return typeof s === "string" && s.trim(); })
          .map(function(s) { return s.slice(0, WELL_KNOWN_MAX_STRING_LEN); })
          .slice(0, 20);
        if (prov.length > 0) p.providers = prov;
      }
      // v0.1 fallback: provider string -> providers array
      if (!p.providers && typeof entry.provider === "string" && entry.provider.trim()) {
        p.providers = [entry.provider.slice(0, WELL_KNOWN_MAX_STRING_LEN)];
      }
      // v0.2: retention object
      if (entry.retention && typeof entry.retention === "object" && !Array.isArray(entry.retention)) {
        const rt = entry.retention;
        if (rt.type === "session" || rt.type === "until_withdrawal") {
          p.retention = { type: rt.type };
        } else if (rt.type === "fixed") {
          const fixedRt = { type: "fixed" };
          if (typeof rt.value === "number" && rt.value > 0 && Number.isInteger(rt.value)) {
            fixedRt.value = rt.value;
          }
          if (typeof rt.unit === "string" && ["days", "months", "years"].includes(rt.unit)) {
            fixedRt.unit = rt.unit;
          }
          if (fixedRt.value && fixedRt.unit) p.retention = fixedRt;
        }
      }
      clean.purposes[key] = p;
    }
  }
  if (raw.data_handling && typeof raw.data_handling === "object") {
    const dh = {};
    if (typeof raw.data_handling.storage_region === "string") {
      dh.storage_region = raw.data_handling.storage_region.slice(0, 20);
    }
    if (typeof raw.data_handling.international_transfers === "boolean") {
      dh.international_transfers = raw.data_handling.international_transfers;
    }
    if (Object.keys(dh).length > 0) clean.data_handling = dh;
  }
  // v0.2: links object (replaces rights_url)
  if (raw.links && typeof raw.links === "object" && !Array.isArray(raw.links)) {
    const ln = {};
    if (typeof raw.links.policy === "string" && /^https?:\/\//i.test(raw.links.policy)) {
      ln.policy = raw.links.policy.slice(0, 500);
    }
    if (typeof raw.links.rights === "string" && /^https?:\/\//i.test(raw.links.rights)) {
      ln.rights = raw.links.rights.slice(0, 500);
    }
    if (Object.keys(ln).length > 0) clean.links = ln;
  }
  // v0.1 fallback: rights_url -> links.rights
  if (!clean.links && typeof raw.rights_url === "string" && /^https?:\/\//i.test(raw.rights_url)) {
    clean.links = { rights: raw.rights_url.slice(0, 500) };
  }
  // v0.2: last_updated date
  if (typeof raw.last_updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.last_updated)) {
    clean.last_updated = raw.last_updated;
  }
  return clean;
}

// Evict oldest wk_ entries if over the limit
async function evictOldCacheEntries() {
  const all = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  const wkEntries = [];
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith("wk_") && val && typeof val.ts === "number") {
      wkEntries.push({ key, ts: val.ts });
    }
  }
  if (wkEntries.length <= WELL_KNOWN_MAX_ENTRIES) return;
  wkEntries.sort((a, b) => a.ts - b.ts);
  const toRemove = wkEntries.slice(0, wkEntries.length - WELL_KNOWN_MAX_ENTRIES).map(e => e.key);
  if (toRemove.length > 0) {
    chrome.storage.local.remove(toRemove);
  }
}

// Global WK indicator state (read by popup.js renderSignalsBar)
var _wkIndicatorState = "disabled";
var _wkIndicatorTitle = "ProtoConsent .well-known status unavailable";

function setWellKnownIndicator(state, titleText) {
  _wkIndicatorState = state;
  _wkIndicatorTitle = titleText || (
    state === "active" ? "Valid ProtoConsent .well-known declaration detected"
    : state === "inactive" ? "No valid ProtoConsent .well-known declaration for this site"
    : "ProtoConsent .well-known status unavailable"
  );

  // Refresh the signals bar if it exists (pill indicators are rendered there now)
  if (typeof renderSignalsBar === "function") renderSignalsBar();
}

// Load and display site declaration from .well-known/protoconsent.json
async function loadSiteDeclaration() {
  if (!currentDomain) {
    setWellKnownIndicator("disabled", "ProtoConsent .well-known unavailable on this page");
    return;
  }

  setWellKnownIndicator("inactive", "Checking ProtoConsent .well-known declaration...");

  const container = document.getElementById("pc-site-declaration");
  if (!container) return;

  try {
    const cacheKey = "wk_" + currentDomain;
    const cached = await new Promise(resolve =>
      chrome.storage.local.get([cacheKey], resolve)
    );
    if (cached[cacheKey]) {
      const entry = cached[cacheKey];
      const ttl = entry.data ? WELL_KNOWN_CACHE_TTL : WELL_KNOWN_NEGATIVE_TTL;
      if (Date.now() - entry.ts < ttl) {
        if (entry.data) {
          renderSiteDeclaration(container, entry.data);
          setWellKnownIndicator("active");
        } else {
          setWellKnownIndicator("inactive");
        }
        return;
      }
    }

    // Fetch via background service worker (bypasses page Service Workers, no cookies sent)
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: "PROTOCONSENT_FETCH_WELL_KNOWN", domain: currentDomain, host: currentHost, protocol: currentProtocol },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(resp);
          }
        }
      );
    });

    const data = response?.data || null;

    if (data && validateSiteDeclaration(data)) {
      const clean = sanitizeDeclaration(data);
      // Cache sanitized declaration (24h TTL), then evict oldest if over limit
      chrome.storage.local.set({ [cacheKey]: { data: clean, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
        evictOldCacheEntries();
      });
      renderSiteDeclaration(container, clean);
      setWellKnownIndicator("active");
    } else {
      // Cache negative/invalid result (6h TTL) to avoid re-fetching on every popup open
      chrome.storage.local.set({ [cacheKey]: { data: null, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
        evictOldCacheEntries();
      });
      setWellKnownIndicator("inactive");
    }
  } catch (err) {
    console.error("[well-known] Error:", err);
    setWellKnownIndicator("disabled", "Could not check ProtoConsent .well-known declaration");
  }
}

// Minimal validation of a ProtoConsent .well-known/protoconsent.json file.
// See design/spec/protoconsent-well-known.md §4.2 for the rules.
function validateSiteDeclaration(json) {
  if (!json || typeof json !== "object") return false;
  if (!json.purposes || typeof json.purposes !== "object") return false;

  let hasValidPurpose = false;
  for (const key of Object.keys(json.purposes)) {
    if (!PURPOSES_TO_SHOW.includes(key)) continue;
    const entry = json.purposes[key];
    if (entry && typeof entry === "object" && typeof entry.used === "boolean") {
      hasValidPurpose = true;
      break;
    }
  }
  return hasValidPurpose;
}

function toggleSidePanel() {
  const sideTab = document.getElementById("pc-side-tab");
  const sidePanel = document.getElementById("pc-side-panel");
  if (!sideTab || !sidePanel) return;
  const isOpen = sidePanel.classList.toggle("is-open");
  sideTab.classList.toggle("is-open", isOpen);
  sideTab.setAttribute("aria-expanded", isOpen ? "true" : "false");
  sidePanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
  const layout = document.getElementById("popup-layout");
  if (layout) layout.classList.toggle("has-side-panel", isOpen);
}

function renderSiteDeclaration(container, declaration) {
  container.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "pc-declaration-title";
  titleEl.textContent = "Site declaration";
  container.appendChild(titleEl);

  // Render each purpose in display order
  for (const purposeKey of PURPOSES_TO_SHOW) {
    const cfg = purposesConfig[purposeKey];
    if (!cfg) continue;

    const row = document.createElement("div");
    row.className = "pc-declaration-row";

    const nameEl = document.createElement("span");
    nameEl.className = "pc-declaration-purpose";
    nameEl.textContent = getPurposeLabel(purposeKey, "short");

    const checkEl = document.createElement("span");
    checkEl.className = "pc-declaration-check";

    const basisEl = document.createElement("span");
    basisEl.className = "pc-declaration-basis";

    const entry = declaration.purposes[purposeKey];
    if (!entry) {
      checkEl.textContent = "—";
      checkEl.classList.add("not-declared");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Not declared");
    } else if (entry.used) {
      checkEl.textContent = "✓";
      checkEl.classList.add("used");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Used");

      if (typeof entry.legal_basis === "string") {
        const basisIcon = LEGAL_BASIS_ICONS[entry.legal_basis];
        if (basisIcon) {
          const iconImg = document.createElement("img");
          iconImg.src = basisIcon;
          iconImg.alt = "";
          iconImg.className = "pc-declaration-icon";
          iconImg.width = 14;
          iconImg.height = 14;
          iconImg.onerror = () => iconImg.remove();
          basisEl.appendChild(iconImg);
        }
        basisEl.appendChild(document.createTextNode(
          LEGAL_BASIS_LABELS[entry.legal_basis] || entry.legal_basis.replace(/_/g, " ")
        ));
      }
      // v0.2: retention inline after legal basis
      if (entry.retention) {
        let retText = "";
        if (entry.retention.type === "session") retText = "session";
        else if (entry.retention.type === "fixed" && entry.retention.value && entry.retention.unit) {
          retText = entry.retention.value + " " + entry.retention.unit;
        } else if (entry.retention.type === "until_withdrawal") retText = "withdrawal";
        if (retText) {
          basisEl.appendChild(document.createTextNode(" \u00B7 "));
          const retSpan = document.createElement("span");
          retSpan.className = "pc-declaration-retention";
          retSpan.textContent = retText;
          basisEl.appendChild(retSpan);
        }
      }
    } else {
      checkEl.textContent = "✗";
      checkEl.classList.add("not-used");
      checkEl.setAttribute("role", "img");
      checkEl.setAttribute("aria-label", "Not used");
    }

    row.appendChild(nameEl);
    row.appendChild(checkEl);
    row.appendChild(basisEl);
    container.appendChild(row);
  }

  // Collect providers and sharing info across purposes
  const providers = new Set();
  const sharingValues = new Set();
  for (const purposeKey of PURPOSES_TO_SHOW) {
    const entry = declaration.purposes[purposeKey];
    if (entry && entry.used) {
      if (Array.isArray(entry.providers)) {
        entry.providers.forEach(function(p) { providers.add(p); });
      }
      if (typeof entry.sharing === "string") sharingValues.add(entry.sharing.replace(/_/g, " "));
    }
  }

  // Data handling section (if present and valid)
  if (declaration.data_handling && typeof declaration.data_handling === "object") {
    const dh = declaration.data_handling;

    if (typeof dh.storage_region === "string") {
      const regionEl = document.createElement("div");
      regionEl.className = "pc-declaration-data";
      regionEl.textContent = "Stored: " + dh.storage_region.toUpperCase();
      container.appendChild(regionEl);
    }

    if (dh.international_transfers === true || dh.international_transfers === false) {
      const intlEl = document.createElement("div");
      intlEl.className = "pc-declaration-data";

      const intlIcon = document.createElement("img");
      intlIcon.src = dh.international_transfers
        ? "../icons/declaration/intl_transfers_yes.png"
        : "../icons/declaration/intl_transfers_no.png";
      intlIcon.alt = "";
      intlIcon.className = "pc-declaration-icon";
      intlIcon.width = 14;
      intlIcon.height = 14;
      intlIcon.onerror = () => intlIcon.remove();
      intlEl.appendChild(intlIcon);

      const intlText = dh.international_transfers ? " International transfers" : " No international transfers";
      intlEl.appendChild(document.createTextNode(intlText));
      container.appendChild(intlEl);
    }
  }

  if (providers.size > 0) {
    const provEl = document.createElement("div");
    provEl.className = "pc-declaration-data";
    provEl.textContent = (providers.size === 1 ? "Provider: " : "Providers: ") + [...providers].join(", ");
    container.appendChild(provEl);
  }

  if (sharingValues.size > 0) {
    const shareEl = document.createElement("div");
    shareEl.className = "pc-declaration-data";

    const shareIcon = document.createElement("img");
    shareIcon.src = "../icons/declaration/sharing.png";
    shareIcon.alt = "";
    shareIcon.className = "pc-declaration-icon";
    shareIcon.width = 14;
    shareIcon.height = 14;
    shareIcon.onerror = () => shareIcon.remove();
    shareEl.appendChild(shareIcon);

    const shareText = document.createTextNode(" Sharing: " + [...sharingValues].join(", "));
    shareEl.appendChild(shareText);
    container.appendChild(shareEl);
  }

  // Links (v0.2) — policy and rights URLs (also handles v0.1 rights_url via sanitizer fallback)
  if (declaration.links && typeof declaration.links === "object") {
    const linkDefs = [
      { key: "policy", heading: "Privacy policy" },
      { key: "rights", heading: "Your rights" },
    ];
    for (const ld of linkDefs) {
      const linkUrl = declaration.links[ld.key];
      if (typeof linkUrl !== "string" || !/^https?:\/\//i.test(linkUrl)) continue;

      const linkEl = document.createElement("div");
      linkEl.className = "pc-declaration-data";

      const maxLen = 50;
      const displayUrl = linkUrl.length > maxLen ? linkUrl.slice(0, maxLen) + "[...]" : linkUrl;

      // Domain check (anti-phishing: only make same-domain links clickable)
      let linkHost = "";
      try { linkHost = new URL(linkUrl).hostname.replace(/^www\./, ""); } catch (_) {}
      const siteDomain = (currentDomain || "").replace(/^www\./, "");
      const isSameDomain = linkHost.includes(".") && (
        linkHost === siteDomain
        || linkHost.endsWith("." + siteDomain)
        || siteDomain.endsWith("." + linkHost)
      );

      const headingEl = document.createElement("span");
      headingEl.className = "pc-declaration-purpose";
      headingEl.textContent = ld.heading;
      linkEl.appendChild(headingEl);

      const urlLabel = document.createElement("span");
      urlLabel.className = "pc-declaration-link--url";
      urlLabel.textContent = displayUrl;
      urlLabel.title = linkUrl;
      linkEl.appendChild(urlLabel);

      const actionRow = document.createElement("div");
      actionRow.className = "pc-declaration-actions";

      if (isSameDomain && linkHost) {
        const anchor = document.createElement("a");
        anchor.href = linkUrl;
        anchor.textContent = ld.heading + " \u2197";
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.className = "pc-declaration-link";
        actionRow.appendChild(anchor);
      } else if (linkHost) {
        const warnEl = document.createElement("span");
        warnEl.className = "pc-declaration-warning";
        warnEl.textContent = "Different domain \u002D not clickable";
        actionRow.appendChild(warnEl);
      }

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "pc-declaration-copy";
      copyBtn.textContent = "Copy URL";
      copyBtn.title = linkUrl;
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(linkUrl).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
        }).catch(() => {
          copyBtn.textContent = "Failed";
          setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500);
        });
      });
      actionRow.appendChild(copyBtn);

      linkEl.appendChild(actionRow);
      container.appendChild(linkEl);
    }
  }

  // v0.2: last_updated date
  if (typeof declaration.last_updated === "string") {
    const updEl = document.createElement("div");
    updEl.className = "pc-declaration-data";
    updEl.textContent = "Updated: " + declaration.last_updated;
    container.appendChild(updEl);
  }

  // Show the side tab and wire toggle (guard against duplicate listeners)
  const sideTab = document.getElementById("pc-side-tab");
  const sidePanel = document.getElementById("pc-side-panel");
  if (sideTab && sidePanel && !sideTab.dataset.bound) {
    sideTab.dataset.bound = "1";
    sideTab.classList.add("is-visible");
    const layout = document.getElementById("popup-layout");
    if (layout) layout.classList.add("has-side-tab");
    sideTab.addEventListener("click", toggleSidePanel);
  }
}
