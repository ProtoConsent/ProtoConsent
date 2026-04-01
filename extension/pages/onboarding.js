// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const PROFILE_DESCRIPTIONS = {
  strict: 'Only essential features. Blocks analytics, ads, and all tracking.',
  balanced: 'Allows analytics and personalization. Blocks ads and third-party sharing.',
  permissive: 'Allows most data uses. Only advanced tracking is blocked.'
};

const PROFILE_ORDER = ['strict', 'balanced', 'permissive'];
const RECOMMENDED = 'balanced';

let selectedProfile = RECOMMENDED;
let presets = null;
let purposes = null;

async function init() {
  try {
    const [presetsRes, purposesRes] = await Promise.all([
      fetch('../config/presets.json'),
      fetch('../config/purposes.json')
    ]);
    presets = await presetsRes.json();
    purposes = await purposesRes.json();
  } catch {
    document.getElementById('ob-profiles').textContent =
      'Could not load configuration. Please reload the page.';
    return;
  }

  renderProfiles();
  wireEvents();

  // Version in footer
  const manifest = chrome.runtime.getManifest();
  document.getElementById('ob-version').textContent =
    'ProtoConsent v' + manifest.version;
}

function renderProfiles() {
  const container = document.getElementById('ob-profiles');
  const sortedPurposes = Object.entries(purposes)
    .sort(([, a], [, b]) => a.order - b.order);

  for (const key of PROFILE_ORDER) {
    const preset = presets[key];
    if (!preset) continue;

    const card = document.createElement('div');
    card.className = 'ob-profile-card';
    card.dataset.profile = key;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', key === selectedProfile ? 'true' : 'false');
    card.setAttribute('tabindex', '0');

    if (key === selectedProfile) {
      card.classList.add('is-selected');
    }

    // Head: name + recommended badge
    const head = document.createElement('div');
    head.className = 'ob-profile-head';

    const name = document.createElement('span');
    name.className = 'ob-profile-name';
    name.textContent = preset.label;
    head.appendChild(name);

    if (key === RECOMMENDED) {
      const badge = document.createElement('span');
      badge.className = 'ob-profile-badge';
      badge.textContent = 'Recommended';
      head.appendChild(badge);
    }

    card.appendChild(head);

    // Description
    const desc = document.createElement('div');
    desc.className = 'ob-profile-desc';
    desc.textContent = PROFILE_DESCRIPTIONS[key] || '';
    card.appendChild(desc);

    // Purpose pills
    const pills = document.createElement('div');
    pills.className = 'ob-profile-pills';

    for (const [purposeKey, purposeCfg] of sortedPurposes) {
      const allowed = preset.purposes[purposeKey];
      const pill = document.createElement('span');
      pill.className = 'ob-pill ' + (allowed ? 'allowed' : 'denied');
      pill.textContent = purposeCfg.short_label;
      pills.appendChild(pill);
    }

    card.appendChild(pills);
    container.appendChild(card);
  }
}

function wireEvents() {
  const container = document.getElementById('ob-profiles');

  // Card click
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.ob-profile-card');
    if (card) selectCard(card);
  });

  // Keyboard: Enter/Space to select, arrow keys to navigate
  container.addEventListener('keydown', (e) => {
    const card = e.target.closest('.ob-profile-card');
    if (!card) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectCard(card);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = card.nextElementSibling;
      if (next) next.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = card.previousElementSibling;
      if (prev) prev.focus();
    }
  });

  // Save button
  document.getElementById('ob-save').addEventListener('click', save);

  // Settings link in confirmation screen
  document.getElementById('ob-link-settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/purposes-editor.html') });
  });
}

function selectCard(card) {
  const cards = document.querySelectorAll('.ob-profile-card');
  cards.forEach((c) => {
    c.classList.remove('is-selected');
    c.setAttribute('aria-checked', 'false');
  });
  card.classList.add('is-selected');
  card.setAttribute('aria-checked', 'true');
  selectedProfile = card.dataset.profile;
}

function save() {
  const data = {
    defaultProfile: selectedProfile,
    onboardingComplete: true
  };

  chrome.storage.local.set(data, () => {
    // Notify background to rebuild rules with new default
    chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
      void chrome.runtime.lastError;
    });

    // Show confirmation
    document.getElementById('ob-setup').classList.add('ob-hidden');
    document.getElementById('ob-done').classList.remove('ob-hidden');
    document.getElementById('ob-chosen-profile').textContent =
      presets[selectedProfile]?.label || selectedProfile;
  });
}

document.addEventListener('DOMContentLoaded', init);
