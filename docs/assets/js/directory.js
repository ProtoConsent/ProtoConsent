/*
  ProtoConsent browser extension
  Copyright (C) 2026 ProtoConsent contributors
  SPDX-License-Identifier: GPL-3.0-or-later

  Directory page – renders sites.json as a list of site cards.
*/

(function () {
  'use strict';

  const listEl = document.getElementById('dir-list');
  const emptyEl = document.getElementById('dir-empty');
  const errorEl = document.getElementById('dir-error');

  const PURPOSE_LABELS = {
    functional: 'Functional',
    analytics: 'Analytics',
    ads: 'Ads',
    personalization: 'Personalization',
    third_parties: 'Third parties',
    advanced_tracking: 'Advanced tracking'
  };

  function renderSite(site) {
    const card = document.createElement('div');
    card.className = 'dir-card';

    const header = document.createElement('div');
    header.className = 'dir-card-header';

    const link = document.createElement('a');
    link.href = 'https://' + site.domain;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'dir-card-domain';
    link.textContent = site.domain;

    const version = document.createElement('span');
    version.className = 'dir-card-version';
    version.textContent = 'v' + site.version;

    header.appendChild(link);
    header.appendChild(version);

    const meta = document.createElement('div');
    meta.className = 'dir-card-meta';

    const purposes = document.createElement('span');
    purposes.textContent = site.purposes + ' purpose' + (site.purposes !== 1 ? 's' : '') + ' declared';

    const added = document.createElement('span');
    added.textContent = 'Added ' + site.added;

    meta.appendChild(purposes);
    meta.appendChild(added);

    const actions = document.createElement('div');
    actions.className = 'dir-card-actions';

    const validateLink = document.createElement('a');
    validateLink.href = 'validate.html?domain=' + encodeURIComponent(site.domain);
    validateLink.className = 'btn-secondary';
    validateLink.textContent = 'Validate';

    const viewLink = document.createElement('a');
    viewLink.href = 'https://' + site.domain + '/.well-known/protoconsent.json';
    viewLink.target = '_blank';
    viewLink.rel = 'noopener noreferrer';
    viewLink.className = 'btn-secondary';
    viewLink.textContent = 'View JSON';

    actions.appendChild(validateLink);
    actions.appendChild(viewLink);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(actions);

    return card;
  }

  function renderDirectory(data) {
    if (!data.sites || data.sites.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    // Sort by added date (newest first)
    const sorted = data.sites.slice().sort(function (a, b) {
      return b.added.localeCompare(a.added);
    });

    var countEl = document.createElement('p');
    countEl.className = 'dir-count';
    countEl.textContent = sorted.length + ' site' + (sorted.length !== 1 ? 's' : '') + ' registered';
    listEl.appendChild(countEl);

    sorted.forEach(function (site) {
      listEl.appendChild(renderSite(site));
    });
  }

  fetch('directory/sites.json')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(renderDirectory)
    .catch(function () {
      errorEl.hidden = false;
    });
})();
