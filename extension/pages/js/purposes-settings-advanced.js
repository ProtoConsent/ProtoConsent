// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Advanced tab: theme, export/import, inter-extension API

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

const EXPORT_KEYS = [
	"defaultProfile", "defaultPurposes", "rules", "whitelist",
	"gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled", "operatingMode",
	"enhancedPreset", "enhancedLists", "enhancedCosmeticEnabled",
	"interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending",
	"dynamicListsConsent", "consentEnhancedLink",
	"autoRefreshIntervalOwn", "autoRefreshIntervalExternal",
	"celMode", "celCustomPurposes",
	"cmpAutoResponse", "cmpEnabled", "cmpCookieMaxAge", "cmpCustomUuid",
	"cmpDetectionEnabled",
	"cmpCookieInjectionEnabled", "cmpCosmeticEnabled", "cmpScrollUnlockEnabled",
	"theme"
];

const VALID_PROFILES = ["strict", "balanced", "permissive", "custom"];
const VALID_ENHANCED_PRESETS = ["off", "basic", "full", "custom"];

const IMPORT_MAX_BYTES = 512 * 1024; // 512 KB

const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

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
	if ("enhancedCosmeticEnabled" in data) {
		if (typeof data.enhancedCosmeticEnabled === "boolean") clean.enhancedCosmeticEnabled = data.enhancedCosmeticEnabled;
		else errors.push("enhancedCosmeticEnabled: must be boolean");
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
	if ("autoRefreshIntervalOwn" in data) {
		const v = data.autoRefreshIntervalOwn;
		if (typeof v === "number" && v >= 6 && v <= 168) clean.autoRefreshIntervalOwn = v;
		else errors.push("autoRefreshIntervalOwn: must be number 6-168");
	}
	if ("autoRefreshIntervalExternal" in data) {
		const v = data.autoRefreshIntervalExternal;
		if (typeof v === "number" && v >= 6 && v <= 168) clean.autoRefreshIntervalExternal = v;
		else errors.push("autoRefreshIntervalExternal: must be number 6-168");
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
	for (const bk of ["cmpCookieInjectionEnabled", "cmpCosmeticEnabled", "cmpScrollUnlockEnabled"]) {
		if (bk in data) {
			if (typeof data[bk] === "boolean") clean[bk] = data[bk];
			else errors.push(bk + ": must be boolean");
		}
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

document.addEventListener('DOMContentLoaded', initThemeSection);
document.addEventListener('DOMContentLoaded', initDataSection);

const INTER_EXT_KEYS = ["interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending"];
const CWS_BASE = "https://chromewebstore.google.com/detail/";

function initInterExt() {
	const section = document.getElementById('inter-ext-section');
	const toggle = document.getElementById('inter-ext-toggle');
	const toggleLabel = document.getElementById('inter-ext-toggle-label');
	const container = document.getElementById('inter-ext-container');
	if (!section || !toggle || !container) return;

	const idEl = document.getElementById('inter-ext-id');
	if (idEl) idEl.innerHTML = '<span class="ps-info-pill" title="Other extensions need this ID to connect">&#x2139; Info</span> <strong>Extension ID:</strong> ' + chrome.runtime.id;

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
