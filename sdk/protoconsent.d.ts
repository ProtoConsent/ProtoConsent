/**
 * Copyright (C) 2026 ProtoConsent contributors
 * SPDX-License-Identifier: MIT
 * 
 * ProtoConsent SDK type declarations.
 *
 * Provides TypeScript types for the ProtoConsent browser extension SDK.
 * Use alongside protoconsent.js (ES module or script tag).
 *
 */

/** Valid purpose keys recognised by ProtoConsent. */
export type Purpose =
	| 'functional'
	| 'analytics'
	| 'ads'
	| 'personalization'
	| 'third_parties'
	| 'advanced_tracking';

/** Profile names corresponding to predefined presets. */
export type Profile = 'strict' | 'balanced' | 'permissive';

/** Object mapping every purpose to its allowed/denied state. */
export type PurposeStates = Record<Purpose, boolean>;

interface ProtoConsentSDK {
	/** SDK version string. */
	readonly version: string;

	/** Array of valid purpose keys. */
	readonly purposes: readonly Purpose[];

	/**
	 * Check whether a specific purpose is allowed for the current domain.
	 *
	 * @param purpose - One of the valid purpose keys.
	 * @returns `true` if allowed, `false` if denied, `null` if extension is not present.
	 */
	get(purpose: Purpose): Promise<boolean | null>;

	/**
	 * Get all purpose states for the current domain.
	 *
	 * @returns Object with a boolean property per purpose, or `null` if extension is not present.
	 */
	getAll(): Promise<PurposeStates | null>;

	/**
	 * Get the active profile for the current domain.
	 *
	 * @returns Profile name, or `null` if extension is not present.
	 */
	getProfile(): Promise<Profile | null>;
}

declare const ProtoConsent: ProtoConsentSDK;
export default ProtoConsent;
