// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Support tab: debug toggle, troubleshooting info dump

function initSupportSection() {
	const toggle = document.getElementById('ps-debug-toggle');
	const label = document.getElementById('ps-debug-label');
	const wrap = document.getElementById('ps-troubleshoot-wrap');
	const hint = document.getElementById('ps-troubleshoot-hint');
	const pre = document.getElementById('ps-troubleshoot-info');

	function setDebugUI(on) {
		label.textContent = on ? 'Enabled' : 'Disabled';
		if (wrap) wrap.hidden = !on;
		if (hint) hint.hidden = on;
		if (on && pre) loadTroubleshootInfo(pre);
	}

	if (toggle && label) {
		chrome.storage.local.get('debug', (d) => {
			const on = d.debug === true;
			toggle.checked = on;
			setDebugUI(on);
		});
		toggle.addEventListener('change', () => {
			const on = toggle.checked;
			if (on) {
				chrome.storage.local.set({ debug: true });
			} else {
				chrome.storage.local.remove('debug');
			}
			setDebugUI(on);
		});
	}

	const copyBtn = document.getElementById('ps-troubleshoot-copy');
	if (copyBtn && pre) {
		let copyTimer = 0;
		copyBtn.addEventListener('click', () => {
			clearTimeout(copyTimer);
			navigator.clipboard.writeText(pre.textContent).then(() => {
				copyBtn.textContent = 'Copied!';
				copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
			}).catch(() => {
				copyBtn.textContent = 'Failed';
				copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
			});
		});
	}

	const clearBtn = document.getElementById('ps-troubleshoot-clear-errors');
	if (clearBtn && pre) {
		clearBtn.addEventListener('click', () => {
			chrome.runtime.sendMessage({ type: 'PROTOCONSENT_CLEAR_ERRORS' }, () => {
				loadTroubleshootInfo(pre);
			});
		});
	}
}

function loadTroubleshootInfo(pre) {
	const manifest = chrome.runtime.getManifest();
	chrome.runtime.sendMessage({ type: 'PROTOCONSENT_GET_DEBUG' }, (bg) => {
		if (chrome.runtime.lastError || !bg) {
			pre.textContent = 'ProtoConsent v' + manifest.version + '\nCould not load debug data.';
			return;
		}
		const lines = [];

		lines.push('ProtoConsent v' + manifest.version);
		lines.push('  mode: ' + (bg.operatingMode === 'protoconsent' ? 'Monitoring' : 'Blocking'));
		lines.push('');

		if (bg.globalProfile) {
			lines.push('global profile: ' + bg.globalProfile);
			if (bg.globalPurposes) {
				lines.push('  ' + Object.entries(bg.globalPurposes)
					.map(([k, v]) => k + ':' + (v ? '\u2713' : '\u2717')).join('  '));
			}
			lines.push('');
		}

		if (bg.sessionKeys !== undefined) {
			lines.push('session storage: ' + bg.sessionKeys + ' keys');
		}
		lines.push('navigation guard: ' + (bg.navigatingTabs || 0) + ' tabs');
		lines.push('log ports: ' + (bg.logPorts || 0));
		lines.push('');

		if (bg.categoryDomains) {
			lines.push('blocklist sizes:');
			for (const [cat, info] of Object.entries(bg.categoryDomains).sort()) {
				lines.push('  ' + cat + ': ' + info);
			}
			lines.push('');
		}

		if (bg.enableIds) {
			lines.push('rulesets:');
			lines.push('  enabled:  ' + (bg.enableIds.join(', ') || '(none)'));
			lines.push('  disabled: ' + (bg.disableIds.join(', ') || '(none)'));
			lines.push('  dynamic: ' + bg.dynamicCount +
				' (' + bg.overrideCount + ' overrides, ' +
				bg.gpcGlobal + ' GPC global, ' + bg.gpcPerSite + ' GPC per-site)');
			if (bg.error) lines.push('  ERROR: ' + bg.error);
			if (bg.rulesetError) lines.push('  RULESET ERROR: ' + bg.rulesetError);
			lines.push('');
		}

		if (bg.selectiveTs) {
			lines.push('last selective rebuild: ' + (bg.selectiveCategories || []).join(', '));
			lines.push('  removed: ' + bg.selectiveRemoved + '  added: ' + bg.selectiveAdded +
				'  at: ' + new Date(bg.selectiveTs).toLocaleTimeString());
			lines.push('');
		}

		if (bg.overrideDetails && Object.keys(bg.overrideDetails).length) {
			lines.push('overrides:');
			for (const [id, detail] of Object.entries(bg.overrideDetails)) {
				lines.push('  rule ' + id + ': ' + detail);
			}
			lines.push('');
		}

		if (bg.customSites && bg.customSites.length) {
			lines.push('custom sites (' + bg.customSites.length + '): ' + bg.customSites.join(', '));
			lines.push('');
		}

		if (bg.whitelistDomainCount > 0) {
			lines.push('whitelist: ' + bg.whitelistDomainCount + ' domains (' +
				bg.whitelistGlobalCount + ' global, ' + bg.whitelistPerSiteCount + ' per-site), ' +
				bg.whitelistRuleCount + ' DNR rules');
			lines.push('');
		}

		if (bg.enhancedCount > 0 || bg.enhancedRules > 0) {
			lines.push('enhanced protection: ' + (bg.enhancedCount || 0) + ' lists, ' + (bg.enhancedRules || 0) + ' DNR rules');
			if (bg.enhancedListIds && bg.enhancedListIds.length) {
				lines.push('  lists: ' + bg.enhancedListIds.join(', '));
			}
		} else {
			lines.push('enhanced protection: off');
		}
		lines.push('');

		if (bg.hotfixDomainCount > 0) {
			lines.push('hotfix (safelist): ' + bg.hotfixDomainCount + ' domains, listener ' + (bg.hotfixListenerActive ? 'active' : 'inactive'));
			lines.push('');
		}

		if (bg.regionalLanguages) {
			if (bg.regionalLanguages.length > 0) {
				lines.push('regional: ' + bg.regionalLanguages.join(', '));
				const regEnabled = (bg.enhancedListIds || []).filter(id => id.startsWith('regional_'));
				const regAll = (bg.enhancedAllIds || []).filter(id => id.startsWith('regional_'));
				lines.push('  enabled: ' + regEnabled.length + ' / ' + regAll.length + ' downloaded');
				if (regEnabled.length > 0) {
					lines.push('  active: ' + regEnabled.join(', '));
				}
			} else {
				lines.push('regional: (none selected)');
			}
			lines.push('');
		}

		if (bg.cmpLists) {
			lines.push('Cookie banner management: ' + (bg.cmpLists.length > 0 ? bg.cmpLists.join(', ') : '(none)'));
			lines.push('');
		}

		if (bg.cosmeticGenericCount || bg.cosmeticDomainCount) {
			lines.push('cosmetic injection: ' + (bg.cosmeticGenericCount || 0) + ' generic, ' + (bg.cosmeticDomainCount || 0) + ' domain-specific');
			if (bg.cosmeticLists && bg.cosmeticLists.length) {
				lines.push('  lists: ' + bg.cosmeticLists.join(', '));
			}
			lines.push('');
		}

		if (bg.blockerDetect) {
			const bd = bg.blockerDetect;
			lines.push('blocker detection:');
			lines.push('  navCount: ' + bd.navCount + '  totalObserved: ' + bd.totalObserved);
			lines.push('  behavioralSignal: ' + bd.behavioralSignal + '  noBlockerWarning: ' + bd.noBlockerWarning);
			lines.push('  pathOnlyPatterns: ' + (bd.pathOnlyPatterns || 0) + '  pathAttrIndex: ' + (bd.pathAttrIndexSize || 0));
			lines.push('  live coverage: ' + bd.liveCoverageEntries + ' tabs, ' + bd.liveCoverageObserved + ' observed');
			lines.push('');
		}

		const consent = bg.dynamicListsConsent ? 'on' : 'off';
		lines.push('dynamic lists: consent ' + consent);
		lines.push('  source: ' + (bg.catalogSource || 'none'));
		if (bg.catalogLastFetched) {
			lines.push('  last load: ' + new Date(bg.catalogLastFetched).toISOString());
		}
		if (bg.catalogError) lines.push('  error: ' + bg.catalogError);
		lines.push('  catalog: local ' + (bg.catalogLocalCount || 0) + ', remote ' + (bg.catalogRemoteCount || 0));
		lines.push('');

		const cel = bg.consentEnhancedLink ? 'on' : 'off';
		lines.push('consent-enhanced link: ' + cel);
		if (bg.consentLinkedListIds && bg.consentLinkedListIds.length) {
			lines.push('  linked lists: ' + bg.consentLinkedListIds.join(', '));
		}
		lines.push('');

		if (bg.chStripping) {
			lines.push('client hints stripping: ' + bg.chStripping + ' (toggle: ' + (bg.chEnabled ? 'on' : 'off') + '), ' + (bg.chRules || 0) + ' DNR rules');
			lines.push('');
		}

		lines.push('URL param stripping: global ' + (bg.paramStripping ? 'on' : 'off') + ', per-site ' + (bg.paramStrippingSites ? 'on' : 'off'));
		lines.push('');

		if (typeof bg.interExtEnabled !== 'undefined') {
			lines.push('inter-extension API: ' + (bg.interExtEnabled ? 'on' : 'off'));
			if (bg.interExtEnabled) {
				lines.push('  allowlist: ' + bg.interExtAllowlist.length + '  pending: ' + bg.interExtPending.length + '  denylist: ' + bg.interExtDenylist.length);
			}
			lines.push('');
		}

		const errs = Array.isArray(bg.errors) ? bg.errors : [];
		if (errs.length) {
			lines.push('recent errors (' + errs.length + '):');
			for (const e of errs) {
				const ts = new Date(e.t).toLocaleTimeString();
				lines.push('  [' + ts + '] ' + e.scope + ': ' + e.msg);
			}
		} else {
			lines.push('recent errors: none');
		}
		lines.push('');

		pre.textContent = lines.join('\n');
	});
}
