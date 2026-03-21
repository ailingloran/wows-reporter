-- WoWS Reporter SQLite Schema
-- Run automatically by db.ts on first startup.

-- Snapshot of key metrics taken at each report run
CREATE TABLE IF NOT EXISTS snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at            TEXT    NOT NULL,
  period              TEXT    NOT NULL,
  messages            INTEGER,
  active_members      INTEGER,
  joins               INTEGER,
  leaves              INTEGER,
  player_role_count   INTEGER,
  raw_json            TEXT
);

-- Per-channel message counts per snapshot
CREATE TABLE IF NOT EXISTS channel_stats (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  channel_id    TEXT    NOT NULL,
  channel_name  TEXT    NOT NULL,
  messages      INTEGER,
  PRIMARY KEY (snapshot_id, channel_id)
);

-- @Player role membership events (real-time, from Discord gateway)
CREATE TABLE IF NOT EXISTS player_role_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time  TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  event_type  TEXT    NOT NULL
);

-- Daily @Player role count snapshots (taken at midnight CET)
CREATE TABLE IF NOT EXISTS player_role_snapshots (
  snapshot_date TEXT    PRIMARY KEY,
  total_count   INTEGER NOT NULL
);

-- Community Pulse reports (OpenAI sentiment analysis results)
CREATE TABLE IF NOT EXISTS sentiment_reports (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  TEXT    NOT NULL,
  mood      TEXT,
  raw_json  TEXT
);

-- Async Community Chat jobs
CREATE TABLE IF NOT EXISTS chat_jobs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  question      TEXT NOT NULL,
  window_hours  INTEGER NOT NULL,
  collect_cap   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  answer        TEXT,
  collected     INTEGER,
  analysed      INTEGER,
  error         TEXT
);

-- ── Staff Activity Tracking ───────────────────────────────────────────────────

-- Staff group definitions (CMs, Moderators, Helpers)
CREATE TABLE IF NOT EXISTS staff_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Role IDs assigned to each staff group
CREATE TABLE IF NOT EXISTS staff_tracked_roles (
  group_id INTEGER NOT NULL REFERENCES staff_groups(id) ON DELETE CASCADE,
  role_id  TEXT    NOT NULL,
  PRIMARY KEY (group_id, role_id)
);

-- Explicit user IDs assigned to each staff group
CREATE TABLE IF NOT EXISTS staff_tracked_users (
  group_id INTEGER NOT NULL REFERENCES staff_groups(id) ON DELETE CASCADE,
  user_id  TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Per-message activity log (full server coverage, no channel/length filters)
CREATE TABLE IF NOT EXISTS staff_message_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  group_id     INTEGER NOT NULL,
  channel_id   TEXT    NOT NULL,  -- root channel (parent ID for threads)
  channel_name TEXT    NOT NULL,
  is_thread    INTEGER NOT NULL DEFAULT 0,
  thread_id    TEXT,              -- thread channel ID when is_thread = 1
  message_id   TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL  -- Unix ms timestamp
);

-- Weekly aggregated snapshots
CREATE TABLE IF NOT EXISTS staff_weekly_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start    INTEGER NOT NULL,  -- Unix ms of Monday 00:00 UTC
  user_id       TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  group_id      INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER NOT NULL DEFAULT 0,
  thread_count  INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER,
  top_channel   TEXT,
  UNIQUE(week_start, user_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_msg_user_time
  ON staff_message_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_msg_time
  ON staff_message_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_weekly_week
  ON staff_weekly_snapshots(week_start DESC);

-- Named access tokens for shared dashboard access (guest read-only sessions)
CREATE TABLE IF NOT EXISTS access_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT    NOT NULL,
  token      TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    -- NULL = never expires
);

-- ── Narrative Drift Tracking ──────────────────────────────────────────────────

-- Daily per-category sentiment aggregates derived from Community Pulse reports
CREATE TABLE IF NOT EXISTS narrative_daily (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL,  -- YYYY-MM-DD
  category       TEXT    NOT NULL,  -- e.g. 'economy', 'balance', etc.
  pain_count     INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  topic_count    INTEGER NOT NULL DEFAULT 0,
  sentiment      REAL    NOT NULL DEFAULT 3.0,  -- 1–5 composite score
  mood_ref       REAL    NOT NULL DEFAULT 3.0,  -- overall mood_score of that report
  items_json     TEXT,                           -- JSON array of matched item texts
  UNIQUE(date, category)
);

-- Emerging keyword counts per day (words not in any category taxonomy)
CREATE TABLE IF NOT EXISTS narrative_keywords (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT    NOT NULL,
  keyword  TEXT    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(date, keyword)
);

CREATE INDEX IF NOT EXISTS idx_narrative_daily_date
  ON narrative_daily(date DESC);

CREATE INDEX IF NOT EXISTS idx_narrative_keywords_date
  ON narrative_keywords(date DESC);

-- ── AI-powered Narrative Drift (gpt-4.1-mini) ──────────────────────────────────
-- Separate tables so lexicon and AI results can be compared side-by-side.
-- Controlled by NARRATIVE_AI_ENABLED=true in .env.
-- To disable: set NARRATIVE_AI_ENABLED=false.
-- To remove:  drop these tables + delete src/store/narrativeAiDb.ts.

CREATE TABLE IF NOT EXISTS narrative_ai_daily (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL,
  category       TEXT    NOT NULL,
  pain_count     INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  topic_count    INTEGER NOT NULL DEFAULT 0,  -- neutral count
  sentiment      REAL    NOT NULL DEFAULT 3.0,
  mood_ref       REAL    NOT NULL DEFAULT 3.0,
  items_json     TEXT,
  UNIQUE(date, category)
);

CREATE TABLE IF NOT EXISTS narrative_ai_keywords (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT    NOT NULL,
  keyword  TEXT    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(date, keyword)
);

CREATE INDEX IF NOT EXISTS idx_narrative_ai_daily_date
  ON narrative_ai_daily(date DESC);

CREATE INDEX IF NOT EXISTS idx_narrative_ai_keywords_date
  ON narrative_ai_keywords(date DESC);

-- Weekly Community Pulse summaries (synthesised from 7 daily reports, Monday 12:00 CET)
CREATE TABLE IF NOT EXISTS weekly_pulse_reports (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  TEXT    NOT NULL,   -- ISO timestamp of when generated
  from_date TEXT    NOT NULL,   -- YYYY-MM-DD start of week covered
  to_date   TEXT    NOT NULL,   -- YYYY-MM-DD end of week covered
  day_count INTEGER NOT NULL,   -- number of daily reports used
  avg_mood  REAL    NOT NULL,   -- average mood score across the week
  raw_json  TEXT    NOT NULL    -- WeeklyPulseResult JSON
);

CREATE INDEX IF NOT EXISTS idx_weekly_pulse_taken_at
  ON weekly_pulse_reports(taken_at DESC);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_snapshots_period_taken
  ON snapshots(period, taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_role_events_time
  ON player_role_events(event_time DESC);

CREATE INDEX IF NOT EXISTS idx_chat_jobs_created_at
  ON chat_jobs(created_at DESC);
