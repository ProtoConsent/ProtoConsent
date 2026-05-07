// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Element picker: injected on-demand via chrome.scripting.executeScript.
// Creates an overlay that lets the user click page elements to generate
// CSS selectors, then sends them to the background for permanent hiding.

(() => {
  "use strict";
  if (document.__pcPickerActive) return;
  document.__pcPickerActive = true;

  const OVERLAY_Z = 2147483647;
  const HIGHLIGHT_COLOR = "rgba(59, 130, 246, 0.25)";
  const HIGHLIGHT_BORDER = "2px solid rgba(59, 130, 246, 0.8)";

  let currentTarget = null;
  let highlightBox = null;
  let toolbar = null;
  const savedSelectors = new Set();
  let savedCount = 0;

  function getHost() { return location.hostname.replace(/^www\./, ""); }

  // --- Selector generation ---

  function generateSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // 1. #id (if unique)
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }

    // 2. Unique class combination
    const classes = [...el.classList].filter(c => !/^pc-picker/.test(c));
    if (classes.length > 0) {
      const classSel = el.tagName.toLowerCase() + classes.map(c => "." + CSS.escape(c)).join("");
      try {
        const count = document.querySelectorAll(classSel).length;
        if (count === 1) return classSel;
        if (count <= 5) return classSel; // note: will hide up to 5 matching elements
      } catch (_) {}
    }

    // 3. Unique class subset (try each class alone)
    for (const c of classes) {
      const sel = "." + CSS.escape(c);
      try {
        if (document.querySelectorAll(sel).length <= 5) return sel;
      } catch (_) {}
    }

    // 4. nth-child path (last resort)
    return buildNthChildPath(el);
  }

  function buildNthChildPath(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      let seg = node.tagName.toLowerCase();
      if (node.id) {
        seg = "#" + CSS.escape(node.id);
        parts.unshift(seg);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          seg += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(seg);
      node = parent;
      if (parts.length > 6) break; // avoid absurdly long paths
    }
    return parts.join(" > ");
  }

  // --- Validation ---

  function isSelectorTooGeneric(sel) {
    try {
      return document.querySelectorAll(sel).length > 20;
    } catch (_) {
      return true;
    }
  }

  function isSafeSelector(sel) {
    return sel && !sel.includes("{") && !sel.includes("}") && !sel.includes("<") && !sel.includes("url(");
  }

  // --- UI ---

  function createHighlightBox() {
    const box = document.createElement("div");
    box.setAttribute("data-pc-picker", "highlight");
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: String(OVERLAY_Z),
      background: HIGHLIGHT_COLOR,
      border: HIGHLIGHT_BORDER,
      borderRadius: "2px",
      transition: "top 0.05s, left 0.05s, width 0.05s, height 0.05s",
      display: "none",
    });
    document.documentElement.appendChild(box);
    return box;
  }

  function createToolbar() {
    const bar = document.createElement("div");
    bar.setAttribute("data-pc-picker", "toolbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "ProtoConsent element picker");
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: String(OVERLAY_Z),
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px 12px",
      padding: "8px 16px",
      background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
      pointerEvents: "auto",
    });

    const label = document.createElement("span");
    label.textContent = "ProtoConsent: click an element to hide it";
    label.style.fontWeight = "500";
    bar.appendChild(label);

    const selectorPreview = document.createElement("code");
    selectorPreview.setAttribute("data-pc-picker", "preview");
    Object.assign(selectorPreview.style, {
      background: "rgba(255,255,255,0.1)",
      padding: "2px 8px",
      borderRadius: "4px",
      fontFamily: "monospace",
      fontSize: "11px",
      maxWidth: "300px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "#93c5fd",
    });
    selectorPreview.textContent = "—";
    bar.appendChild(selectorPreview);

    const cancelBtn = document.createElement("button");
    Object.assign(cancelBtn.style, {
      background: "rgba(255,255,255,0.15)",
      border: "1px solid rgba(255,255,255,0.2)",
      color: "#e2e8f0",
      borderRadius: "6px",
      padding: "4px 12px",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "500",
    });
    cancelBtn.textContent = "✕ Done";
    cancelBtn.setAttribute("aria-label", "Close element picker");
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cleanup();
    });
    bar.appendChild(cancelBtn);

    const statusLine = document.createElement("div");
    statusLine.setAttribute("data-pc-picker", "status");
    statusLine.setAttribute("aria-live", "polite");
    Object.assign(statusLine.style, {
      width: "100%",
      textAlign: "center",
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#86efac",
      display: "none",
    });
    bar.appendChild(statusLine);

    document.documentElement.appendChild(bar);
    return bar;
  }

  function updateHighlight(el) {
    if (!el || el.hasAttribute("data-pc-picker")) {
      highlightBox.style.display = "none";
      currentTarget = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    Object.assign(highlightBox.style, {
      display: "block",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
    currentTarget = el;

    // Update preview
    if (toolbar) {
      const preview = toolbar.querySelector('[data-pc-picker="preview"]');
      if (preview) {
        const sel = generateSelector(el);
        if (!sel) {
          preview.textContent = "(no selector)";
          preview.style.color = "#fca5a5";
        } else {
          let count;
          try { count = document.querySelectorAll(sel).length; } catch (_) { count = 0; }
          const tooGeneric = count > 20;
          preview.textContent = sel + (count > 1 ? " (" + count + " matches)" : "");
          preview.style.color = tooGeneric ? "#fca5a5" : count > 1 ? "#fbbf24" : "#93c5fd";
        }
      }
    }
  }

  // --- Event handlers ---

  function onMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== currentTarget) {
      updateHighlight(el);
    }
  }

  function onMouseLeave() {
    if (highlightBox) highlightBox.style.display = "none";
    currentTarget = null;
  }

  function onMouseDown(e) {
    // Let toolbar buttons receive native mousedown
    if (e.target.closest('[data-pc-picker="toolbar"]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    // Let toolbar buttons handle their own clicks
    if (e.target.closest('[data-pc-picker="toolbar"]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!currentTarget) return;

    // Warn when targeting an iframe (can't pick inside cross-origin frames)
    const isFrame = currentTarget.tagName === "IFRAME" || currentTarget.tagName === "FRAME";
    if (isFrame && !currentTarget.__pcConfirmed) {
      currentTarget.__pcConfirmed = true;
      flashToolbar("Will hide entire iframe, click again to confirm", "#fbbf24");
      return;
    }

    const sel = generateSelector(currentTarget);
    if (!sel) return;

    if (!isSafeSelector(sel)) {
      flashToolbar("Unsafe selector, skipped", "#fca5a5");
      return;
    }
    if (isSelectorTooGeneric(sel)) {
      flashToolbar("Too generic (matches " + document.querySelectorAll(sel).length + " elements), skipped", "#fca5a5");
      return;
    }

    // Skip if already saved this session
    if (savedSelectors.has(sel)) {
      flashToolbar("Already hidden: " + sel, "#93c5fd");
      return;
    }

    // Immediately hide matching elements
    const targets = document.querySelectorAll(sel);
    for (const t of targets) {
      t.style.setProperty("display", "none", "important");
    }

    // Send to background for persistent storage
    try {
      chrome.runtime.sendMessage({
        type: "PROTOCONSENT_PICKER_SAVE",
        domain: getHost(),
        selector: sel,
      }, (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok) {
          savedSelectors.add(sel);
          savedCount++;
          showStatus(savedCount + " hidden | last: " + sel);
        } else {
          flashToolbar("Save failed", "#fca5a5");
        }
      });
    } catch (_) {
      flashToolbar("Save failed", "#fca5a5");
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  function flashToolbar(text, color) {
    if (!toolbar) return;
    const preview = toolbar.querySelector('[data-pc-picker="preview"]');
    if (preview) {
      preview.textContent = text;
      preview.style.color = color || "#93c5fd";
    }
  }

  function showStatus(text) {
    if (!toolbar) return;
    const status = toolbar.querySelector('[data-pc-picker="status"]');
    if (status) {
      status.textContent = text;
      status.style.display = "block";
    }
  }

  // --- Lifecycle ---

  function cleanup() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mouseleave", onMouseLeave);
    if (highlightBox) { highlightBox.remove(); highlightBox = null; }
    if (toolbar) { toolbar.remove(); toolbar = null; }
    currentTarget = null;
    document.__pcPickerActive = false;
  }

  // --- Init ---

  highlightBox = createHighlightBox();
  toolbar = createToolbar();

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("mouseleave", onMouseLeave);

  // Auto-cleanup if extension context is invalidated (update/reload)
  try {
    const port = chrome.runtime.connect({ name: "picker" });
    port.onDisconnect.addListener(cleanup);
  } catch (_) {}
})();
