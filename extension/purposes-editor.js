// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// TODO: Add purpose editing (add/remove/reorder purposes)
// TODO: Add import/export (JSON)
// TODO: Add i18n support (load labels from localized config)
// TODO: Connect to extension settings (save edits to chrome.storage.local)

async function init() {
	const statusEl = document.getElementById('status-msg');
	try {
		const [purposesRes, presetsRes] = await Promise.all([
			fetch(chrome.runtime.getURL('config/purposes.json')),
			fetch(chrome.runtime.getURL('config/presets.json'))
		]);
		const purposes = await purposesRes.json();
		const presets = await presetsRes.json();

		statusEl.style.display = 'none';
		renderPurposes(purposes);
		renderPresets(presets, purposes);

		const versionEl = document.getElementById('viewer-version');
		if (versionEl) {
			versionEl.textContent = 'ProtoConsent v' + chrome.runtime.getManifest().version;
		}
	} catch (err) {
		statusEl.textContent = 'Error loading configuration: ' + err.message;
		statusEl.classList.add('error');
	}
}

function renderPurposes(purposes) {
	const container = document.getElementById('purpose-list');
	const section = document.getElementById('purposes-section');

	for (const [key, p] of Object.entries(purposes)) {
		const card = document.createElement('div');
		card.className = 'purpose-card';

		const header = document.createElement('div');
		header.className = 'purpose-header';

		const badge = document.createElement('span');
		badge.className = 'purpose-short';
		badge.textContent = p.short;

		const label = document.createElement('span');
		label.className = 'purpose-label';
		label.textContent = p.label;

		header.appendChild(badge);
		header.appendChild(label);
		card.appendChild(header);

		const desc = document.createElement('p');
		desc.className = 'purpose-desc';
		desc.textContent = p.description;
		card.appendChild(desc);

		if (p.consent_commons_keys && p.consent_commons_keys.length) {
			const keys = document.createElement('div');
			keys.className = 'purpose-keys';
			for (const k of p.consent_commons_keys) {
				const pill = document.createElement('span');
				pill.className = 'purpose-key';
				pill.textContent = k;
				keys.appendChild(pill);
			}
			card.appendChild(keys);
		}

		container.appendChild(card);
	}
	section.style.display = '';
}

function renderPresets(presets, purposes) {
	const container = document.getElementById('preset-list');
	const section = document.getElementById('presets-section');

	for (const [key, preset] of Object.entries(presets)) {
		const card = document.createElement('div');
		card.className = 'preset-card';

		const name = document.createElement('div');
		name.className = 'preset-name';
		name.textContent = preset.label;
		card.appendChild(name);

		const pills = document.createElement('div');
		pills.className = 'preset-purposes';
		for (const [pKey, allowed] of Object.entries(preset.purposes)) {
			const pill = document.createElement('span');
			pill.className = 'preset-pill ' + (allowed ? 'allowed' : 'denied');
			pill.textContent = (purposes[pKey] ? purposes[pKey].short : pKey) + (allowed ? ' \u2713' : ' \u2717');
			pills.appendChild(pill);
		}
		card.appendChild(pills);

		container.appendChild(card);
	}
	section.style.display = '';
}

document.addEventListener('DOMContentLoaded', init);
