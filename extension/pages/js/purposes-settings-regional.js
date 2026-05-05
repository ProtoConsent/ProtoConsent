// ProtoConsent regional language selection for Purpose Settings
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders per-region checkboxes in the Regional Filters section of
// purposes-settings.html.  Reads region labels from bundled
// config/regional-languages.json and validates against the CDN-authoritative
// catalog regions array obtained via GET_STATE.
//
// Globals: isRegionalEntry (config.js)

// Capture hash before applyHashRoute replaces it with the tab name
const _regionalScrollTarget = location.hash === '#regional-filters' ? 'regional-filters' : null;

// Serialized storage writes — each toggle waits for the previous to finish
let _regionalLangQueue = Promise.resolve();

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
				if (chrome.runtime.lastError || !resp) resolve({ catalog: null, lists: {} });
				else resolve({ catalog: resp.catalog, lists: resp.lists || {} });
			});
		}),
	]).then(([rlConfig, { catalog, lists: epLists }]) => {
		section.classList.remove('ps-hidden');

		// Deferred scroll: applyHashRoute switches tab but replaces hash,
		// so we check for the section ID being in the URL at load time
		if (_regionalScrollTarget) {
			setTimeout(function() {
				const target = document.getElementById(_regionalScrollTarget);
				if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}, 50);
		}

		// Catalog regions: collect unique regions from per-source entries
		let catalogRegions = null;
		if (catalog) {
			const regions = new Set();
			for (const def of Object.values(catalog)) {
				if (def.region) regions.add(def.region);
			}
			if (regions.size > 0) catalogRegions = regions;
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

			const filterInput = document.createElement('input');
			filterInput.type = 'text';
			filterInput.placeholder = 'Filter by language or list name...';
			filterInput.className = 'ps-regional-filter';
			filterInput.setAttribute('aria-label', 'Filter regional lists');
			grid.parentNode.insertBefore(filterInput, grid);

			regionCodes.sort();

			filterInput.addEventListener('input', function () {
				const q = filterInput.value.toLowerCase();
				for (const row of grid.querySelectorAll('.ps-gpc-toggle-row')) {
					row.style.display = q && row.dataset.search.indexOf(q) === -1 ? 'none' : '';
				}
			});

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
					flagImg.alt = fc;
					flagImg.title = fc + ' - ' + rlConfig[code].label;
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
				const sources = rlConfig[code].sources;
				if (sources && sources.length > 0) {
					for (let i = 0; i < sources.length; i++) {
						if (i > 0) descEl.appendChild(document.createTextNode(', '));
						const link = document.createElement('a');
						link.href = sources[i].url;
						link.target = '_blank';
						link.rel = 'noopener noreferrer';
						link.textContent = sources[i].name;
						link.className = 'ps-regional-source-link';
						descEl.appendChild(link);
					}
				} else {
					descEl.textContent = flagCodes.length > 0
						? flagCodes.join('/')
						: code.toUpperCase();
				}
				info.appendChild(descEl);
				row.appendChild(info);

				const searchParts = [code, rlConfig[code].label];
				if (sources) for (const s of sources) searchParts.push(s.name);
				row.dataset.search = searchParts.join(' ').toLowerCase();

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

				// Per-source sub-toggles for multi-source regions
				if (sources && sources.length > 1) {
					const subContainer = document.createElement('div');
					subContainer.className = 'ps-regional-sources';
					subContainer.setAttribute('role', 'group');
					subContainer.setAttribute('aria-label', rlConfig[code].label + ' filter sources');
					if (!cb.checked) subContainer.hidden = true;

					for (const src of sources) {
						const subRow = document.createElement('div');
						subRow.className = 'ps-regional-subtoggle-row';

						const subLabel = document.createElement('label');
						subLabel.className = 'ps-regional-subtoggle-label';
						subLabel.textContent = src.name;
						subLabel.setAttribute('for', 'rl-src-' + code + '-' + src.slug);
						subRow.appendChild(subLabel);

						const subCb = document.createElement('input');
						subCb.type = 'checkbox';
						subCb.id = 'rl-src-' + code + '-' + src.slug;
						subCb.className = 'ps-gpc-toggle ps-regional-subtoggle';
						const bId = 'regional_' + code + '_' + src.slug + '_blocking';
						const cId = 'regional_' + code + '_' + src.slug + '_cosmetic';
						const bEnabled = epLists[bId] ? epLists[bId].enabled !== false : true;
						const cEnabled = epLists[cId] ? epLists[cId].enabled !== false : true;
						subCb.checked = bEnabled || cEnabled;
						subCb.setAttribute('aria-label', (subCb.checked ? 'Disable ' : 'Enable ') + src.name);
						subCb.addEventListener('change', () => {
							subCb.setAttribute('aria-label', (subCb.checked ? 'Disable ' : 'Enable ') + src.name);
							chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_TOGGLE", listId: bId, enabled: subCb.checked });
							chrome.runtime.sendMessage({ type: "PROTOCONSENT_ENHANCED_TOGGLE", listId: cId, enabled: subCb.checked });
						});
						subRow.appendChild(subCb);
						subContainer.appendChild(subRow);
					}

					cb.addEventListener('change', () => {
						subContainer.hidden = !cb.checked;
					});

					row.appendChild(subContainer);
				}

				grid.appendChild(row);
			}
		});
	})
	.catch(err => {
		console.warn('ProtoConsent: failed to load regional-languages.json:', err);
	});
}
