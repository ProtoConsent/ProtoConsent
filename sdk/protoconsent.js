// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: MIT

// ProtoConsent SDK v0.2.2
//
// Purpose-signalling SDK for web pages to read user consent preferences
// from the ProtoConsent browser extension.
//
// Quick start:
//
//   import ProtoConsent from './protoconsent.js';
//
//   // Check whether analytics is allowed on this site
//   const allowed = await ProtoConsent.get('analytics');
//   if (allowed) {
//     // load analytics scripts
//   }
//
//   // Read all purpose states at once
//   const all = await ProtoConsent.getAll();
//   // → { functional: true, analytics: false, ads: false, ... }
//
//   // Read the active profile
//   const profile = await ProtoConsent.getProfile();
//   // → "strict", "balanced", "permissive", or null
//
// Every method returns a Promise. If the extension is not installed,
// all calls resolve to null — no errors, no side effects.
//
// See design/protocol-draft.md for the protocol specification.

const VERSION = '0.2.2';

const PURPOSES = Object.freeze([
	'functional',
	'analytics',
	'ads',
	'personalization',
	'third_parties',
	'advanced_tracking'
]);

/**
 * Pending queries awaiting a response from the extension content script.
 * Maps message ID → { resolve, timer }.
 */
const PENDING = new Map();

/**
 * Time in milliseconds to wait for a response before assuming
 * the extension is not installed or not responding.
 */
const TIMEOUT_MS = 500;

/**
 * Query the ProtoConsent extension via window.postMessage.
 *
 * Protocol:
 * 1. SDK posts { type: 'PROTOCONSENT_QUERY', id, action, ...payload }
 * 2. Extension content script receives it and reads chrome.storage.local
 * 3. Content script posts { type: 'PROTOCONSENT_RESPONSE', id, data }
 * 4. SDK resolves the matching promise
 *
 * If no response arrives within TIMEOUT_MS, resolves to null
 * (extension not installed or content script not present).
 *
 * @param {string} action - 'get', 'getAll', or 'getProfile'
 * @param {object} payload - additional fields (e.g. { purpose: 'analytics' })
 * @returns {Promise<*>} The response data, or null on timeout.
 */
function _queryExtension(action, payload) {
	try {
		return new Promise((resolve) => {
			const id = crypto.randomUUID();
			const timer = setTimeout(() => {
				PENDING.delete(id);
				resolve(null);
			}, TIMEOUT_MS);

			PENDING.set(id, { resolve, timer });

			window.postMessage({
				type: 'PROTOCONSENT_QUERY',
				id,
				action,
				...payload
			}, window.location.origin);
		});
	} catch (_) {
		return Promise.resolve(null);
	}
}

// Listen for responses from the extension content script
if (typeof window !== 'undefined') {
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		if (!event.data || event.data.type !== 'PROTOCONSENT_RESPONSE') return;

		const pending = PENDING.get(event.data.id);
		if (pending) {
			clearTimeout(pending.timer);
			PENDING.delete(event.data.id);
			pending.resolve(event.data.data);
		}
	});
}

/**
 * Check whether a specific purpose is allowed for the current domain.
 *
 * @param {string} purpose - One of the valid purpose keys.
 * @returns {Promise<boolean|null>} true = allowed, false = denied, null = unknown.
 * @throws {Error} If purpose is not a valid key.
 */
function get(purpose) {
	if (!PURPOSES.includes(purpose)) {
		return Promise.reject(new Error(
			`Invalid purpose "${purpose}". Valid purposes: ${PURPOSES.join(', ')}`
		));
	}
	return _queryExtension('get', { purpose });
}

/**
 * Get all purpose states for the current domain.
 *
 * @returns {Promise<object|null>} Object with a boolean property per purpose, or null.
 */
function getAll() {
	return _queryExtension('getAll', {});
}

/**
 * Get the active profile for the current domain.
 *
 * @returns {Promise<string|null>} "strict", "balanced", "permissive", or null.
 */
function getProfile() {
	return _queryExtension('getProfile', {});
}

const ProtoConsent = Object.freeze({
	version: VERSION,
	purposes: PURPOSES,
	get,
	getAll,
	getProfile
});

globalThis.ProtoConsent = ProtoConsent;

export default ProtoConsent;
