# TradeRep Pro — SMS Proxy Server

Python HTTP server that sits between your Flutter app and Twilio. Credentials never touch the client.

## How It Works

```
Flutter App  →  POST /sms/send  →  This Server  →  Twilio (or mock)
```

- **Mock mode** (default): Simulates sends, 90% delivery rate, no Twilio account needed
- **Live mode**: Calls real Twilio API — flip one env var, no code changes

---

## Deploy to Railway

### 1. Create a new Railway project

Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
(or use **Empty Service** + Railway CLI)

### 2. Connect this folder as your repo

Push `traderep_backend/` contents to a GitHub repo, then connect it in Railway.

Or use the Railway CLI:
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 3. Set Environment Variables

In Railway Dashboard → your service → **Variables** tab, add:

| Variable | Required | Description |
|---|---|---|
| `MOCK_MODE` | ✅ | `true` = simulate (safe default), `false` = real Twilio |
| `TWILIO_ACCOUNT_SID` | When live | Your Twilio Account SID (starts with AC) |
| `TWILIO_AUTH_TOKEN` | When live | Your Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | When live | Your Twilio number in E.164 format (`+1XXXXXXXXXX`) |
| `GOOGLE_REVIEW_LINK` | Optional | Your Google review URL (default placeholder used if omitted) |
| `PORT` | Auto | Set automatically by Railway — **do not set manually** |

> `requirements.txt` includes `twilio>=8.0.0`. It installs automatically.
> When `MOCK_MODE=true`, the twilio package is imported lazily — no real calls are made.

### 4. Verify Deployment

Once deployed, Railway gives you a public URL like:
```
https://traderep-sms-production.up.railway.app
```

Test the health endpoint:
```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "TradeRep Pro SMS API",
  "mock_mode": true,
  "twilio_configured": false,
  "messages_sent": 0,
  "google_review_link": "https://g.page/r/review"
}
```

---

## Update Flutter App

After Railway is live, update `_baseUrl` in your Flutter app:

**File**: `lib/shared/services/sms_service.dart`

```dart
// Before (sandbox local mock):
static const String _baseUrl = 'http://localhost:5061';

// After (Railway deployment):
static const String _baseUrl = 'https://YOUR-RAILWAY-URL.up.railway.app';
```

Then rebuild the Flutter web app and APK.

---

## API Endpoints

### `GET /health`
Health check — shows current mode and config status.

### `GET /sms/config`
Returns safe config info (phone number masked, no secrets exposed).

### `GET /sms/log`
Returns all SMS messages sent this session (in-memory, resets on redeploy).

### `GET /sms/status/{id}`
Lookup a specific message by `id` or Twilio `sid`.

### `POST /sms/send`
Send an SMS.

**Request body:**
```json
{
  "to_phone": "+17205551234",
  "body": "Hi Sarah! Your lawn service is scheduled for tomorrow at 9am. – TradeRep Pro",
  "job_id": "job_001",
  "template_key": "status_scheduled",
  "customer_name": "Sarah",
  "type": "status_update"
}
```

**Response (success):**
```json
{
  "success": true,
  "message": {
    "id": "uuid",
    "sid": "MOCK_XXXXXXXXXX",
    "job_id": "job_001",
    "to": "+17205551234",
    "body": "...",
    "status": "delivered",
    "is_mock": true,
    "sent_at": "2025-01-01T00:00:00+00:00"
  }
}
```

---

## Switch to Live Twilio

1. In Railway Variables, set:
   ```
   MOCK_MODE=false
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
   ```
2. **Redeploy** (Railway does this automatically when you save variables)
3. Test `/health` — `mock_mode` should now be `false` and `twilio_configured` should be `true`

No code changes required anywhere.

---

## Local Development

```bash
# Copy and fill in your env vars
cp .env.example .env

# Run locally (mock mode by default)
python sms_server.py

# Server starts on http://localhost:8080
# Test: curl http://localhost:8080/health
```

---

## File Structure

```
traderep_backend/
├── sms_server.py      # Main server — all logic in one file
├── requirements.txt   # twilio (optional for mock mode)
├── Procfile           # Railway process declaration
├── railway.toml       # Railway build + deploy config
├── .gitignore         # Excludes .env and caches
├── .env.example       # Copy to .env for local dev
└── README.md          # This file
```
