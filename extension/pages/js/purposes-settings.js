// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
		renderEnhancedPresets();

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
		updateConsentPresetHighlight(value);

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

function updateConsentPresetHighlight(activeProfile) {
	const container = document.getElementById('preset-list');
	if (!container) return;
	const cards = container.querySelectorAll('.ps-preset-card');
	cards.forEach(card => {
		card.classList.remove('ps-consent-preset-active');
		const badge = card.querySelector('.ps-consent-current-badge');
		if (badge) badge.remove();
	});
	// Named presets are in order: strict, balanced, permissive → index 0, 1, 2
	// Custom card has id="custom-preset-card"
	if (activeProfile === 'custom') {
		const customCard = document.getElementById('custom-preset-card');
		if (customCard) {
			customCard.classList.add('ps-consent-preset-active');
			const name = customCard.querySelector('.ps-preset-name');
			if (name && !name.querySelector('.ps-consent-current-badge')) {
				const badge = document.createElement('span');
				badge.className = 'ps-consent-current-badge';
				badge.textContent = ' (default)';
				name.appendChild(badge);
			}
		}
	} else {
		// Match by data attribute
		const target = container.querySelector('.ps-preset-card[data-preset="' + activeProfile + '"]');
		if (target) {
			target.classList.add('ps-consent-preset-active');
			const name = target.querySelector('.ps-preset-name');
			if (name) {
				const badge = document.createElement('span');
				badge.className = 'ps-consent-current-badge';
				badge.textContent = ' (default)';
				name.appendChild(badge);
			}
		}
	}
}

function renderPresets(presets, purposes) {
	const container = document.getElementById('preset-list');
	const section = document.getElementById('presets-section');
	if (!container || !section) return;

	// Read current default profile to highlight active card
	chrome.storage.local.get(['defaultProfile', 'defaultPurposes'], (result) => {
		const activeProfile = result.defaultProfile || 'balanced';

		for (const [presetKey, preset] of Object.entries(presets)) {
			const card = document.createElement('div');
			card.className = 'ps-preset-card';
			card.dataset.preset = presetKey;
			if (presetKey === activeProfile) card.classList.add('ps-consent-preset-active');

			const name = document.createElement('div');
			name.className = 'ps-preset-name';
			name.textContent = preset.label;
			if (presetKey === activeProfile) {
				const badge = document.createElement('span');
				badge.className = 'ps-consent-current-badge';
				badge.textContent = ' (default)';
				name.appendChild(badge);
			}
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

		// Custom preset card (updated live by initDefaultProfile)
		const customCard = document.createElement('div');
		customCard.className = 'ps-preset-card';
		customCard.id = 'custom-preset-card';
		if (activeProfile === 'custom') customCard.classList.add('ps-consent-preset-active');

		const customName = document.createElement('div');
		customName.className = 'ps-preset-name';
		customName.textContent = 'Custom';
		if (activeProfile === 'custom') {
			const badge = document.createElement('span');
			badge.className = 'ps-consent-current-badge';
			badge.textContent = ' (default)';
			customName.appendChild(badge);
		}
		customCard.appendChild(customName);

		const customPills = document.createElement('div');
		customPills.className = 'ps-preset-purposes';
		customPills.id = 'custom-preset-pills';

		// Populate pills from stored custom purposes, or derive from active preset
		const storedPurposes = result.defaultPurposes;
		const sortedKeys = Object.keys(purposes)
			.sort((a, b) => (purposes[a].order || 0) - (purposes[b].order || 0));
		for (const key of sortedKeys) {
			let allowed;
			if (storedPurposes) {
				allowed = purposes[key].required ? true : (storedPurposes[key] !== false);
			} else {
				// No custom profile saved yet - show what the active preset allows
				const presetDef = presets[activeProfile];
				allowed = presetDef ? (presetDef.purposes[key] !== false) : true;
			}
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = (purposes[key] ? purposes[key].short : key) + (allowed ? ' \u2713' : ' \u2717');
			customPills.appendChild(pill);
		}

		customCard.appendChild(customPills);
		container.appendChild(customCard);

		// GPC signal toggle row
		const gpcCard = document.createElement('div');
		gpcCard.className = 'ps-preset-card';

		const gpcRow = document.createElement('div');
		gpcRow.className = 'ps-gpc-toggle-row';

		const gpcLeft = document.createElement('div');
		const gpcName = document.createElement('span');
		gpcName.className = 'ps-gpc-info-name';
		gpcName.textContent = 'GPC (Global Privacy Control)';
		const gpcDesc = document.createElement('div');
		gpcDesc.className = 'ps-gpc-info-desc';
		gpcDesc.textContent = 'Privacy signal sent to websites when any of these purposes are denied';
		gpcLeft.appendChild(gpcName);
		gpcLeft.appendChild(gpcDesc);

		const gpcToggle = document.createElement('input');
		gpcToggle.type = 'checkbox';
		gpcToggle.id = 'gpc-toggle';
		gpcToggle.className = 'ps-gpc-toggle';
		gpcToggle.checked = true;

		const gpcToggleLabel = document.createElement('label');
		gpcToggleLabel.className = 'ps-gpc-toggle-label';
		gpcToggleLabel.setAttribute('for', 'gpc-toggle');
		gpcToggleLabel.textContent = 'Enabled';

		gpcRow.appendChild(gpcLeft);
		gpcRow.appendChild(gpcToggleLabel);
		gpcRow.appendChild(gpcToggle);
		gpcCard.appendChild(gpcRow);

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

		// Load stored GPC toggle state
		chrome.storage.local.get(['gpcEnabled'], (r) => {
			gpcToggle.checked = r.gpcEnabled !== false;
			gpcToggleLabel.textContent = gpcToggle.checked ? 'Enabled' : 'Disabled';
		});

		gpcToggle.addEventListener('change', () => {
			const enabled = gpcToggle.checked;
			gpcToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
			chrome.storage.local.set({ gpcEnabled: enabled }, notifyBackground);
		});

		// Client Hints stripping toggle row
		const chCard = document.createElement('div');
		chCard.className = 'ps-preset-card';

		const chRow = document.createElement('div');
		chRow.className = 'ps-gpc-toggle-row';

		const chLeft = document.createElement('div');
		const chName = document.createElement('span');
		chName.className = 'ps-gpc-info-name';
		chName.textContent = 'Client Hints Stripping';
		const chDesc = document.createElement('div');
		chDesc.className = 'ps-gpc-info-desc';
		chDesc.textContent = 'Removes high-entropy fingerprinting headers when advanced tracking is denied';
		chLeft.appendChild(chName);
		chLeft.appendChild(chDesc);

		const chToggle = document.createElement('input');
		chToggle.type = 'checkbox';
		chToggle.id = 'ch-toggle';
		chToggle.className = 'ps-gpc-toggle';
		chToggle.checked = true;

		const chToggleLabel = document.createElement('label');
		chToggleLabel.className = 'ps-gpc-toggle-label';
		chToggleLabel.setAttribute('for', 'ch-toggle');
		chToggleLabel.textContent = 'Enabled';

		chRow.appendChild(chLeft);
		chRow.appendChild(chToggleLabel);
		chRow.appendChild(chToggle);
		chCard.appendChild(chRow);

		const chPills = document.createElement('div');
		chPills.className = 'ps-preset-purposes';
		const chHeaders = [
			'Full-Version-List', 'Platform-Version', 'Arch',
			'Bitness', 'Model', 'WoW64', 'Form-Factors'
		];
		for (const h of chHeaders) {
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill gpc';
			pill.textContent = 'Sec-CH-UA-' + h;
			chPills.appendChild(pill);
		}
		chCard.appendChild(chPills);
		container.appendChild(chCard);

		// Load stored CH toggle state
		chrome.storage.local.get(['chStrippingEnabled'], (r) => {
			chToggle.checked = r.chStrippingEnabled !== false;
			chToggleLabel.textContent = chToggle.checked ? 'Enabled' : 'Disabled';
		});

		chToggle.addEventListener('change', () => {
			const enabled = chToggle.checked;
			chToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
			chrome.storage.local.set({ chStrippingEnabled: enabled }, notifyBackground);
		});
	});
}

function renderEnhancedPresets() {
	const container = document.getElementById('enhanced-preset-list');
	const section = document.getElementById('enhanced-presets-section');
	if (!container || !section) return;

	Promise.all([
		fetch(chrome.runtime.getURL('config/enhanced-lists.json')).then(r => {
			if (!r.ok) throw new Error("enhanced-lists.json: HTTP " + r.status);
			return r.json();
		}),
		new Promise(resolve => {
			chrome.storage.local.get(['enhancedPreset'], r => resolve(r.enhancedPreset || 'off'));
		}),
		new Promise(resolve => {
			chrome.storage.local.get(['enhancedLists'], r => resolve(r.enhancedLists || {}));
		}),
	]).then(([catalog, currentPreset, enhancedLists]) => {
		const presets = [
			{ id: 'off', label: 'Off', desc: 'Only ProtoConsent core lists (default)' },
			{ id: 'basic', label: 'Basic', desc: 'Conservative third-party lists' },
			{ id: 'full', label: 'Full', desc: 'All available third-party lists' },
		];

		for (const preset of presets) {
			const card = document.createElement('div');
			card.className = 'ps-preset-card';
			if (currentPreset === preset.id) card.classList.add('ps-preset-active');

			const name = document.createElement('div');
			name.className = 'ps-preset-name';
			name.textContent = preset.label;
			if (currentPreset === preset.id) {
				const badge = document.createElement('span');
				badge.className = 'ps-enhanced-current-badge';
				badge.textContent = ' (current)';
				name.appendChild(badge);
			}
			card.appendChild(name);

			const desc = document.createElement('p');
			desc.className = 'ps-purpose-desc';
			desc.textContent = preset.desc;
			card.appendChild(desc);

			// Show which lists are included in this preset
			const pills = document.createElement('div');
			pills.className = 'ps-preset-purposes';
			for (const [listId, listDef] of Object.entries(catalog)) {
				const included = preset.id === 'full' ||
					(preset.id === 'basic' && listDef.preset === 'basic');
				if (preset.id === 'off') continue;
				const pill = document.createElement('span');
				pill.className = 'ps-preset-pill ' + (included ? 'allowed' : 'denied');
				pill.textContent = listDef.name + (included ? ' \u2713' : ' \u2717');
				pills.appendChild(pill);
			}
			if (preset.id !== 'off') card.appendChild(pills);
			container.appendChild(card);
		}

		// Custom indicator
		if (currentPreset === 'custom') {
			const customCard = document.createElement('div');
			customCard.className = 'ps-preset-card ps-preset-active';
			const customName = document.createElement('div');
			customName.className = 'ps-preset-name';
			customName.textContent = 'Custom';
			const badge = document.createElement('span');
			badge.className = 'ps-enhanced-current-badge';
			badge.textContent = ' (current)';
			customName.appendChild(badge);
			customCard.appendChild(customName);
			const customDesc = document.createElement('p');
			customDesc.className = 'ps-purpose-desc';
			customDesc.textContent = 'Individual lists toggled from the Enhanced tab in the popup.';
			customCard.appendChild(customDesc);

			// Pills showing per-list enabled/disabled state
			const pills = document.createElement('div');
			pills.className = 'ps-preset-purposes';
			for (const [listId, listDef] of Object.entries(catalog)) {
				const listData = enhancedLists[listId];
				if (!listData) continue;
				const enabled = !!listData.enabled;
				const pill = document.createElement('span');
				pill.className = 'ps-preset-pill ' + (enabled ? 'allowed' : 'denied');
				pill.textContent = listDef.name + (enabled ? ' \u2713' : ' \u2717');
				pills.appendChild(pill);
			}
			customCard.appendChild(pills);
			container.appendChild(customCard);
		}

		section.classList.remove('ps-hidden');
	}).catch(err => {
		console.warn('ProtoConsent: failed to load enhanced presets:', err);
	});
}

function notifyBackground() {
	chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
		void chrome.runtime.lastError; // suppress warning if background is inactive
	});
}

document.addEventListener('DOMContentLoaded', init);
