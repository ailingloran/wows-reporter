/**
 * SQLite database initialisation and helper functions.
 * Uses better-sqlite3 (synchronous API — safe for cron jobs).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';

const DB_PATH  = path.join(process.cwd(), 'data', 'metrics.db');
const SQL_PATH = path.join(__dirname, 'schema.sql');

let db: Database.Database;

export function initDb(): Database.Database {
  // Ensure data/ directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply schema
  const schema = fs.readFileSync(SQL_PATH, 'utf-8');
  db.exec(schema);
  logger.info(`[db] Connected to ${DB_PATH}`);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

export interface SnapshotRow {
  id:                 number;
  taken_at:           string;
  period:             string;
  messages:           number | null;
  active_members:     number | null;
  joins:              number | null;
  leaves:             number | null;
  player_role_count:  number | null;
  raw_json:           string | null;
}

export function insertSnapshot(data: Omit<SnapshotRow, 'id'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO snapshots (taken_at, period, messages, active_members, joins, leaves, player_role_count, raw_json)
    VALUES (@taken_at, @period, @messages, @active_members, @joins, @leaves, @player_role_count, @raw_json)
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid as number;
}

export function getLastSnapshot(period: 'daily' | 'monthly'): SnapshotRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM snapshots WHERE period = ? ORDER BY taken_at DESC LIMIT 1`)
    .get(period) as SnapshotRow | undefined;
}

export function getSnapshotsBetween(period: 'daily' | 'monthly', from: string, to: string): SnapshotRow[] {
  return getDb()
    .prepare(`SELECT * FROM snapshots WHERE period = ? AND taken_at BETWEEN ? AND ? ORDER BY taken_at ASC`)
    .all(period, from, to) as SnapshotRow[];
}

// ── Channel stats helpers ─────────────────────────────────────────────────────

export interface ChannelStatRow {
  snapshot_id:  number;
  channel_id:   string;
  channel_name: string;
  messages:     number;
}

export function insertChannelStats(snapshotId: number, channels: Array<{ channelId: string; name: string; messageCount: number }>): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO channel_stats (snapshot_id, channel_id, channel_name, messages)
    VALUES (?, ?, ?, ?)
  `);
  const insert = getDb().transaction(() => {
    for (const ch of channels) {
      stmt.run(snapshotId, ch.channelId, ch.name, ch.messageCount);
    }
  });
  insert();
}

export function getChannelStatsForSnapshot(snapshotId: number): ChannelStatRow[] {
  return getDb()
    .prepare(`SELECT * FROM channel_stats WHERE snapshot_id = ? ORDER BY messages DESC`)
    .all(snapshotId) as ChannelStatRow[];
}

// ── @Player role helpers ──────────────────────────────────────────────────────

export function insertPlayerRoleEvent(userId: string, eventType: 'join' | 'leave'): void {
  getDb().prepare(`
    INSERT INTO player_role_events (event_time, user_id, event_type)
    VALUES (?, ?, ?)
  `).run(new Date().toISOString(), userId, eventType);
}

export function upsertPlayerRoleSnapshot(date: string, count: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO player_role_snapshots (snapshot_date, total_count)
    VALUES (?, ?)
  `).run(date, count);
}

export function getPlayerRoleSnapshot(date: string): { total_count: number } | undefined {
  return getDb()
    .prepare(`SELECT total_count FROM player_role_snapshots WHERE snapshot_date = ?`)
    .get(date) as { total_count: number } | undefined;
}

export function getLatestPlayerRoleSnapshot(): { snapshot_date: string; total_count: number } | undefined {
  return getDb()
    .prepare(`SELECT * FROM player_role_snapshots ORDER BY snapshot_date DESC LIMIT 1`)
    .get() as { snapshot_date: string; total_count: number } | undefined;
}

export function getPlayerRoleSnapshotsBetween(from: string, to: string): Array<{ snapshot_date: string; total_count: number }> {
  return getDb()
    .prepare(`SELECT * FROM player_role_snapshots WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date ASC`)
    .all(from, to) as Array<{ snapshot_date: string; total_count: number }>;
}
