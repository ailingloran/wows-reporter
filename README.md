# WoWS Discord Reporting Bot

Automated community reporting bot for World of Warships Discord servers. Posts daily and monthly statistics, runs AI-powered community sentiment analysis, and provides a searchable message database with a conversational Q&A interface.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Create the Discord Bot](#step-1--create-the-discord-bot)
4. [Step 2 — Get Your Statbot API Key](#step-2--get-your-statbot-api-key)
5. [Step 3 — Set Up the VPS](#step-3--set-up-the-vps)
6. [Step 4 — Deploy](#step-4--deploy)
7. [Step 5 — Configure .env](#step-5--configure-env)
8. [Step 6 — Build & First Run](#step-6--build--first-run)
9. [Step 7 — Run with PM2](#step-7--run-with-pm2)
10. [Day-to-Day Operations](#day-to-day-operations)
11. [Runtime Settings Panel](#runtime-settings-panel)
12. [Slash Commands](#slash-commands)
13. [File Structure](#file-structure)
14. [Troubleshooting](#troubleshooting)

---

## What It Does

| Feature | Description |
|---|---|
| **Daily Report** | Auto-posts at configurable hour (default 00:00 CET). Messages, active members, joins/leaves, @Player role count, top hotspot channels — all with delta vs previous day. |
| **Monthly Report** | Posts on the 1st of each month. Full month aggregates, channel movers, keyword theme breakdown. Requires staff approval via Discord buttons before publishing. |
| **Community Pulse** | Daily AI-generated sentiment analysis (default 17:00 CET). Topics, pain points (with recurring detection), positives, insightful minority highlight, mood score 1–5. Powered by OpenAI GPT-4o-mini. |
| **Community Chat** | Ask any question about recent player discussions. Uses FTS5 full-text search across the indexed message database + two-pass GPT Q&A with session context. |
| **Message Indexer** | Real-time Discord message archiver with FTS5 full-text search. Backfill up to 30 days. Feeds both Community Pulse and Community Chat. |
| **@Player Role Tracker** | Listens to Gateway events to track every @Player role addition/removal in real-time. Nightly snapshots for trend reporting. |
| **Web Dashboard** | Password-protected Express API on port 3000. Powers the dockworks.dev admin panel (stats, pulse reports, chat history, settings). |
| **Runtime Settings** | Change report hours, toggle delivery, update channel IDs — all without redeploying. |

---

## Prerequisites

- A **VPS** running Linux (Ubuntu 22.04+)
- A **Discord account** with admin access to your server
- **Statbot** added to your Discord server (https://statbot.net)
- An **OpenAI API key** (for Community Pulse and Community Chat — optional, bot runs without it)
- Basic SSH comfort

---

## Step 1 — Create the Discord Bot

### 1.1 Create the Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name → **Create**

### 1.2 Create the Bot Token

1. In the sidebar, click **Bot**
2. Click **Add Bot** → **Yes, do it!**
3. Under **Token**, click **Reset Token** → copy it. This is `DISCORD_BOT_TOKEN`.

### 1.3 Enable Privileged Intents

On the **Bot** page, scroll to **Privileged Gateway Intents** and enable:

- **GUILD MEMBERS** — required for @Player role tracking
- **MESSAGE CONTENT** — required for message indexing

Click **Save Changes**.

### 1.4 Invite the Bot

1. Go to **OAuth2** → **URL Generator**
2. Scopes: `bot`, `applications.commands`
3. Bot Permissions: `Send Messages`, `Embed Links`, `Read Message History`, `View Channels`, `Use External Emojis`, `Manage Threads`
4. Copy the generated URL and open it in your browser to invite the bot.

### 1.5 Collect IDs

Enable **Developer Mode** in Discord (User Settings → Advanced → Developer Mode), then right-click to copy:

| Value | How to get it |
|---|---|
| `STATBOT_GUILD_ID` | Right-click server icon → Copy Server ID |
| `DISCORD_STAFF_CHANNEL_ID` | Right-click daily report channel → Copy Channel ID |
| `DISCORD_MONTHLY_CHANNEL_ID` | Right-click monthly report channel → Copy Channel ID |
| `DISCORD_PLAYER_ROLE_ID` | Server Settings → Roles → right-click @Player → Copy Role ID |
| `DISCORD_STAFF_ROLE_IDS` | Same way, for each staff role |
| `DISCORD_ADMIN_ROLE_IDS` | Same way, for admin roles (Community Pulse commands) |
| `SENTIMENT_CHANNEL_IDS` | Right-click each channel to index → Copy Channel ID (comma-separated) |

---

## Step 2 — Get Your Statbot API Key

1. Go to https://statbot.net/dashboard
2. Select your server
3. Click your profile → **API Keys**
4. Generate a new key. This is `STATBOT_API_KEY`.

---

## Step 3 — Set Up the VPS

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Install SQLite tools (optional, for manual DB inspection)
sudo apt install -y sqlite3
```

---

## Step 4 — Deploy

### Clone the repo

```bash
cd ~
git clone https://github.com/ailingloran/wows-reporter.git wows-reporter
cd wows-reporter
```

### Install dependencies

```bash
npm install
```

### Create the data directory and mount point for the message DB

```bash
mkdir -p data
# If using a Hetzner volume for messages.db, mount it at /mnt/HC_Volume_... first
# The MESSAGE_DB_PATH env var controls where messages.db is stored
```

---

## Step 5 — Configure .env

```bash
cp .env.example .env
nano .env
```

```env
# ── Statbot ──────────────────────────────────────────────────────────────────
STATBOT_API_KEY=abc123...
STATBOT_GUILD_ID=123456789012345678

# ── Discord ──────────────────────────────────────────────────────────────────
DISCORD_BOT_TOKEN=MTA...
DISCORD_STAFF_CHANNEL_ID=111111111111111111      # Daily reports post here
DISCORD_MONTHLY_CHANNEL_ID=222222222222222222    # Monthly reports post here
DISCORD_PLAYER_ROLE_ID=333333333333333333        # @Player role to track
DISCORD_STAFF_ROLE_IDS=444444444444444444        # Staff roles (comma-separated)
DISCORD_ADMIN_ROLE_IDS=555555555555555555        # Admin roles for /sentiment commands

# ── Community Pulse (AI sentiment) ───────────────────────────────────────────
OPENAI_API_KEY=sk-...                            # Required for Pulse + Chat
SENTIMENT_CHANNEL_IDS=666666666666,777777777777  # Channels to index and analyse
SENTIMENT_MESSAGE_LIMIT=3000                     # Max messages per pulse run

# ── Scheduling ───────────────────────────────────────────────────────────────
DAILY_CRON=0 0 * * *          # Midnight CET
MONTHLY_CRON=0 0 1 * *        # 1st of month, midnight CET
SENTIMENT_CRON=0 17 * * *     # 17:00 CET daily

# ── Delivery ─────────────────────────────────────────────────────────────────
DAILY_DELIVERY=discord         # 'discord' | 'dashboard' | 'both'
MONTHLY_DELIVERY=both
MONTHLY_APPROVAL_MODE=true     # true = draft with buttons; false = auto-publish

# ── Dashboard ────────────────────────────────────────────────────────────────
DASHBOARD_PORT=3000
DASHBOARD_SECRET=YourStrongPasswordHere          # Change this!

# ── Message Database ─────────────────────────────────────────────────────────
MESSAGE_DB_PATH=/mnt/HC_Volume_105012469/messages.db  # Or ./data/messages.db locally

# ── Misc ─────────────────────────────────────────────────────────────────────
LOG_LEVEL=info
```

---

## Step 6 — Build & First Run

```bash
# Compile TypeScript
npm run build

# Seed the @Player role baseline (run once on first deploy)
node dist/index.js --seed

# Test the daily report
node dist/index.js --test-daily

# Backfill message index (optional, indexes last 48h of messages)
node dist/index.js --backfill 48
```

---

## Step 7 — Run with PM2

```bash
# Start the bot
pm2 start ecosystem.config.js

# Save process list so it survives VPS reboots
pm2 save

# Generate the startup script (run the command it outputs)
pm2 startup

# Verify
pm2 status
pm2 logs wows-reporter
```

---

## Day-to-Day Operations

### Deploying code changes

**On your local Windows machine (PowerShell):**

```powershell
cd 'C:\Users\kuba_\Reporting Bot'

# Stage and commit
git add -A
git commit -m "feat: description of change"

# Push to GitHub
git push
```

**On the VPS (SSH):**

```bash
cd ~/wows-reporter

# Pull latest code
git pull

# Rebuild and restart
npm run build && pm2 restart wows-reporter

# Or step by step:
npm run build
pm2 restart wows-reporter
```

### Checking status and logs

```bash
# Live process status
pm2 status

# Follow live logs
pm2 logs wows-reporter

# Last 100 lines
pm2 logs wows-reporter --lines 100

# Clear log files
pm2 flush wows-reporter
```

### Restarting, stopping, reloading

```bash
# Graceful restart (no downtime)
pm2 restart wows-reporter

# Stop
pm2 stop wows-reporter

# Start again
pm2 start wows-reporter
```

### Triggering reports manually

```bash
# Trigger daily report immediately (bot keeps running)
# Use the dashboard at http://YOUR_VPS:3000 → Trigger buttons
# Or use the Discord slash command: /report daily

# Via CLI (stops PM2, runs once, restarts):
pm2 stop wows-reporter
node dist/index.js --test-daily
pm2 start ecosystem.config.js
```

### Backfilling the message index

```bash
# Index last 48 hours of messages (default)
pm2 stop wows-reporter
node dist/index.js --backfill 48
pm2 start ecosystem.config.js

# Or trigger from the dashboard → Backfill button
```

### Inspecting the SQLite database

```bash
# Main metrics DB
sqlite3 ~/wows-reporter/data/metrics.db
sqlite> SELECT * FROM snapshots ORDER BY taken_at DESC LIMIT 5;
sqlite> SELECT * FROM sentiment_reports ORDER BY taken_at DESC LIMIT 3;
sqlite> SELECT * FROM bot_settings;
sqlite> .quit

# Message index DB
sqlite3 /mnt/HC_Volume_105012469/messages.db
sqlite> SELECT COUNT(*) FROM discord_messages;
sqlite> SELECT * FROM discord_messages ORDER BY created_at DESC LIMIT 10;
sqlite> .quit
```

### Updating environment variables

```bash
nano ~/wows-reporter/.env
# Edit the values, save (Ctrl+X, Y, Enter)

# Rebuild and restart to pick up changes
npm run build && pm2 restart wows-reporter
```

---

## Runtime Settings Panel

Many settings can be changed **without redeploying** via the dashboard at `http://YOUR_VPS:3000` → **Settings** tab, or directly via the API:

| Setting key | Description |
|---|---|
| `daily_hour` | Hour for daily report (0–23) |
| `monthly_hour` | Hour for monthly report on the 1st |
| `sentiment_hour` | Hour for Community Pulse (default 17) |
| `daily_enabled` | Enable/disable daily report |
| `monthly_enabled` | Enable/disable monthly report |
| `sentiment_enabled` | Enable/disable Community Pulse |
| `daily_delivery` | `discord` / `dashboard` / `both` |
| `monthly_delivery` | `discord` / `dashboard` / `both` |
| `sentiment_channel_ids` | Comma-separated channel IDs to index |
| `sentiment_message_limit` | Max messages per pulse analysis (default 3000) |
| `staff_channel_id` | Override report destination channel |
| `monthly_channel_id` | Override monthly report channel |

Changes to `daily_hour`, `monthly_hour`, `sentiment_hour` hot-reload the cron without a restart.
Changes to `sentiment_channel_ids` hot-reload the message indexer channel list.

---

## Slash Commands

| Command | Who can use | What it does |
|---|---|---|
| `/report daily` | Staff | Snapshot @Player role and post daily report now |
| `/report monthly` | Staff | Post monthly report draft now |
| `/snapshot` | Staff | Take a fresh @Player role snapshot and show count |
| `/status` | Staff | Show last report times, current @Player count, mood |
| `/sentiment run` | Admin | Trigger Community Pulse report now |
| `/sentiment status` | Admin | Show last pulse run time and mood |

**Staff** = roles in `DISCORD_STAFF_ROLE_IDS` (or Administrator if not set).
**Admin** = roles in `DISCORD_ADMIN_ROLE_IDS` (or Administrator if not set).

---

## File Structure

```
wows-reporter/
├── src/
│   ├── index.ts                 Entry point — init, CLI flags
│   ├── config.ts                All env vars + keyword buckets
│   ├── logger.ts                Winston logger
│   ├── scheduler.ts             Cron job registration + hot-reload
│   │
│   ├── api/
│   │   ├── statbot.ts           Statbot REST API wrapper
│   │   ├── discord.ts           Discord.js client + report delivery
│   │   └── openai.ts            GPT-4o-mini: analyseCommunityPulse, answerQuestion, extractKeywordsForSearch
│   │
│   ├── collectors/
│   │   ├── metrics.ts           Fetch & persist Statbot data
│   │   ├── memberTracker.ts     @Player role tracker + nightly snapshots
│   │   └── keywords.ts          Keyword bucket mapper
│   │
│   ├── indexer/
│   │   ├── messageIndexer.ts    Real-time Discord message archiver + backfill
│   │   └── messageFilter.ts     Quality filter (min length, word count)
│   │
│   ├── store/
│   │   ├── db.ts                Main SQLite (metrics, snapshots, sentiment, chat jobs)
│   │   ├── messageDb.ts         Message archive + FTS5 search
│   │   ├── settingsDb.ts        Runtime key-value settings
│   │   └── schema.sql           SQL schema reference
│   │
│   ├── reports/
│   │   ├── daily.ts             Daily report builder
│   │   ├── monthly.ts           Monthly report builder + approval flow
│   │   ├── sentiment.ts         Community Pulse builder (citations, recurring, delta)
│   │   └── formatters.ts        Number/delta/date formatters
│   │
│   ├── commands/
│   │   ├── register.ts          Slash command definitions
│   │   └── handlers.ts          Command logic + permission checks
│   │
│   └── dashboard/
│       ├── server.ts            Express API (all REST endpoints)
│       └── chatJobs.ts          Async Community Chat job queue + session history
│
├── data/
│   └── metrics.db               SQLite DB (auto-created, gitignored)
│
├── dist/                        Compiled JS (auto-created, gitignored)
├── .env                         Your secrets (gitignored — never commit!)
├── .env.example                 Template
├── ecosystem.config.js          PM2 config
├── package.json
├── tsconfig.json
└── README.md
```

---

## Troubleshooting

### Bot doesn't start

```bash
pm2 logs wows-reporter --lines 50
# Look for "Error" or "Cannot find" lines
```

Common causes:
- Missing `.env` values → check every required key is filled
- Port 3000 already in use → change `DASHBOARD_PORT` in `.env`
- Old `dist/` from a previous build → run `npm run build` again

### Community Pulse not posting

- Verify `OPENAI_API_KEY` is set in `.env`
- Verify `SENTIMENT_CHANNEL_IDS` has at least one valid channel ID
- Check the bot has **Read Message History** permission in those channels
- The bot needs at least 10 messages in the last 24h to run the analysis
- Test manually via dashboard → **Trigger Sentiment** button or `/sentiment run`

### Message index is empty / Chat says "not enough messages"

```bash
# Check index size
sqlite3 /mnt/HC_Volume_.../messages.db "SELECT COUNT(*) FROM discord_messages;"

# Run a backfill
pm2 stop wows-reporter
node dist/index.js --backfill 48
pm2 start ecosystem.config.js

# Or use dashboard → FTS Health / Backfill section
```

### @Player role count is 0

- Make sure `DISCORD_PLAYER_ROLE_ID` is the role ID, not the name
- Verify **GUILD_MEMBERS** privileged intent is enabled on the Developer Portal
- Re-run `--seed` if you changed the role ID

### Statbot sections missing from report

```bash
# Test the Statbot API manually
curl -H "Authorization: Bearer YOUR_STATBOT_API_KEY" \
  "https://api.statbot.net/v1/guilds/YOUR_GUILD_ID/messages?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z"
```

If `403`, your plan may not include the API. The bot skips missing sections automatically.

### TypeScript build errors

```bash
npm run build 2>&1 | head -30
# Fix the errors shown, then rebuild
```
