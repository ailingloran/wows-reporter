/**
 * Message index database — stored on the Hetzner volume.
 * Separate from metrics.db so it can live on dedicated block storage
 * and grow independently without affecting the main DB.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';
import { config } from '../config';

let msgDb: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discord_messages (
  message_id  TEXT    PRIMARY KEY,
  channel_id  TEXT    NOT NULL,
  author_id   TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_time
  ON discord_messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_msg_channel_time
  ON discord_messages(channel_id, created_at DESC);
`;

export function initMessageDb(): void {
  const dbPath = config.messageDbPath;
  const dir    = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  msgDb = new Database(dbPath);
  msgDb.pragma('journal_mode = WAL');
  msgDb.pragma('synchronous = NORMAL'); // safe with WAL; avoids fsync on every write

  msgDb.exec(SCHEMA);

  const { total } = msgDb
    .prepare('SELECT COUNT(*) AS total FROM discord_messages')
    .get() as { total: number };

  logger.info(`[messageDb] Opened ${dbPath} — ${total} messages indexed`);
}

function db(): Database.Database {
  if (!msgDb) throw new Error('Message DB not initialised — call initMessageDb() first');
  return msgDb;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MessageRow {
  message_id: string;
  channel_id: string;
  author_id:  string;
  content:    string;
  created_at: number; // Unix ms
}

// ── Writes ────────────────────────────────────────────────────────────────────

export function insertMessage(row: MessageRow): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO discord_messages
         (message_id, channel_id, author_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.message_id, row.channel_id, row.author_id, row.content, row.created_at);
}

export function bulkInsertMessages(rows: MessageRow[]): number {
  if (rows.length === 0) return 0;

  const stmt = db().prepare(
    `INSERT OR IGNORE INTO discord_messages
       (message_id, channel_id, author_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db().transaction(() => {
    for (const r of rows) {
      inserted += stmt.run(r.message_id, r.channel_id, r.author_id, r.content, r.created_at).changes;
    }
  });
  tx();

  return inserted;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function countIndexedMessages(windowHours?: number): number {
  if (!windowHours) {
    return (db().prepare('SELECT COUNT(*) AS c FROM discord_messages').get() as { c: number }).c;
  }
  const cutoff = Date.now() - windowHours * 3_600_000;
  return (
    db()
      .prepare('SELECT COUNT(*) AS c FROM discord_messages WHERE created_at >= ?')
      .get(cutoff) as { c: number }
  ).c;
}

/**
 * Query messages for a chat job.
 *
 * Strategy:
 *   1. If keywords are provided, fetch keyword-matching messages first (LIKE scan).
 *   2. Pad up to `limit` with random non-matching messages from the same window.
 *   3. If no keywords, return a random sample from the window.
 *
 * This ensures GPT sees the most relevant messages while still providing
 * broader context from the rest of the community conversation.
 */
export function queryIndexedMessages(
  windowHours: number,
  channelIds:  string[],
  limit:       number,
  keywords:    string[],
): string[] {
  if (channelIds.length === 0) return [];

  const cutoff = Date.now() - windowHours * 3_600_000;
  const chPh   = channelIds.map(() => '?').join(', ');

  if (keywords.length === 0) {
    return (
      db()
        .prepare(
          `SELECT content FROM discord_messages
           WHERE created_at >= ? AND channel_id IN (${chPh})
           ORDER BY RANDOM()
           LIMIT ?`,
        )
        .all(cutoff, ...channelIds, limit) as { content: string }[]
    ).map(r => r.content);
  }

  // Build LIKE conditions
  const likeClause    = keywords.map(() => 'content LIKE ?').join(' OR ');
  const notLikeClause = keywords.map(() => 'content NOT LIKE ?').join(' AND ');
  const likeParams    = keywords.map(k => `%${k}%`);

  // 1. Keyword matches
  const matching = (
    db()
      .prepare(
        `SELECT content FROM discord_messages
         WHERE created_at >= ? AND channel_id IN (${chPh})
           AND (${likeClause})
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(cutoff, ...channelIds, ...likeParams, limit) as { content: string }[]
  ).map(r => r.content);

  if (matching.length >= limit) return matching.slice(0, limit);

  // 2. Pad with non-matching random messages
  const remaining = limit - matching.length;
  const padding = (
    db()
      .prepare(
        `SELECT content FROM discord_messages
         WHERE created_at >= ? AND channel_id IN (${chPh})
           AND (${notLikeClause})
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(cutoff, ...channelIds, ...likeParams, remaining) as { content: string }[]
  ).map(r => r.content);

  return [...matching, ...padding];
}
