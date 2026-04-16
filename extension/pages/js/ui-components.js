// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared UI components: collapsible bars and grid cards.
// Loaded before popup.js - no dependencies on popup globals.

// --- Collapsible bar ---

function createCollapsibleBar(id, opts) {
  // opts: { collapsedContent, expandedContent, tint, ariaLabel }
  var bar = document.createElement("div");
  bar.className = "pc-bar" + (opts.tint ? " pc-bar-" + opts.tint : "");
  bar.id = id;

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "pc-bar-toggle";
  toggle.setAttribute("aria-expanded", "false");
  if (opts.ariaLabel) toggle.setAttribute("aria-label", opts.ariaLabel);

  var chevron = document.createElement("span");
  chevron.className = "pc-bar-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "\u25B8";

  var label = document.createElement("span");
  label.className = "pc-bar-label";
  toggle.appendChild(chevron);
  toggle.appendChild(label);
  bar.appendChild(toggle);

  var body = document.createElement("div");
  body.className = "pc-bar-body";
  body.hidden = true;
  bar.appendChild(body);

  toggle.addEventListener("click", function () {
    var expanded = bar.classList.toggle("is-expanded");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    body.hidden = !expanded;
  });

  bar._label = label;
  bar._body = body;
  bar.setCollapsed = function (content) {
    if (typeof content === "string") label.textContent = content;
    else { label.textContent = ""; label.appendChild(content); }
  };
  bar.setExpanded = function (content) {
    body.textContent = "";
    if (typeof content === "string") body.textContent = content;
    else body.appendChild(content);
  };

  return bar;
}

// --- Grid card ---

function createGridCard(opts) {
  // opts: { id, icon, iconSrc, title, metric, tint, full }
  // Returns { card, body, setMetric(text), setTitle(text) }
  // body is a separate element placed AFTER card in the grid to span full-width
  var card = document.createElement("div");
  card.className = "pc-grid-card" + (opts.full ? " pc-grid-card-full" : "");
  if (opts.id) card.id = opts.id;

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "pc-grid-card-toggle";
  toggle.setAttribute("aria-expanded", "false");

  if (opts.iconSrc) {
    var iconEl = document.createElement("span");
    iconEl.className = "pc-grid-card-icon";
    iconEl.setAttribute("aria-hidden", "true");
    var img = document.createElement("img");
    img.src = opts.iconSrc;
    img.width = 20;
    img.height = 20;
    img.alt = "";
    img.className = "pc-grid-card-icon-img";
    iconEl.appendChild(img);
    toggle.appendChild(iconEl);
  } else if (opts.icon) {
    var iconEl = document.createElement("span");
    iconEl.className = "pc-grid-card-icon";
    iconEl.textContent = opts.icon;
    iconEl.setAttribute("aria-hidden", "true");
    toggle.appendChild(iconEl);
  }

  var titleEl = document.createElement("span");
  titleEl.className = "pc-grid-card-title";
  titleEl.textContent = opts.title || "";
  toggle.appendChild(titleEl);

  var metricEl = document.createElement("span");
  metricEl.className = "pc-grid-card-metric";
  metricEl.textContent = opts.metric || "";
  toggle.appendChild(metricEl);
  card.appendChild(toggle);

  var body = document.createElement("div");
  body.className = "pc-grid-card-body";
  body.hidden = true;
  if (opts.id) body.id = opts.id + "-body";

  toggle.addEventListener("click", function () {
    var grid = card.parentElement;
    var wasExpanded = card.classList.contains("is-expanded");

    // Accordion: collapse all siblings
    if (grid) {
      grid.querySelectorAll(".pc-grid-card.is-expanded").forEach(function (c) {
        c.classList.remove("is-expanded");
        c.querySelector(".pc-grid-card-toggle").setAttribute("aria-expanded", "false");
      });
      grid.querySelectorAll(".pc-grid-card-body").forEach(function (b) {
        b.hidden = true;
      });
    }

    if (!wasExpanded) {
      card.classList.add("is-expanded");
      toggle.setAttribute("aria-expanded", "true");
      body.hidden = false;
    }
  });

  return {
    card: card,
    body: body,
    setMetric: function (text) { metricEl.textContent = text; },
    setTitle: function (text) { titleEl.textContent = text; }
  };
}
