// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// About tab: version, credits from config/credits.json

function initAboutSection() {
	const versionEl = document.getElementById('about-version');
	if (versionEl) {
		versionEl.textContent = 'ProtoConsent v' + chrome.runtime.getManifest().version;
	}

	const container = document.getElementById('credits-list');
	const section = document.getElementById('credits-section');
	if (!container || !section) return;

	fetch(chrome.runtime.getURL('config/credits.json'))
		.then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
		.then(data => {
			for (const group of data.sections) {
				const details = document.createElement('details');
				details.className = 'ps-accordion';

				const summary = document.createElement('summary');
				summary.className = 'ps-accordion-header';
				summary.textContent = group.title;
				details.appendChild(summary);

				const body = document.createElement('div');
				body.className = 'ps-accordion-body';

				for (const entry of group.entries) {
					const row = document.createElement('div');
					row.className = 'ps-credit-entry';

					const link = document.createElement('a');
					link.className = 'ps-credit-name';
					link.href = entry.url;
					link.target = '_blank';
					link.rel = 'noopener noreferrer';
					link.textContent = entry.name;
					row.appendChild(link);

					if (entry.by) {
						const by = document.createElement('span');
						by.className = 'ps-credit-by';
						by.textContent = ' by ' + entry.by;
						row.appendChild(by);
					}

					if (entry.license) {
						const license = document.createElement('span');
						license.className = 'ps-credit-license';
						license.textContent = ' - ' + entry.license;
						row.appendChild(license);
					}

					if (entry.usage) {
						const usage = document.createElement('span');
						usage.className = 'ps-credit-usage';
						usage.textContent = ' - ' + entry.usage;
						row.appendChild(usage);
					}

					body.appendChild(row);
				}

				details.appendChild(body);
				container.appendChild(details);
			}

			section.classList.remove('ps-hidden');
		})
		.catch(err => {
			console.warn('ProtoConsent: failed to load credits.json:', err);
		});
}
