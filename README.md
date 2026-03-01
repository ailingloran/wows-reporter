# ⚓ WoWS Discord Reporting Pack Generator

A fully automated, self-hosted Node.js bot that posts daily and monthly community statistics reports to your Discord server's staff channel. Data is pulled from the **Statbot REST API** and your own **@Player role tracker**.

---

## 📋 Table of Contents

1. [What It Does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Create the Discord Bot](#step-1--create-the-discord-bot)
4. [Step 2 — Get Your Statbot API Key](#step-2--get-your-statbot-api-key)
5. [Step 3 — Set Up the VPS](#step-3--set-up-the-vps)
6. [Step 4 — Deploy the Project](#step-4--deploy-the-project)
7. [Step 5 — Configure .env](#step-5--configure-env)
8. [Step 6 — Build & First Run](#step-6--build--first-run)
9. [Step 7 — Start with PM2 (Production)](#step-7--start-with-pm2-production)
10. [Step 8 — Optional Web Dashboard](#step-8--optional-web-dashboard)
11. [Step 9 — Nginx + HTTPS (Dashboard)](#step-9--nginx--https-dashboard)
12. [How Reports Look](#how-reports-look)
13. [Customising Keyword Buckets](#customising-keyword-buckets)
14. [Useful Commands](#useful-commands)
15. [Troubleshooting](#troubleshooting)
16. [File Structure Reference](#file-structure-reference)

---

## What It Does

| Feature | Description |
|---|---|
| **Daily Report** | Posted automatically at midnight CET to your staff channel. Includes messages, active members, joins/leaves, @Player role count, and top hotspot channels — all with delta arrows vs the previous day. |
| **Monthly Report** | Posted on the 1st of each month. Includes month totals, channel movers (growers/decliners), keyword themes, and staff comms summary. Posted as a **draft with Approve/Edit buttons** so a staff member reviews before publishing. |
| **@Player Role Tracker** | Listens to Discord Gateway events to track every @Player role addition/removal in real-time. Saves nightly snapshots for trend reporting. |
| **Web Dashboard** | Optional password-protected dashboard at `http://your-vps:3000` with live charts. |
| **Graceful Degradation** | If a Statbot endpoint is unavailable (plan limits, 404), that section is skipped — the rest of the report still posts. |

---

## Prerequisites

Before you start, make sure you have:

- A **VPS or server** running Linux (Ubuntu 22.04 recommended)
- A **Discord account** with admin access to your server
- **Statbot** already added to your Discord server (https://statbot.net)
- Basic comfort with a terminal / SSH

---

## Step 1 — Create the Discord Bot

> **Time needed: ~10 minutes**

### 1.1 Create the Application

1. Go to https://discord.com/developers/applications
2. Click **"New Application"** → give it a name (e.g. `WoWS Reporter`) → **Create**

### 1.2 Create the Bot

1. In the left sidebar, click **"Bot"**
2. Click **"Add Bot"** → **"Yes, do it!"**
3. Under **"Token"**, click **"Reset Token"** → copy and save it somewhere safe. **This is your `DISCORD_BOT_TOKEN`.**

### 1.3 Enable Privileged Intents

Still on the **Bot** page, scroll down to **"Privileged Gateway Intents"** and enable:

- ✅ **GUILD MEMBERS** — required for @Player role tracking
- ✅ **MESSAGE CONTENT** — required for keyword scanning (disable if you only use Statbot keywords)

Click **Save Changes**.

### 1.4 Invite the Bot to Your Server

1. Click **"OAuth2"** → **"URL Generator"** in the left sidebar
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check:
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
   - `View Channels`
   - `Use External Emojis`
   - `Manage Threads`
4. Copy the generated URL at the bottom, open it in your browser, and invite the bot to your server.

### 1.5 Collect IDs

Enable **Developer Mode** in Discord (User Settings → Advanced → Developer Mode).

Then right-click the following and copy their IDs:

| Value | How to get it |
|---|---|
| **Server ID** (`STATBOT_GUILD_ID`) | Right-click your server icon → Copy Server ID |
| **Staff Channel ID** (`DISCORD_STAFF_CHANNEL_ID`) | Right-click the channel where daily reports go → Copy Channel ID |
| **Monthly Channel ID** (`DISCORD_MONTHLY_CHANNEL_ID`) | Right-click the channel for monthly drafts → Copy Channel ID |
| **@Player Role ID** (`DISCORD_PLAYER_ROLE_ID`) | Server Settings → Roles → right-click @Player → Copy Role ID |

---

## Step 2 — Get Your Statbot API Key

1. Go to https://statbot.net/dashboard
2. Select your server
3. Click your profile/avatar → **"API"** or look for the **API Keys** section
4. Generate a new API key. **This is your `STATBOT_API_KEY`.**

> **Note:** Copy your Discord **Server (Guild) ID** from Step 1.5 — you'll need it as `STATBOT_GUILD_ID`.

---

## Step 3 — Set Up the VPS

> **Time needed: ~15 minutes**
> These commands are for Ubuntu 22.04. Adjust for other distros.

SSH into your VPS, then run:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js version (should say v20.x.x)
node --version

# Install PM2 globally (process manager)
sudo npm install -g pm2

# Install SQLite tools (optional, for manual DB inspection)
sudo apt install -y sqlite3

# Install Nginx (only needed for the web dashboard with HTTPS)
sudo apt install -y nginx

# Install Certbot for free TLS certificates (only for dashboard)
sudo apt install -y certbot python3-certbot-nginx
```

---

## Step 4 — Deploy the Project

### 4.1 Copy the project files to your VPS

**Option A — SCP (simplest):**
From your Windows machine, open PowerShell or Command Prompt:

```powershell
# Copy the entire wows-reporter folder to your VPS
scp -r "C:\Users\kuba_\Downloads\wows-reporter" youruser@YOUR_VPS_IP:/home/youruser/
```

**Option B — Git (recommended for future updates):**
```bash
# On your VPS:
cd /home/youruser
git clone https://github.com/YOUR_REPO/wows-reporter.git
cd wows-reporter
```

**Option C — SFTP client:**
Use FileZilla or WinSCP to drag-and-drop the `wows-reporter` folder to `/home/youruser/` on your VPS.

### 4.2 Enter the project directory

```bash
cd /home/youruser/wows-reporter
```

### 4.3 Install dependencies

```bash
npm install
```

> This installs all packages listed in `package.json`. It may take 1–2 minutes.

---

## Step 5 — Configure .env

Create your `.env` file from the template:

```bash
cp .env.example .env
nano .env
```

Fill in every value. Here is what each one means:

```env
# ── Statbot ──────────────────────────────────────────────
STATBOT_API_KEY=abc123...        # From Statbot dashboard → API Keys
STATBOT_GUILD_ID=123456789...    # Your Discord server ID

# ── Discord ──────────────────────────────────────────────
DISCORD_BOT_TOKEN=MTA...         # From Discord Developer Portal → Bot → Token
DISCORD_STAFF_CHANNEL_ID=...     # Channel where daily reports post
DISCORD_MONTHLY_CHANNEL_ID=...   # Channel where monthly drafts post
DISCORD_PLAYER_ROLE_ID=...       # ID of the @Player role to track
DISCORD_STAFF_ROLE_IDS=...       # Optional: comma-separated staff role IDs

# ── Scheduling ────────────────────────────────────────────
DAILY_CRON=0 0 * * *             # Midnight CET (leave as-is)
MONTHLY_CRON=0 0 1 * *           # 1st of month, midnight CET

# ── Delivery ─────────────────────────────────────────────
DAILY_DELIVERY=discord           # 'discord' | 'dashboard' | 'both'
MONTHLY_DELIVERY=both            # 'discord' | 'dashboard' | 'both'
MONTHLY_APPROVAL_MODE=true       # true = draft with buttons; false = auto-publish

# ── Dashboard ─────────────────────────────────────────────
DASHBOARD_PORT=3000
DASHBOARD_SECRET=YourStrongPassword123   # Change this!

# ── Misc ──────────────────────────────────────────────────
DAILY_WINDOW=calendarDay
LOG_LEVEL=info
```

Save and exit (`Ctrl+X`, then `Y`, then `Enter` in nano).

> ⚠️ **Never share or commit your `.env` file. It contains your bot token.**

---

## Step 6 — Build & First Run

### 6.1 Compile TypeScript

```bash
npm run build
```

This compiles `src/` → `dist/`. You should see no errors.

### 6.2 Create required directories

```bash
mkdir -p data logs
```

### 6.3 Seed the @Player role baseline

This takes an initial count of your @Player role members so the bot has a starting point for deltas:

```bash
node dist/index.js --seed
```

Expected output:
```
2026-01-21 00:00:00 [INFO] Database initialised
2026-01-21 00:00:00 [INFO] Discord client ready
2026-01-21 00:00:00 [INFO] Discord bot logged in as WoWS Reporter#1234
2026-01-21 00:00:00 [INFO] Seed mode: taking @Player role baseline snapshot...
2026-01-21 00:00:02 [INFO] [memberTracker] Baseline seeded: 3421 @Player members.
```

### 6.4 Test the daily report

This triggers the daily report immediately so you can verify it posts correctly to your staff channel:

```bash
node dist/index.js --test-daily
```

Check your Discord staff channel — a report embed should appear within a few seconds.

### 6.5 Test the monthly report (optional)

```bash
node dist/index.js --test-monthly
```

Check your Discord monthly channel — a draft with Approve/Edit buttons should appear.

---

## Step 7 — Start with PM2 (Production)

PM2 keeps the bot running 24/7, restarts it on crash, and survives VPS reboots.

```bash
# Start the bot with PM2
pm2 start ecosystem.config.js

# Save the PM2 process list so it restarts on VPS reboot
pm2 save

# Generate the system startup script (run the command it outputs)
pm2 startup
# --> It will print a command like: sudo env PATH=... pm2 startup systemd -u youruser --hp /home/youruser
# --> Copy and run that exact command.
```

### Verify it's running

```bash
pm2 status
# Should show: wows-reporter | online

pm2 logs wows-reporter
# Should show the bot startup logs
```

The bot is now live. It will:
- Post a daily report at **midnight CET** every night
- Post a monthly draft on the **1st of each month** at midnight CET
- Snapshot the @Player role count nightly at **00:05 CET**

---

## Step 8 — Optional Web Dashboard

If you set `DAILY_DELIVERY=both` or `MONTHLY_DELIVERY=both`, the web dashboard is automatically started on port 3000.

To access it locally: `http://YOUR_VPS_IP:3000`

Login: any username + the `DASHBOARD_SECRET` you set in `.env`.

The dashboard shows:
- Stat cards (messages, active members, joins, leaves, @Player count)
- 30-day messages chart
- @Player role growth chart (all time)
- Daily joins/leaves chart

---

## Step 9 — Nginx + HTTPS (Dashboard)

> Skip this if you don't need the dashboard accessible from the internet.

### 9.1 Point a subdomain to your VPS

In your domain registrar's DNS settings, add an **A record**:
- Name: `reports` (gives you `reports.yourdomain.com`)
- Value: your VPS IP address

Wait a few minutes for DNS to propagate.

### 9.2 Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/wows-reporter
```

Paste this, replacing `reports.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name reports.yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host             $host;
        proxy_set_header   X-Real-IP        $remote_addr;
        proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header   Upgrade          $http_upgrade;
        proxy_set_header   Connection       'upgrade';
    }
}
```

Save and exit. Then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/wows-reporter /etc/nginx/sites-enabled/
sudo nginx -t          # Test config (should say "ok")
sudo systemctl reload nginx
```

### 9.3 Get a free TLS certificate

```bash
sudo certbot --nginx -d reports.yourdomain.com
```

Follow the prompts. Certbot will automatically configure HTTPS and auto-renew.

Your dashboard is now available at **https://reports.yourdomain.com** 🎉

---

## How Reports Look

### Daily Report (Discord Embed)

```
📊 Daily Report — 21 Jan 2026
Community stats for 21 Jan 2026

📨 Messages          👥 Active Members
1,243                89
+156 🔼 +14.4%       -3 🔽 -3.3%

📥 Joins             📤 Leaves          ⚖️ Net Change
12                   4                  +8

⚓ @Player Role
3,421 total
+8 🔼 +0.2%

🔥 Top Channels Today
1. #general — 423 msgs (34.0%)
2. #strategy — 218 msgs (17.5%)
3. #off-topic — 156 msgs (12.5%)

WoWS Community Reports · Auto-generated
```

### Monthly Report (Draft with Buttons)

The monthly report includes four sections:
- **Section A** — Month totals + delta vs previous month
- **Section B** — Top 3 channel growers & decliners
- **Section C** — Keyword themes (CV Spotting, Submarines, Economy, etc.)
- **Section D** — Staff comms summary

Staff click **✅ Approve & Publish** to confirm, or **✏️ Request Edit** to flag for changes.

---

## Customising Keyword Buckets

Edit `src/config.ts` and update the `KEYWORD_BUCKETS` object:

```typescript
export const KEYWORD_BUCKETS: Record<string, string[]> = {
  'CV Spotting':   ['cv', 'carrier', 'spotting', 'planes', 'air'],
  'Submarines':    ['sub', 'submarine', 'depth charge', 'sonar'],
  'Economy':       ['credits', 'economy', 'coal', 'steel'],
  // Add your own:
  'New Ships':     ['new ship', 'release', 'announced'],
};
```

After editing, rebuild:

```bash
npm run build
pm2 restart wows-reporter
```

---

## Useful Commands

```bash
# Check bot status
pm2 status

# View live logs
pm2 logs wows-reporter

# View last 100 log lines
pm2 logs wows-reporter --lines 100

# Restart the bot (after config changes)
pm2 restart wows-reporter

# Stop the bot
pm2 stop wows-reporter

# Trigger a daily report right now (without waiting for cron)
pm2 stop wows-reporter
node dist/index.js --test-daily
pm2 start wows-reporter

# Inspect the SQLite database manually
sqlite3 data/metrics.db
sqlite> SELECT * FROM snapshots ORDER BY taken_at DESC LIMIT 5;
sqlite> SELECT * FROM player_role_snapshots ORDER BY snapshot_date DESC LIMIT 10;
sqlite> .quit

# Rebuild after code changes
npm run build && pm2 restart wows-reporter
```

---

## Troubleshooting

### Bot doesn't log in
- Double-check `DISCORD_BOT_TOKEN` in `.env` — no quotes, no extra spaces
- Make sure the bot is invited to the server (Step 1.4)
- Ensure Privileged Intents are enabled on the Developer Portal (Step 1.3)

### "Missing Access" or embed not posting
- Make sure the bot has **Send Messages** and **Embed Links** permissions in the target channel
- Check the channel ID is correct in `.env`

### Statbot returns null / sections are missing
- Test your API key manually:
  ```bash
  curl -H "Authorization: Bearer YOUR_STATBOT_API_KEY" \
    "https://api.statbot.net/v1/guilds/YOUR_GUILD_ID/messages?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z"
  ```
- If it returns `403`, your plan may not include the API. Contact Statbot support.
- If a specific endpoint returns `404`, it's unavailable on your plan — the bot will skip that section automatically.

### @Player role count is always 0
- Make sure `DISCORD_PLAYER_ROLE_ID` is the role ID (not name)
- Run `--seed` again if you changed the role ID
- Verify **GUILD_MEMBERS** privileged intent is enabled

### Monthly report doesn't fire
- The default cron `0 0 1 * *` fires at midnight CET on the **1st of the month**
- Check PM2 logs around midnight on the 1st for errors
- Test manually: `node dist/index.js --test-monthly`

### TypeScript build errors
```bash
npm run lint    # Shows all TypeScript errors without building
npm run build   # Full build
```

---

## File Structure Reference

```
wows-reporter/
├── src/
│   ├── index.ts              Entry point — init, CLI flags, startup
│   ├── config.ts             All env vars + keyword buckets
│   ├── logger.ts             Winston logger setup
│   ├── scheduler.ts          Cron job registration
│   │
│   ├── api/
│   │   ├── statbot.ts        Statbot REST API wrapper
│   │   └── discord.ts        Discord bot client + delivery functions
│   │
│   ├── collectors/
│   │   ├── metrics.ts        Fetch & store Statbot data
│   │   ├── memberTracker.ts  @Player role real-time tracker + snapshots
│   │   └── keywords.ts       Keyword bucket scanner
│   │
│   ├── store/
│   │   ├── db.ts             SQLite init + CRUD helpers
│   │   └── schema.sql        Table definitions
│   │
│   ├── reports/
│   │   ├── daily.ts          Daily report builder
│   │   ├── monthly.ts        Monthly report builder
│   │   └── formatters.ts     Delta arrows, number formatting
│   │
│   └── dashboard/
│       ├── server.ts         Express web dashboard API
│       └── public/
│           └── index.html    Dashboard HTML/CSS/JS with Chart.js
│
├── data/
│   └── metrics.db            SQLite database (auto-created, gitignored)
│
├── logs/                     Log files (auto-created, gitignored)
├── dist/                     Compiled JS output (auto-created)
│
├── .env                      Your secrets (gitignored — never commit!)
├── .env.example              Template for .env
├── .gitignore
├── ecosystem.config.js       PM2 configuration
├── package.json
├── tsconfig.json
└── README.md                 This file
```

---

## Security Notes

- **Never commit `.env`** — it contains your bot token and API keys
- The web dashboard uses Basic Auth — use a strong `DASHBOARD_SECRET`
- Keep Node.js updated: `sudo apt upgrade nodejs`
- The bot only needs the permissions listed in Step 1.4 — don't grant Administrator

---

*Generated from the WoWS Reporting Pack Blueprint · Automated with Node.js + Discord.js + Statbot*
