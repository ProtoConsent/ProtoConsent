// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// well-known.js — .well-known/protoconsent.json fetch, validation, and rendering.
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

function setWellKnownIndicator(state, titleText) {
  const indicatorEl = document.getElementById("pc-wk-indicator");
  const labelEl = document.getElementById("pc-wk-label");
  if (!indicatorEl || !labelEl) return;

  indicatorEl.classList.remove("is-active", "is-inactive", "is-disabled");

  if (state === "active") {
    indicatorEl.classList.add("is-active");
    labelEl.textContent = "WK ok";
    indicatorEl.title = titleText || "Valid .well-known declaration detected";
    return;
  }

  if (state === "inactive") {
    indicatorEl.classList.add("is-inactive");
    labelEl.textContent = "WK off";
    indicatorEl.title = titleText || "No valid .well-known declaration for this site";
    return;
  }

  indicatorEl.classList.add("is-disabled");
  labelEl.textContent = "WK n/a";
  indicatorEl.title = titleText || ".well-known status unavailable";
}

// Load and display site declaration from .well-known/protoconsent.json
async function loadSiteDeclaration() {
  if (!currentDomain) {
    setWellKnownIndicator("disabled", ".well-known unavailable on this page");
    return;
  }

  setWellKnownIndicator("inactive", "Checking .well-known declaration...");

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

    // Fetch via executeScript: runs in the page context (same-origin, no extra permissions)
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: async () => {
        try {
          const res = await fetch("/.well-known/protoconsent.json");
          if (res.ok) return await res.json();
        } catch (_) {}
        return null;
      }
    });

    const data = results && results[0] && results[0].result;

    if (data && validateSiteDeclaration(data)) {
      // Cache valid declarations (24h TTL)
      chrome.storage.local.set({ [cacheKey]: { data, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
      renderSiteDeclaration(container, data);
      setWellKnownIndicator("active");
    } else {
      // Cache negative/invalid result (6h TTL) to avoid re-fetching on every popup open
      chrome.storage.local.set({ [cacheKey]: { data: null, ts: Date.now() } }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[well-known] Cache write error:", chrome.runtime.lastError);
        }
      });
      setWellKnownIndicator("inactive");
    }
  } catch (err) {
    console.error("[well-known] Error:", err);
    setWellKnownIndicator("disabled", "Could not check .well-known declaration");
  }
}

// Minimal validation of a .well-known/protoconsent.json file.
// See design/well-known-spec.md §4.2 for the rules.
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
    nameEl.textContent = cfg.short_label || cfg.label || purposeKey;

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
      if (typeof entry.provider === "string") providers.add(entry.provider);
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
    provEl.textContent = "Provider: " + [...providers].join(", ");
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

  // Rights URL (only https:// or http:// to prevent javascript: / data: XSS)
  if (typeof declaration.rights_url === "string" &&
      /^https?:\/\//i.test(declaration.rights_url)) {
    const rightsEl = document.createElement("div");
    rightsEl.className = "pc-declaration-data";
    const rightsLink = document.createElement("a");
    rightsLink.href = declaration.rights_url;
    rightsLink.textContent = "Your rights";
    rightsLink.target = "_blank";
    rightsLink.rel = "noopener noreferrer";
    rightsLink.className = "pc-declaration-link";
    rightsEl.appendChild(rightsLink);
    container.appendChild(rightsEl);
  }

  // Show the side tab and wire toggle (guard against duplicate listeners)
  const sideTab = document.getElementById("pc-side-tab");
  const sidePanel = document.getElementById("pc-side-panel");
  if (sideTab && sidePanel && !sideTab.dataset.bound) {
    sideTab.dataset.bound = "1";
    sideTab.classList.add("is-visible");
    sideTab.addEventListener("click", () => {
      const isOpen = sidePanel.classList.toggle("is-open");
      sideTab.classList.toggle("is-open", isOpen);
      sideTab.setAttribute("aria-expanded", isOpen ? "true" : "false");
      sidePanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    });
  }
}
