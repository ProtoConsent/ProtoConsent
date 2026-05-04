// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Protection tab: enhanced presets, cosmetic filtering, CMP, dynamic lists, CEL

function renderEnhancedPresets() {
	const container = document.getElementById('enhanced-preset-list');
	const section = document.getElementById('enhanced-section');
	if (!container || !section) return;

	Promise.all([
		fetch(chrome.runtime.getURL('config/enhanced-lists.json')).then(r => {
			if (!r.ok) throw new Error("enhanced-lists.json: HTTP " + r.status);
			return r.json();
		}).then(data => data.lists || data),
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

function initCosmeticSection() {
	const toggle = document.getElementById('cosmetic-master-toggle');
	const label = document.getElementById('cosmetic-master-label');
	if (!toggle) return;

	chrome.storage.local.get('enhancedCosmeticEnabled', (data) => {
		const on = data.enhancedCosmeticEnabled !== false;
		toggle.checked = on;
		if (label) label.textContent = on ? 'Enabled' : 'Disabled';
	});

	toggle.addEventListener('change', () => {
		const v = toggle.checked;
		if (label) label.textContent = v ? 'Enabled' : 'Disabled';
		chrome.storage.local.set({ enhancedCosmeticEnabled: v });
		chrome.runtime.sendMessage({ type: "PROTOCONSENT_RULES_UPDATED" });
	});

	const section = document.getElementById('cosmetic-section');
	if (section) section.classList.remove('ps-hidden');
}

function initCmpSection() {
	const section = document.getElementById('cmp-section');
	const toggle = document.getElementById('cmp-auto-toggle');
	const toggleLabel = document.getElementById('cmp-auto-label');
	const detail = document.getElementById('cmp-detail');
	const listEl = document.getElementById('cmp-list');
	const uuidInput = document.getElementById('cmp-uuid-input');
	const maxageInput = document.getElementById('cmp-maxage-input');
	const cookieToggle = document.getElementById('cmp-cookie-toggle');
	const cookieLabel = document.getElementById('cmp-cookie-label');
	const cosmeticToggle = document.getElementById('cmp-cosmetic-toggle');
	const cosmeticLabel = document.getElementById('cmp-cosmetic-label');
	const scrollToggle = document.getElementById('cmp-scroll-toggle');
	const scrollLabel = document.getElementById('cmp-scroll-label');
	const cmpListAccordion = document.getElementById('cmp-list-accordion');
	const cmpAdvancedAccordion = document.getElementById('cmp-advanced-accordion');
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

			chrome.storage.local.get(['cmpAutoResponse', 'cmpEnabled', 'cmpCustomUuid', 'cmpCookieMaxAge',
				'cmpCookieInjectionEnabled', 'cmpCosmeticEnabled', 'cmpScrollUnlockEnabled'], (data) => {
				const masterOn = data.cmpAutoResponse !== false;
				const enabled = data.cmpEnabled || {};

				toggle.checked = masterOn;
				toggleLabel.textContent = masterOn ? 'Enabled' : 'Disabled';
				if (!masterOn) detail.classList.add('ps-hidden');

				const layerToggles = [
					{ el: cookieToggle, label: cookieLabel, key: 'cmpCookieInjectionEnabled' },
					{ el: cosmeticToggle, label: cosmeticLabel, key: 'cmpCosmeticEnabled' },
					{ el: scrollToggle, label: scrollLabel, key: 'cmpScrollUnlockEnabled' },
				];

				const setCmpAccordions = (visible) => {
					const method = visible ? 'remove' : 'add';
					if (cmpListAccordion) cmpListAccordion.classList[method]('ps-hidden');
					if (cmpAdvancedAccordion) cmpAdvancedAccordion.classList[method]('ps-hidden');
				};

				for (const { el, label, key } of layerToggles) {
					if (!el) continue;
					const on = key === 'cmpCookieInjectionEnabled' ? data[key] === true : data[key] !== false;
					el.checked = on;
					if (label) label.textContent = on ? 'Enabled' : 'Disabled';
					if (key === 'cmpCookieInjectionEnabled') setCmpAccordions(on);
					el.addEventListener('change', () => {
						const v = el.checked;
						if (label) label.textContent = v ? 'Enabled' : 'Disabled';
						chrome.storage.local.set({ [key]: v });
						if (key === 'cmpCookieInjectionEnabled') setCmpAccordions(v);
					});
				}

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

function renderDynamicListsToggle(purposes) {
	const section = document.getElementById('enhanced-section');
	const toggle = document.getElementById('ps-dynamic-toggle');
	const label = document.getElementById('ps-dynamic-label');
	const celToggle = document.getElementById('ps-cel-toggle');
	const celLabel = document.getElementById('ps-cel-label');
	if (!section || !toggle || !label) return;

	chrome.storage.local.get(['dynamicListsConsent', 'consentEnhancedLink', 'celMode', 'celCustomPurposes'], (data) => {
		const syncEnabled = data.dynamicListsConsent !== false;
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
		renderAutoRefreshSettings(syncEnabled);
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
			// Update alarms and auto-refresh section visibility
			chrome.runtime.sendMessage(
				{ type: "PROTOCONSENT_REFRESH_ALARMS_UPDATED" },
				() => { void chrome.runtime.lastError; }
			);
			renderAutoRefreshSettings(enabled);
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

function renderAutoRefreshSettings(syncEnabled) {
	const section = document.getElementById('ps-autorefresh-section');
	if (!section) return;
	if (!syncEnabled) {
		section.classList.add('ps-hidden');
		return;
	}
	section.classList.remove('ps-hidden');

	const ownInput = document.getElementById('ps-refresh-own');
	const extInput = document.getElementById('ps-refresh-ext');
	if (!ownInput || !extInput) return;

	// Always reload values from storage (even on re-render)
	chrome.storage.local.get(['autoRefreshIntervalOwn', 'autoRefreshIntervalExternal'], (data) => {
		let ownVal = parseInt(data.autoRefreshIntervalOwn, 10);
		let extVal = parseInt(data.autoRefreshIntervalExternal, 10);
		ownInput.value = (isNaN(ownVal) || ownVal < 6 || ownVal > 168) ? 24 : ownVal;
		extInput.value = (isNaN(extVal) || extVal < 6 || extVal > 168) ? 24 : extVal;
		if (data.autoRefreshIntervalOwn) ownInput.classList.add('ps-cmp-input-saved');
		if (data.autoRefreshIntervalExternal) extInput.classList.add('ps-cmp-input-saved');
	});

	// Only attach listeners once
	if (ownInput.dataset.bound) return;
	ownInput.dataset.bound = "1";
	extInput.dataset.bound = "1";

	function validateInterval(input, errorId) {
		const raw = input.value.trim();
		const errorEl = document.getElementById(errorId);
		const savedEl = document.getElementById(errorId.replace('-error', '-saved'));
		if (!raw) {
			input.classList.remove('ps-cmp-input-error', 'ps-cmp-input-saved');
			if (errorEl) errorEl.classList.add('ps-hidden');
			if (savedEl) savedEl.classList.add('ps-hidden');
			return true;
		}
		const val = parseInt(raw, 10);
		if (isNaN(val) || val < 6 || val > 168) {
			if (errorEl) { errorEl.textContent = 'Must be 6-168'; errorEl.classList.remove('ps-hidden'); }
			input.classList.add('ps-cmp-input-error');
			input.classList.remove('ps-cmp-input-saved');
			if (savedEl) savedEl.classList.add('ps-hidden');
			return false;
		}
		input.classList.remove('ps-cmp-input-error');
		if (errorEl) errorEl.classList.add('ps-hidden');
		return true;
	}

	function saveInterval(input, storageKey, errorId) {
		if (!validateInterval(input, errorId)) return;
		const raw = input.value.trim();
		const val = raw ? parseInt(raw, 10) : 24;
		input.value = val;
		chrome.storage.local.set({ [storageKey]: val }, () => {
			chrome.runtime.sendMessage(
				{ type: "PROTOCONSENT_REFRESH_ALARMS_UPDATED" },
				() => { void chrome.runtime.lastError; }
			);
			input.classList.add('ps-cmp-input-saved');
			const saved = document.getElementById(errorId.replace('-error', '-saved'));
			if (saved) {
				saved.classList.remove('ps-hidden');
				setTimeout(() => saved.classList.add('ps-hidden'), 1500);
			}
		});
	}

	// Block non-digit keys that type="number" allows (e, +, -, .)
	function blockNonDigitKeys(e) {
		if (["e", "E", "+", "-", "."].includes(e.key)) e.preventDefault();
	}
	// Sanitize pasted values to digits only
	function sanitizePaste(e) {
		e.preventDefault();
		const text = (e.clipboardData || window.clipboardData).getData("text");
		const digits = text.replace(/[^0-9]/g, "");
		if (digits) e.target.value = digits;
		validateInterval(e.target, e.target.id === 'ps-refresh-own' ? 'ps-refresh-own-error' : 'ps-refresh-ext-error');
	}
	ownInput.addEventListener('keydown', blockNonDigitKeys);
	extInput.addEventListener('keydown', blockNonDigitKeys);
	ownInput.addEventListener('paste', sanitizePaste);
	extInput.addEventListener('paste', sanitizePaste);

	ownInput.addEventListener('input', () => validateInterval(ownInput, 'ps-refresh-own-error'));
	extInput.addEventListener('input', () => validateInterval(extInput, 'ps-refresh-ext-error'));
	ownInput.addEventListener('change', () => saveInterval(ownInput, 'autoRefreshIntervalOwn', 'ps-refresh-own-error'));
	extInput.addEventListener('change', () => saveInterval(extInput, 'autoRefreshIntervalExternal', 'ps-refresh-ext-error'));
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
			return def && def.category && CEL_PURPOSE_ORDER.includes(def.category);
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
