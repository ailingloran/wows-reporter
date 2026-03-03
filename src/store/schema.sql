-- WoWS Reporter SQLite Schema
-- Run automatically by db.ts on first startup.

-- Snapshot of key metrics taken at each report run
CREATE TABLE IF NOT EXISTS snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at            TEXT    NOT NULL,   -- ISO-8601 UTC timestamp
  period              TEXT    NOT NULL,   -- 'daily' | 'monthly'
  messages            INTEGER,
  active_members      INTEGER,
  joins               INTEGER,
  leaves              INTEGER,
  player_role_count   INTEGER,            -- from own @Player tracker
  raw_json            TEXT                -- full Statbot response (JSON)
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
  event_time  TEXT    NOT NULL,           -- ISO-8601 UTC timestamp
  user_id     TEXT    NOT NULL,
  event_type  TEXT    NOT NULL            -- 'join' | 'leave'
);

-- Daily @Player role count snapshots (taken at midnight CET)
CREATE TABLE IF NOT EXISTS player_role_snapshots (
  snapshot_date TEXT    PRIMARY KEY,      -- YYYY-MM-DD
  total_count   INTEGER NOT NULL
);

-- Community Pulse reports (OpenAI sentiment analysis results)
CREATE TABLE IF NOT EXISTS sentiment_reports (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  TEXT    NOT NULL,   -- ISO-8601 UTC timestamp
  mood      TEXT,               -- one-sentence mood summary
  raw_json  TEXT                -- full PulseResult as JSON
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_snapshots_period_taken
  ON snapshots(period, taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_role_events_time
  ON player_role_events(event_time DESC);
