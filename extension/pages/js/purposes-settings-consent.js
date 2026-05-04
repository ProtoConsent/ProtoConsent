// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Consent tab: profiles, presets, privacy signals, operating mode

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
			chrome.storage.local.remove("defaultPurposes", () => {
				chrome.storage.local.set({ defaultProfile: value }, notifyBackground);
			});
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
