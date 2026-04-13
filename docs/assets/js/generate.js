// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// generate.js: .well-known/protoconsent.json generator logic

(function () {
  "use strict";

  var KNOWN_PURPOSES = [
    "functional", "analytics", "ads",
    "personalization", "third_parties", "advanced_tracking",
  ];

  var PURPOSE_LABELS = {
    functional: "Functional",
    analytics: "Analytics",
    ads: "Ads",
    personalization: "Personalization",
    third_parties: "Third parties",
    advanced_tracking: "Advanced tracking",
  };

  var LEGAL_BASIS_OPTIONS = [
    { value: "", label: "-- none --" },
    { value: "consent", label: "Consent" },
    { value: "contractual", label: "Contractual" },
    { value: "legitimate_interest", label: "Legitimate interest" },
    { value: "legal_obligation", label: "Legal obligation" },
    { value: "public_interest", label: "Public interest" },
    { value: "vital_interest", label: "Vital interest" },
  ];

  var SHARING_OPTIONS = [
    { value: "", label: "-- none --" },
    { value: "none", label: "None" },
    { value: "within_group", label: "Within group" },
    { value: "third_parties", label: "Third parties" },
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

  // DOM
  var purposesContainer = document.getElementById("gen-purposes");
  var regionInput = document.getElementById("gen-region");
  var regionHint = regionInput.nextElementSibling;
  var intlToggle = document.getElementById("gen-intl");
  var rightsInput = document.getElementById("gen-rights");
  var rightsHint = document.getElementById("gen-rights-error");
  var previewDiv = document.getElementById("gen-preview");
  var jsonOutput = document.getElementById("gen-json");
  var copyBtn = document.getElementById("gen-copy-btn");
  var downloadBtn = document.getElementById("gen-download-btn");

  // --- Build purpose rows ---

  function buildSelect(id, options) {
    var sel = document.createElement("select");
    sel.id = id;
    sel.className = "gen-select";
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement("option");
      opt.value = options[i].value;
      opt.textContent = options[i].label;
      sel.appendChild(opt);
    }
    return sel;
  }

  function buildPurposeRow(key) {
    var row = document.createElement("div");
    row.className = "gen-purpose";
    row.dataset.purpose = key;

    // Name
    var name = document.createElement("span");
    name.className = "gen-purpose-name";
    name.textContent = PURPOSE_LABELS[key];
    row.appendChild(name);

    // Toggle
    var toggle = document.createElement("label");
    toggle.className = "gen-toggle";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "gen-used-" + key;
    cb.setAttribute("role", "switch");
    cb.setAttribute("aria-checked", "false");
    cb.setAttribute("aria-label", PURPOSE_LABELS[key] + " toggle");
    var track = document.createElement("span");
    track.className = "gen-toggle-track";
    toggle.appendChild(cb);
    toggle.appendChild(track);
    row.appendChild(toggle);

    // Used label
    var usedLabel = document.createElement("span");
    usedLabel.className = "gen-used-label";
    usedLabel.textContent = "Not used";
    usedLabel.id = "gen-used-label-" + key;
    row.appendChild(usedLabel);

    // Optional fields — always visible
    var opts = document.createElement("div");
    opts.className = "gen-opts is-open";
    opts.id = "gen-opts-" + key;

    // Legal basis
    var lbField = document.createElement("div");
    lbField.className = "gen-field";
    var lbLabel = document.createElement("label");
    lbLabel.className = "gen-field-label";
    lbLabel.htmlFor = "gen-lb-" + key;
    lbLabel.textContent = "Legal basis";
    lbField.appendChild(lbLabel);
    lbField.appendChild(buildSelect("gen-lb-" + key, LEGAL_BASIS_OPTIONS));
    opts.appendChild(lbField);

    // Sharing
    var shField = document.createElement("div");
    shField.className = "gen-field";
    var shLabel = document.createElement("label");
    shLabel.className = "gen-field-label";
    shLabel.htmlFor = "gen-sh-" + key;
    shLabel.textContent = "Sharing";
    shField.appendChild(shLabel);
    shField.appendChild(buildSelect("gen-sh-" + key, SHARING_OPTIONS));
    opts.appendChild(shField);

    // Provider
    var prField = document.createElement("div");
    prField.className = "gen-field";
    var prLabel = document.createElement("label");
    prLabel.className = "gen-field-label";
    prLabel.htmlFor = "gen-pr-" + key;
    prLabel.textContent = "Provider";
    prField.appendChild(prLabel);
    var prInput = document.createElement("input");
    prInput.type = "text";
    prInput.id = "gen-pr-" + key;
    prInput.className = "gen-input";
    prInput.placeholder = "e.g. Google Analytics";
    prInput.autocomplete = "off";
    prInput.spellcheck = false;
    prInput.maxLength = 80;
    var prHint = document.createElement("span");
    prHint.className = "gen-hint";
    prHint.textContent = "No HTML or special chars";
    prField.appendChild(prInput);
    prField.appendChild(prHint);
    opts.appendChild(prField);

    row.appendChild(opts);

    // Toggle handler
    cb.addEventListener("change", function () {
      usedLabel.textContent = cb.checked ? "Used" : "Not used";
      cb.setAttribute("aria-checked", String(cb.checked));
      update();
    });

    return row;
  }

  // Init purpose rows
  for (var i = 0; i < KNOWN_PURPOSES.length; i++) {
    purposesContainer.appendChild(buildPurposeRow(KNOWN_PURPOSES[i]));
  }

  // --- Build JSON ---

  function buildJson() {
    var obj = { protoconsent: "0.1", purposes: {} };

    for (var i = 0; i < KNOWN_PURPOSES.length; i++) {
      var key = KNOWN_PURPOSES[i];
      var used = document.getElementById("gen-used-" + key).checked;
      var entry = { used: used };

      if (used) {
        var lb = document.getElementById("gen-lb-" + key).value;
        var sh = document.getElementById("gen-sh-" + key).value;
        var pr = document.getElementById("gen-pr-" + key).value.trim();
        if (lb) entry.legal_basis = lb;
        if (sh) entry.sharing = sh;
        if (pr) entry.provider = pr;
      }

      obj.purposes[key] = entry;
    }

    // Data handling
    var region = regionInput.value.trim();
    var intl = intlToggle.checked;
    if (region || intl) {
      obj.data_handling = {};
      if (region) obj.data_handling.storage_region = region;
      if (intl) obj.data_handling.international_transfers = true;
    }

    // Rights URL
    var rights = rightsInput.value.trim();
    if (rights) obj.rights_url = rights;

    return JSON.stringify(obj, null, 2);
  }

  // --- Preview ---

  function renderPreview(json) {
    previewDiv.innerHTML = "";

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
        if (entry.provider) details.push(entry.provider);
        if (entry.sharing) details.push("sharing: " + entry.sharing.replace(/_/g, " "));
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
      if (json.data_handling.storage_region) {
        var regionEl = document.createElement("div");
        regionEl.className = "vld-preview-data";
        regionEl.textContent = "Stored: " + json.data_handling.storage_region.toUpperCase();
        previewDiv.appendChild(regionEl);
      }
      if (json.data_handling.international_transfers) {
        var intlEl = document.createElement("div");
        intlEl.className = "vld-preview-data";
        var intlIcon = document.createElement("img");
        intlIcon.src = ICON_PATH + "intl_transfers_yes.png";
        intlIcon.alt = "";
        intlIcon.className = "vld-preview-icon";
        intlIcon.width = 14;
        intlIcon.height = 14;
        intlIcon.onerror = function () { this.remove(); };
        intlEl.appendChild(intlIcon);
        intlEl.appendChild(document.createTextNode(" International transfers"));
        previewDiv.appendChild(intlEl);
      }
    }

    if (json.rights_url) {
      var rightsEl = document.createElement("div");
      rightsEl.className = "vld-preview-data";
      var heading = document.createElement("span");
      heading.className = "vld-preview-purpose";
      heading.textContent = "Rights URL";
      rightsEl.appendChild(heading);
      var urlLabel = document.createElement("span");
      urlLabel.className = "vld-preview-link--url";
      var maxLen = 50;
      urlLabel.textContent = json.rights_url.length > maxLen
        ? json.rights_url.slice(0, maxLen) + "[...]"
        : json.rights_url;
      urlLabel.title = json.rights_url;
      rightsEl.appendChild(urlLabel);
      previewDiv.appendChild(rightsEl);
    }
  }

  // --- Update ---

  function update() {
    var text = buildJson();
    jsonOutput.value = text;
    try {
      renderPreview(JSON.parse(text));
    } catch (_) {}
  }

  // --- Copy ---

  copyBtn.addEventListener("click", function () {
    var text = jsonOutput.value;
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = "Copy JSON"; }, 2000);
    }, function () {
      // Fallback
      jsonOutput.select();
      document.execCommand("copy");
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = "Copy JSON"; }, 2000);
    });
  });

  // --- Download ---

  downloadBtn.addEventListener("click", function () {
    var text = jsonOutput.value;
    if (!text) return;
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "protoconsent.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  function validateRegion() {
    var val = regionInput.value.trim();
    if (!val) {
      regionInput.classList.remove("is-invalid");
      regionHint.classList.remove("is-invalid");
      return;
    }
    if (/^[a-zA-Z]{2,15}$/.test(val)) {
      regionInput.classList.remove("is-invalid");
      regionHint.classList.remove("is-invalid");
    } else {
      regionInput.classList.add("is-invalid");
      regionHint.classList.add("is-invalid");
    }
  }

  // --- URL validation ---

  function isValidUrl(str) {
    try {
      var u = new URL(str);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function validateRightsUrl() {
    var val = rightsInput.value.trim();
    if (!val) {
      rightsInput.classList.remove("is-invalid");
      rightsHint.classList.remove("is-invalid");
      return;
    }
    if (isValidUrl(val)) {
      rightsInput.classList.remove("is-invalid");
      rightsHint.classList.remove("is-invalid");
    } else {
      rightsInput.classList.add("is-invalid");
      rightsHint.classList.add("is-invalid");
    }
  }

  // --- Event delegation for optional fields ---

  regionInput.addEventListener("input", function () {
    validateRegion();
    update();
  });
  intlToggle.addEventListener("change", update);
  rightsInput.addEventListener("input", function () {
    validateRightsUrl();
    update();
  });

  function validateProvider(input) {
    var val = input.value;
    var hint = input.nextElementSibling;
    if (!val || /^[\w\s.\-()&,]+$/.test(val)) {
      input.classList.remove("is-invalid");
      if (hint) hint.classList.remove("is-invalid");
    } else {
      input.classList.add("is-invalid");
      if (hint) hint.classList.add("is-invalid");
    }
  }

  // Selects and provider inputs inside purposes
  purposesContainer.addEventListener("change", function (e) {
    if (e.target.tagName === "SELECT") update();
  });
  purposesContainer.addEventListener("input", function (e) {
    if (e.target.type === "text") {
      validateProvider(e.target);
      update();
    }
  });

  // Initial render
  update();
})();
