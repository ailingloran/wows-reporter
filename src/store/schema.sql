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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_snapshots_period_taken
  ON snapshots(period, taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_role_events_time
  ON player_role_events(event_time DESC);

CREATE INDEX IF NOT EXISTS idx_chat_jobs_created_at
  ON chat_jobs(created_at DESC);
