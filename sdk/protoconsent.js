// Copyright (C) 2026 ProtoConsent contributors
// Licensed under the MIT License. See the LICENSE file in this directory for details.

// ProtoConsent SDK v0.1.0-alpha
//
// Purpose-signalling SDK for web pages to read user consent preferences
// from the ProtoConsent browser extension.
//
// Usage (ES module):
//   import ProtoConsent from './protoconsent.js';
//   const allowed = await ProtoConsent.get('analytics');
//
// Usage (script tag):
//   <script type="module" src="protoconsent.js"></script>
//   <script type="module">
//     const allowed = await window.ProtoConsent.get('analytics');
//   </script>
//
// Status: alpha — API surface defined, messaging not yet implemented.
// See design/protocol-draft.md for the protocol specification.

const VERSION = '0.1.0-alpha';

const PURPOSES = Object.freeze([
	'functional',
	'analytics',
	'ads',
	'personalization',
	'third_parties',
	'advanced_tracking'
]);

/**
 * Query the ProtoConsent extension via window.postMessage.
 *
 * The intended protocol (not yet implemented):
 * 1. SDK posts { type: 'PROTOCONSENT_QUERY', id, action, ...payload }
 * 2. Extension content script receives it and reads chrome.storage.local
 * 3. Content script posts { type: 'PROTOCONSENT_RESPONSE', id, data }
 * 4. SDK resolves the matching promise
 *
 * TODO: Implement postMessage query with timeout and response matching.
 * TODO: Implement extension content script that bridges page <-> storage.
 *
 * @param {string} _action - 'get', 'getAll', or 'getProfile'
 * @param {object} _payload - additional fields (e.g. { purpose: 'analytics' })
 * @returns {Promise<*>} Currently resolves to null (extension not detected).
 */
function _queryExtension(_action, _payload) {
	return Promise.resolve(null);
}

/**
 * Check whether a specific purpose is allowed for the current domain.
 *
 * @param {string} purpose - One of the 6 valid purpose keys.
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
 * @returns {Promise<object|null>} Object with 6 boolean properties, or null.
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
