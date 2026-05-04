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

function closeOnboardingTab() {
  chrome.tabs.getCurrent(tab => {
    if (tab) chrome.tabs.remove(tab.id);
  });
}

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
  detectRegionalLanguage();

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

  // Get Started -> save profile and go to options screen
  document.getElementById('ob-save').addEventListener('click', () => {
    saveProfile(() => goToScreen('ob-done-screen'));
  });

  // Skip -> save balanced defaults, open Settings, close onboarding
  document.getElementById('ob-skip').addEventListener('click', () => {
    selectedProfile = RECOMMENDED;
    saveProfile(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/purposes-settings.html') });
      closeOnboardingTab();
    });
  });

  // Done -> save step 2 options, open Settings and close onboarding tab
  document.getElementById('ob-done').addEventListener('click', () => {
    saveOptions(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/purposes-settings.html') });
      closeOnboardingTab();
    });
  });

  // Update confirmation text when monitoring toggle changes
  const monToggle = document.getElementById('ob-monitoring-toggle');
  if (monToggle) {
    monToggle.addEventListener('change', () => {
      const modeEl = document.getElementById('ob-chosen-mode');
      if (modeEl) modeEl.textContent = monToggle.checked ? 'Monitoring' : 'Blocking';
    });
  }
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

function goToScreen(screenId) {
  const screens = document.querySelectorAll('.ob-screen');
  screens.forEach((s) => s.classList.add('ob-hidden'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.remove('ob-hidden');
    const heading = target.querySelector('.ob-title');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }
}

function saveProfile(callback) {
  const data = {
    defaultProfile: selectedProfile,
    operatingMode: 'standalone',
    onboardingComplete: true,
    enhancedPreset: 'basic',
  };

  chrome.storage.local.set(data, () => {
    chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
      void chrome.runtime.lastError;
    });

    // Show chosen profile in step 2
    const celProfileEl = document.getElementById('ob-cel-profile-name');
    if (celProfileEl) celProfileEl.textContent = presets[selectedProfile]?.label || selectedProfile;
    document.getElementById('ob-chosen-profile').textContent =
      presets[selectedProfile]?.label || selectedProfile;

    if (callback) callback();
  });
}

function saveOptions(callback) {
  const celChecked = document.getElementById('ob-cel-toggle')?.checked;
  const monitoringChecked = document.getElementById('ob-monitoring-toggle')?.checked;
  const mode = monitoringChecked ? 'protoconsent' : 'standalone';

  if (celChecked) {
    setConsentEnhancedLink(true, () => { void 0; });
  }

  chrome.storage.local.set({ operatingMode: mode }, () => {
    chrome.runtime.sendMessage({ type: 'PROTOCONSENT_SET_OPERATING_MODE', mode: mode }, () => {
      void chrome.runtime.lastError;
    });
    if (callback) callback();
  });
}

function detectRegionalLanguage() {
  const container = document.getElementById('ob-regional-flags');
  if (!container) return;

  fetch(chrome.runtime.getURL('config/regional-languages.json'))
    .then(r => r.ok ? r.json() : null)
    .then(rlConfig => {
      if (!rlConfig) return;

      // Build language -> region map
      const langToRegion = {};
      for (const [code, entry] of Object.entries(rlConfig)) {
        for (const lang of entry.languages) {
          langToRegion[lang] = code;
        }
      }

      // Detect from browser locale
      const uiLang = chrome.i18n.getUILanguage();
      const baseLang = (uiLang || '').split('-')[0].toLowerCase();
      const detected = langToRegion[uiLang] || langToRegion[baseLang] || null;

      if (detected) {
        // Save to storage if not already set
        chrome.storage.local.get(['regionalLanguages'], (stored) => {
          if (!Array.isArray(stored.regionalLanguages)) {
            chrome.storage.local.set({ regionalLanguages: [detected] });
          }
        });

        // Render detected flag(s)
        const entry = rlConfig[detected];
        container.setAttribute('aria-label', entry.label + ' detected');
        const flagCodes = entry.flag
          ? (Array.isArray(entry.flag) ? entry.flag : [entry.flag])
          : [];
        for (const fc of flagCodes) {
          const img = document.createElement('img');
          img.src = chrome.runtime.getURL('icons/flags/' + fc.toLowerCase() + '.svg');
          img.width = 20;
          img.height = 15;
          img.alt = '';
          img.setAttribute('aria-hidden', 'true');
          img.style.verticalAlign = 'middle';
          img.style.marginLeft = '4px';
          img.onerror = function () { this.style.display = 'none'; };
          container.appendChild(img);
        }
      } else {
        // No detection: show all available flags
        container.setAttribute('aria-label', '30 languages available');
        const sortedCodes = Object.keys(rlConfig).sort();
        for (const code of sortedCodes) {
          const entry = rlConfig[code];
          const flagCodes = entry.flag
            ? (Array.isArray(entry.flag) ? entry.flag : [entry.flag])
            : [];
          for (const fc of flagCodes) {
            const img = document.createElement('img');
            img.src = chrome.runtime.getURL('icons/flags/' + fc.toLowerCase() + '.svg');
            img.width = 16;
            img.height = 12;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            img.title = entry.label;
            img.style.verticalAlign = 'middle';
            img.style.marginLeft = '2px';
            img.onerror = function () { this.style.display = 'none'; };
            container.appendChild(img);
          }
        }
      }
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
