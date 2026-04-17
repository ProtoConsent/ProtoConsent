# ProtoConsent Inter-Extension Protocol (Draft)

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../../LICENSE-CC-BY-SA) file for details.

## 1. Overview

This document specifies the inter-extension communication protocol for ProtoConsent. It defines how other browser extensions can query the user's consent state via `chrome.runtime.sendMessage`. ProtoConsent acts as a read-only **consent provider**; consumer extensions can read preferences but never modify them.

The protocol reuses the same data model and purpose definitions described in [data-model.md](data-model.md).

**Status:** draft.

## Contents

- [ProtoConsent Inter-Extension Protocol (Draft)](#protoconsent-inter-extension-protocol-draft)
  - [1. Overview](#1-overview)
  - [Contents](#contents)
  - [2. Architecture](#2-architecture)
  - [3. Message Types](#3-message-types)
  - [4. Discovery](#4-discovery)
  - [5. Security Model](#5-security-model)
  - [6. Cross-Browser Compatibility](#6-cross-browser-compatibility)

## 2. Architecture

```text
 Consumer extension                        ProtoConsent extension
 ┌────────────────┐  sendMessage(extId)   ┌────────────────┐  chrome.storage  ┌─────────┐
 │  Background /  │ ────────────────────→ │ onMessageExt.  │ ←──────────────→ │ Storage │
 │  Service worker│                       │ (background)   │                  │ (local) │
 │                │ ←──────────────────── │                │                  └─────────┘
 └────────────────┘  sendResponse         └────────────────┘
```

Communication uses `chrome.runtime.sendMessage(targetExtensionId, message)` on the sender side and `chrome.runtime.onMessageExternal` on the receiver. The browser verifies `sender.id`; it cannot be spoofed.

## 3. Message Types

All messages use a `type` field prefixed with `protoconsent:`.

**Capabilities discovery** — the consumer asks what the provider supports:

```json
{ "type": "protoconsent:capabilities" }
```

Response:

```json
{
  "type": "protoconsent:capabilities_response",
  "name": "ProtoConsent",
  "version": "0.4.0",
  "protocol_version": "0.1",
  "supported_types": ["protoconsent:query", "protoconsent:capabilities"],
  "purposes": ["functional", "analytics", "ads", "personalization", "third_parties", "advanced_tracking"]
}
```

**Consent query** — the consumer queries consent state for a domain:

```json
{
  "type": "protoconsent:query",
  "domain": "example.com"
}
```

Response:

```json
{
  "type": "protoconsent:response",
  "domain": "example.com",
  "purposes": {
    "functional": true,
    "analytics": false,
    "ads": false,
    "personalization": true,
    "third_parties": false,
    "advanced_tracking": false
  },
  "profile": "balanced",
  "version": "0.4.0"
}
```

All six purposes are always returned, regardless of which the consumer is interested in.

**Error** — returned for invalid, unauthorized, or rate-limited queries:

```json
{
  "type": "protoconsent:error",
  "error": "need_authorization",
  "message": "Extension not authorized. The user must approve this extension in ProtoConsent settings."
}
```

Error codes: `disabled`, `need_authorization`, `invalid_domain`, `rate_limited`, `unknown_type`, `internal`.

## 4. Discovery

The sender must know ProtoConsent's extension ID. Options:

- **Chrome Web Store ID**: stable across all installs. Consumer extensions can hardcode it.
- **User-configurable**: the consumer extension stores the provider ID as a setting.
- **Probe**: the consumer sends `protoconsent:capabilities` to a list of known IDs and uses the one that responds.

If ProtoConsent is not installed, `chrome.runtime.sendMessage` sets `chrome.runtime.lastError` with "Could not establish connection." Consumers should handle this gracefully.

## 5. Security Model

- **Opt-in master switch**: the inter-extension API is disabled by default. The user must explicitly enable it in ProtoConsent's settings (`interExtEnabled` in storage). When disabled, a `disabled` error is returned (not a silent drop), so legitimate developers can diagnose the issue. Toggling the switch off and on preserves the allowlist, denylist, and pending queue — it only stops and resumes message processing.
- **TOFU allowlist (Trust on First Use)**: even when the API is enabled, each consumer extension must be individually approved by the user. On first contact from an unknown extension, ProtoConsent stores a pending authorization request and responds with a `need_authorization` error. The user can then approve or deny the extension via the settings UI. Approved extension IDs are stored in `interExtAllowlist`. This prevents silent probing by untrusted extensions.
- **Denylist**: when the user explicitly denies an extension, its ID is moved to `interExtDenylist`. Future messages from denied extensions are silently dropped — no response is sent, giving the attacker no signal that ProtoConsent is active.
- **Pending queue cap**: the pending authorization queue is capped at 10 entries. When full, new unknown extensions are silently ignored (not queued) to prevent an attacker from evicting legitimate pending requests that the user has not yet reviewed. The user must clear or act on pending entries before new ones can be recorded.
- **Global unknown-ID cooldown**: a maximum of 3 new unknown extension IDs are processed per minute. Beyond this threshold, messages from unknown extensions are silently dropped. This prevents flooding attacks where a malicious actor generates many fake extension IDs to overwhelm the user with authorization prompts.
- **Read-only**: the listener only reads storage. There is no code path from external messages to storage writes or rule rebuilds.
- **Domain validation**: the `domain` field is validated with the same hostname regex used for all internal domain handling.
- **Rate limiting**: 10 requests per minute per sender extension. Exceeded requests receive a `rate_limited` error.
- **Sender verification**: `sender.id` is provided by the browser and cannot be forged. It is used for rate limiting, allowlist matching, and denylist filtering.
- **No bulk queries**: one domain per request. There is no endpoint to retrieve all stored rules.
- **Bounded response**: the response contains only the fixed six-purpose schema, a profile name, and a version string. No user-controlled data beyond the echoed domain.
- **No intrusive prompts**: authorization requests are queued silently and reviewed at the user's discretion via the settings UI. This eliminates clickjacking vectors from automated popup windows.

The user manages the allowlist, denylist, and pending queue from the Purpose Settings page, which provides a master switch and per-extension Allow / Block / Revoke / Unblock controls. All inter-extension events (successes, errors, rate limits) are also visible in the Log tab's Requests stream, colour-coded and timestamped, so the user can observe API activity after the fact. Silent drops (denylist, global cooldown) are not logged. See [architecture.md §12.4–12.5](../architecture.md#124-management-ui) for implementation details.

## 6. Cross-Browser Compatibility

| Browser | `onMessageExternal` | `externally_connectable` | Notes |
|---------|---------------------|--------------------------|-------|
| Chrome  | Supported           | Supported (omit = all allowed) | Default behaviour when key is absent: all extensions can send. |
| Firefox | Supported           | **Not supported** (ignored) | All extensions can always send. Runtime `sender.id` validation works identically. Requires `browser_specific_settings.gecko.id` for a stable extension ID. |

ProtoConsent omits `externally_connectable` from the manifest, giving identical open-access behaviour on both browsers. Security is enforced at runtime (opt-in toggle, per-extension allowlist, rate limiting, input validation), not at the manifest level.

## 7. Test Consumer

A minimal test extension is available at [`examples/test-consumer/`](../../examples/test-consumer/) to test the inter-extension API interactively. It sends capabilities queries, consent queries, invalid inputs, and rate-limit tests, and logs responses in a popup panel. See the [README](../../examples/test-consumer/README.md) for setup instructions.
