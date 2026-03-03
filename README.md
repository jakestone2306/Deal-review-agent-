# Adapt Demo Review Server

Automatically scores every Adapt Demo call the moment Fathom finishes processing it.
Delivers results to HubSpot (note on deal), Slack (DM to rep), and Gmail (email to manager).

## How it works

```
Fathom finishes processing a call
        ↓
Fires webhook → this server
        ↓
Fetches raw transcript from Fathom API
        ↓
Scores against 7 criteria using Claude AI
        ↓
Delivers simultaneously to:
  • HubSpot — note on deal + contact
  • Slack   — DM to rep
  • Gmail   — email to Jake
```

Total time from call ending to delivery: ~2-3 minutes.

---

## Deploy to Render.com (10 minutes)

### Step 1 — Push to GitHub

1. Create a new GitHub repo (private is fine)
2. Upload all files from this folder
3. Push to main

### Step 2 — Create Render Web Service

1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects the settings from `render.yaml`
5. Click **Create Web Service**

### Step 3 — Add Environment Variables

In Render dashboard → your service → **Environment**, add these:

| Variable | Where to find it |
|----------|-----------------|
| `FATHOM_API_KEY` | Fathom → Settings → API |
| `FATHOM_WEBHOOK_SECRET` | Fathom → Settings → Webhooks (after creating the webhook) |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot → Settings → Private Apps → Create app → copy token |
| `SLACK_BOT_TOKEN` | api.slack.com → Your Apps → OAuth Tokens (starts with `xoxb-`) |
| `GMAIL_REFRESH_TOKEN` | See Gmail setup below (optional) |
| `GMAIL_CLIENT_ID` | See Gmail setup below (optional) |
| `GMAIL_CLIENT_SECRET` | See Gmail setup below (optional) |

### Step 4 — Get your public URL

After deploy, Render gives you a URL like:
`https://adapt-demo-review-server.onrender.com`

Your webhook endpoint is:
`https://adapt-demo-review-server.onrender.com/webhook/fathom`

### Step 5 — Register webhook in Fathom

1. Go to **Fathom → Settings → Webhooks**
2. Click **Add Webhook**
3. URL: `https://adapt-demo-review-server.onrender.com/webhook/fathom`
4. Events: select **recording.completed**
5. Copy the signing secret → paste as `FATHOM_WEBHOOK_SECRET` in Render
6. Save

That's it. Every Adapt Demo call now auto-reviews the moment it's processed.

---

## HubSpot Private App Token

1. HubSpot → Settings → Integrations → Private Apps
2. **Create a private app**
3. Name: "Adapt Demo Review"
4. Scopes needed:
   - `crm.objects.notes.write`
   - `crm.objects.notes.read`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
5. Copy the access token

---

## Slack Bot Token

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. **Create New App → From scratch**
3. Name: "Adapt Demo Review"
4. Workspace: Adapt Insurance
5. Go to **OAuth & Permissions**
6. Add Bot Token Scopes: `chat:write`, `chat:write.public`
7. **Install to workspace**
8. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

---

## Gmail Setup (optional)

If you'd prefer emails to send directly (not drafts), set up Gmail OAuth:

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable Gmail API
3. Create OAuth 2.0 credentials → Desktop app
4. Copy Client ID and Client Secret
5. Run this once locally to get a refresh token:

```bash
node get-gmail-token.js
```

Follow the prompts, authorize with Jake's Google account, and copy the refresh token.

If Gmail env vars are not set, the server simply skips email (HubSpot + Slack still work).

---

## Test it manually

Once deployed, trigger a review directly:

```bash
curl -X POST https://adapt-demo-review-server.onrender.com/review/126417834
```

Replace `126417834` with any Fathom recording ID.

Check health:
```bash
curl https://adapt-demo-review-server.onrender.com/health
```

---

## Logs

In Render dashboard → your service → **Logs** — you'll see every step of every review in real time.
