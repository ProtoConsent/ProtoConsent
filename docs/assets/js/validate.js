// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// validate.js: .well-known/protoconsent.json validator logic

(function () {
  "use strict";

  const WORKER_URL = "https://api.protoconsent.org";

  const KNOWN_PURPOSES = [
    "functional", "analytics", "ads",
    "personalization", "third_parties", "advanced_tracking",
  ];

  const PURPOSE_LABELS = {
    functional: "Functional",
    analytics: "Analytics",
    ads: "Ads",
    personalization: "Personalization",
    third_parties: "Third parties",
    advanced_tracking: "Advanced tracking",
  };

  const KNOWN_LEGAL_BASIS = [
    "consent", "contractual", "legitimate_interest",
    "legal_obligation", "public_interest", "vital_interest",
  ];

  var ICON_PATH = "assets/icons/declaration/";

  var LEGAL_BASIS_ICONS = {
    consent: ICON_PATH + "consent.png",
    contractual: ICON_PATH + "contractual.png",
    legitimate_interest: ICON_PATH + "legitimate_interest.png",
    legal_obligation: ICON_PATH + "legal_obligation.png",
    public_interest: ICON_PATH + "public_interest.png",
    vital_interest: ICON_PATH + "vital_interest.png",
  };

  const KNOWN_SHARING = ["none", "within_group", "third_parties"];

  // DOM refs
  const domainInput = document.getElementById("vld-domain");
  const fetchBtn = document.getElementById("vld-fetch-btn");
  const jsonTextarea = document.getElementById("vld-json");
  const pasteBtn = document.getElementById("vld-paste-btn");
  const fileInput = document.getElementById("vld-file");
  const resultsSection = document.getElementById("vld-results-section");
  const resultsDiv = document.getElementById("vld-results");
  const previewSection = document.getElementById("vld-preview-section");
  const previewDiv = document.getElementById("vld-preview");

  // --- Validation engine ---

  function validate(json, extras) {
    const checks = [];

    // 1. protoconsent field
    if (typeof json.protoconsent !== "string") {
      checks.push({ level: "error", msg: 'Missing "protoconsent" field (string required).' });
    } else if (json.protoconsent !== "0.1" && json.protoconsent !== "0.2") {
      checks.push({ level: "warn", msg: 'Version is "' + json.protoconsent + '", expected "0.1" or "0.2". Forward-compatible, but verify.' });
    } else {
      checks.push({ level: "pass", msg: 'Version: "' + json.protoconsent + '"' });
    }

    // 2. purposes object
    if (!json.purposes || typeof json.purposes !== "object" || Array.isArray(json.purposes)) {
      checks.push({ level: "error", msg: 'Missing or invalid "purposes" object.' });
      return checks;
    }

    // 3. At least one known purpose
    const declaredKeys = Object.keys(json.purposes);
    const knownKeys = declaredKeys.filter(function (k) { return KNOWN_PURPOSES.indexOf(k) !== -1; });
    const unknownKeys = declaredKeys.filter(function (k) { return KNOWN_PURPOSES.indexOf(k) === -1; });

    if (knownKeys.length === 0) {
      checks.push({ level: "error", msg: "No recognised purposes declared. Need at least one of: " + KNOWN_PURPOSES.join(", ") + "." });
      return checks;
    }
    checks.push({ level: "pass", msg: knownKeys.length + " purpose(s) declared: " + knownKeys.join(", ") + "." });

    if (unknownKeys.length > 0) {
      checks.push({ level: "info", msg: "Unknown purpose keys (ignored by extension): " + unknownKeys.join(", ") + "." });
    }

    // 4. Validate each purpose entry
    for (var i = 0; i < knownKeys.length; i++) {
      var key = knownKeys[i];
      var entry = json.purposes[key];

      if (!entry || typeof entry !== "object") {
        checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': entry is not an object.' });
        continue;
      }

      if (typeof entry.used !== "boolean") {
        checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': "used" must be a boolean.' });
        continue;
      }

      checks.push({ level: "pass", msg: PURPOSE_LABELS[key] + ": used = " + entry.used });

      if (entry.legal_basis !== undefined) {
        if (typeof entry.legal_basis !== "string") {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "legal_basis" should be a string.' });
        } else if (KNOWN_LEGAL_BASIS.indexOf(entry.legal_basis) === -1) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': unknown legal_basis "' + entry.legal_basis + '". Known values: ' + KNOWN_LEGAL_BASIS.join(", ") + "." });
        }
      }

      if (entry.sharing !== undefined) {
        if (typeof entry.sharing !== "string") {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "sharing" should be a string.' });
        } else if (KNOWN_SHARING.indexOf(entry.sharing) === -1) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': unknown sharing value "' + entry.sharing + '". Known values: ' + KNOWN_SHARING.join(", ") + "." });
        }
      }

      if (entry.provider !== undefined) {
        if (typeof entry.provider !== "string") {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "provider" should be a string.' });
        } else {
          checks.push({ level: "info", msg: PURPOSE_LABELS[key] + ': "provider" is deprecated in v0.2. Use "providers" array instead.' });
        }
      }

      if (entry.providers !== undefined) {
        if (!Array.isArray(entry.providers)) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "providers" should be an array.' });
        } else if (entry.providers.length === 0) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "providers" is empty.' });
        } else if (!entry.providers.every(function (p) { return typeof p === "string"; })) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': all entries in "providers" should be strings.' });
        }
      }

      if (entry.retention !== undefined) {
        if (typeof entry.retention !== "object" || Array.isArray(entry.retention)) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': "retention" should be an object.' });
        } else {
          var rt = entry.retention;
          if (typeof rt.type !== "string") {
            checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': retention.type is required (string).' });
          } else if (["session", "fixed", "until_withdrawal"].indexOf(rt.type) === -1) {
            checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ': unknown retention type "' + rt.type + '".' });
          } else if (rt.type === "fixed") {
            if (typeof rt.value !== "number" || !Number.isInteger(rt.value)) {
              checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': retention.value must be an integer.' });
            } else if (rt.value <= 0) {
              checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': retention.value must be > 0. Use type "session" instead.' });
            }
            if (typeof rt.unit !== "string" || ["days", "months", "years"].indexOf(rt.unit) === -1) {
              checks.push({ level: "error", msg: PURPOSE_LABELS[key] + ': retention.unit must be "days", "months", or "years".' });
            }
          }
        }
      }

      if (entry.used === false) {
        var detailFields = ["legal_basis", "providers", "sharing", "retention"]
          .filter(function (f) { return entry[f] !== undefined; });
        if (detailFields.length > 0) {
          checks.push({ level: "warn", msg: PURPOSE_LABELS[key] + ": " + detailFields.join(", ") +
            ' present but "used" is false. These fields are only meaningful when used is true.' });
        }
      }

      // Extra fields in purpose entry
      var knownPurposeFields = ["used", "legal_basis", "sharing", "provider", "providers", "retention"];
      var extraPurposeFields = Object.keys(entry).filter(function (k) { return knownPurposeFields.indexOf(k) === -1; });
      if (extraPurposeFields.length > 0) {
        checks.push({ level: "info", msg: PURPOSE_LABELS[key] + ": extra fields (ignored by extension): " + extraPurposeFields.join(", ") + "." });
      }
    }

    // 5. Not declared purposes
    var notDeclared = KNOWN_PURPOSES.filter(function (k) { return knownKeys.indexOf(k) === -1; });
    if (notDeclared.length > 0) {
      checks.push({ level: "info", msg: "Not declared (no claim made): " + notDeclared.map(function (k) { return PURPOSE_LABELS[k]; }).join(", ") + "." });
    }

    // 6. data_handling
    if (json.data_handling !== undefined) {
      if (typeof json.data_handling !== "object" || Array.isArray(json.data_handling)) {
        checks.push({ level: "warn", msg: '"data_handling" should be an object.' });
      } else {
        var dh = json.data_handling;
        if (dh.storage_region !== undefined) {
          if (typeof dh.storage_region === "string") {
            checks.push({ level: "pass", msg: "Storage region: " + dh.storage_region });
          } else {
            checks.push({ level: "warn", msg: '"storage_region" should be a string.' });
          }
        }
        if (dh.international_transfers !== undefined) {
          if (typeof dh.international_transfers === "boolean") {
            checks.push({ level: "pass", msg: "International transfers: " + dh.international_transfers });
          } else {
            checks.push({ level: "warn", msg: '"international_transfers" should be a boolean.' });
          }
        }
      }
    }

    // 7. links
    if (json.links !== undefined) {
      if (typeof json.links !== "object" || Array.isArray(json.links)) {
        checks.push({ level: "warn", msg: '"links" should be an object.' });
      } else {
        var linkKeys = ["policy", "rights"];
        for (var li = 0; li < linkKeys.length; li++) {
          var lk = linkKeys[li];
          if (json.links[lk] !== undefined) {
            if (typeof json.links[lk] !== "string") {
              checks.push({ level: "warn", msg: '"links.' + lk + '" should be a string.' });
            } else if (/^https:\/\//.test(json.links[lk])) {
              checks.push({ level: "pass", msg: "Link (" + lk + "): " + json.links[lk] });
            } else if (/^http:\/\//.test(json.links[lk])) {
              checks.push({ level: "warn", msg: "Link (" + lk + ") uses http:// (HTTPS is recommended)." });
            } else {
              checks.push({ level: "warn", msg: '"links.' + lk + '" should start with https:// or http://.' });
            }
          }
        }
        var knownLinkFields = ["policy", "rights"];
        var extraLinkFields = Object.keys(json.links).filter(function (k) { return knownLinkFields.indexOf(k) === -1; });
        if (extraLinkFields.length > 0) {
          checks.push({ level: "info", msg: "Extra fields in links (ignored): " + extraLinkFields.join(", ") + "." });
        }
      }
    }

    // 8. last_updated
    if (json.last_updated !== undefined) {
      if (typeof json.last_updated !== "string") {
        checks.push({ level: "warn", msg: '"last_updated" should be a string.' });
      } else if (/T/.test(json.last_updated)) {
        checks.push({ level: "warn", msg: '"last_updated" should be date only (YYYY-MM-DD), not datetime.' });
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(json.last_updated)) {
        checks.push({ level: "warn", msg: '"last_updated" should be ISO 8601 date (YYYY-MM-DD).' });
      } else {
        var updDate = new Date(json.last_updated + "T00:00:00Z");
        var now = new Date();
        if (updDate > now) {
          checks.push({ level: "warn", msg: '"last_updated" is in the future (' + json.last_updated + ').' });
        } else {
          checks.push({ level: "pass", msg: "Last updated: " + json.last_updated });
          var twelveMonthsAgo = new Date(now);
          twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
          if (updDate < twelveMonthsAgo) {
            checks.push({ level: "info", msg: "Declaration is over 12 months old. It may be outdated." });
          }
        }
      }
    }

    // 9. rights_url (deprecated in v0.2)
    if (json.rights_url !== undefined) {
      checks.push({ level: "info", msg: '"rights_url" is deprecated in v0.2. Use "links.rights" instead.' });
      if (typeof json.rights_url !== "string") {
        checks.push({ level: "warn", msg: '"rights_url" should be a string.' });
      } else if (/^https:\/\//.test(json.rights_url)) {
        checks.push({ level: "pass", msg: "Rights URL: " + json.rights_url });
      } else if (/^http:\/\//.test(json.rights_url)) {
        checks.push({ level: "warn", msg: "Rights URL uses http:// (HTTPS is recommended)." });
      } else {
        checks.push({ level: "warn", msg: "Rights URL should start with https:// or http://." });
      }
    }

    // 10. Extra top-level fields
    var knownTopLevel = ["protoconsent", "purposes", "data_handling", "rights_url", "links", "last_updated"];
    var extraFields = Object.keys(json).filter(function (k) { return knownTopLevel.indexOf(k) === -1; });
    if (extraFields.length > 0) {
      checks.push({ level: "info", msg: "Extra top-level fields (ignored by extension): " + extraFields.join(", ") + "." });
    }

    // 9. Content-Type (only from fetch)
    if (extras && extras.contentType) {
      if (extras.contentType.indexOf("application/json") !== -1) {
        checks.push({ level: "pass", msg: "Content-Type: " + extras.contentType });
      } else {
        checks.push({ level: "warn", msg: "Content-Type is " + extras.contentType + " (should be application/json)." });
      }
    }

    return checks;
  }

  // --- Rendering ---

  function renderResults(checks) {
    resultsDiv.innerHTML = "";
    resultsSection.hidden = false;

    var hasError = false;
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (c.level === "error") hasError = true;

      var row = document.createElement("div");
      row.className = "vld-check vld-check--" + c.level;

      var icon = document.createElement("span");
      icon.className = "vld-check-icon";
      icon.setAttribute("aria-hidden", "true");
      if (c.level === "pass") icon.textContent = "\u2713";
      else if (c.level === "error") icon.textContent = "\u2717";
      else if (c.level === "warn") icon.textContent = "\u26A0";
      else icon.textContent = "\u2139";

      var text = document.createElement("span");
      text.textContent = c.msg;

      row.appendChild(icon);
      row.appendChild(text);
      resultsDiv.appendChild(row);
    }

    // Summary
    var summary = document.createElement("div");
    summary.className = "vld-summary " + (hasError ? "vld-summary--fail" : "vld-summary--pass");
    summary.textContent = hasError ? "Validation failed. Fix the errors above." : "Valid declaration.";
    resultsDiv.insertBefore(summary, resultsDiv.firstChild);
  }

  function renderPreview(json) {
    previewDiv.innerHTML = "";
    previewSection.hidden = false;

    for (var i = 0; i < KNOWN_PURPOSES.length; i++) {
      var key = KNOWN_PURPOSES[i];
      var row = document.createElement("div");
      row.className = "vld-preview-row";

      var nameEl = document.createElement("span");
      nameEl.className = "vld-preview-purpose";
      nameEl.textContent = PURPOSE_LABELS[key];

      var statusEl = document.createElement("span");
      statusEl.className = "vld-preview-status";

      var entry = json.purposes ? json.purposes[key] : undefined;
      if (!entry) {
        statusEl.textContent = "\u2014";
        statusEl.classList.add("vld-preview--nd");
        statusEl.title = "Not declared";
      } else if (entry.used) {
        statusEl.textContent = "\u2713";
        statusEl.classList.add("vld-preview--used");
        statusEl.title = "Used";
      } else {
        statusEl.textContent = "\u2717";
        statusEl.classList.add("vld-preview--notused");
        statusEl.title = "Not used";
      }

      var basisEl = document.createElement("span");
      basisEl.className = "vld-preview-basis";
      if (entry && entry.legal_basis) {
        var iconSrc = LEGAL_BASIS_ICONS[entry.legal_basis];
        if (iconSrc) {
          var iconImg = document.createElement("img");
          iconImg.src = iconSrc;
          iconImg.alt = "";
          iconImg.className = "vld-preview-icon";
          iconImg.width = 14;
          iconImg.height = 14;
          iconImg.onerror = function () { this.remove(); };
          basisEl.appendChild(iconImg);
        }
        basisEl.appendChild(document.createTextNode(entry.legal_basis.replace(/_/g, " ")));
      }

      var detailEl = document.createElement("span");
      detailEl.className = "vld-preview-detail";
      if (entry) {
        var details = [];
        if (entry.providers && entry.providers.length) details.push(entry.providers.join(", "));
        else if (entry.provider) details.push(entry.provider);
        if (entry.sharing) details.push("sharing: " + entry.sharing.replace(/_/g, " "));
        if (entry.retention) {
          if (entry.retention.type === "session") details.push("session");
          else if (entry.retention.type === "fixed" && entry.retention.value && entry.retention.unit) details.push(entry.retention.value + " " + entry.retention.unit);
          else if (entry.retention.type === "until_withdrawal") details.push("until withdrawal");
        }
        if (details.length > 0) detailEl.textContent = details.join(" \u00b7 ");
      }

      row.appendChild(nameEl);
      row.appendChild(statusEl);
      row.appendChild(basisEl);
      row.appendChild(detailEl);
      previewDiv.appendChild(row);
    }

    // Data handling
    if (json.data_handling) {
      var dh = json.data_handling;
      if (dh.storage_region) {
        var regionEl = document.createElement("div");
        regionEl.className = "vld-preview-data";
        regionEl.textContent = "Stored: " + dh.storage_region.toUpperCase();
        previewDiv.appendChild(regionEl);
      }
      if (typeof dh.international_transfers === "boolean") {
        var intlEl = document.createElement("div");
        intlEl.className = "vld-preview-data";
        var intlIconSrc = dh.international_transfers
          ? ICON_PATH + "intl_transfers_yes.png"
          : ICON_PATH + "intl_transfers_no.png";
        var intlIcon = document.createElement("img");
        intlIcon.src = intlIconSrc;
        intlIcon.alt = "";
        intlIcon.className = "vld-preview-icon";
        intlIcon.width = 14;
        intlIcon.height = 14;
        intlIcon.onerror = function () { this.remove(); };
        intlEl.appendChild(intlIcon);
        intlEl.appendChild(document.createTextNode(
          dh.international_transfers ? " International transfers" : " No international transfers"
        ));
        previewDiv.appendChild(intlEl);
      }
    }

    // Last updated
    if (json.last_updated && typeof json.last_updated === "string") {
      var updEl = document.createElement("div");
      updEl.className = "vld-preview-data";
      var updText = "Last updated: " + json.last_updated;
      var updParsed = new Date(json.last_updated + "T00:00:00Z");
      var updNow = new Date();
      var updThreshold = new Date(updNow);
      updThreshold.setFullYear(updThreshold.getFullYear() - 1);
      if (!isNaN(updParsed.getTime()) && updParsed < updThreshold) {
        updText += " (may be outdated)";
      }
      updEl.textContent = updText;
      previewDiv.appendChild(updEl);
    }

    // Links (v0.2)
    if (json.links && typeof json.links === "object") {
      var linkEntries = [
        { key: "policy", label: "Privacy policy" },
        { key: "rights", label: "Your rights" },
      ];
      for (var lpi = 0; lpi < linkEntries.length; lpi++) {
        var le = linkEntries[lpi];
        var linkUrl = json.links[le.key];
        if (!linkUrl || typeof linkUrl !== "string" || !/^https?:\/\//.test(linkUrl)) continue;

        var linkRowEl = document.createElement("div");
        linkRowEl.className = "vld-preview-data";

        var linkHeading = document.createElement("span");
        linkHeading.className = "vld-preview-purpose";
        linkHeading.textContent = le.label;
        linkRowEl.appendChild(linkHeading);

        // Domain match check
        var linkInputDomain = sanitizeDomain(domainInput.value);
        var linkHost = "";
        try { linkHost = new URL(linkUrl).hostname.replace(/^www\./, ""); } catch (_) {}
        var linkSiteDomain = linkInputDomain ? linkInputDomain.replace(/^www\./, "") : "";
        var linkIsSame = linkHost.indexOf(".") !== -1 && linkSiteDomain && (
          linkHost === linkSiteDomain
          || linkHost.endsWith("." + linkSiteDomain)
          || linkSiteDomain.endsWith("." + linkHost)
        );

        if (linkIsSame && linkHost) {
          var linkAnchor = document.createElement("a");
          linkAnchor.href = linkUrl;
          linkAnchor.textContent = le.label + " \u2197";
          linkAnchor.target = "_blank";
          linkAnchor.rel = "noopener noreferrer";
          linkAnchor.className = "vld-preview-link";
          linkRowEl.appendChild(linkAnchor);
        } else {
          var linkUrlLabel = document.createElement("span");
          linkUrlLabel.className = "vld-preview-link--url";
          var linkMaxLen = 50;
          linkUrlLabel.textContent = linkUrl.length > linkMaxLen ? linkUrl.slice(0, linkMaxLen) + "[...]" : linkUrl;
          linkUrlLabel.title = linkUrl;
          linkRowEl.appendChild(linkUrlLabel);
          if (linkHost && linkInputDomain) {
            var linkWarn = document.createElement("span");
            linkWarn.className = "vld-preview-warning";
            linkWarn.textContent = "Different domain \u2013 not clickable";
            linkRowEl.appendChild(linkWarn);
          }
        }

        previewDiv.appendChild(linkRowEl);
      }
    }

    // Fallback: rights_url (v0.1)
    if (json.rights_url && /^https?:\/\//.test(json.rights_url) && !(json.links && json.links.rights)) {
      var rightsEl = document.createElement("div");
      rightsEl.className = "vld-preview-data";

      var fullUrl = json.rights_url;
      var maxLen = 50;
      var displayUrl = fullUrl.length > maxLen
        ? fullUrl.slice(0, maxLen) + "[...]"
        : fullUrl;

      var heading = document.createElement("span");
      heading.className = "vld-preview-purpose";
      heading.textContent = "Rights URL";
      rightsEl.appendChild(heading);

      var urlLabel = document.createElement("span");
      urlLabel.className = "vld-preview-link--url";
      urlLabel.textContent = displayUrl;
      urlLabel.title = fullUrl;
      rightsEl.appendChild(urlLabel);

      // Domain match check (only when validating a live domain)
      var inputDomain = sanitizeDomain(domainInput.value);
      if (inputDomain) {
        var rightsHost = "";
        try { rightsHost = new URL(fullUrl).hostname.replace(/^www\./, ""); } catch (_) {}
        var siteDomain = inputDomain.replace(/^www\./, "");
        var isSameDomain = rightsHost.indexOf(".") !== -1 && (
          rightsHost === siteDomain
          || rightsHost.endsWith("." + siteDomain)
          || siteDomain.endsWith("." + rightsHost)
        );

        if (isSameDomain && rightsHost) {
          var rightsLink = document.createElement("a");
          rightsLink.href = fullUrl;
          rightsLink.textContent = "See your rights \u2197";
          rightsLink.target = "_blank";
          rightsLink.rel = "noopener noreferrer";
          rightsLink.className = "vld-preview-link";
          rightsEl.appendChild(rightsLink);
        } else if (rightsHost) {
          var warnEl = document.createElement("span");
          warnEl.className = "vld-preview-warning";
          warnEl.textContent = "Different domain \u2013 not clickable";
          rightsEl.appendChild(warnEl);
        }
      }

      previewDiv.appendChild(rightsEl);
    }
  }

  function showError(msg) {
    resultsDiv.innerHTML = "";
    resultsSection.hidden = false;
    previewSection.hidden = true;
    var el = document.createElement("div");
    el.className = "vld-summary vld-summary--fail";
    el.textContent = msg;
    resultsDiv.appendChild(el);
  }

  function clearResults() {
    resultsSection.hidden = true;
    previewSection.hidden = true;
    resultsDiv.innerHTML = "";
    previewDiv.innerHTML = "";
  }

  // Extract line/column from JSON.parse error (browser-dependent formats)
  function parseJsonError(text, error) {
    var msg = error.message || "";
    var line = -1, col = -1;

    // Firefox: "... at line 9 column 36 ..."
    var firefoxMatch = msg.match(/line (\d+) column (\d+)/);
    if (firefoxMatch) {
      line = parseInt(firefoxMatch[1], 10);
      col = parseInt(firefoxMatch[2], 10);
    }

    // Chrome/Edge: "... at position 234" (byte offset)
    if (line === -1) {
      var chromeMatch = msg.match(/position (\d+)/);
      if (chromeMatch) {
        var pos = parseInt(chromeMatch[1], 10);
        var lines = text.substring(0, pos).split("\n");
        line = lines.length;
        col = lines[lines.length - 1].length + 1;
      }
    }

    return { line: line, col: col };
  }

  function showJsonSyntaxError(text, error) {
    resultsDiv.innerHTML = "";
    resultsSection.hidden = false;
    previewSection.hidden = true;

    var pos = parseJsonError(text, error);
    var lines = text.split("\n");

    // Summary
    var summary = document.createElement("div");
    summary.className = "vld-summary vld-summary--fail";
    if (pos.line > 0) {
      summary.textContent = "JSON syntax error at line " + pos.line + ", column " + pos.col + ".";
    } else {
      summary.textContent = "Invalid JSON: " + error.message;
    }
    resultsDiv.appendChild(summary);

    // Show error line with pointer
    if (pos.line > 0 && pos.line <= lines.length) {
      var snippet = document.createElement("pre");
      snippet.className = "vld-error-snippet";

      var content = "";
      // Show surrounding lines for context
      var start = Math.max(0, pos.line - 3);
      var end = Math.min(lines.length, pos.line + 1);
      for (var i = start; i < end; i++) {
        var lineNum = String(i + 1).padStart(3, " ");
        var prefix = (i === pos.line - 1) ? " > " : "   ";
        content += prefix + lineNum + " | " + lines[i] + "\n";
        if (i === pos.line - 1 && pos.col > 0) {
          content += "        " + " ".repeat(pos.col - 1) + "^\n";
        }
      }
      snippet.textContent = content;
      resultsDiv.appendChild(snippet);
    }

    // Hint
    var hint = document.createElement("div");
    hint.className = "vld-check vld-check--info";
    hint.innerHTML = '<span class="vld-check-icon" aria-hidden="true">\u2139</span>' +
      "<span>Common causes: missing value, trailing comma, unquoted string, missing closing bracket.</span>";
    resultsDiv.appendChild(hint);
  }

  // --- JSON validation from text ---

  function validateText(text, extras) {
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      showJsonSyntaxError(text, e);
      return;
    }

    var checks = validate(json, extras);
    renderResults(checks);

    var hasError = checks.some(function (c) { return c.level === "error"; });
    if (!hasError) {
      renderPreview(json);
    } else {
      previewSection.hidden = true;
    }
  }

  // --- Fetch from domain ---

  function sanitizeDomain(raw) {
    var d = raw.trim().toLowerCase();
    // Strip protocol if pasted
    d = d.replace(/^https?:\/\//, "");
    // Strip path
    d = d.replace(/\/.*$/, "");
    // Strip port
    d = d.replace(/:\d+$/, "");
    return d;
  }

  function isValidDomain(d) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) return false; // IPv4
    if (d.indexOf(":") !== -1) return false; // IPv6
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) && d.length <= 253 && d.indexOf(".") !== -1;
  }

  async function fetchAndValidate() {
    var raw = domainInput.value;
    var domain = sanitizeDomain(raw);

    if (!isValidDomain(domain)) {
      showError("Enter a valid domain (e.g. example.com).");
      return;
    }

    clearResults();
    fetchBtn.disabled = true;
    fetchBtn.textContent = "Checking\u2026";

    try {
      var url = WORKER_URL + "?domain=" + encodeURIComponent(domain);
      var resp = await fetch(url);
      var data = await resp.json();

      if (data.error === "rate_limited") {
        showError("Too many requests. Please wait a minute and try again.");
        return;
      }
      if (data.error === "invalid_domain") {
        showError("Invalid domain format.");
        return;
      }
      if (data.error === "not_found") {
        showError("File not found (HTTP " + data.status + "). Make sure .well-known/protoconsent.json is served at https://" + domain + "/.");
        return;
      }
      if (data.error === "fetch_failed") {
        showError("Could not reach " + domain + ". Check that the domain is correct and the server is accessible.");
        return;
      }
      if (data.error === "not_json") {
        showError("The server returned a non-JSON response (Content-Type: " + (data.content_type || "unknown") + "). Make sure .well-known/protoconsent.json is a real JSON file, not an HTML error page.");
        return;
      }
      if (data.error === "too_large") {
        showError("File too large (" + Math.round((data.size || 0) / 1024) + " KB). A valid declaration should be under 50 KB.");
        return;
      }
      if (data.error === "bad_redirect") {
        showError("The server redirects to a different location (" + (data.location || "unknown") + "). The file should be served directly at https://" + domain + "/.well-known/protoconsent.json.");
        return;
      }
      if (!data.ok || !data.body) {
        showError("Unexpected response from validation service.");
        return;
      }

      // Defense-in-depth size check (API enforces this too)
      if (data.body.length > 51200) {
        showError("File too large (" + Math.round(data.body.length / 1024) + " KB). A valid declaration should be under 50 KB.");
        return;
      }

      // Put fetched JSON in textarea for reference
      try {
        jsonTextarea.value = JSON.stringify(JSON.parse(data.body), null, 2);
      } catch (_) {
        jsonTextarea.value = data.body;
      }

      validateText(data.body, { contentType: data.content_type || "" });
    } catch (e) {
      showError("Network error: " + e.message);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Validate";
    }
  }

  // --- Event listeners ---

  fetchBtn.addEventListener("click", fetchAndValidate);
  domainInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") fetchAndValidate();
  });

  var MAX_FILE_SIZE = 50 * 1024; // 50 KB

  pasteBtn.addEventListener("click", function () {
    var text = jsonTextarea.value.trim();
    if (!text) {
      showError("Paste or load a JSON file first.");
      return;
    }
    if (text.length > MAX_FILE_SIZE) {
      showError("Input too large (" + Math.round(text.length / 1024) + " KB). A valid declaration should be under 50 KB.");
      return;
    }
    validateText(text);
  });

  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      showError("File too large (" + Math.round(file.size / 1024) + " KB). A valid declaration should be under 50 KB.");
      fileInput.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      jsonTextarea.value = reader.result;
      validateText(reader.result);
    };
    reader.onerror = function () {
      showError("Could not read file.");
    };
    reader.readAsText(file);
    // Reset so same file can be re-loaded
    fileInput.value = "";
  });

  // Auto-validate from ?domain= query param (e.g. from directory page)
  var params = new URLSearchParams(window.location.search);
  var paramDomain = params.get("domain");
  if (paramDomain) {
    domainInput.value = paramDomain;
    fetchAndValidate();
  }
})();
