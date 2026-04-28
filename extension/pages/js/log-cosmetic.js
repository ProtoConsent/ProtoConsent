// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Cosmetic tab: per-selector exclusion, site-level exclusion, filter + pagination.
// Loaded before log.js - exposes renderLogCosmetic() and _cosmeticCachedData.

let logCosmeticFilter = "";
// eslint-disable-next-line no-unused-vars -- read by log.js refreshLogView guard
let _cosmeticCachedData = null;

// Cache of user cosmetic exceptions (loaded once per popup open)
let _cosmeticUserExceptions = null;
let _cosmeticExceptionsLoading = false;

function loadCosmeticExceptions(cb) {
  if (_cosmeticUserExceptions !== null) { cb(_cosmeticUserExceptions); return; }
  if (_cosmeticExceptionsLoading) { setTimeout(() => loadCosmeticExceptions(cb), 100); return; }
  _cosmeticExceptionsLoading = true;
  const timeout = setTimeout(() => {
    _cosmeticExceptionsLoading = false;
    _cosmeticUserExceptions = {};
    cb(_cosmeticUserExceptions);
  }, 5000);
  chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_COSMETIC_EXCEPTIONS" }, (resp) => {
    clearTimeout(timeout);
    _cosmeticExceptionsLoading = false;
    if (chrome.runtime.lastError) {
      _cosmeticUserExceptions = {};
    } else {
      _cosmeticUserExceptions = (resp && resp.exceptions) ? resp.exceptions : {};
    }
    cb(_cosmeticUserExceptions);
  });
}

// eslint-disable-next-line no-unused-vars -- called from log.js
function renderLogCosmetic() {
  const container = document.getElementById("pc-log-cosmetic");
  if (!container) return;

  if (!_cosmeticCachedData) {
    container.innerHTML = "";
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      const tabUrl = tabs[0].url || "";
      let tabDomain = "";
      try { tabDomain = new URL(tabUrl).hostname.replace(/^www\./, ""); } catch (_) {}

      chrome.runtime.sendMessage({ type: "PROTOCONSENT_GET_COSMETIC", tabId: tabs[0].id }, (resp) => {
        if (chrome.runtime.lastError) resp = null;
        const c = resp?.cosmetic || null;
        const domainSels = c ? (c.domainSelectors || []) : [];
        const genericSels = c ? (c.genericSelectors || []) : [];
        const domain = c ? c.domain : tabDomain;

        if (!domain) {
          container.innerHTML = '<div class="pc-log-empty">No cosmetic filters applied on this page.</div>';
          return;
        }

        loadCosmeticExceptions((exceptions) => {
          const excludedSet = new Set(exceptions[domain] || []);
          const allSelectors = domainSels.concat(genericSels);
          const notOnPage = (exceptions[domain] || []).filter(s => !allSelectors.includes(s));
          chrome.storage.local.get(["cosmeticExcludedSites"], (r) => {
            const siteExcluded = (r.cosmeticExcludedSites || []).includes(domain);
            if (!siteExcluded && allSelectors.length === 0 && notOnPage.length === 0) {
              container.innerHTML = '<div class="pc-log-empty">No cosmetic filters applied on this page.</div>';
              return;
            }
            _cosmeticCachedData = { domain, domainSels, genericSels, excludedSet, notOnPage, siteExcluded };
            _renderCosmeticFromCache(container);
          });
        });
      });
    });
    return;
  }

  _renderCosmeticFromCache(container);
}

function _renderCosmeticFromCache(container) {
  const { domain, domainSels, genericSels, excludedSet, notOnPage, siteExcluded } = _cosmeticCachedData;
  const allSelectors = domainSels.concat(genericSels);
  const activeSet = new Set(domainSels);
  container.innerHTML = "";

  // Header row: label + site-level button
  const headerRow = document.createElement("div");
  headerRow.className = "pc-cosmetic-header-row";

  const label = document.createElement("div");
  label.className = "pc-log-purpose-label";
  if (allSelectors.length > 0) {
    let parts = [];
    if (domainSels.length > 0) parts.push(domainSels.length + " site");
    if (genericSels.length > 0) parts.push(genericSels.length + (genericSels.length >= 500 ? "+" : "") + " generic");
    if (notOnPage.length > 0) parts.push(notOnPage.length + " excluded");
    label.textContent = parts.join(", ");
  } else {
    label.textContent = "Cosmetic filtering active (reload page to see selectors)";
  }
  headerRow.appendChild(label);

  // Exclude full site button
  const siteBtn = document.createElement("button");
  siteBtn.type = "button";
  if (siteExcluded) {
    siteBtn.className = "pc-log-allow-btn is-allowed";
    siteBtn.textContent = "Site excluded";
    siteBtn.title = "Restore cosmetic filtering for " + domain;
    siteBtn.addEventListener("click", () => {
      siteBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_COSMETIC_RESTORE_SITE", domain }, (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          _cosmeticCachedData.siteExcluded = false;
          _renderCosmeticFromCache(container);
        } else { siteBtn.disabled = false; }
      });
    });
  } else {
    siteBtn.className = "pc-log-allow-btn";
    siteBtn.textContent = "Exclude site";
    siteBtn.title = "Disable all cosmetic filtering for " + domain;
    siteBtn.addEventListener("click", () => {
      siteBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "PROTOCONSENT_COSMETIC_EXCLUDE_SITE", domain }, (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          _cosmeticCachedData.siteExcluded = true;
          _renderCosmeticFromCache(container);
        } else { siteBtn.disabled = false; }
      });
    });
  }
  headerRow.appendChild(siteBtn);
  container.appendChild(headerRow);

  const allRows = allSelectors.concat(notOnPage);
  if (allRows.length === 0) return;

  // Filter
  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "pc-log-filter";
  filterInput.placeholder = "Filter selectors\u2026";
  filterInput.value = logCosmeticFilter;
  filterInput.setAttribute("aria-label", "Filter cosmetic selectors");
  filterInput.addEventListener("input", () => {
    logCosmeticFilter = filterInput.value;
    _renderCosmeticFromCache(container);
    const newInput = container.querySelector(".pc-log-filter");
    if (newInput) newInput.focus();
  });
  container.appendChild(filterInput);

  const query = logCosmeticFilter.toLowerCase();
  const filtered = query ? allRows.filter(s => s.toLowerCase().includes(query)) : allRows;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pc-log-empty";
    empty.textContent = 'No matches for "' + logCosmeticFilter + '".';
    container.appendChild(empty);
    return;
  }

  // Table
  const table = document.createElement("table");
  table.className = "pc-log-table";
  const colgroup = document.createElement("colgroup");
  colgroup.innerHTML = '<col style="width:28px"><col style="width:auto"><col style="width:58px">';
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headTr = document.createElement("tr");
  for (const text of ["", "Selector", ""]) {
    const th = document.createElement("th");
    th.textContent = text;
    headTr.appendChild(th);
  }
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const COSMETIC_PAGE_SIZE = 50;
  const firstBatch = filtered.slice(0, COSMETIC_PAGE_SIZE);

  for (const sel of firstBatch) {
    tbody.appendChild(buildCosmeticRow(domain, sel, excludedSet.has(sel), activeSet.has(sel)));
  }
  table.appendChild(tbody);
  container.appendChild(table);

  if (filtered.length > COSMETIC_PAGE_SIZE) {
    let shown = COSMETIC_PAGE_SIZE;
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "pc-log-show-more";
    moreBtn.textContent = "Show " + (filtered.length - shown) + " more selectors";
    container.appendChild(moreBtn);
    moreBtn.addEventListener("click", () => {
      const nextPage = filtered.slice(shown, shown + COSMETIC_PAGE_SIZE);
      const pageFrag = document.createDocumentFragment();
      for (const sel of nextPage) {
        pageFrag.appendChild(buildCosmeticRow(domain, sel, excludedSet.has(sel), activeSet.has(sel)));
      }
      tbody.appendChild(pageFrag);
      shown += nextPage.length;
      if (shown >= filtered.length) {
        moreBtn.remove();
      } else {
        moreBtn.textContent = "Show " + (filtered.length - shown) + " more selectors";
      }
    });
  }
}

function buildCosmeticRow(domain, selector, isExcluded, isActive) {
  const tr = document.createElement("tr");
  if (isExcluded) tr.className = "pc-cosmetic-excluded";
  else if (isActive) tr.className = "pc-cosmetic-active";

  const tdIcon = document.createElement("td");
  tdIcon.className = "pc-log-domains-icon";
  const img = document.createElement("img");
  img.src = "../icons/grid/cosmetic.svg";
  img.width = 14;
  img.height = 14;
  img.alt = "C";
  img.title = "Cosmetic filter";
  img.onerror = function() { tdIcon.textContent = "C"; };
  tdIcon.appendChild(img);
  tr.appendChild(tdIcon);

  const tdSelector = document.createElement("td");
  tdSelector.className = "pc-log-table-domain pc-cosmetic-sel-cell";
  tdSelector.textContent = selector;
  tdSelector.title = selector;
  tr.appendChild(tdSelector);

  const tdAction = document.createElement("td");
  tdAction.className = "pc-log-domains-action";
  const btn = document.createElement("button");
  btn.type = "button";
  if (isExcluded) {
    btn.className = "pc-log-allow-btn is-allowed";
    btn.textContent = "Excluded";
    btn.title = "Click to restore this selector (will hide elements again after reload)";
    btn.addEventListener("click", () => handleCosmeticRestore(domain, selector, btn));
  } else {
    btn.className = "pc-log-allow-btn";
    btn.textContent = "Exclude";
    btn.title = "Exclude this selector (unhide element after reload)";
    btn.addEventListener("click", () => handleCosmeticExclude(domain, selector, btn));
  }
  tdAction.appendChild(btn);
  tr.appendChild(tdAction);

  return tr;
}

function handleCosmeticExclude(domain, selector, btn) {
  btn.disabled = true;
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_COSMETIC_EXCLUDE", domain, selector },
    (resp) => {
      void chrome.runtime.lastError;
      if (resp?.ok) {
        _cosmeticUserExceptions = null;
        _cosmeticCachedData = null;
        btn.className = "pc-log-allow-btn is-allowed";
        btn.textContent = "Excluded";
        btn.title = "Click to restore this selector (will hide elements again after reload)";
        btn.disabled = false;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", () => handleCosmeticRestore(domain, selector, newBtn));
      } else {
        btn.disabled = false;
      }
    }
  );
}

function handleCosmeticRestore(domain, selector, btn) {
  btn.disabled = true;
  chrome.runtime.sendMessage(
    { type: "PROTOCONSENT_COSMETIC_RESTORE", domain, selector },
    (resp) => {
      void chrome.runtime.lastError;
      if (resp?.ok) {
        _cosmeticUserExceptions = null;
        _cosmeticCachedData = null;
        btn.className = "pc-log-allow-btn";
        btn.textContent = "Exclude";
        btn.title = "Exclude this selector (unhide element after reload)";
        btn.disabled = false;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", () => handleCosmeticExclude(domain, selector, newBtn));
      } else {
        btn.disabled = false;
      }
    }
  );
}
