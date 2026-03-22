# ProtoConsent API Draft

This document is part of the ProtoConsent project and is licensed under the Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) license. See the repository README and the [LICENSE-CC-BY-SA](../LICENSE-CC-BY-SA) file for details.

## Core Endpoints

### 1. Configuration

### 2. Import/Export

### 3. Validation

### 4. Audit/Logs

## API Principles
- Stateless, RESTful endpoints
- All responses in JSON (except for file exports)
- Versioned under `/v1/` path

## Example: Minimal Configuration
```json
{
	"purposes": [
		{ "id": "functional", "label": "Functional", "description": "...", "children": [] }
	]
}
```

---
This draft is a starting point for the public API. Next: refine endpoints, add authentication, and document integration flows for SDKs and third-party tools.