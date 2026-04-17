// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const TAB_NAMES = ['consent', 'protection', 'advanced'];
const SECTION_TAB_MAP = {
	'default-profile-section': 'consent',
	'presets-section': 'consent',
	'privacy-signals-section': 'consent',
	'mode-section': 'consent',
	'enhanced-section': 'protection',
	'cmp-section': 'protection',
	'regional-filters': 'protection',
	'inter-ext-section': 'advanced',
	'data-section': 'advanced',
};

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
		renderDynamicListsToggle(purposes);
		initModeSection();
		initCmpSection();
		initRegionalSection();
		initInterExt();
		initTabs();

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
			const label = purposes[key] ? purposes[key].short : key;
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = label + (allowed ? ' \u2713' : ' \u2717');
			pill.setAttribute('aria-label', label + ': ' + (allowed ? 'allowed' : 'denied'));
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
	if (!container) return;

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
				const label = purposes[pKey] ? purposes[pKey].short : pKey;
				const pill = document.createElement('span');
				pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
				pill.textContent = label + (allowed ? ' \u2713' : ' \u2717');
				pill.setAttribute('aria-label', label + ': ' + (allowed ? 'allowed' : 'denied'));
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
			const label = purposes[key] ? purposes[key].short : key;
			const pill = document.createElement('span');
			pill.className = 'ps-preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = label + (allowed ? ' \u2713' : ' \u2717');
			pill.setAttribute('aria-label', label + ': ' + (allowed ? 'allowed' : 'denied'));
			customPills.appendChild(pill);
		}

		customCard.appendChild(customPills);
		container.appendChild(customCard);

		// GPC and CH rendered in Privacy Signals section
		renderPrivacySignals(purposes);
	});
}

function renderPrivacySignals(purposes) {
	const container = document.getElementById('privacy-signals-list');
	const section = document.getElementById('privacy-signals-section');
	if (!container || !section) return;

	// GPC signal toggle
	const gpcCard = document.createElement('div');
	gpcCard.className = 'ps-signal-card';

	const gpcRow = document.createElement('div');
	gpcRow.className = 'ps-gpc-toggle-row';

	const gpcLeft = document.createElement('div');
	const gpcName = document.createElement('span');
	gpcName.className = 'ps-gpc-info-name';
	gpcName.textContent = 'GPC (Global Privacy Control)';
	gpcName.id = 'gpc-name';
	const gpcDesc = document.createElement('div');
	gpcDesc.className = 'ps-gpc-info-desc';
	gpcDesc.textContent = 'Privacy signal (Sec-GPC) sent to websites when any of these purposes are denied. Legally recognised as an opt-out under California CCPA/CPRA.';
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

	gpcToggle.setAttribute('aria-describedby', 'gpc-name');
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

	chrome.storage.local.get(['gpcEnabled'], (r) => {
		gpcToggle.checked = r.gpcEnabled !== false;
		gpcToggleLabel.textContent = gpcToggle.checked ? 'Enabled' : 'Disabled';
	});

	gpcToggle.addEventListener('change', () => {
		const enabled = gpcToggle.checked;
		gpcToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ gpcEnabled: enabled }, notifyBackground);
	});

	// Client Hints stripping toggle
	const chCard = document.createElement('div');
	chCard.className = 'ps-signal-card';

	const chRow = document.createElement('div');
	chRow.className = 'ps-gpc-toggle-row';

	const chLeft = document.createElement('div');
	const chName = document.createElement('span');
	chName.className = 'ps-gpc-info-name';
	chName.textContent = 'Client Hints Stripping';
	chName.id = 'ch-name';
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

	chToggle.setAttribute('aria-describedby', 'ch-name');
	chRow.appendChild(chLeft);
	chRow.appendChild(chToggleLabel);
	chRow.appendChild(chToggle);
	chCard.appendChild(chRow);

	const chPills = document.createElement('div');
	chPills.className = 'ps-preset-purposes';
	for (const label of HIGH_ENTROPY_CH_LABELS) {
		const pill = document.createElement('span');
		pill.className = 'ps-preset-pill gpc';
		pill.textContent = label;
		chPills.appendChild(pill);
	}
	chCard.appendChild(chPills);
	container.appendChild(chCard);

	getChStrippingEnabled((enabled) => {
		chToggle.checked = enabled;
		chToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
	});

	chToggle.addEventListener('change', () => {
		const enabled = chToggle.checked;
		chToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ chStrippingEnabled: enabled }, notifyBackground);
	});

	// URL tracking parameter stripping toggle
	const paramCard = document.createElement('div');
	paramCard.className = 'ps-signal-card';

	const paramRow = document.createElement('div');
	paramRow.className = 'ps-gpc-toggle-row';

	const paramLeft = document.createElement('div');
	const paramName = document.createElement('span');
	paramName.className = 'ps-gpc-info-name';
	paramName.textContent = 'URL Parameter Stripping';
	paramName.id = 'param-strip-name';
	const paramDesc = document.createElement('div');
	paramDesc.className = 'ps-gpc-info-desc';
	paramDesc.textContent = 'Removes tracking parameters (utm_source, fbclid, gclid, msclkid...) from URLs during navigation';
	paramLeft.appendChild(paramName);
	paramLeft.appendChild(paramDesc);

	const paramToggle = document.createElement('input');
	paramToggle.type = 'checkbox';
	paramToggle.id = 'param-strip-toggle';
	paramToggle.className = 'ps-gpc-toggle';
	paramToggle.checked = true;

	const paramToggleLabel = document.createElement('label');
	paramToggleLabel.className = 'ps-gpc-toggle-label';
	paramToggleLabel.setAttribute('for', 'param-strip-toggle');
	paramToggleLabel.textContent = 'Enabled';

	paramToggle.setAttribute('aria-describedby', 'param-strip-name');
	paramRow.appendChild(paramLeft);
	paramRow.appendChild(paramToggleLabel);
	paramRow.appendChild(paramToggle);
	paramCard.appendChild(paramRow);

	const paramPills = document.createElement('div');
	paramPills.className = 'ps-preset-purposes';
	for (const label of ['utm_*', 'fbclid', 'gclid', 'msclkid', '304 params']) {
		const pill = document.createElement('span');
		pill.className = 'ps-preset-pill gpc';
		pill.textContent = label;
		paramPills.appendChild(pill);
	}
	paramCard.appendChild(paramPills);

	paramToggle.addEventListener('change', () => {
		const enabled = paramToggle.checked;
		paramToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
		paramSitesToggle.disabled = !enabled;
		paramSitesToggleLabel.textContent = (!enabled || !paramSitesToggle.checked) ? 'Disabled' : 'Enabled';
		chrome.storage.local.set({ paramStrippingEnabled: enabled }, notifyBackground);
	});

	// Per-site parameter stripping sub-toggle
	const paramSitesRow = document.createElement('div');
	paramSitesRow.className = 'ps-gpc-toggle-row';
	paramSitesRow.style.marginTop = '12px';

	const paramSitesLeft = document.createElement('div');
	const paramSitesName = document.createElement('span');
	paramSitesName.className = 'ps-gpc-info-name';
	paramSitesName.textContent = 'Per-site parameters';
	paramSitesName.id = 'param-strip-sites-name';
	const paramSitesDesc = document.createElement('div');
	paramSitesDesc.className = 'ps-gpc-info-desc';
	paramSitesDesc.textContent = 'Additional site-specific parameters for 879 domains (Amazon, Google, Facebook...)';
	paramSitesLeft.appendChild(paramSitesName);
	paramSitesLeft.appendChild(paramSitesDesc);

	const paramSitesToggle = document.createElement('input');
	paramSitesToggle.type = 'checkbox';
	paramSitesToggle.id = 'param-strip-sites-toggle';
	paramSitesToggle.className = 'ps-gpc-toggle';
	paramSitesToggle.checked = true;

	const paramSitesToggleLabel = document.createElement('label');
	paramSitesToggleLabel.className = 'ps-gpc-toggle-label';
	paramSitesToggleLabel.setAttribute('for', 'param-strip-sites-toggle');
	paramSitesToggleLabel.textContent = 'Enabled';

	paramSitesToggle.setAttribute('aria-describedby', 'param-strip-sites-name');
	paramSitesRow.appendChild(paramSitesLeft);
	paramSitesRow.appendChild(paramSitesToggleLabel);
	paramSitesRow.appendChild(paramSitesToggle);
	paramCard.appendChild(paramSitesRow);

	chrome.storage.local.get(['paramStrippingEnabled', 'paramStrippingSitesEnabled'], (r) => {
		const masterOn = r.paramStrippingEnabled !== false;
		paramToggle.checked = masterOn;
		paramToggleLabel.textContent = masterOn ? 'Enabled' : 'Disabled';
		paramSitesToggle.disabled = !masterOn;
		paramSitesToggle.checked = r.paramStrippingSitesEnabled !== false;
		paramSitesToggleLabel.textContent = (masterOn && paramSitesToggle.checked) ? 'Enabled' : 'Disabled';
	});

	paramSitesToggle.addEventListener('change', () => {
		const enabled = paramSitesToggle.checked;
		paramSitesToggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ paramStrippingSitesEnabled: enabled }, notifyBackground);
	});

	container.appendChild(paramCard);

	section.classList.remove('ps-hidden');
}

function renderEnhancedPresets() {
	const container = document.getElementById('enhanced-preset-list');
	const section = document.getElementById('enhanced-section');
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
		new Promise(resolve => {
			chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, (resp) => {
				if (chrome.runtime.lastError || !resp) resolve([]);
				else resolve(resp.consentLinkedListIds || []);
			});
		}),
	]).then(([catalog, currentPreset, enhancedLists, consentLinkedListIds]) => {
		const celIds = new Set(consentLinkedListIds);
		const presets = [
			{ id: 'off', label: 'Off', desc: 'Only ProtoConsent core lists (default)' },
			{ id: 'basic', label: 'Balanced', desc: 'Conservative third-party lists' },
			{ id: 'full', label: 'Full', desc: 'All available third-party lists' },
		];

		for (const preset of presets) {
			const card = document.createElement('div');
			card.className = 'ps-preset-card';
			if (currentPreset === preset.id) card.classList.add('ps-preset-active');

			const name = document.createElement('div');
			name.className = 'ps-preset-name';
			const shieldCount = preset.id === 'full' ? 3 : preset.id === 'basic' ? 2 : 0;
			for (let i = 0; i < shieldCount; i++) {
				const img = document.createElement('img');
				img.src = ENHANCED_ICON;
				img.alt = '';
				img.width = 14;
				img.height = 14;
				img.className = 'ps-preset-shield';
				name.appendChild(img);
			}
			name.appendChild(document.createTextNode(preset.label));
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
			let coreRendered = false;
			let cmpRendered = false;
			for (const [listId, listDef] of Object.entries(catalog)) {
				if (CMP_IDS.has(listId)) {
					if (cmpRendered) continue;
					cmpRendered = true;
					const included = preset.id === 'full' ||
						(preset.id === 'basic' && listDef.preset === 'basic');
					const pill = document.createElement('span');
					pill.className = 'ps-preset-pill ' + (included ? 'allowed' : 'denied');
					pill.textContent = 'ProtoConsent Banners' + (included ? ' \u2713' : ' \u2717');
					pill.setAttribute('aria-label', 'ProtoConsent Banners: ' + (included ? 'included' : 'not included'));
					pills.appendChild(pill);
					continue;
				}
				if (CORE_IDS.has(listId)) {
					if (coreRendered) continue;
					coreRendered = true;
					const included = preset.id === 'full' ||
						(preset.id === 'basic' && listDef.preset === 'basic');
					const pill = document.createElement('span');
					pill.className = 'ps-preset-pill ' + (included ? 'allowed' : 'denied');
					pill.textContent = 'ProtoConsent Core' + (included ? ' \u2713' : ' \u2717');
					pill.setAttribute('aria-label', 'ProtoConsent Core: ' + (included ? 'included' : 'not included'));
					pills.appendChild(pill);
					continue;
				}
				const included = preset.id === 'full' ||
					(preset.id === 'basic' && listDef.preset === 'basic');
				const pill = document.createElement('span');
				pill.className = 'ps-preset-pill ' + (included ? 'allowed' : 'denied');
				pill.textContent = listDef.name + (included ? ' \u2713' : ' \u2717');
				pill.setAttribute('aria-label', listDef.name + ': ' + (included ? 'included' : 'not included'));
				pills.appendChild(pill);
			}
			card.appendChild(pills);
			container.appendChild(card);
		}

		// Custom card (always visible)
		const customCard = document.createElement('div');
		customCard.className = 'ps-preset-card';
		if (currentPreset === 'custom') customCard.classList.add('ps-preset-active');
		const customName = document.createElement('div');
		customName.className = 'ps-preset-name';
		const pencil = document.createElement('span');
		pencil.className = 'ps-preset-custom-icon';
		pencil.textContent = '\u270E';
		pencil.setAttribute('aria-hidden', 'true');
		customName.appendChild(pencil);
		customName.appendChild(document.createTextNode('Custom'));
		if (currentPreset === 'custom') {
			const badge = document.createElement('span');
			badge.className = 'ps-enhanced-current-badge';
			badge.textContent = ' (current)';
			customName.appendChild(badge);
		}
		customCard.appendChild(customName);
		const customDesc = document.createElement('p');
		customDesc.className = 'ps-purpose-desc';
		customDesc.textContent = 'Individual lists toggled from the Protection tab in the popup.';
		customCard.appendChild(customDesc);

		// Pills showing per-list enabled/disabled state (only if any downloaded)
		const hasDownloaded = Object.keys(enhancedLists).length > 0;
		if (hasDownloaded) {
			const pills = document.createElement('div');
			pills.className = 'ps-preset-purposes';
			let coreRendered = false;
			let cmpRendered = false;
			for (const [listId, listDef] of Object.entries(catalog)) {
				if (CMP_IDS.has(listId)) {
					if (cmpRendered) continue;
					cmpRendered = true;
					const cmpIdList = Object.keys(catalog).filter(id => CMP_IDS.has(id));
					const cmpData = cmpIdList.map(id => enhancedLists[id]).filter(Boolean);
					if (cmpData.length === 0) continue;
					const allEnabled = cmpData.every(d => !!d.enabled);
					const pill = document.createElement('span');
					pill.className = 'ps-preset-pill ' + (allEnabled ? 'allowed' : 'denied');
					pill.textContent = 'ProtoConsent Banners' + (allEnabled ? ' \u2713' : ' \u2717');
					pill.setAttribute('aria-label', 'ProtoConsent Banners: ' + (allEnabled ? 'enabled' : 'disabled'));
					pills.appendChild(pill);
					continue;
				}
				if (CORE_IDS.has(listId)) {
					if (coreRendered) continue;
					coreRendered = true;
					const coreIds = Object.keys(catalog).filter(id => CORE_IDS.has(id));
					const coreData = coreIds.map(id => enhancedLists[id]).filter(Boolean);
					if (coreData.length === 0) continue;
					const allEnabled = coreData.every(d => !!d.enabled) || coreIds.some(id => celIds.has(id));
					const pill = document.createElement('span');
					pill.className = 'ps-preset-pill ' + (allEnabled ? 'allowed' : 'denied');
					pill.textContent = 'ProtoConsent Core' + (allEnabled ? ' \u2713' : ' \u2717');
					pill.setAttribute('aria-label', 'ProtoConsent Core: ' + (allEnabled ? 'enabled' : 'disabled'));
					pills.appendChild(pill);
					continue;
				}
				const listData = enhancedLists[listId];
				if (!listData) continue;
				const enabled = !!listData.enabled || celIds.has(listId);
				const pill = document.createElement('span');
				pill.className = 'ps-preset-pill ' + (enabled ? 'allowed' : 'denied');
				pill.textContent = listDef.name + (enabled ? ' \u2713' : ' \u2717');
				pill.setAttribute('aria-label', listDef.name + ': ' + (enabled ? 'enabled' : 'disabled'));
				pills.appendChild(pill);
			}
			customCard.appendChild(pills);
		}
		container.appendChild(customCard);

		section.classList.remove('ps-hidden');
	}).catch(err => {
		console.warn('ProtoConsent: failed to load enhanced presets:', err);
	});
}

function initModeSection() {
	const section = document.getElementById('mode-section');
	const container = section?.querySelector('.ps-mode-cards');
	if (!section || !container) return;
	const cards = container.querySelectorAll('.ps-mode-card');

	function selectCard(mode) {
		cards.forEach(c => {
			const active = c.dataset.mode === mode;
			c.classList.toggle('is-selected', active);
			c.setAttribute('aria-checked', active ? 'true' : 'false');
			c.setAttribute('tabindex', active ? '0' : '-1');
		});
	}

	chrome.storage.local.get(['operatingMode'], (data) => {
		selectCard(data.operatingMode === 'protoconsent' ? 'protoconsent' : 'standalone');
		section.classList.remove('ps-hidden');
	});

	function applyMode(mode) {
		selectCard(mode);
		chrome.runtime.sendMessage(
			{ type: 'PROTOCONSENT_SET_OPERATING_MODE', mode },
			(resp) => {
				void chrome.runtime.lastError;
				if (resp && !resp.ok) {
					selectCard(mode === 'protoconsent' ? 'standalone' : 'protoconsent');
				}
			}
		);
	}

	cards.forEach(card => {
		card.addEventListener('click', () => {
			if (!card.classList.contains('is-selected')) applyMode(card.dataset.mode);
		});
	});

	container.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			const focused = document.activeElement;
			if (focused?.classList.contains('ps-mode-card') && !focused.classList.contains('is-selected')) {
				applyMode(focused.dataset.mode);
			}
		}
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const arr = Array.from(cards);
			const idx = arr.indexOf(document.activeElement);
			if (idx === -1) return;
			const next = arr[(idx + 1) % arr.length];
			next.focus();
		}
	});
}

function initCmpSection() {
	const section = document.getElementById('cmp-section');
	const toggle = document.getElementById('cmp-auto-toggle');
	const toggleLabel = document.getElementById('cmp-auto-label');
	const detail = document.getElementById('cmp-detail');
	const listEl = document.getElementById('cmp-list');
	const uuidInput = document.getElementById('cmp-uuid-input');
	const maxageInput = document.getElementById('cmp-maxage-input');
	let cmpQueue = Promise.resolve();
	if (!section || !toggle || !detail || !listEl) return;

	chrome.storage.local.get(['_cmpSignatures'], (stored) => {
		const sigsPromise = stored._cmpSignatures
			? Promise.resolve(stored._cmpSignatures)
			: fetch(chrome.runtime.getURL('rules/protoconsent_cmp_signatures.json'))
				.then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
				.then(wrapper => wrapper.signatures || wrapper);
		sigsPromise.then(sigs => {
			const cmpIds = Object.keys(sigs);

			chrome.storage.local.get(['cmpAutoResponse', 'cmpEnabled', 'cmpCustomUuid', 'cmpCookieMaxAge'], (data) => {
				const masterOn = data.cmpAutoResponse !== false;
				const enabled = data.cmpEnabled || {};

				toggle.checked = masterOn;
				toggleLabel.textContent = masterOn ? 'Enabled' : 'Disabled';
				if (!masterOn) detail.classList.add('ps-hidden');

				// Per-CMP checkboxes
				for (const id of cmpIds) {
					const row = document.createElement('div');
					row.className = 'ps-cmp-toggle-row';

					const label = document.createElement('label');
					label.setAttribute('for', 'cmp-' + id);
					label.textContent = id.replace(/_/g, ' ');

					const cb = document.createElement('input');
					cb.type = 'checkbox';
					cb.id = 'cmp-' + id;
					cb.checked = enabled[id] !== false;
					cb.addEventListener('change', () => {
						cmpQueue = cmpQueue.then(() => new Promise(resolve => {
							chrome.storage.local.get(['cmpEnabled'], (r) => {
								const cur = r.cmpEnabled || {};
								cur[id] = cb.checked;
								chrome.storage.local.set({ cmpEnabled: cur }, resolve);
							});
						}));
					});

					row.appendChild(label);
					row.appendChild(cb);
					listEl.appendChild(row);
				}

				// UUID input
				if (uuidInput) {
					const uuidError = document.getElementById('cmp-uuid-error');
					const uuidSaved = document.getElementById('cmp-uuid-saved');
					const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
					uuidInput.value = data.cmpCustomUuid || '';
					if (data.cmpCustomUuid) { uuidInput.classList.add('ps-cmp-input-saved'); }

					const validateUuid = () => {
						const val = uuidInput.value.trim();
						if (!val) {
							uuidInput.classList.remove('ps-cmp-input-error', 'ps-cmp-input-saved');
							if (uuidError) uuidError.classList.add('ps-hidden');
							if (uuidSaved) uuidSaved.classList.add('ps-hidden');
							return true;
						}
						if (!UUID_RE.test(val)) {
							if (uuidError) { uuidError.textContent = 'Invalid UUID v4 format'; uuidError.classList.remove('ps-hidden'); }
							uuidInput.classList.add('ps-cmp-input-error');
							uuidInput.classList.remove('ps-cmp-input-saved');
							if (uuidSaved) uuidSaved.classList.add('ps-hidden');
							return false;
						}
						uuidInput.classList.remove('ps-cmp-input-error');
						if (uuidError) uuidError.classList.add('ps-hidden');
						return true;
					};

					uuidInput.addEventListener('input', validateUuid);
					uuidInput.addEventListener('change', () => {
						if (!validateUuid()) return;
						const val = uuidInput.value.trim();
						chrome.storage.local.set({ cmpCustomUuid: val });
						if (val) {
							uuidInput.classList.add('ps-cmp-input-saved');
							if (uuidSaved) { uuidSaved.classList.remove('ps-hidden'); setTimeout(() => uuidSaved.classList.add('ps-hidden'), 2000); }
						} else {
							uuidInput.classList.remove('ps-cmp-input-saved');
						}
					});
				}

				// Max-age input (days -> seconds)
				if (maxageInput) {
					const maxageError = document.getElementById('cmp-maxage-error');
					const maxageSaved = document.getElementById('cmp-maxage-saved');
					const storedDays = data.cmpCookieMaxAge ? Math.round(data.cmpCookieMaxAge / 86400) : '';
					maxageInput.value = storedDays;
					if (storedDays) { maxageInput.classList.add('ps-cmp-input-saved'); }

					const validateMaxage = () => {
						const raw = maxageInput.value.trim();
						if (!raw) {
							maxageInput.classList.remove('ps-cmp-input-error', 'ps-cmp-input-saved');
							if (maxageError) maxageError.classList.add('ps-hidden');
							if (maxageSaved) maxageSaved.classList.add('ps-hidden');
							return true;
						}
						const days = parseInt(raw, 10);
						if (isNaN(days) || days < 1 || days > 365) {
							if (maxageError) { maxageError.textContent = 'Must be 1\u2013365'; maxageError.classList.remove('ps-hidden'); }
							maxageInput.classList.add('ps-cmp-input-error');
							maxageInput.classList.remove('ps-cmp-input-saved');
							if (maxageSaved) maxageSaved.classList.add('ps-hidden');
							return false;
						}
						maxageInput.classList.remove('ps-cmp-input-error');
						if (maxageError) maxageError.classList.add('ps-hidden');
						return true;
					};

					maxageInput.addEventListener('input', validateMaxage);
					maxageInput.addEventListener('change', () => {
						if (!validateMaxage()) return;
						const raw = maxageInput.value.trim();
						if (!raw) {
							chrome.storage.local.remove('cmpCookieMaxAge');
							maxageInput.classList.remove('ps-cmp-input-saved');
							return;
						}
						const days = parseInt(raw, 10);
						chrome.storage.local.set({ cmpCookieMaxAge: days * 86400 });
						maxageInput.classList.add('ps-cmp-input-saved');
						if (maxageSaved) { maxageSaved.classList.remove('ps-hidden'); setTimeout(() => maxageSaved.classList.add('ps-hidden'), 2000); }
					});
				}

				section.classList.remove('ps-hidden');
			});
		})
		.catch(err => {
			console.warn('ProtoConsent: failed to load CMP signatures:', err);
		});
	});

	toggle.addEventListener('change', () => {
		const on = toggle.checked;
		toggleLabel.textContent = on ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ cmpAutoResponse: on });
		if (on) detail.classList.remove('ps-hidden');
		else detail.classList.add('ps-hidden');
	});

	// CMP Detection toggle
	const detectToggle = document.getElementById('cmp-detect-toggle');
	const detectLabel = document.getElementById('cmp-detect-label');
	if (detectToggle && detectLabel) {
		chrome.storage.local.get(['cmpDetectionEnabled'], (data) => {
			const on = data.cmpDetectionEnabled !== false;
			detectToggle.checked = on;
			detectLabel.textContent = on ? 'Enabled' : 'Disabled';
		});
		detectToggle.addEventListener('change', () => {
			const on = detectToggle.checked;
			detectLabel.textContent = on ? 'Enabled' : 'Disabled';
			chrome.storage.local.set({ cmpDetectionEnabled: on });
		});
	}
}

function notifyBackground(cb) {
	chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
		void chrome.runtime.lastError;
		if (cb) cb();
	});
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('DOMContentLoaded', initThemeSection);

// --- Theme ---

function initThemeSection() {
	const sel = document.getElementById('theme-select');
	if (!sel) return;
	chrome.storage.local.get('theme', (data) => {
		sel.value = data.theme || 'auto';
	});
	sel.addEventListener('change', () => {
		chrome.storage.local.set({ theme: sel.value });
	});
	chrome.storage.onChanged.addListener((changes) => {
		if (changes.theme) sel.value = changes.theme.newValue || 'auto';
	});
}

// --- Export / Import ---

const EXPORT_KEYS = [
	"defaultProfile", "defaultPurposes", "rules", "whitelist",
	"gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled", "operatingMode",
	"enhancedPreset", "enhancedLists",
	"interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending",
	"dynamicListsConsent", "consentEnhancedLink",
	"celMode", "celCustomPurposes",
	"cmpAutoResponse", "cmpEnabled", "cmpCookieMaxAge", "cmpCustomUuid",
	"cmpDetectionEnabled",
	"theme"
];

const VALID_PROFILES = ["strict", "balanced", "permissive", "custom"];
const VALID_ENHANCED_PRESETS = ["off", "basic", "full", "custom"];

const IMPORT_MAX_BYTES = 512 * 1024; // 512 KB

const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

// Strip dangerous keys from an object (shallow)
function sanitizeObjectKeys(obj) {
	const clean = {};
	for (const key of Object.keys(obj)) {
		if (DANGEROUS_KEYS.includes(key)) continue;
		clean[key] = obj[key];
	}
	return clean;
}

function validateImport(data) {
	const clean = {};
	const errors = [];

	if ("defaultProfile" in data) {
		if (VALID_PROFILES.includes(data.defaultProfile)) clean.defaultProfile = data.defaultProfile;
		else errors.push("defaultProfile: invalid value");
	}
	if ("defaultPurposes" in data) {
		const dp = data.defaultPurposes;
		if (typeof dp === "object" && dp !== null && !Array.isArray(dp) &&
			Object.values(dp).every(v => typeof v === "boolean")) {
			clean.defaultPurposes = sanitizeObjectKeys(dp);
		} else errors.push("defaultPurposes: must be {key: boolean}");
	}
	if ("rules" in data) {
		const r = data.rules;
		if (typeof r === "object" && r !== null && !Array.isArray(r)) {
			clean.rules = sanitizeObjectKeys(r);
		} else errors.push("rules: must be an object");
	}
	if ("whitelist" in data) {
		const w = data.whitelist;
		if (typeof w === "object" && w !== null && !Array.isArray(w)) {
			clean.whitelist = sanitizeObjectKeys(w);
		} else errors.push("whitelist: must be an object");
	}
	if ("gpcEnabled" in data) {
		if (typeof data.gpcEnabled === "boolean") clean.gpcEnabled = data.gpcEnabled;
		else errors.push("gpcEnabled: must be boolean");
	}
	if ("chStrippingEnabled" in data) {
		if (typeof data.chStrippingEnabled === "boolean") clean.chStrippingEnabled = data.chStrippingEnabled;
		else errors.push("chStrippingEnabled: must be boolean");
	}
	if ("paramStrippingEnabled" in data) {
		if (typeof data.paramStrippingEnabled === "boolean") clean.paramStrippingEnabled = data.paramStrippingEnabled;
		else errors.push("paramStrippingEnabled: must be boolean");
	}
	if ("paramStrippingSitesEnabled" in data) {
		if (typeof data.paramStrippingSitesEnabled === "boolean") clean.paramStrippingSitesEnabled = data.paramStrippingSitesEnabled;
		else errors.push("paramStrippingSitesEnabled: must be boolean");
	}
	if ("operatingMode" in data) {
		if (data.operatingMode === "standalone" || data.operatingMode === "protoconsent") clean.operatingMode = data.operatingMode;
		else errors.push("operatingMode: must be 'standalone' or 'protoconsent'");
	}
	if ("enhancedPreset" in data) {
		if (VALID_ENHANCED_PRESETS.includes(data.enhancedPreset)) clean.enhancedPreset = data.enhancedPreset;
		else errors.push("enhancedPreset: invalid value");
	}
	if ("enhancedLists" in data) {
		const el = data.enhancedLists;
		if (typeof el === "object" && el !== null && !Array.isArray(el)) {
			clean.enhancedLists = sanitizeObjectKeys(el);
		} else errors.push("enhancedLists: must be an object");
	}

	if ("interExtEnabled" in data) {
		if (typeof data.interExtEnabled === "boolean") clean.interExtEnabled = data.interExtEnabled;
		else errors.push("interExtEnabled: must be boolean");
	}
	if ("interExtAllowlist" in data) {
		if (Array.isArray(data.interExtAllowlist) && data.interExtAllowlist.every(v => typeof v === "string")) {
			clean.interExtAllowlist = data.interExtAllowlist;
		} else errors.push("interExtAllowlist: must be string[]");
	}
	if ("interExtDenylist" in data) {
		if (Array.isArray(data.interExtDenylist) && data.interExtDenylist.every(v => typeof v === "string")) {
			clean.interExtDenylist = data.interExtDenylist;
		} else errors.push("interExtDenylist: must be string[]");
	}
	if ("interExtPending" in data) {
		if (Array.isArray(data.interExtPending) && data.interExtPending.every(v =>
			typeof v === "object" && v !== null && typeof v.id === "string")) {
			clean.interExtPending = data.interExtPending;
		} else errors.push("interExtPending: must be {id:string}[]");
	}
	if ("dynamicListsConsent" in data) {
		if (typeof data.dynamicListsConsent === "boolean") clean.dynamicListsConsent = data.dynamicListsConsent;
		else errors.push("dynamicListsConsent: must be boolean");
	}
	if ("consentEnhancedLink" in data) {
		if (typeof data.consentEnhancedLink === "boolean") clean.consentEnhancedLink = data.consentEnhancedLink;
		else errors.push("consentEnhancedLink: must be boolean");
	}
	if ("celMode" in data) {
		if (data.celMode === "profile" || data.celMode === "custom") clean.celMode = data.celMode;
		else errors.push("celMode: must be 'profile' or 'custom'");
	}
	if ("celCustomPurposes" in data) {
		const cp = data.celCustomPurposes;
		if (typeof cp === "object" && cp !== null && !Array.isArray(cp) &&
			Object.values(cp).every(v => typeof v === "boolean")) {
			const validKeys = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);
			const filtered = {};
			for (const [k, v] of Object.entries(sanitizeObjectKeys(cp))) {
				if (validKeys.has(k)) filtered[k] = v;
			}
			clean.celCustomPurposes = filtered;
		} else errors.push("celCustomPurposes: must be {key: boolean}");
	}

	if ("cmpAutoResponse" in data) {
		if (typeof data.cmpAutoResponse === "boolean") clean.cmpAutoResponse = data.cmpAutoResponse;
		else errors.push("cmpAutoResponse: must be boolean");
	}
	if ("cmpDetectionEnabled" in data) {
		if (typeof data.cmpDetectionEnabled === "boolean") clean.cmpDetectionEnabled = data.cmpDetectionEnabled;
		else errors.push("cmpDetectionEnabled: must be boolean");
	}
	if ("cmpEnabled" in data) {
		const ce = data.cmpEnabled;
		if (typeof ce === "object" && ce !== null && !Array.isArray(ce) &&
			Object.values(ce).every(v => typeof v === "boolean")) {
			clean.cmpEnabled = sanitizeObjectKeys(ce);
		} else errors.push("cmpEnabled: must be {key: boolean}");
	}
	if ("cmpCookieMaxAge" in data) {
		if (typeof data.cmpCookieMaxAge === "number" && data.cmpCookieMaxAge > 0 && data.cmpCookieMaxAge <= 31536000) {
			clean.cmpCookieMaxAge = data.cmpCookieMaxAge;
		} else errors.push("cmpCookieMaxAge: must be number (1-31536000)");
	}
	if ("cmpCustomUuid" in data) {
		const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		if (typeof data.cmpCustomUuid === "string" && (data.cmpCustomUuid === "" || UUID_RE.test(data.cmpCustomUuid))) {
			clean.cmpCustomUuid = data.cmpCustomUuid;
		} else errors.push("cmpCustomUuid: must be empty or valid UUID v4");
	}
	if ("theme" in data) {
		if (["auto", "light", "dark"].includes(data.theme)) clean.theme = data.theme;
		else errors.push("theme: must be auto, light, or dark");
	}

	return { clean, errors };
}

function renderDynamicListsToggle(purposes) {
	const section = document.getElementById('enhanced-section');
	const toggle = document.getElementById('ps-dynamic-toggle');
	const label = document.getElementById('ps-dynamic-label');
	const celToggle = document.getElementById('ps-cel-toggle');
	const celLabel = document.getElementById('ps-cel-label');
	if (!section || !toggle || !label) return;

	chrome.storage.local.get(['dynamicListsConsent', 'consentEnhancedLink', 'celMode', 'celCustomPurposes'], (data) => {
		const syncEnabled = data.dynamicListsConsent === true;
		toggle.checked = syncEnabled;
		label.textContent = syncEnabled ? 'Enabled' : 'Disabled';

		if (celToggle && celLabel) {
			const celEnabled = data.consentEnhancedLink === true;
			celToggle.checked = celEnabled;
			celLabel.textContent = celEnabled ? 'Enabled' : 'Disabled';
			updateCelNote(celEnabled);
			renderCelModePanel(celEnabled, data.celMode || 'profile', data.celCustomPurposes || null, purposes);
		}

		section.classList.remove('ps-hidden');
	});

	toggle.addEventListener('change', () => {
		const enabled = toggle.checked;
		label.textContent = enabled ? 'Enabled' : 'Disabled';
		setDynamicListsConsent(enabled, () => {
			// Invalidate catalog cache so next Enhanced tab load picks up new consent
			chrome.runtime.sendMessage(
				{ type: "PROTOCONSENT_ENHANCED_GET_STATE", forceRefresh: true },
				() => { void chrome.runtime.lastError; }
			);
		});
	});

	if (celToggle && celLabel) {
		celToggle.addEventListener('change', () => {
			const enabled = celToggle.checked;
			celLabel.textContent = enabled ? 'Enabled' : 'Disabled';
			setConsentEnhancedLink(enabled, () => {
				notifyBackground(() => {
					updateCelNote(enabled);
				});
				chrome.storage.local.get(['celMode', 'celCustomPurposes'], (d) => {
					renderCelModePanel(enabled, d.celMode || 'profile', d.celCustomPurposes || null, purposes);
				});
			});
		});
	}
}

const CEL_PURPOSE_ORDER = ["analytics", "ads", "personalization", "third_parties", "advanced_tracking"];

function renderCelModePanel(celEnabled, celMode, celCustomPurposes, purposes) {
	const panel = document.getElementById('ps-cel-mode-panel');
	if (!panel) return;
	panel.innerHTML = '';

	if (!celEnabled) {
		panel.classList.add('ps-hidden');
		return;
	}
	panel.classList.remove('ps-hidden');

	// Mode selector row
	const modeRow = document.createElement('div');
	modeRow.className = 'ps-cel-mode-row';

	const modeLabel = document.createElement('span');
	modeLabel.className = 'ps-cel-mode-label';
	modeLabel.textContent = 'Consent Link Mode';
	modeRow.appendChild(modeLabel);

	const modeGroup = document.createElement('div');
	modeGroup.className = 'ps-cel-mode-group';
	modeGroup.setAttribute('role', 'radiogroup');
	modeGroup.setAttribute('aria-label', 'Consent link mode');

	for (const mode of ['profile', 'custom']) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ps-cel-mode-btn' + (celMode === mode ? ' is-active' : '');
		btn.textContent = mode === 'profile' ? 'Profile' : 'Custom';
		btn.setAttribute('role', 'radio');
		btn.setAttribute('aria-checked', celMode === mode ? 'true' : 'false');
		btn.setAttribute('tabindex', celMode === mode ? '0' : '-1');
		btn.setAttribute('aria-description', mode === 'profile'
			? 'Use denied purposes from your default profile'
			: 'Choose which purposes activate enhanced lists');
		btn.addEventListener('click', () => {
			if (celMode === mode) return;
			// When switching to custom for the first time, persist defaults (all denied)
			const toStore = { celMode: mode };
			if (mode === 'custom' && !celCustomPurposes) {
				const defaults = {};
				for (const k of CEL_PURPOSE_ORDER) defaults[k] = true;
				celCustomPurposes = defaults;
				toStore.celCustomPurposes = defaults;
			}
			chrome.storage.local.set(toStore, () => {
				renderCelModePanel(true, mode, celCustomPurposes, purposes);
				notifyBackground(() => {
					updateCelNote(true);
				});
			});
		});
		modeGroup.appendChild(btn);
	}
	// Arrow-key navigation for radio group (WAI-ARIA pattern)
	modeGroup.addEventListener('keydown', (e) => {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		const btns = [...modeGroup.querySelectorAll('[role="radio"]')];
		const idx = btns.indexOf(document.activeElement);
		if (idx < 0) return;
		e.preventDefault();
		const next = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
		btns[next].focus();
		btns[next].click();
	});
	modeRow.appendChild(modeGroup);
	panel.appendChild(modeRow);

	// Purpose toggles (only in custom mode)
	if (celMode === 'custom') {
		const purposesBox = document.createElement('div');
		purposesBox.className = 'ps-cel-purposes';

		const customs = celCustomPurposes || {};
		for (const key of CEL_PURPOSE_ORDER) {
			const row = document.createElement('label');
			row.className = 'ps-cel-purpose-row';

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'ps-cel-purpose-cb';
			// Default to denied (true) if not yet stored
			cb.checked = key in customs ? customs[key] : true;
			cb.dataset.purpose = key;
			cb.addEventListener('change', () => {
				const updated = {};
				for (const c of purposesBox.querySelectorAll('.ps-cel-purpose-cb')) {
					updated[c.dataset.purpose] = c.checked;
				}
				celCustomPurposes = updated;
				chrome.storage.local.set({ celCustomPurposes: updated }, () => {
					notifyBackground(() => {
						updateCelNote(true);
					});
				});
			});

			const lbl = document.createElement('span');
			lbl.className = 'ps-cel-purpose-text';
			const pDef = purposes[key];
			lbl.textContent = pDef ? pDef.short_label : key.replace(/_/g, ' ');

			row.appendChild(cb);
			row.appendChild(lbl);
			purposesBox.appendChild(row);
		}

		const hint = document.createElement('div');
		hint.className = 'ps-cel-hint';
		hint.textContent = 'Checked purposes will activate their enhanced lists.';
		purposesBox.appendChild(hint);

		panel.appendChild(purposesBox);
	}
}

function updateCelNote(celEnabled) {
	const note = document.getElementById('ps-cel-note');
	if (!note) return;
	if (!celEnabled) {
		note.classList.add('ps-hidden');
		note.innerHTML = '';
		return;
	}
	chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, (resp) => {
		if (chrome.runtime.lastError || !resp) return;
		const lists = resp.lists || {};
		const catalog = resp.catalog || {};
		const celMode = resp.celMode || 'profile';
		const hasDownloadedWithCategory = Object.keys(lists).some(id => {
			const def = catalog[id];
			return def && def.category && def.category !== "security";
		});
		note.innerHTML = '';
		const noteLabel = document.createElement('span');
		noteLabel.className = 'ps-cel-note-label';
		noteLabel.textContent = 'Consent Link:';
		note.appendChild(noteLabel);
		if (!hasDownloadedWithCategory) {
			note.appendChild(document.createTextNode(' No enhanced lists with a category are downloaded yet. Download lists from the Protection tab in the popup for consent link to take effect.'));
			note.classList.remove('ps-hidden');
		} else {
			const linked = resp.consentLinkedListIds || [];
			if (linked.length > 0) {
				note.appendChild(document.createTextNode(' '));
				const pillWrap = document.createElement('span');
				pillWrap.className = 'ps-cel-note-pills';
				for (const id of linked) {
					const pill = document.createElement('span');
					pill.className = 'ps-preset-pill ps-cel-active-pill';
					pill.textContent = catalog[id]?.name || id;
					pillWrap.appendChild(pill);
				}
				note.appendChild(pillWrap);
			} else {
				note.appendChild(document.createTextNode(' No lists match your denied purposes in '));
				if (celMode === 'custom') {
					note.appendChild(document.createTextNode('your custom purpose selection above.'));
				} else {
					note.appendChild(document.createTextNode('the '));
					const link = document.createElement('a');
					link.href = '#default-profile-section';
					link.className = 'ps-cel-note-link';
					link.textContent = 'default profile';
					note.appendChild(link);
					note.appendChild(document.createTextNode('.'));
				}
			}
			note.classList.remove('ps-hidden');
		}
	});
}

function initDataSection() {
	const exportBtn = document.getElementById('export-btn');
	const importBtn = document.getElementById('import-btn');
	const importFile = document.getElementById('import-file');
	const statusEl = document.getElementById('data-status');
	if (!exportBtn || !importBtn || !importFile || !statusEl) return;

	function showStatus(msg, isError) {
		statusEl.textContent = msg;
		statusEl.className = 'ps-data-status' + (isError ? ' ps-data-status-error' : '');
		statusEl.classList.remove('ps-hidden');
		setTimeout(() => statusEl.classList.add('ps-hidden'), 4000);
	}

	exportBtn.addEventListener('click', () => {
		chrome.storage.local.get(EXPORT_KEYS, (data) => {
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'protoconsent-config.json';
			a.click();
			URL.revokeObjectURL(url);
			showStatus('Configuration exported.', false);
		});
	});

	importBtn.addEventListener('click', () => importFile.click());

	importFile.addEventListener('change', () => {
		const file = importFile.files[0];
		if (!file) return;
		importFile.value = '';

		if (!file.name.endsWith('.json')) {
			showStatus('Only .json files are accepted.', true);
			return;
		}

		if (file.size > IMPORT_MAX_BYTES) {
			showStatus('File too large (max 512 KB).', true);
			return;
		}

		const reader = new FileReader();
		reader.onerror = () => {
			showStatus('Failed to read file.', true);
		};
		reader.onload = (e) => {
			let data;
			try {
				data = JSON.parse(e.target.result);
			} catch {
				showStatus('Invalid JSON file.', true);
				return;
			}

			if (typeof data !== 'object' || data === null || Array.isArray(data)) {
				showStatus('Invalid configuration format.', true);
				return;
			}

			// Only import known keys with type validation
			const { clean: toWrite, errors } = validateImport(data);

			if (Object.keys(toWrite).length === 0) {
				showStatus('No valid settings found.' + (errors.length ? ' ' + errors[0] : ''), true);
				return;
			}

			if (errors.length > 0) {
				console.warn('ProtoConsent import: skipped invalid keys:', errors);
			}

			if (!confirm('This will overwrite your current settings. Continue?')) return;

			chrome.storage.local.set(toWrite, () => {
				if (chrome.runtime.lastError) {
					showStatus('Storage error: ' + chrome.runtime.lastError.message, true);
					return;
				}
				notifyBackground();
				showStatus('Imported ' + Object.keys(toWrite).length + ' settings. Reloading...', false);
				setTimeout(() => location.reload(), 1200);
			});
		};
		reader.readAsText(file);
	});
}

document.addEventListener('DOMContentLoaded', initDataSection);

// --- Inter-extension API UI ---

const INTER_EXT_KEYS = ["interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending"];
const CWS_BASE = "https://chromewebstore.google.com/detail/";

function initInterExt() {
	const section = document.getElementById('inter-ext-section');
	const toggle = document.getElementById('inter-ext-toggle');
	const toggleLabel = document.getElementById('inter-ext-toggle-label');
	const container = document.getElementById('inter-ext-container');
	if (!section || !toggle || !container) return;

	function renderLists(data) {
		const enabled = data.interExtEnabled === true;
		toggle.checked = enabled;
		toggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';

		if (enabled) {
			container.classList.remove('ps-hidden');
		} else {
			container.classList.add('ps-hidden');
		}

		renderPendingList(data.interExtPending || []);
		renderAllowList(data.interExtAllowlist || []);
		renderDenyList(data.interExtDenylist || []);
	}

	function load() {
		chrome.storage.local.get(INTER_EXT_KEYS, renderLists);
	}

	toggle.addEventListener('change', () => {
		const enabled = toggle.checked;
		toggleLabel.textContent = enabled ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ interExtEnabled: enabled });
		if (enabled) {
			container.classList.remove('ps-hidden');
		} else {
			container.classList.add('ps-hidden');
		}
	});

	// Listen for storage changes to update UI live (debounced)
	let interExtDebounce = null;
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		if (INTER_EXT_KEYS.some(k => k in changes)) {
			if (interExtDebounce) clearTimeout(interExtDebounce);
			interExtDebounce = setTimeout(() => { interExtDebounce = null; load(); }, 100);
		}
	});

	section.classList.remove('ps-hidden');
	load();
}

function makeExtIdEl(id) {
	const span = document.createElement('span');
	span.className = 'ps-ext-id';
	const link = document.createElement('a');
	link.href = CWS_BASE + id;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	link.title = 'Look up on Chrome Web Store';
	link.textContent = id;
	span.appendChild(link);
	return span;
}

function makeBtn(text, cls, handler, extId) {
	const btn = document.createElement('button');
	btn.className = 'ps-ext-btn ' + cls;
	btn.type = 'button';
	btn.textContent = text;
	if (extId) btn.setAttribute('aria-label', text + ' extension ' + extId);
	btn.addEventListener('click', () => {
		btn.disabled = true;
		handler();
	});
	return btn;
}

function moveExtension(fromKey, toKey, id, entry) {
	chrome.storage.local.get([fromKey, toKey], (r) => {
		let fromList = r[fromKey] || [];
		let toList = r[toKey] || [];

		// Remove from source
		if (fromKey === 'interExtPending') {
			fromList = fromList.filter(e => e.id !== id);
		} else {
			fromList = fromList.filter(e => e !== id);
		}

		// Add to destination (avoid duplicates)
		if (toKey === 'interExtPending') {
			if (!toList.some(e => e.id === id)) toList.push(entry || { id: id, firstSeen: Date.now() });
		} else {
			if (!toList.includes(id)) toList.push(id);
		}

		chrome.storage.local.set({ [fromKey]: fromList, [toKey]: toList });
	});
}

function removeFromList(key, id) {
	chrome.storage.local.get([key], (r) => {
		let list = r[key] || [];
		if (key === 'interExtPending') {
			list = list.filter(e => e.id !== id);
		} else {
			list = list.filter(e => e !== id);
		}
		chrome.storage.local.set({ [key]: list });
	});
}

function renderPendingList(pending) {
	const listEl = document.getElementById('inter-ext-pending-list');
	const countEl = document.getElementById('inter-ext-pending-count');
	const detailsEl = document.getElementById('inter-ext-pending');
	if (!listEl) return;

	listEl.replaceChildren();
	if (countEl) countEl.textContent = pending.length;

	if (pending.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'ps-ext-empty';
		empty.textContent = 'No pending requests.';
		listEl.appendChild(empty);
		if (detailsEl) detailsEl.removeAttribute('open');
		return;
	}

	// Auto-open when there are pending requests
	if (detailsEl) detailsEl.setAttribute('open', '');

	for (const entry of pending) {
		const row = document.createElement('div');
		row.className = 'ps-ext-row';
		row.appendChild(makeExtIdEl(entry.id));

		const actions = document.createElement('div');
		actions.className = 'ps-ext-actions';
		actions.appendChild(makeBtn('Allow', 'ps-ext-btn-allow', () => {
			moveExtension('interExtPending', 'interExtAllowlist', entry.id);
		}, entry.id));
		actions.appendChild(makeBtn('Block', 'ps-ext-btn-deny', () => {
			moveExtension('interExtPending', 'interExtDenylist', entry.id);
		}, entry.id));
		row.appendChild(actions);
		listEl.appendChild(row);
	}
}

function renderAllowList(allowlist) {
	const listEl = document.getElementById('inter-ext-allow-list');
	const countEl = document.getElementById('inter-ext-allow-count');
	if (!listEl) return;

	listEl.replaceChildren();
	if (countEl) countEl.textContent = allowlist.length;

	if (allowlist.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'ps-ext-empty';
		empty.textContent = 'No authorized extensions.';
		listEl.appendChild(empty);
		return;
	}

	for (const id of allowlist) {
		const row = document.createElement('div');
		row.className = 'ps-ext-row';
		row.appendChild(makeExtIdEl(id));

		const actions = document.createElement('div');
		actions.className = 'ps-ext-actions';
		actions.appendChild(makeBtn('Revoke', 'ps-ext-btn-revoke', () => {
			removeFromList('interExtAllowlist', id);
		}, id));
		actions.appendChild(makeBtn('Block', 'ps-ext-btn-deny', () => {
			moveExtension('interExtAllowlist', 'interExtDenylist', id);
		}, id));
		row.appendChild(actions);
		listEl.appendChild(row);
	}
}

function renderDenyList(denylist) {
	const listEl = document.getElementById('inter-ext-deny-list');
	const countEl = document.getElementById('inter-ext-deny-count');
	if (!listEl) return;

	listEl.replaceChildren();
	if (countEl) countEl.textContent = denylist.length;

	if (denylist.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'ps-ext-empty';
		empty.textContent = 'No blocked extensions.';
		listEl.appendChild(empty);
		return;
	}

	for (const id of denylist) {
		const row = document.createElement('div');
		row.className = 'ps-ext-row';
		row.appendChild(makeExtIdEl(id));

		const actions = document.createElement('div');
		actions.className = 'ps-ext-actions';
		actions.appendChild(makeBtn('Unblock', 'ps-ext-btn-revoke', () => {
			removeFromList('interExtDenylist', id);
		}, id));
		row.appendChild(actions);
		listEl.appendChild(row);
	}
}

// --- Tab navigation ---

function switchTab(name) {
	if (!TAB_NAMES.includes(name)) return;

	document.querySelectorAll('.ps-tab').forEach(tab => {
		const isActive = tab.dataset.tab === name;
		tab.classList.toggle('is-active', isActive);
		tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
		tab.setAttribute('tabindex', isActive ? '0' : '-1');
	});

	document.querySelectorAll('.ps-panel').forEach(panel => {
		const isActive = panel.dataset.panel === name;
		panel.classList.toggle('is-active', isActive);
		panel.hidden = !isActive;
	});

	history.replaceState(null, '', '#' + name);
}

function applyHashRoute() {
	const hash = location.hash.replace('#', '');

	if (TAB_NAMES.includes(hash)) {
		switchTab(hash);
		return;
	}

	if (hash && SECTION_TAB_MAP[hash]) {
		switchTab(SECTION_TAB_MAP[hash]);
		requestAnimationFrame(() => {
			const el = document.getElementById(hash);
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
		return;
	}

	switchTab('consent');
}

function handleCrossTabLink(e) {
	const link = e.target.closest('a[href^="#"]');
	if (!link) return;

	const targetId = link.getAttribute('href').slice(1);
	if (!targetId) return;

	const tabName = SECTION_TAB_MAP[targetId];
	if (!tabName) return;

	e.preventDefault();
	switchTab(tabName);
	requestAnimationFrame(() => {
		const el = document.getElementById(targetId);
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	});
}

function initTabs() {
	const tabs = document.querySelectorAll('.ps-tab');
	const tablist = document.querySelector('.ps-tabs');

	tabs.forEach(tab => {
		tab.addEventListener('click', () => switchTab(tab.dataset.tab));
	});

	if (tablist) {
		tablist.addEventListener('keydown', (e) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			const visible = Array.from(tabs);
			const idx = visible.indexOf(document.activeElement);
			if (idx === -1) return;
			e.preventDefault();
			const next = e.key === 'ArrowRight'
				? visible[(idx + 1) % visible.length]
				: visible[(idx - 1 + visible.length) % visible.length];
			next.focus();
			next.click();
		});
	}

	applyHashRoute();
	window.addEventListener('hashchange', applyHashRoute);
	document.addEventListener('click', handleCrossTabLink);
}
