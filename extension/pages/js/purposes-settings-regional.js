// ProtoConsent regional language selection for Purpose Settings
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders per-region checkboxes in the Regional Filters section of
// purposes-settings.html.  Reads region labels from bundled
// config/regional-languages.json and validates against the CDN-authoritative
// catalog regions array obtained via GET_STATE.
//
// Globals: REGIONAL_COSMETIC_ID, REGIONAL_BLOCKING_ID (config.js)

/* global REGIONAL_COSMETIC_ID, REGIONAL_BLOCKING_ID */

// Capture hash before applyHashRoute replaces it with the tab name
var _regionalScrollTarget = location.hash === '#regional-filters' ? 'regional-filters' : null;

// Serialized storage writes — each toggle waits for the previous to finish
var _regionalLangQueue = Promise.resolve();

function initRegionalSection() {
	const section = document.getElementById('regional-section');
	const grid = document.getElementById('regional-language-grid');
	if (!section || !grid) return;

	// Load regional config (labels/mappings) and merged catalog (CDN-authoritative regions)
	Promise.all([
		fetch(chrome.runtime.getURL('config/regional-languages.json'))
			.then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
		new Promise(resolve => {
			chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_GET_STATE" }, (resp) => {
				if (chrome.runtime.lastError || !resp) resolve(null);
				else resolve(resp.catalog);
			});
		}),
	]).then(([rlConfig, catalog]) => {
		section.classList.remove('ps-hidden');

		// Deferred scroll: applyHashRoute switches tab but replaces hash,
		// so we check for the section ID being in the URL at load time
		if (_regionalScrollTarget) {
			setTimeout(function() {
				var target = document.getElementById(_regionalScrollTarget);
				if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}, 50);
		}

		// Catalog regions (CDN-authoritative): only show regions the catalog says are valid
		let catalogRegions = null;
		if (catalog) {
			const def = catalog[REGIONAL_COSMETIC_ID] || catalog[REGIONAL_BLOCKING_ID];
			if (def && Array.isArray(def.regions)) {
				catalogRegions = new Set(def.regions);
			}
		}

		// Valid regions: in config AND in catalog (if available)
		const regionCodes = Object.keys(rlConfig).filter(code =>
			!catalogRegions || catalogRegions.has(code)
		);

		// Build langToRegion map from config
		const langToRegion = {};
		for (const [code, entry] of Object.entries(rlConfig)) {
			for (const lang of entry.languages) {
				langToRegion[lang] = code;
			}
		}

		// Detect default from browser locale
		const uiLang = chrome.i18n.getUILanguage();
		const baseLang = uiLang.split('-')[0].toLowerCase();
		const rawDetected = langToRegion[uiLang] || langToRegion[baseLang] || null;
		// Only use detected region if it's in the valid set
		const detectedRegion = rawDetected && regionCodes.includes(rawDetected) ? rawDetected : null;

		chrome.storage.local.get(['regionalLanguages'], (stored) => {
			// Default: browser-detected region, or empty
			let selected = stored.regionalLanguages;
			if (!Array.isArray(selected)) {
				selected = detectedRegion ? [detectedRegion] : [];
				chrome.storage.local.set({ regionalLanguages: selected });
			}

			// Prune stale region codes no longer in the valid set
			const validSet = new Set(regionCodes);
			const pruned = selected.filter(s => validSet.has(s));
			if (pruned.length !== selected.length) {
				selected = pruned;
				chrome.storage.local.set({ regionalLanguages: selected });
			}

			grid.replaceChildren();
			for (const code of regionCodes) {
				const row = document.createElement('div');
				row.className = 'ps-gpc-toggle-row';

				const info = document.createElement('div');
				const nameEl = document.createElement('label');
				nameEl.className = 'ps-gpc-info-name';
				nameEl.setAttribute('for', 'rl-' + code);

				// Flag image(s) before label text
				const flagCodes = rlConfig[code].flag
					? (Array.isArray(rlConfig[code].flag) ? rlConfig[code].flag : [rlConfig[code].flag])
					: [];
				for (const fc of flagCodes) {
					const flagImg = document.createElement('img');
					flagImg.src = chrome.runtime.getURL('icons/flags/' + fc.toLowerCase() + '.svg');
					flagImg.width = 20;
					flagImg.height = 15;
					flagImg.alt = '';
					flagImg.className = 'ps-regional-flag';
					flagImg.onerror = function() { this.style.display = 'none'; };
					nameEl.appendChild(flagImg);
				}

				nameEl.appendChild(document.createTextNode(rlConfig[code].label));
				if (code === detectedRegion) {
					const badge = document.createElement('span');
					badge.className = 'ps-detected-badge';
					badge.textContent = ' (detected)';
					badge.style.opacity = '0.6';
					badge.style.fontSize = '0.85em';
					nameEl.appendChild(badge);
				}
				info.appendChild(nameEl);

				const descEl = document.createElement('div');
				descEl.className = 'ps-gpc-info-desc';
				descEl.id = 'rl-desc-' + code;
				descEl.textContent = flagCodes.length > 0
					? flagCodes.join('/')
					: code.toUpperCase();
				info.appendChild(descEl);
				row.appendChild(info);

				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.id = 'rl-' + code;
				cb.className = 'ps-gpc-toggle';
				cb.checked = selected.includes(code);
				cb.setAttribute('aria-describedby', 'rl-desc-' + code);
				cb.addEventListener('change', () => {
					_regionalLangQueue = _regionalLangQueue.then(() => new Promise(resolve => {
						chrome.storage.local.get(['regionalLanguages'], (r) => {
							let langs = Array.isArray(r.regionalLanguages) ? r.regionalLanguages.slice() : [];
							if (cb.checked) {
								if (!langs.includes(code)) langs.push(code);
							} else {
								langs = langs.filter(l => l !== code);
							}
							chrome.storage.local.set({ regionalLanguages: langs }, resolve);
						});
					}));
				});
				row.appendChild(cb);
				grid.appendChild(row);
			}
		});
	})
	.catch(err => {
		console.warn('ProtoConsent: failed to load regional-languages.json:', err);
	});
}
