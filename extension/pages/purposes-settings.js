// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// TODO: Add import/export (JSON)
// TODO: Add i18n support (load labels from localized config)

async function init() {
	const statusEl = document.getElementById('status-msg');
	try {
		const [purposesRes, presetsRes] = await Promise.all([
			fetch(chrome.runtime.getURL('config/purposes.json')),
			fetch(chrome.runtime.getURL('config/presets.json'))
		]);
		if (!purposesRes.ok) throw new Error("purposes.json: HTTP " + purposesRes.status);
		if (!presetsRes.ok) throw new Error("presets.json: HTTP " + presetsRes.status);
		const purposes = await purposesRes.json();
		const presets = await presetsRes.json();

		statusEl.classList.add('ps-hidden');
		initDefaultProfile(purposes);
		renderPurposes(purposes);
		renderPresets(presets, purposes);

		const versionEl = document.getElementById('viewer-version');
		if (versionEl) {
			versionEl.textContent = 'ProtoConsent v' + chrome.runtime.getManifest().version;
		}

		const welcomeLink = document.getElementById('ps-welcome-link');
		if (welcomeLink) {
			welcomeLink.addEventListener('click', (e) => {
				e.preventDefault();
				chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
			});
		}
	} catch (err) {
		statusEl.textContent = 'Error loading configuration: ' + err.message;
		statusEl.classList.add('error');
	}
}

function initDefaultProfile(purposes) {
	const section = document.getElementById('default-profile-section');
	const selectEl = document.getElementById('default-profile-select');
	const resetBtn = document.getElementById('reset-all-sites');
	const togglesContainer = document.getElementById('custom-toggles');
	if (!section || !selectEl || !resetBtn || !togglesContainer) return;

	// Build dynamic toggle rows from purposes config, sorted by order
	const purposeKeys = Object.keys(purposes)
		.sort((a, b) => (purposes[a].order || 0) - (purposes[b].order || 0));
	const checkboxes = {};
	for (const key of purposeKeys) {
		const row = document.createElement('div');
		row.className = 'ps-custom-toggle-row';

		const label = document.createElement('label');
		label.className = 'ps-custom-toggle-label';
		label.textContent = purposes[key].label || key;
		label.setAttribute('for', 'dp-' + key);

		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.id = 'dp-' + key;
		cb.checked = true;

		if (purposes[key].required) {
			cb.disabled = true;
			label.textContent += ' (required)';
		}

		row.appendChild(label);
		row.appendChild(cb);
		togglesContainer.appendChild(row);
		checkboxes[key] = cb;
	}

	// Load stored values
	chrome.storage.local.get(['defaultProfile', 'defaultPurposes'], (result) => {
		const profile = result.defaultProfile || 'balanced';
		selectEl.value = profile;

		if (profile === 'custom') {
			togglesContainer.classList.remove('ps-hidden');
			if (result.defaultPurposes) {
				for (const key of purposeKeys) {
					if (purposes[key].required) {
						checkboxes[key].checked = true;
					} else if (key in result.defaultPurposes) {
						checkboxes[key].checked = result.defaultPurposes[key];
					}
				}
			}
		}
		updateCustomPresetCard();
	});

	function saveCustomPurposes() {
		const dp = {};
		for (const key of purposeKeys) {
			dp[key] = purposes[key].required ? true : checkboxes[key].checked;
		}
		chrome.storage.local.set({ defaultPurposes: dp }, notifyBackground);
		updateCustomPresetCard();
	}

	// Update the custom preset card pills to reflect current toggles
	function updateCustomPresetCard() {
		const pillsEl = document.getElementById('custom-preset-pills');
		if (!pillsEl) return;
		pillsEl.replaceChildren();
		for (const key of purposeKeys) {
			const allowed = checkboxes[key].checked;
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = (purposes[key] ? purposes[key].short : key) + (allowed ? ' \u2713' : ' \u2717');
			pillsEl.appendChild(pill);
		}
	}

	// Toggle visibility and save on dropdown change
	selectEl.addEventListener('change', () => {
		const value = selectEl.value;

		if (value === 'custom') {
			togglesContainer.classList.remove('ps-hidden');
			// Atomic write: both keys together to avoid inconsistent state
			const dp = {};
			for (const key of purposeKeys) {
				dp[key] = checkboxes[key].checked;
			}
			chrome.storage.local.set({ defaultProfile: value, defaultPurposes: dp }, notifyBackground);
			updateCustomPresetCard();
		} else {
			togglesContainer.classList.add('ps-hidden');
			chrome.storage.local.set({ defaultProfile: value }, notifyBackground);
		}
	});

	// Save on each checkbox change
	for (const key of purposeKeys) {
		checkboxes[key].addEventListener('change', saveCustomPurposes);
	}

	// Reset all sites
	resetBtn.addEventListener('click', () => {
		if (!confirm('Remove all per-site settings? Every site will use the default profile.')) return;
		chrome.storage.local.set({ rules: {} }, () => {
			chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
				void chrome.runtime.lastError; // suppress warning if background is inactive
			});
			resetBtn.textContent = 'Done';
			resetBtn.setAttribute('aria-live', 'polite');
			setTimeout(() => { resetBtn.textContent = 'Reset all sites'; resetBtn.removeAttribute('aria-live'); }, 1500);
		});
	});

	section.classList.remove('ps-hidden');
}

function renderPurposes(purposes) {
	const container = document.getElementById('purpose-list');
	const section = document.getElementById('purposes-section');
	if (!container || !section) return;

	const purposeEntries = Object.values(purposes)
		.sort((a, b) => (a.order || 0) - (b.order || 0));

	for (const p of purposeEntries) {
		const card = document.createElement('div');
		card.className = 'ps-purpose-card';

		const header = document.createElement('div');
		header.className = 'ps-purpose-header';

		if (p.icon) {
			const iconImg = document.createElement('img');
			iconImg.className = 'ps-purpose-icon-img';
			iconImg.src = p.icon;
			iconImg.alt = '';
			iconImg.onerror = function () { this.remove(); };
			header.appendChild(iconImg);
		}

		const badge = document.createElement('span');
		badge.className = 'ps-purpose-short';
		badge.textContent = p.short;

		const label = document.createElement('span');
		label.className = 'ps-purpose-label';
		label.textContent = p.label;

		header.appendChild(badge);
		header.appendChild(label);
		card.appendChild(header);

		const desc = document.createElement('p');
		desc.className = 'ps-purpose-desc';
		desc.textContent = p.description;
		card.appendChild(desc);

		if (p.consent_commons_keys && p.consent_commons_keys.length) {
			const keys = document.createElement('div');
			keys.className = 'ps-purpose-keys';
			const keysLabel = document.createElement('span');
			keysLabel.className = 'ps-purpose-keys-label';
			keysLabel.textContent = 'Consent Commons:';
			keys.appendChild(keysLabel);
			for (const k of p.consent_commons_keys) {
				const pill = document.createElement('span');
				pill.className = 'ps-purpose-key';
				pill.textContent = k.replace(/_/g, ' ');
				keys.appendChild(pill);
			}
			card.appendChild(keys);
		}

		container.appendChild(card);
	}
	section.classList.remove('ps-hidden');
}

function renderPresets(presets, purposes) {
	const container = document.getElementById('preset-list');
	const section = document.getElementById('presets-section');
	if (!container || !section) return;

	for (const preset of Object.values(presets)) {
		const card = document.createElement('div');
		card.className = 'ps-preset-card';

		const name = document.createElement('div');
		name.className = 'ps-preset-name';
		name.textContent = preset.label;
		card.appendChild(name);

		const pills = document.createElement('div');
		pills.className = 'ps-preset-purposes';
		for (const [pKey, allowed] of Object.entries(preset.purposes)) {
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = (purposes[pKey] ? purposes[pKey].short : pKey) + (allowed ? ' \u2713' : ' \u2717');
			pills.appendChild(pill);
		}
		card.appendChild(pills);

		container.appendChild(card);
	}
	section.classList.remove('ps-hidden');

	// GPC signal info row — read-only, shows which purposes trigger Sec-GPC
	const gpcCard = document.createElement('div');
	gpcCard.className = 'ps-preset-card';

	const gpcInfo = document.createElement('div');
	gpcInfo.className = 'ps-gpc-info-row';

	const gpcName = document.createElement('span');
	gpcName.className = 'ps-gpc-info-name';
	gpcName.textContent = 'GPC (Global Privacy Control)';
	gpcInfo.appendChild(gpcName);

	const gpcDesc = document.createElement('span');
	gpcDesc.className = 'ps-gpc-info-desc';
	gpcDesc.textContent = '\u002D privacy signal sent to websites when any of these purposes are denied';
	gpcInfo.appendChild(gpcDesc);

	gpcCard.appendChild(gpcInfo);

	const gpcPills = document.createElement('div');
	gpcPills.className = 'ps-preset-purposes';
	const gpcEntries = Object.values(purposes)
		.sort((a, b) => (a.order || 0) - (b.order || 0));
	for (const pDef of gpcEntries) {
		if (!pDef.triggers_gpc) continue;
		const pill = document.createElement('span');
		pill.className = 'ps-preset-pill gpc';
		pill.textContent = pDef.short + ' \u2717';
		gpcPills.appendChild(pill);
	}
	gpcCard.appendChild(gpcPills);
	container.appendChild(gpcCard);

	// Always render custom preset card (updated live by initDefaultProfile)
	const customCard = document.createElement('div');
	customCard.className = 'ps-preset-card';
	customCard.id = 'custom-preset-card';

	const customName = document.createElement('div');
	customName.className = 'ps-preset-name';
	customName.textContent = 'Custom (your default)';
	customCard.appendChild(customName);

	const customPills = document.createElement('div');
	customPills.className = 'ps-preset-purposes';
	customPills.id = 'custom-preset-pills';
	customCard.appendChild(customPills);
	container.appendChild(customCard);
}

function notifyBackground() {
	chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
		void chrome.runtime.lastError; // suppress warning if background is inactive
	});
}

document.addEventListener('DOMContentLoaded', init);
