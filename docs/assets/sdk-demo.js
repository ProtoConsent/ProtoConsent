// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// sdk-demo.js — Live test for the ProtoConsent SDK on protoconsent.org.
// Queries the extension via postMessage and displays the result.

(function () {
  'use strict';

  var TIMEOUT_MS = 600;
  var PURPOSES = [
    'functional', 'analytics', 'ads',
    'personalization', 'third_parties', 'advanced_tracking'
  ];

  var PURPOSE_LABELS = {
    functional: 'Functional',
    analytics: 'Analytics',
    ads: 'Ads / Marketing',
    personalization: 'Personalization',
    third_parties: 'Third-party sharing',
    advanced_tracking: 'Advanced tracking'
  };

  function queryExtension(action, purpose) {
    try {
      var id = crypto.randomUUID();
      return new Promise(function (resolve) {
        var timer = setTimeout(function () { resolve(null); }, TIMEOUT_MS);
        window.addEventListener('message', function handler(event) {
          if (event.source !== window) return;
          if (!event.data || event.data.type !== 'PROTOCONSENT_RESPONSE') return;
          if (event.data.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          resolve(event.data.data);
        });
        window.postMessage({
          type: 'PROTOCONSENT_QUERY',
          id: id,
          action: action,
          purpose: purpose || null
        }, window.location.origin);
      });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function renderDetected(container, profile, purposes) {
    var wrapEl = document.createElement('div');
    wrapEl.className = 'sdk-demo-detected';

    var profileEl = document.createElement('div');
    profileEl.className = 'sdk-demo-profile';
    profileEl.textContent = 'Profile: ' + profile;
    wrapEl.appendChild(profileEl);

    var listEl = document.createElement('div');
    listEl.className = 'sdk-demo-purposes';

    PURPOSES.forEach(function (key) {
      var allowed = purposes[key];
      var itemEl = document.createElement('span');
      itemEl.className = 'sdk-demo-purpose ' + (allowed ? 'is-allowed' : 'is-blocked');
      itemEl.textContent = PURPOSE_LABELS[key] + ': ' + (allowed ? 'allowed' : 'blocked');
      listEl.appendChild(itemEl);
    });

    wrapEl.appendChild(listEl);
    container.appendChild(wrapEl);
  }

  function renderNotDetected(container) {
    var msgEl = document.createElement('div');
    msgEl.className = 'sdk-demo-noext';

    var iconEl = document.createElement('img');
    iconEl.src = 'assets/logo/protoconsent_logo_32.png';
    iconEl.alt = 'ProtoConsent icon';
    iconEl.width = 24;
    iconEl.height = 24;
    iconEl.className = 'sdk-demo-icon';
    msgEl.appendChild(iconEl);

    var textEl = document.createElement('span');
    textEl.textContent = 'Install the ProtoConsent extension to see your preferences for this site. ';
    msgEl.appendChild(textEl);

    var linkEl = document.createElement('a');
    linkEl.href = 'https://github.com/ProtoConsent/ProtoConsent#getting-started-developer-mode';
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
    linkEl.textContent = 'Installation guide';
    msgEl.appendChild(linkEl);

    container.appendChild(msgEl);
  }

  async function init() {
    var container = document.getElementById('sdk-demo-result');
    if (!container) return;

    try {
      var profile = await queryExtension('getProfile');
      var purposes = await queryExtension('getAll');

      if (profile && purposes) {
        renderDetected(container, profile, purposes);
      } else {
        renderNotDetected(container);
      }
    } catch (_) {
      renderNotDetected(container);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
