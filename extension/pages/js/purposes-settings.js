// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const TAB_NAMES = ['consent', 'protection', 'regional', 'advanced'];
const SECTION_TAB_MAP = {
	'default-profile-section': 'consent',
	'presets-section': 'consent',
	'privacy-signals-section': 'consent',
	'mode-section': 'consent',
	'enhanced-section': 'protection',
	'cosmetic-section': 'protection',
	'cmp-section': 'protection',
	'regional-filters': 'regional',
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
		initCosmeticSection();
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

function notifyBackground(cb) {
	chrome.runtime.sendMessage({ type: 'PROTOCONSENT_RULES_UPDATED' }, () => {
		void chrome.runtime.lastError;
		if (cb) cb();
	});
}

document.addEventListener('DOMContentLoaded', init);

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
