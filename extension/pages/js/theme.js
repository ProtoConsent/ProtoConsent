// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared theme helper. Reads "theme" from storage ("auto"|"light"|"dark"),
// applies or removes the html.pc-dark class accordingly.
// Loaded early in popup.html and purposes-settings.html.
 
(function () {
  var mq = window.matchMedia("(prefers-color-scheme: dark)");

  // Only apply dark class in the popup; settings page stays light
  var isPopup = /popup\.html/.test(location.pathname);

  // Prevent light-mode flash while theme loads
  if (isPopup) document.documentElement.style.visibility = "hidden";

  function apply(pref) {
    if (!isPopup) return;
    var dark = pref === "dark" || (pref !== "light" && mq.matches);
    document.documentElement.classList.toggle("pc-dark", dark);
    document.documentElement.style.visibility = "";
  }

  chrome.storage.local.get("theme", function (r) {
    apply(r.theme || "auto");
  });

  mq.addEventListener("change", function () {
    chrome.storage.local.get("theme", function (r) {
      apply(r.theme || "auto");
    });
  });

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.theme) apply(changes.theme.newValue || "auto");
  });
})();
