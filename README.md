# n8n-nodes-tuya-smartlife

An n8n community node for controlling **Tuya Smart Life** devices — no developer account required. Authentication works via a one-time QR code scan in the Smart Life app, using the same API as the official Home Assistant Tuya integration.

---

## Installation

### Option A — n8n Community Node UI (recommended)

1. Open n8n → **Settings → Community Nodes**
2. Click **Install**
3. Enter `n8n-nodes-tuya-smartlife`
4. Confirm and restart n8n

### Option B — Manual (self-hosted n8n)

```bash
# In your n8n custom extensions directory:
git clone https://github.com/Fh26697/n8n-nodes-tuya-smartlife
cd n8n-nodes-tuya-smartlife
npm install
npm run build
```

Then set the environment variable so n8n picks up the node:

```bash
export N8N_CUSTOM_EXTENSIONS=/path/to/n8n-nodes-tuya-smartlife
```

---

## Setup: One-Time QR Login

Because this node uses the Smart Life consumer API (not a developer API key), authentication is done once via QR code. Your credentials then stay valid via automatic token refresh.

**Step 1 — Find your User Code**

Open the **Smart Life** app → tap **Me** (bottom right) → tap the ⚙️ gear icon → **Account and Security** → **User Code**. Copy the code.

**Step 2 — Create the credential**

In n8n go to **Credentials → Add Credential → Tuya Smart Life API** and enter:
- **App Client ID** — leave the pre-filled default as-is unless you have your own Tuya app registration
- **User Code** — the code from Step 1
- **Region** — select your region (EU / US / CN)

Leave the token fields empty for now.

**Step 3 — Generate the QR code**

Add a **Tuya Smart Life** node to a workflow, set:
- Resource: `Setup`
- Operation: `Generate QR Code`

Execute the node. The output contains a `qrcode` field (a Base64 PNG image) and a `token` field.

**Step 4 — Scan with the Smart Life app**

Open **Smart Life** app → tap the **scan icon** (top right on the Home screen) → scan the QR code displayed in n8n.

**Step 5 — Complete the login**

Add a second **Tuya Smart Life** node:
- Resource: `Setup`
- Operation: `Complete Login`
- QR Token: paste the `token` value from Step 3

Execute the node. It polls the API every 2 seconds (up to 60 seconds) until the scan is confirmed. On success the output contains `accessToken`, `refreshToken`, `expireTime`, `uid`, and `terminalId`.

**Step 6 — Save the tokens**

Copy those five values back into your **Tuya Smart Life API** credential fields and save. You are now logged in. The tokens refresh automatically when they expire.

---

## Operations

### Resource: Setup

| Operation | Description | Parameters |
|---|---|---|
| Generate QR Code | Creates a login QR code | — |
| Complete Login | Polls until QR code is scanned | **QR Token** (from Generate QR Code) |

### Resource: Devices

| Operation | Description | Parameters |
|---|---|---|
| Get All | Returns all devices in your home | — |
| Get Status | Returns the current status codes of one device | **Device ID** |

### Resource: Device

| Operation | Description | Parameters |
|---|---|---|
| Send Command | Sends one or more commands to a device | **Device ID**, **Commands (JSON)** |

**Commands format:**

```json
[
  { "code": "switch_1", "value": true },
  { "code": "bright_value", "value": 500 }
]
```

Common codes: `switch_1` (on/off), `bright_value` (brightness 10–1000), `temp_value` (color temperature), `colour_data` (color in HSV JSON).

---

## How It Works

This node reverse-engineers the request-signing protocol of the official **Tuya Device Sharing SDK** that powers the Home Assistant Tuya integration. No Tuya developer account or IoT platform registration is needed.

The signing algorithm:
1. Each request generates a random UUID (`rid`) and derives a per-request AES-128-GCM key via `HMAC-SHA256(key=rid, msg=MD5(rid + refreshToken))`.
2. Query parameters and the request body are AES-GCM encrypted before being sent.
3. A signature over the request headers and encrypted payloads (HMAC-SHA256) is attached as `X-sign`.

All cryptography uses **Node.js built-in `crypto` only** — no additional dependencies.

---

## Credits & Sources

| What | Where |
|---|---|
| **Tuya Device Sharing SDK** (Python) — original signing implementation | https://github.com/tuya/tuya-device-sharing-sdk |
| **n8n Community Node API** | https://docs.n8n.io/integrations/creating-nodes/ |

This node is an independent TypeScript re-implementation and is not affiliated with or endorsed by Tuya Inc. or the Home Assistant project.

---

## License

MIT — see [LICENSE](./LICENSE)
