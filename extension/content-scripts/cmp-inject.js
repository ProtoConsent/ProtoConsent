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

  // --- Constants ---
  const CMP_DEFAULT_MAX_AGE = 7776000;   // 90 days (seconds)
  const CMP_CLEANUP_DELAY   = 5000;      // ms before deleting injected cookies
  const CMP_ENFORCE_TIMEOUT = 10000;     // ms watching for CMP re-lock attempts
  const CMP_OBSERVER_TIMEOUT = 15000;    // ms safety limit for banner detection

  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return;

  let stored;
  try {
    stored = await chrome.storage.local.get(['_cmpSignatures', '_cmpSiteSignatures', '_userPurposes', '_tcString',
      'cmpAutoResponse', 'cmpEnabled', 'cmpCookieMaxAge', 'cmpCustomUuid',
      'cmpCookieInjectionEnabled', 'cmpCosmeticEnabled', 'cmpScrollUnlockEnabled',
      '_cmpDomainCache']);
  } catch (_) { return; }
  const sigs = Object.assign({}, stored._cmpSignatures, stored._cmpSiteSignatures);
  const prefs = stored._userPurposes;
  const tcString = stored._tcString;
  const { cmpAutoResponse, cmpEnabled, cmpCookieMaxAge, cmpCustomUuid,
    cmpCookieInjectionEnabled, cmpCosmeticEnabled, cmpScrollUnlockEnabled } = stored;
  if (cmpAutoResponse === false) return;
  if (!sigs || !prefs) return;

  // Registrable domain (simple heuristic)
  const MULTI_TLDS = [
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
    'com.au', 'org.au', 'net.au', 'edu.au',
    'co.jp', 'or.jp', 'ne.jp',
    'com.br', 'org.br', 'net.br',
    'co.kr', 'or.kr',
    'co.in', 'org.in', 'net.in',
    'co.nz', 'org.nz', 'net.nz',
    'co.za', 'org.za', 'net.za',
    'com.mx', 'org.mx',
    'com.ar', 'org.ar',
    'co.il',
    'com.tr', 'org.tr',
    'com.tw', 'org.tw',
    'com.sg', 'org.sg',
    'com.hk', 'org.hk',
    'co.id',
    'com.ph',
    'co.th',
    'com.my',
    'com.cn', 'org.cn', 'net.cn',
    'co.ke',
    'com.ng',
    'com.eg',
    'com.ua', 'org.ua',
    'com.pl', 'org.pl',
    'co.at',
  ];
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
    if (cmp.domains && !cmp.domains.some(d => d === domain || (brand.length >= 3 && d === brand))) continue;
    if (cmpEnabled && cmpEnabled[cmpId] === false) continue;
    applicableSigs[cmpId] = cmp;
  }

  // UUID: fresh random per page visit (unlinkable), unless user set a fixed one
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const customValid = cmpCustomUuid && UUID_RE.test(cmpCustomUuid);
  const uuid = customValid ? cmpCustomUuid
    : (typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
      : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // Sanitize TC string: only allow base64url-safe chars (IAB TCF spec)
  const safeTcString = typeof tcString === 'string'
    ? tcString.replace(/[^A-Za-z0-9_\-.~+/=]/g, '').slice(0, 2000) : '';

  const hostname = location.hostname;
  const BANNED_SELS = new Set([
    'div', 'span', 'body', 'html', 'main', 'header', 'footer', 'section',
    'article', 'aside', 'nav', 'title', '*', '[role="dialog"]',
    '.modal', '.overlay', '.modal-backdrop', '.popup',
  ]);

  // --- Layer 1: Cookie injection ---
  // Existing cookies: if a CMP (or the user) already set a consent cookie,
  // do not overwrite it. This prevents clobbering real consent from CMPs
  // like Didomi whose tokens are site-specific and cannot be templated.
  let existingCookies;
  try {
    existingCookies = new Set(
      (document.cookie || '').split(';').map(c => c.split('=')[0].trim()).filter(Boolean)
    );
  } catch (_) {
    return;
  }
  const injectedCookies = [];
  if (cmpCookieInjectionEnabled === true) {
    const domainCache = stored._cmpDomainCache;
    const cachedCmpIds = (domainCache && typeof domainCache === 'object') ? domainCache[domain] : undefined;
    const sigsToInject = cachedCmpIds
      ? Object.fromEntries(Object.entries(applicableSigs).filter(([id]) => cachedCmpIds.includes(id)))
      : applicableSigs;

    const maxAge = Math.min(Math.max(Number(cmpCookieMaxAge) || CMP_DEFAULT_MAX_AGE, 60), 31536000);
    for (const [cmpId, cmp] of Object.entries(sigsToInject)) {
      if (!cmp.cookie) continue;
      const fmt = cmp.format || { allow: '1', deny: '0' };

      for (const c of cmp.cookie) {
        if (typeof c.template !== 'string' || !c.template) continue;
        if (!c.name || /[;=\s]/.test(c.name)) continue;
        if (existingCookies.has(c.name)) continue;

        let val = c.template
          .replaceAll('{DATE_ISO}', now.toISOString())
          .replaceAll('{DATESTAMP_ENCODED}', encodeURIComponent(now.toString()))
          .replaceAll('{UUID}', uuid)
          .replaceAll('{TIMESTAMP}', String(now.getTime()))
          .replaceAll('{STAMP}', String(Math.random()).slice(2, 10))
          .replaceAll('{TC_STRING}', safeTcString);

        for (const [purpose, allowed] of Object.entries(prefs)) {
          val = val.replaceAll(`{${purpose}}`, allowed ? fmt.allow : fmt.deny);
        }

        val = val.replace(/\{[a-z_]+\}/g, fmt.deny);
        val = val.replaceAll(';', '');
        try {
          document.cookie = `${c.name}=${val}; path=/; domain=.${domain}; SameSite=Lax; max-age=${maxAge}`;
          injectedCookies.push(c.name);
        } catch (_) {}
      }
    }

    if (injectedCookies.length && !cachedCmpIds) {
      setTimeout(() => {
        for (const name of injectedCookies) {
          try { document.cookie = `${name}=; path=/; domain=.${domain}; max-age=0`; } catch (_) {}
        }
      }, CMP_CLEANUP_DELAY);
    }
  }


  // --- Layer 2: Cosmetic safety net ---
  const selectors = [];
  if (cmpCosmeticEnabled !== false) {
    for (const cmp of Object.values(applicableSigs)) {
      if (cmp.selector) {
        if (cmp.excludeHosts && cmp.excludeHosts.some(h => hostname === h || hostname.endsWith('.' + h))) continue;
        const safe = cmp.selector.split(',').map(s => s.trim()).filter(s => s && !BANNED_SELS.has(s));
        if (safe.length) selectors.push(safe.join(', '));
      }
    }
    if (selectors.length) {
      const style = document.createElement('style');
      style.setAttribute('data-pc-cmp', '');
      style.textContent = selectors.join(',') + '{display:none!important}';
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // --- Layer 3: Scroll unlock (only if CMP banner exists in DOM) ---
  const lockEntries = [];
  if (cmpScrollUnlockEnabled !== false) {
    for (const cmp of Object.values(applicableSigs)) {
      if (cmp.selector) {
        if (cmp.excludeHosts && cmp.excludeHosts.some(h => hostname === h || hostname.endsWith('.' + h))) continue;
        const sels = cmp.selector.split(',').map(s => s.trim()).filter(s => s && !BANNED_SELS.has(s));
        if (sels.length) lockEntries.push({ sels, cls: cmp.lockClass || null });
      }
    }
    if (lockEntries.length) {
      const unlock = () => {
        const lockClasses = lockEntries.map(e => e.cls).filter(Boolean);
        if (lockClasses.length) {
          const s = document.createElement('style');
          s.setAttribute('data-pc-cmp', '');
          const lockSels = lockClasses.flatMap(c => [`body.${c}`, `html.${c}`]).join(',');
          s.textContent = lockSels + '{overflow:auto!important;height:auto!important;position:static!important}';
          (document.head || document.documentElement).appendChild(s);
        }

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
        setTimeout(() => mo.disconnect(), CMP_ENFORCE_TIMEOUT);
      };

      const tryUnlock = () => {
        for (const { sels, cls } of lockEntries) {
          try {
            if (sels.some(s => document.querySelector(s))) return true;
          } catch (_) {}
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
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class']
        });
        document.addEventListener('DOMContentLoaded', () => {
          if (tryUnlock()) {
            observer.disconnect();
            unlock();
          }
        }, { once: true });
        setTimeout(() => observer.disconnect(), CMP_OBSERVER_TIMEOUT);
      }
    }
  }

  // Report CMP activity to background for observability
  if (window === window.top) {
    const cmpIds = Object.keys(applicableSigs);
    if (cmpIds.length > 0) {
      try {
        chrome.runtime.sendMessage({
          type: "PROTOCONSENT_CMP_APPLIED",
          domain: domain,
          cmpIds: cmpIds,
          cmpCount: cmpIds.length,
          cookieCount: injectedCookies.length,
          selectorCount: selectors.length,
          scrollUnlock: lockEntries.length > 0,
        }, () => { void chrome.runtime.lastError; });
      } catch (_) {}
    }
  }
})();
