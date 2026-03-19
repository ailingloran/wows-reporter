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

-- FTS5 index for fast, ranked full-text search over message content.
-- content='discord_messages' makes this a "content table" — FTS only stores
-- the rowid; actual text is read from discord_messages when needed.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content='discord_messages', content_rowid='rowid');

-- Keep FTS in sync with new inserts (updates/deletes not needed — we never
-- modify or delete indexed messages).
CREATE TRIGGER IF NOT EXISTS messages_fts_ai
  AFTER INSERT ON discord_messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
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

  // Populate FTS index from existing rows on first run after adding FTS support.
  // After that, the trigger keeps it in sync automatically.
  if (total > 0) {
    const { c: ftsCount } = msgDb
      .prepare('SELECT COUNT(*) AS c FROM messages_fts')
      .get() as { c: number };
    if (ftsCount === 0) {
      logger.info('[messageDb] FTS index is empty — rebuilding from existing messages...');
      rebuildFts();
      logger.info('[messageDb] FTS rebuild complete');
    }
  }

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

// ── FTS5 helpers ──────────────────────────────────────────────────────────────

/**
 * Rebuild the FTS5 index from scratch, reading all content from discord_messages.
 * Called automatically on first startup after the FTS table is created.
 */
export function rebuildFts(): void {
  db().exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
}

export interface FtsHealth {
  totalMessages:  number;
  ftsCount:       number;
  lastIndexedAt:  number | null; // Unix ms
}

export function getFtsHealth(): FtsHealth {
  const totalMessages = (
    db().prepare('SELECT COUNT(*) AS c FROM discord_messages').get() as { c: number }
  ).c;
  const ftsCount = (
    db().prepare('SELECT COUNT(*) AS c FROM messages_fts').get() as { c: number }
  ).c;
  const row = db()
    .prepare('SELECT MAX(created_at) AS t FROM discord_messages')
    .get() as { t: number | null };
  return { totalMessages, ftsCount, lastIndexedAt: row.t ?? null };
}

/**
 * Sanitise keyword strings into a safe FTS5 OR query.
 * Removes FTS5 special characters and joins with OR.
 */
function buildFtsQuery(keywords: string[]): string {
  // Split multi-word keywords into individual words so that e.g.
  // "Sabaton collaboration" becomes "Sabaton OR collaboration" instead of
  // FTS5 implicit AND (Sabaton AND collaboration).
  const words = keywords
    .flatMap(k => k.replace(/["*()\-^:]/g, ' ').trim().split(/\s+/))
    .map(w => w.trim())
    .filter(w => w.length >= 3)
    .filter((w, i, arr) => arr.findIndex(x => x.toLowerCase() === w.toLowerCase()) === i);
  return words.join(' OR ');
}

/**
 * Search messages using FTS5 BM25 ranking.
 *
 * Returns up to `limit` messages most relevant to `ftsQuery`, filtered by
 * channel and optionally a time window (windowHours = 0 means all time).
 *
 * Results are ordered by BM25 relevance score (most relevant first).
 * If ftsQuery is empty, falls back to a random sample from the window.
 */
export function searchMessagesFts(
  ftsQuery:    string,
  windowHours: number,
  channelIds:  string[],
  limit:       number,
): string[] {
  if (channelIds.length === 0) return [];

  const chPh = channelIds.map(() => '?').join(', ');

  // No FTS query — return random sample from the time window
  if (!ftsQuery.trim()) {
    if (!windowHours) {
      return (
        db()
          .prepare(`SELECT content FROM discord_messages WHERE channel_id IN (${chPh}) ORDER BY RANDOM() LIMIT ?`)
          .all(...channelIds, limit) as { content: string }[]
      ).map(r => r.content);
    }
    const cutoff = Date.now() - windowHours * 3_600_000;
    return (
      db()
        .prepare(
          `SELECT content FROM discord_messages
           WHERE created_at >= ? AND channel_id IN (${chPh})
           ORDER BY RANDOM() LIMIT ?`,
        )
        .all(cutoff, ...channelIds, limit) as { content: string }[]
    ).map(r => r.content);
  }

  // FTS search — join with discord_messages to apply channel + time filters
  if (!windowHours) {
    // All time — no cutoff
    return (
      db()
        .prepare(
          `SELECT dm.content
           FROM messages_fts
           JOIN discord_messages dm ON messages_fts.rowid = dm.rowid
           WHERE messages_fts MATCH ?
             AND dm.channel_id IN (${chPh})
           ORDER BY bm25(messages_fts)
           LIMIT ?`,
        )
        .all(ftsQuery, ...channelIds, limit) as { content: string }[]
    ).map(r => r.content);
  }

  const cutoff = Date.now() - windowHours * 3_600_000;
  return (
    db()
      .prepare(
        `SELECT dm.content
         FROM messages_fts
         JOIN discord_messages dm ON messages_fts.rowid = dm.rowid
         WHERE messages_fts MATCH ?
           AND dm.created_at >= ?
           AND dm.channel_id IN (${chPh})
         ORDER BY bm25(messages_fts)
         LIMIT ?`,
      )
      .all(ftsQuery, cutoff, ...channelIds, limit) as { content: string }[]
  ).map(r => r.content);
}

/**
 * Query messages for sentiment analysis with author IDs.
 * Returns the most recent messages first (recency-weighted) with author info.
 * Used by the Community Pulse report to build author label maps.
 */
export function queryIndexedMessagesWithAuthors(
  windowHours: number,
  channelIds:  string[],
  limit:       number,
): { authorId: string; content: string }[] {
  if (channelIds.length === 0) return [];

  const cutoff = windowHours ? Date.now() - windowHours * 3_600_000 : 0;
  const chPh   = channelIds.map(() => '?').join(', ');
  const timeFilter = cutoff ? 'AND created_at >= ?' : '';
  const baseParams = cutoff ? [...channelIds, cutoff] : [...channelIds];

  return (
    db()
      .prepare(
        `SELECT author_id, content FROM discord_messages
         WHERE channel_id IN (${chPh}) ${timeFilter}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...baseParams, limit) as { author_id: string; content: string }[]
  ).map(r => ({ authorId: r.author_id, content: r.content }));
}

/**
 * Query messages for a chat job (legacy LIKE-based approach, kept for sentiment reports).
 *
 * Strategy:
 *   1. If keywords are provided, fetch keyword-matching messages first (LIKE scan).
 *   2. Pad up to `limit` with random non-matching messages from the same window.
 *   3. If no keywords, return a random sample from the window.
 */
export function queryIndexedMessages(
  windowHours: number,
  channelIds:  string[],
  limit:       number,
  keywords:    string[],
): string[] {
  if (channelIds.length === 0) return [];

  const cutoff = windowHours ? Date.now() - windowHours * 3_600_000 : 0;
  const chPh   = channelIds.map(() => '?').join(', ');

  const timeFilter = cutoff ? 'AND created_at >= ?' : '';
  const baseParams = cutoff ? [...channelIds, cutoff] : [...channelIds];

  if (keywords.length === 0) {
    return (
      db()
        .prepare(
          `SELECT content FROM discord_messages
           WHERE channel_id IN (${chPh}) ${timeFilter}
           ORDER BY RANDOM()
           LIMIT ?`,
        )
        .all(...baseParams, limit) as { content: string }[]
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
         WHERE channel_id IN (${chPh}) ${timeFilter}
           AND (${likeClause})
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(...baseParams, ...likeParams, limit) as { content: string }[]
  ).map(r => r.content);

  if (matching.length >= limit) return matching.slice(0, limit);

  // 2. Pad with non-matching random messages
  const remaining = limit - matching.length;
  const padding = (
    db()
      .prepare(
        `SELECT content FROM discord_messages
         WHERE channel_id IN (${chPh}) ${timeFilter}
           AND (${notLikeClause})
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(...baseParams, ...likeParams, remaining) as { content: string }[]
  ).map(r => r.content);

  return [...matching, ...padding];
}
