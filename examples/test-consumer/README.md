# ProtoConsent API Tester

Minimal browser extension to test the [ProtoConsent inter-extension API](../../design/spec/inter-extension-protocol.md). Use it to verify that another extension can query user consent preferences via `chrome.runtime.sendMessage`.

## Setup

1. Open `chrome://extensions` (or the equivalent in your browser).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this `test-consumer` folder.
4. Open ProtoConsent's settings and enable the **Inter-Extension API**.
5. Open the test consumer popup, paste the ProtoConsent extension ID, and click any button.

The first request from a new extension triggers a `need_authorization` error. Go to ProtoConsent's Purpose Settings page and approve the test consumer in the Inter-Extension section. Subsequent requests will succeed.

## Buttons

| Button | What it does |
|--------|-------------|
| **Capabilities** | Sends `protoconsent:capabilities` and logs the supported types and purposes. |
| **Query consent** | Sends `protoconsent:query` for the domain in the text field. |
| **Unknown type** | Sends an unknown message type to test `unknown_type` error handling. |
| **Invalid domain** | Sends a query with an invalid domain to test `invalid_domain` validation. |
| **Rate limit test (15x)** | Fires 15 rapid queries to test rate limiting (10/min threshold). |
| **Clear log** | Clears the log panel. |

## Notes

- The extension ID is persisted in local storage so you only need to paste it once.
- If a request gets no response (silent drop), the extension is likely on ProtoConsent's denylist or hit the global unknown-ID cooldown.
- This extension requires no host permissions; it only uses `storage` to remember the target ID.
