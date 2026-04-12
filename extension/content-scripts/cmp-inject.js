// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// cmp-inject.js - Injects consent cookies based on user purposes
// before any CMP script loads. Three layers:
//   1. Cookie injection (prevents banner from appearing)
//   2. Cosmetic CSS (hides banner if cookie arrives late)
//   3. Scroll unlock (removes scroll lock if banner was hidden)

(async () => {
  'use strict';

  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return;

  const { _cmpSignatures: sigs, _userPurposes: prefs, _tcString: tcString, _cmpUuid: storedUuid,
    cmpAutoResponse, cmpEnabled, cmpCookieMaxAge, cmpCustomUuid } =
    await chrome.storage.local.get(['_cmpSignatures', '_userPurposes', '_tcString', '_cmpUuid',
      'cmpAutoResponse', 'cmpEnabled', 'cmpCookieMaxAge', 'cmpCustomUuid']);
  if (cmpAutoResponse === false) return;
  if (!sigs || !prefs) return;

  // Registrable domain (simple heuristic)
  // TODO: proper public suffix list for .co.uk, .com.au, etc.
  const MULTI_TLDS = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.kr', 'co.in', 'org.uk'];
  function getRegistrableDomain(hostname) {
    const h = hostname.replace(/^www\./, '');
    for (const tld of MULTI_TLDS) {
      if (h.endsWith('.' + tld)) {
        const parts = h.slice(0, -(tld.length + 1)).split('.');
        return parts[parts.length - 1] + '.' + tld;
      }
    }
    return h.split('.').slice(-2).join('.');
  }

  const domain = getRegistrableDomain(location.hostname);
  const brand = domain.split('.')[0];
  const now = new Date();

  // Filter signatures by domain scope.
  // Entries with "domains" only apply to listed domains/brands.
  // Entries without "domains" apply globally (standard CMPs).
  const applicableSigs = {};
  for (const [cmpId, cmp] of Object.entries(sigs)) {
    if (cmp.domains && !cmp.domains.some(d => d === domain || d === brand)) continue;
    if (cmpEnabled && cmpEnabled[cmpId] === false) continue;
    applicableSigs[cmpId] = cmp;
  }

  // Persistent UUID: reuse across page loads so CMPs see consistent identity
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const customValid = cmpCustomUuid && UUID_RE.test(cmpCustomUuid);
  const uuid = (customValid ? cmpCustomUuid : null) || storedUuid || crypto.randomUUID();
  if (!storedUuid) chrome.storage.local.set({ _cmpUuid: uuid });

  // --- Layer 1: Cookie injection ---
  const maxAge = cmpCookieMaxAge || 7776000;
  const injectedCookies = [];
  for (const [cmpId, cmp] of Object.entries(applicableSigs)) {
    if (!cmp.cookie) continue;
    const fmt = cmp.format || { allow: '1', deny: '0' };

    for (const c of cmp.cookie) {
      if (typeof c.template !== 'string' || !c.template) continue;
      if (!c.name || /[;=\s]/.test(c.name)) continue;

      let val = c.template
        .replace('{DATE_ISO}', now.toISOString())
        .replace('{DATESTAMP_ENCODED}', encodeURIComponent(now.toString()))
        .replace('{UUID}', uuid)
        .replace('{TIMESTAMP}', String(now.getTime()))
        .replace('{STAMP}', String(Math.random()).slice(2, 10))
        .replace('{TC_STRING}', tcString || '');

      for (const [purpose, allowed] of Object.entries(prefs)) {
        val = val.replaceAll(`{${purpose}}`, allowed ? fmt.allow : fmt.deny);
      }

      // Sanitize: strip semicolons to prevent cookie attribute injection
      val = val.replaceAll(';', '');
      document.cookie = `${c.name}=${val}; path=/; domain=.${domain}; SameSite=Lax; max-age=${maxAge}`;
      injectedCookies.push(c.name);
    }
  }

  // Cleanup: delete injected cookies after CMPs have read them (~10s).
  // Reduces HTTP overhead on subsequent requests (images, XHR, lazy loads).
  // Cookies are re-injected on next navigation via document_start.
  if (injectedCookies.length) {
    setTimeout(() => {
      for (const name of injectedCookies) {
        document.cookie = `${name}=; path=/; domain=.${domain}; max-age=0`;
      }
    }, 10000);
  }

  // --- Layer 2: Cosmetic safety net ---
  const selectors = [];
  for (const cmp of Object.values(applicableSigs)) {
    if (cmp.selector) selectors.push(cmp.selector);
  }
  if (selectors.length) {
    const style = document.createElement('style');
    style.setAttribute('data-pc-cmp', '');
    style.textContent = selectors.join(',') + '{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Layer 3: Scroll unlock (only if CMP banner exists in DOM) ---
  // Banners are injected dynamically by CMP scripts after document_start.
  // Use MutationObserver to detect them the moment they appear.
  const lockEntries = [];
  for (const cmp of Object.values(applicableSigs)) {
    if (cmp.selector) {
      const sels = cmp.selector.split(',').map(s => s.trim());
      lockEntries.push({ sels, cls: cmp.lockClass || null });
    }
  }
  if (lockEntries.length) {
    const unlock = () => {
      // CSS targeted at CMP lock classes — self-removing when enforce() strips the class.
      // Does NOT blanket html/body to avoid interfering with legitimate modals.
      const lockClasses = lockEntries.map(e => e.cls).filter(Boolean);
      if (lockClasses.length) {
        const s = document.createElement('style');
        s.setAttribute('data-pc-cmp', '');
        const lockSels = lockClasses.flatMap(c => [`body.${c}`, `html.${c}`]).join(',');
        s.textContent = lockSels + '{overflow:auto!important;height:auto!important;position:static!important}';
        (document.head || document.documentElement).appendChild(s);
      }

      // Inline !important overrides for CMPs that lock scroll via JS, not classes.
      // Only overrides lock patterns (hidden/clip/fixed), not arbitrary values,
      // so legitimate modals using overflow:hidden are not affected.
      const enforce = () => {
        const b = document.body;
        if (b) {
          const bs = getComputedStyle(b);
          if (bs.overflow === 'hidden' || bs.overflow === 'clip')
            b.style.setProperty('overflow', 'auto', 'important');
          if (bs.position === 'fixed')
            b.style.setProperty('position', 'static', 'important');
          lockEntries.forEach(e => {
            if (e.cls && b.classList.contains(e.cls)) b.classList.remove(e.cls);
          });
        }
        const h = document.documentElement;
        const hs = getComputedStyle(h);
        if (hs.overflow === 'hidden' || hs.overflow === 'clip')
          h.style.setProperty('overflow', 'auto', 'important');
      };
      enforce();

      // Watch for CMP re-locking attempts for 10 seconds
      let enforcePending = false;
      const scheduleEnforce = () => {
        if (!enforcePending) {
          enforcePending = true;
          requestAnimationFrame(() => { enforcePending = false; enforce(); });
        }
      };
      const mo = new MutationObserver(scheduleEnforce);
      const startWatch = () => {
        if (document.body)
          mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      };
      if (document.body) startWatch();
      else document.addEventListener('DOMContentLoaded', startWatch, { once: true });
      setTimeout(() => mo.disconnect(), 10000);
    };

    const tryUnlock = () => {
      for (const { sels, cls } of lockEntries) {
        try {
          if (sels.some(s => document.querySelector(s))) return true;
        } catch (_) { /* malformed selector in signatures */ }
        if (cls && document.body?.classList.contains(cls)) return true;
      }
      return false;
    };

    if (tryUnlock()) {
      unlock();
    } else {
      const observer = new MutationObserver(() => {
        if (tryUnlock()) {
          observer.disconnect();
          unlock();
        }
      });
      // Observe on documentElement (exists at document_start, unlike body)
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class']
      });
      // Re-check after DOM is parsed (observer misses pre-existing nodes)
      document.addEventListener('DOMContentLoaded', () => {
        if (tryUnlock()) {
          observer.disconnect();
          unlock();
        }
      }, { once: true });
      // Safety timeout: stop observing after 15s
      setTimeout(() => observer.disconnect(), 15000);
    }
  }
})();
