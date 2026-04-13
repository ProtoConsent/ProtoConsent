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

  var RETENTION_TYPE_OPTIONS = [
    { value: "", label: "-- none --" },
    { value: "session", label: "Session" },
    { value: "fixed", label: "Fixed" },
    { value: "until_withdrawal", label: "Until withdrawal" },
  ];

  var RETENTION_UNIT_OPTIONS = [
    { value: "days", label: "days" },
    { value: "months", label: "months" },
    { value: "years", label: "years" },
  ];

  // --- Site declaration templates ---

  var TEMPLATES = [
    {
      id: "scratch",
      label: "Start from scratch",
      description: "All purposes off. Build your declaration from zero.",
      purposes: {
        functional: { used: false },
        analytics: { used: false },
        ads: { used: false },
        personalization: { used: false },
        third_parties: { used: false },
        advanced_tracking: { used: false },
      },
    },
    {
      id: "blog",
      label: "Blog / informational site",
      description: "Only functional cookies. No tracking, no ads.",
      purposes: {
        functional: { used: true, legal_basis: "consent", sharing: "none", retention: { type: "session" } },
        analytics: { used: false },
        ads: { used: false },
        personalization: { used: false },
        third_parties: { used: false },
        advanced_tracking: { used: false },
      },
    },
    {
      id: "analytics",
      label: "Site with analytics",
      description: "Functional + privacy-friendly analytics. No ads or tracking.",
      purposes: {
        functional: { used: true, legal_basis: "consent", sharing: "none", retention: { type: "session" } },
        analytics: { used: true, legal_basis: "consent", sharing: "none", retention: { type: "fixed", value: 30, unit: "days" } },
        ads: { used: false },
        personalization: { used: false },
        third_parties: { used: false },
        advanced_tracking: { used: false },
      },
      data_handling: { storage_region: "eu" },
    },
    {
      id: "ecommerce",
      label: "E-commerce",
      description: "Functional, analytics, ads and personalization. Common for online stores.",
      purposes: {
        functional: { used: true, legal_basis: "contractual", sharing: "none", retention: { type: "session" } },
        analytics: { used: true, legal_basis: "legitimate_interest", sharing: "none", retention: { type: "fixed", value: 90, unit: "days" } },
        ads: { used: true, legal_basis: "consent", sharing: "third_parties", retention: { type: "fixed", value: 90, unit: "days" } },
        personalization: { used: true, legal_basis: "consent", sharing: "none", retention: { type: "fixed", value: 30, unit: "days" } },
        third_parties: { used: false },
        advanced_tracking: { used: false },
      },
      data_handling: { storage_region: "eu", international_transfers: false },
    },
    {
      id: "full",
      label: "Full declaration",
      description: "All six purposes enabled. Adjust legal bases and sharing to match your site.",
      purposes: {
        functional: { used: true, legal_basis: "legitimate_interest", sharing: "none", retention: { type: "session" } },
        analytics: { used: true, legal_basis: "legitimate_interest", sharing: "none", retention: { type: "fixed", value: 90, unit: "days" } },
        ads: { used: true, legal_basis: "consent", sharing: "third_parties", retention: { type: "fixed", value: 180, unit: "days" } },
        personalization: { used: true, legal_basis: "consent", sharing: "within_group", retention: { type: "fixed", value: 30, unit: "days" } },
        third_parties: { used: true, legal_basis: "consent", sharing: "third_parties", retention: { type: "until_withdrawal" } },
        advanced_tracking: { used: true, legal_basis: "consent", sharing: "none", retention: { type: "fixed", value: 365, unit: "days" } },
      },
      data_handling: { storage_region: "eu", international_transfers: true },
    },
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
  var templateSelect = document.getElementById("gen-template");
  var templateDesc = document.getElementById("gen-template-desc");
  var purposesContainer = document.getElementById("gen-purposes");
  var regionInput = document.getElementById("gen-region");
  var regionHint = regionInput.nextElementSibling;
  var intlToggle = document.getElementById("gen-intl");
  var policyInput = document.getElementById("gen-policy");
  var policyHint = document.getElementById("gen-policy-error");
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

  function toggleRetentionFields(key) {
    var rtType = document.getElementById("gen-rt-" + key).value;
    var extra = document.getElementById("gen-rt-extra-" + key);
    if (rtType === "fixed") {
      extra.classList.add("is-visible");
    } else {
      extra.classList.remove("is-visible");
    }
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

    // Providers
    var prField = document.createElement("div");
    prField.className = "gen-field";
    var prLabel = document.createElement("label");
    prLabel.className = "gen-field-label";
    prLabel.htmlFor = "gen-pr-" + key;
    prLabel.textContent = "Providers";
    prField.appendChild(prLabel);
    var prInput = document.createElement("input");
    prInput.type = "text";
    prInput.id = "gen-pr-" + key;
    prInput.className = "gen-input";
    prInput.placeholder = "e.g. Google Analytics, Hotjar";
    prInput.autocomplete = "off";
    prInput.spellcheck = false;
    prInput.maxLength = 200;
    var prHint = document.createElement("span");
    prHint.className = "gen-hint";
    prHint.textContent = "Comma-separated. No HTML or special chars";
    prField.appendChild(prInput);
    prField.appendChild(prHint);
    opts.appendChild(prField);

    // Retention type
    var rtField = document.createElement("div");
    rtField.className = "gen-field";
    var rtLabel = document.createElement("label");
    rtLabel.className = "gen-field-label";
    rtLabel.htmlFor = "gen-rt-" + key;
    rtLabel.textContent = "Retention";
    rtField.appendChild(rtLabel);
    rtField.appendChild(buildSelect("gen-rt-" + key, RETENTION_TYPE_OPTIONS));

    // Retention value + unit (hidden unless type=fixed)
    var rtExtra = document.createElement("div");
    rtExtra.className = "gen-retention-extra";
    rtExtra.id = "gen-rt-extra-" + key;
    var rvInput = document.createElement("input");
    rvInput.type = "number";
    rvInput.id = "gen-rv-" + key;
    rvInput.className = "gen-input-number";
    rvInput.placeholder = "30";
    rvInput.min = "1";
    rvInput.max = "9999";
    rtExtra.appendChild(rvInput);
    rtExtra.appendChild(buildSelect("gen-ru-" + key, RETENTION_UNIT_OPTIONS));
    rtField.appendChild(rtExtra);

    opts.appendChild(rtField);

    row.appendChild(opts);

    // Toggle handler
    cb.addEventListener("change", function () {
      usedLabel.textContent = cb.checked ? "Used" : "Not used";
      cb.setAttribute("aria-checked", String(cb.checked));
      clearTemplateSelection();
      update();
    });

    return row;
  }

  // Init purpose rows
  for (var i = 0; i < KNOWN_PURPOSES.length; i++) {
    purposesContainer.appendChild(buildPurposeRow(KNOWN_PURPOSES[i]));
  }

  // Populate template dropdown
  for (var t = 0; t < TEMPLATES.length; t++) {
    var opt = document.createElement("option");
    opt.value = TEMPLATES[t].id;
    opt.textContent = TEMPLATES[t].label;
    templateSelect.appendChild(opt);
  }

  // --- Build JSON ---

  function todayISO() {
    var d = new Date();
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd;
  }

  function buildJson() {
    var obj = { protoconsent: "0.2", purposes: {} };

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
        if (pr) {
          entry.providers = pr.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        }

        var rtType = document.getElementById("gen-rt-" + key).value;
        if (rtType) {
          entry.retention = { type: rtType };
          if (rtType === "fixed") {
            var rtVal = parseInt(document.getElementById("gen-rv-" + key).value, 10);
            var rtUnit = document.getElementById("gen-ru-" + key).value;
            if (rtVal > 0) entry.retention.value = rtVal;
            if (rtUnit) entry.retention.unit = rtUnit;
          }
        }
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

    // Links
    var policy = policyInput.value.trim();
    var rights = rightsInput.value.trim();
    if (policy || rights) {
      obj.links = {};
      if (policy) obj.links.policy = policy;
      if (rights) obj.links.rights = rights;
    }

    // Last updated (auto)
    obj.last_updated = todayISO();

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
        if (entry.providers && entry.providers.length) details.push(entry.providers.join(", "));
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

    // Links
    if (json.links && typeof json.links === "object") {
      var linkEntries = [
        { key: "policy", label: "Privacy policy" },
        { key: "rights", label: "Your rights" },
      ];
      for (var lpi = 0; lpi < linkEntries.length; lpi++) {
        var le = linkEntries[lpi];
        var linkUrl = json.links[le.key];
        if (!linkUrl || typeof linkUrl !== "string") continue;

        var linkRowEl = document.createElement("div");
        linkRowEl.className = "vld-preview-data";
        var linkHeading = document.createElement("span");
        linkHeading.className = "vld-preview-purpose";
        linkHeading.textContent = le.label;
        linkRowEl.appendChild(linkHeading);
        var linkUrlLabel = document.createElement("span");
        linkUrlLabel.className = "vld-preview-link--url";
        var linkMaxLen = 50;
        linkUrlLabel.textContent = linkUrl.length > linkMaxLen ? linkUrl.slice(0, linkMaxLen) + "[...]" : linkUrl;
        linkUrlLabel.title = linkUrl;
        linkRowEl.appendChild(linkUrlLabel);
        previewDiv.appendChild(linkRowEl);
      }
    }

    // Last updated
    if (json.last_updated) {
      var updEl = document.createElement("div");
      updEl.className = "vld-preview-data";
      updEl.textContent = "Last updated: " + json.last_updated;
      previewDiv.appendChild(updEl);
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

  function validateUrlField(input, hint) {
    var val = input.value.trim();
    if (!val) {
      input.classList.remove("is-invalid");
      hint.classList.remove("is-invalid");
      return;
    }
    if (isValidUrl(val)) {
      input.classList.remove("is-invalid");
      hint.classList.remove("is-invalid");
    } else {
      input.classList.add("is-invalid");
      hint.classList.add("is-invalid");
    }
  }

  // --- Template logic ---

  function applyTemplate(tpl) {
    for (var j = 0; j < KNOWN_PURPOSES.length; j++) {
      var key = KNOWN_PURPOSES[j];
      var entry = tpl.purposes[key] || { used: false };
      var cb = document.getElementById("gen-used-" + key);
      var label = document.getElementById("gen-used-label-" + key);
      var lb = document.getElementById("gen-lb-" + key);
      var sh = document.getElementById("gen-sh-" + key);
      var pr = document.getElementById("gen-pr-" + key);
      var rt = document.getElementById("gen-rt-" + key);
      var rv = document.getElementById("gen-rv-" + key);
      var ru = document.getElementById("gen-ru-" + key);
      cb.checked = !!entry.used;
      cb.setAttribute("aria-checked", String(cb.checked));
      label.textContent = cb.checked ? "Used" : "Not used";
      lb.value = entry.legal_basis || "";
      sh.value = entry.sharing || "";
      pr.value = (entry.providers || []).join(", ");
      pr.classList.remove("is-invalid");
      var prHint = pr.nextElementSibling;
      if (prHint) prHint.classList.remove("is-invalid");
      if (entry.retention) {
        rt.value = entry.retention.type || "";
        rv.value = entry.retention.value || "";
        ru.value = entry.retention.unit || "days";
      } else {
        rt.value = "";
        rv.value = "";
        ru.value = "days";
      }
      toggleRetentionFields(key);
    }
    // data_handling
    var dh = tpl.data_handling || {};
    regionInput.value = dh.storage_region || "";
    regionInput.classList.remove("is-invalid");
    regionHint.classList.remove("is-invalid");
    intlToggle.checked = !!dh.international_transfers;
    // links
    policyInput.value = "";
    policyInput.classList.remove("is-invalid");
    policyHint.classList.remove("is-invalid");
    rightsInput.value = "";
    rightsInput.classList.remove("is-invalid");
    rightsHint.classList.remove("is-invalid");
    update();
  }

  function clearTemplateSelection() {
    templateSelect.value = "";
    templateDesc.textContent = "";
  }

  templateSelect.addEventListener("change", function () {
    var id = templateSelect.value;
    if (!id) {
      templateDesc.textContent = "";
      return;
    }
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) {
        templateDesc.textContent = TEMPLATES[i].description;
        applyTemplate(TEMPLATES[i]);
        return;
      }
    }
  });

  // --- Event delegation for optional fields ---

  regionInput.addEventListener("input", function () {
    validateRegion();
    clearTemplateSelection();
    update();
  });
  intlToggle.addEventListener("change", function () {
    clearTemplateSelection();
    update();
  });
  policyInput.addEventListener("input", function () {
    validateUrlField(policyInput, policyHint);
    clearTemplateSelection();
    update();
  });
  rightsInput.addEventListener("input", function () {
    validateUrlField(rightsInput, rightsHint);
    clearTemplateSelection();
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

  // Selects, provider inputs, and number inputs inside purposes
  purposesContainer.addEventListener("change", function (e) {
    if (e.target.tagName === "SELECT") {
      // Handle retention type toggles
      var rtMatch = e.target.id && e.target.id.match(/^gen-rt-(.+)$/);
      if (rtMatch) toggleRetentionFields(rtMatch[1]);
      clearTemplateSelection();
      update();
    }
  });
  purposesContainer.addEventListener("input", function (e) {
    if (e.target.type === "text") {
      validateProvider(e.target);
      clearTemplateSelection();
      update();
    }
    if (e.target.type === "number") {
      clearTemplateSelection();
      update();
    }
  });

  // Initial render
  update();
})();
